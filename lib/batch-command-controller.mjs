import { getBatchRetryPolicy } from './batch-error-policy.mjs';

const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function scrubSensitive(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitive(item));
  }
  if (!value || typeof value !== 'object') return value;

  const safe = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const scrubbed = scrubSensitive(childValue, childKey);
    if (scrubbed !== undefined) safe[childKey] = scrubbed;
  }
  return safe;
}

function redactSensitiveColumns(source) {
  if (!source || !Array.isArray(source.headers)) return source;
  const sensitiveColumns = new Set(
    source.headers.flatMap((header, index) => (
      SENSITIVE_KEY.test(String(header)) ? [index] : []
    ))
  );
  if (sensitiveColumns.size === 0) return source;

  const redactRow = (row) => {
    if (!Array.isArray(row)) return row;
    return row.map((value, index) => (
      sensitiveColumns.has(index) ? '[REDACTED]' : value
    ));
  };
  return {
    ...source,
    rows: Array.isArray(source.rows)
      ? source.rows.map(redactRow)
      : source.rows,
    parsedUrls: Array.isArray(source.parsedUrls)
      ? source.parsedUrls.map((item) => ({
          ...item,
          originalRow: redactRow(item.originalRow)
        }))
      : source.parsedUrls
  };
}

function sanitizedStartDraft(draft) {
  const safe = scrubSensitive(draft);
  if (safe?.source) safe.source = redactSensitiveColumns(safe.source);
  return safe;
}

function commandIdentity(prefix, task) {
  return [
    prefix,
    task?.batchId || '',
    task?.urlIndex ?? '',
    task?.attempt ?? ''
  ].join(':');
}

function taskIdentity(task, fallbackBatchId) {
  const batchId = task?.batchId || fallbackBatchId;
  if (
    typeof batchId !== 'string' ||
    batchId.length === 0 ||
    !Number.isInteger(task?.urlIndex) ||
    task.urlIndex < 0 ||
    !Number.isInteger(task?.attempt) ||
    task.attempt < 1
  ) {
    throw codedError('invalid_batch_task');
  }
  return {
    batchId,
    urlIndex: task.urlIndex,
    attempt: task.attempt
  };
}

export function createBatchCommandController(dependencies) {
  const {
    runtimeRequest,
    workerRuntime,
    manualWindows,
    draftStorage = {
      async set() {},
      async remove() {}
    }
  } = dependencies;

  const listeners = new Set();
  let inFlight = null;
  let onlineTarget = null;
  let offlineListener = null;
  let onlineListener = null;

  function publish(update) {
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch (_) {
        // An observer cannot break command ordering.
      }
    }
  }

  function runCommand(identity, operation) {
    if (inFlight) {
      if (inFlight.identity === identity) return inFlight.promise;
      return Promise.reject(codedError('batch_command_in_progress'));
    }

    const promise = Promise.resolve().then(operation);
    inFlight = { identity, promise };
    promise.then(
      () => {
        if (inFlight?.promise === promise) inFlight = null;
      },
      () => {
        if (inFlight?.promise === promise) inFlight = null;
      }
    );
    return promise;
  }

  function currentCheckpoint() {
    const checkpoint = dependencies.getCheckpoint?.();
    if (!checkpoint || typeof checkpoint.batchId !== 'string') {
      throw codedError('checkpoint_not_found');
    }
    return checkpoint;
  }

  async function requestCheckpoint(type, payload) {
    let response;
    try {
      response = await runtimeRequest(type, payload);
    } catch (error) {
      if (typeof error?.code === 'string') throw error;
      throw codedError('batch_runtime_failed');
    }
    if (!response?.ok) {
      throw codedError(response?.error || 'batch_runtime_failed');
    }
    if (!response.checkpoint) throw codedError('checkpoint_not_found');
    publish({ checkpoint: response.checkpoint });
    return response.checkpoint;
  }

  function start(draft) {
    return runCommand('start', async () => {
      const safeDraft = sanitizedStartDraft(draft);
      await draftStorage.set(safeDraft);
      const checkpoint = await requestCheckpoint('BATCH_SESSION_START', {
        batchId: safeDraft?.batchId,
        source: safeDraft?.source,
        settings: safeDraft?.settings
      });
      await workerRuntime.start(checkpoint);
      await draftStorage.remove();
      return checkpoint;
    });
  }

  function pauseWithReason(reason) {
    return runCommand('pause', async () => {
      const checkpoint = currentCheckpoint();
      await workerRuntime.pause(reason);
      return requestCheckpoint('BATCH_SESSION_PAUSE', {
        batchId: checkpoint.batchId
      });
    });
  }

  function pause() {
    return pauseWithReason('user');
  }

  function resume() {
    return runCommand('resume', async () => {
      const checkpoint = currentCheckpoint();
      const resumed = await requestCheckpoint('BATCH_SESSION_RESUME', {
        batchId: checkpoint.batchId
      });
      const accepted = await workerRuntime.resume(resumed);
      if (accepted === false) throw codedError('worker_resume_rejected');
      return resumed;
    });
  }

  function stop(confirmedRisk = false) {
    if (confirmedRisk !== true) {
      return Promise.reject(codedError('stop_confirmation_required'));
    }
    return runCommand('stop', async () => {
      const checkpoint = currentCheckpoint();
      await workerRuntime.stop();
      return requestCheckpoint('BATCH_SESSION_STOP', {
        batchId: checkpoint.batchId
      });
    });
  }

  function retry(task, confirmedRisk = false) {
    const retryPolicy = task?.retryPolicy || getBatchRetryPolicy({
      result: task?.result,
      errorCode: task?.errorCode || task?.error?.code
    });
    if (retryPolicy === 'blocked') {
      return Promise.reject(codedError('retry_blocked'));
    }
    if (retryPolicy === 'confirm' && confirmedRisk !== true) {
      return Promise.reject(codedError('retry_confirmation_required'));
    }

    const identity = commandIdentity('retry', task);
    return runCommand(identity, async () => {
      const checkpoint = currentCheckpoint();
      const payload = {
        ...taskIdentity(task, checkpoint.batchId),
        confirmedRisk: confirmedRisk === true
      };
      const retried = await requestCheckpoint('BATCH_TASK_RETRY', payload);
      if (retried.status === 'running') {
        await workerRuntime.refill(retried);
      }
      return retried;
    });
  }

  function updateManual(task, status) {
    const identity = commandIdentity(`manual:${status}`, task);
    return runCommand(identity, async () => {
      const checkpoint = currentCheckpoint();
      return requestCheckpoint('BATCH_TASK_MANUAL_UPDATE', {
        ...taskIdentity(task, checkpoint.batchId),
        status
      });
    });
  }

  function openManual(task) {
    const identity = commandIdentity('manual:open', task);
    return runCommand(identity, async () => {
      const checkpoint = currentCheckpoint();
      const taskPayload = taskIdentity(task, checkpoint.batchId);
      await manualWindows.open(task.url);
      return requestCheckpoint('BATCH_TASK_MANUAL_UPDATE', {
        ...taskPayload,
        status: 'in_progress'
      });
    });
  }

  function handleOffline() {
    return pauseWithReason('offline');
  }

  function detachOnlineListeners() {
    if (!onlineTarget) return;
    onlineTarget.removeEventListener('offline', offlineListener);
    onlineTarget.removeEventListener('online', onlineListener);
    onlineTarget = null;
    offlineListener = null;
    onlineListener = null;
  }

  function attachOnlineListeners(target) {
    detachOnlineListeners();
    if (!target) return;
    onlineTarget = target;
    offlineListener = () => {
      void handleOffline().catch((error) => {
        publish({
          online: false,
          requiresUserResume: true,
          error: error?.code || 'batch_runtime_failed'
        });
      });
    };
    onlineListener = () => {
      publish({
        online: true,
        requiresUserResume: true
      });
    };
    target.addEventListener('offline', offlineListener);
    target.addEventListener('online', onlineListener);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  if (dependencies.onlineTarget) {
    attachOnlineListeners(dependencies.onlineTarget);
  }

  return {
    start,
    pause,
    resume,
    stop,
    retry,
    openManual,
    updateManual,
    handleOffline,
    attachOnlineListeners,
    detachOnlineListeners,
    subscribe
  };
}
