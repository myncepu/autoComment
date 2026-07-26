import { getBatchRetryPolicy } from './batch-error-policy.mjs';

const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function diagnosticCode(error, fallback) {
  const code = String(error?.code || error || '');
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
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
  let recoveryPersistence = null;
  let cancellationReason = null;
  let urgentPausePromise = null;

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

  function cancellationError() {
    return codedError(
      cancellationReason === 'offline'
        ? 'batch_offline'
        : 'batch_teardown_in_progress'
    );
  }

  async function persistPause(checkpoint, reason) {
    const paused = await requestCheckpoint('BATCH_SESSION_PAUSE', {
      batchId: checkpoint.batchId,
      reason
    });
    recoveryPersistence = null;
    return paused;
  }

  async function persistPauseWithRecovery(checkpoint, reason, command = reason) {
    try {
      return await persistPause(checkpoint, reason);
    } catch (error) {
      return recoverPersistedWorkerFailure({
        command,
        batchId: checkpoint.batchId,
        checkpoint,
        error,
        cleanupWorker: false
      });
    }
  }

  async function recoverPersistedWorkerFailure({
    command,
    batchId,
    checkpoint,
    error,
    cleanupWorker = true
  }) {
    const recoveryErrorCodes = [];
    if (cleanupWorker) {
      try {
        const cleaned = await workerRuntime.pause('runtime_error');
        if (cleaned === false) {
          recoveryErrorCodes.push('worker_pause_rejected');
        }
      } catch (cleanupError) {
        recoveryErrorCodes.push(
          diagnosticCode(cleanupError, 'worker_pause_failed')
        );
      }
    }

    let recoveredCheckpoint = null;
    try {
      const response = await runtimeRequest('BATCH_SESSION_PAUSE', {
        batchId,
        reason: 'runtime_error'
      });
      if (!response?.ok) {
        recoveryErrorCodes.push(
          diagnosticCode(response?.error, 'batch_pause_failed')
        );
      } else if (!response.checkpoint) {
        recoveryErrorCodes.push('checkpoint_not_found');
      } else if (response.checkpoint.status !== 'paused_recovery') {
        recoveryErrorCodes.push('recovery_pause_not_persisted');
      } else {
        recoveredCheckpoint = response.checkpoint;
        recoveryPersistence = null;
        publish({ checkpoint: recoveredCheckpoint });
      }
    } catch (pauseError) {
      recoveryErrorCodes.push(
        diagnosticCode(pauseError, 'batch_pause_failed')
      );
    }

    const persistencePending = !recoveredCheckpoint;
    if (persistencePending) {
      recoveredCheckpoint = {
        ...structuredClone(checkpoint),
        status: 'paused_recovery',
        persistencePending: true,
        lastPersistedStatus: checkpoint.status
      };
      recoveryPersistence = {
        batchId,
        checkpoint: recoveredCheckpoint
      };
      publish({
        checkpoint: recoveredCheckpoint,
        persisted: false,
        recoveryPersistenceRequired: true
      });
    }

    publish({
      type: 'runtime-error',
      command,
      errorCode: diagnosticCode(error, `${command}_worker_failed`),
      recoveryErrorCodes,
      checkpoint: recoveredCheckpoint,
      requiresUserResume: true,
      ...(persistencePending
        ? {
            persisted: false,
            recoveryPersistenceRequired: true
          }
        : {})
    });
    throw error;
  }

  function eligibleManualTask(checkpoint, task) {
    const identity = taskIdentity(task, checkpoint.batchId);
    if (identity.batchId !== checkpoint.batchId) {
      throw codedError('stale_batch');
    }
    const currentTask = checkpoint.tasks?.[String(identity.urlIndex)];
    if (!currentTask) throw codedError('manual_task_not_found');
    if (currentTask.attempt !== identity.attempt) {
      throw codedError('stale_attempt');
    }
    const currentResult = checkpoint.results?.find((result) => (
      result.originalIndex === identity.urlIndex &&
      result.attempt === identity.attempt
    ));
    if (
      currentTask.state !== 'terminal' ||
      !['manual_required', 'no_comment_box'].includes(currentResult?.result)
    ) {
      throw codedError('manual_not_allowed');
    }
    return identity;
  }

  function start(draft) {
    return runCommand('start', async () => {
      if (cancellationReason) throw cancellationError();
      const safeDraft = sanitizedStartDraft(draft);
      await draftStorage.set(safeDraft);
      const checkpoint = await requestCheckpoint('BATCH_SESSION_START', {
        batchId: safeDraft?.batchId,
        source: safeDraft?.source,
        settings: safeDraft?.settings
      });
      if (cancellationReason) {
        return persistPauseWithRecovery(
          checkpoint,
          cancellationReason,
          'start'
        );
      }
      try {
        await workerRuntime.start(checkpoint);
      } catch (error) {
        return recoverPersistedWorkerFailure({
          command: 'start',
          batchId: checkpoint.batchId,
          checkpoint,
          error
        });
      }
      if (cancellationReason) {
        await workerRuntime.pause(cancellationReason);
        return persistPauseWithRecovery(
          checkpoint,
          cancellationReason,
          'start'
        );
      }
      recoveryPersistence = null;
      await draftStorage.remove();
      return checkpoint;
    });
  }

  function pauseWithReason(reason) {
    return runCommand('pause', async () => {
      const checkpoint = currentCheckpoint();
      try {
        const cleaned = await workerRuntime.pause(reason);
        if (cleaned === false) throw codedError('worker_pause_rejected');
      } catch (error) {
        return recoverPersistedWorkerFailure({
          command: 'pause',
          batchId: checkpoint.batchId,
          checkpoint,
          error,
          cleanupWorker: false
        });
      }
      return persistPauseWithRecovery(checkpoint, reason, 'pause');
    });
  }

  function pause(reason = 'user') {
    return reason === 'user'
      ? pauseWithReason(reason)
      : urgentPause(reason);
  }

  function resume() {
    return runCommand('resume', async () => {
      if (cancellationReason) throw cancellationError();
      const checkpoint = currentCheckpoint();
      if (
        recoveryPersistence?.batchId === checkpoint.batchId ||
        checkpoint.persistencePending === true
      ) {
        throw codedError('recovery_persistence_required');
      }
      const resumed = await requestCheckpoint('BATCH_SESSION_RESUME', {
        batchId: checkpoint.batchId
      });
      if (cancellationReason) {
        return persistPauseWithRecovery(
          resumed,
          cancellationReason,
          'resume'
        );
      }
      try {
        const accepted = await workerRuntime.resume(resumed);
        if (accepted === false) throw codedError('worker_resume_rejected');
      } catch (error) {
        return recoverPersistedWorkerFailure({
          command: 'resume',
          batchId: resumed.batchId,
          checkpoint: resumed,
          error
        });
      }
      if (cancellationReason) {
        await workerRuntime.pause(cancellationReason);
        return persistPauseWithRecovery(
          resumed,
          cancellationReason,
          'resume'
        );
      }
      return resumed;
    });
  }

  function stop(confirmedRisk = false) {
    if (confirmedRisk !== true) {
      return Promise.reject(codedError('stop_confirmation_required'));
    }
    return runCommand('stop', async () => {
      const checkpoint = currentCheckpoint();
      try {
        const cleaned = await workerRuntime.stop();
        if (cleaned === false) throw codedError('worker_stop_rejected');
      } catch (error) {
        return recoverPersistedWorkerFailure({
          command: 'stop',
          batchId: checkpoint.batchId,
          checkpoint,
          error,
          cleanupWorker: false
        });
      }
      try {
        const stopped = await requestCheckpoint('BATCH_SESSION_STOP', {
          batchId: checkpoint.batchId
        });
        recoveryPersistence = null;
        return stopped;
      } catch (error) {
        return recoverPersistedWorkerFailure({
          command: 'stop',
          batchId: checkpoint.batchId,
          checkpoint,
          error,
          cleanupWorker: false
        });
      }
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
        try {
          const refilled = await workerRuntime.refill(retried);
          if (refilled === false) throw codedError('worker_refill_rejected');
        } catch (error) {
          return recoverPersistedWorkerFailure({
            command: 'retry',
            batchId: retried.batchId,
            checkpoint: retried,
            error
          });
        }
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
      const taskPayload = eligibleManualTask(checkpoint, task);
      const handle = await manualWindows.open(task.url);
      try {
        return await requestCheckpoint('BATCH_TASK_MANUAL_UPDATE', {
          ...taskPayload,
          status: 'in_progress'
        });
      } catch (error) {
        try {
          await manualWindows.close(handle);
        } catch (_) {
          // The original persistence error remains the command failure.
        }
        throw error;
      }
    });
  }

  function urgentPause(reason) {
    cancellationReason = reason;
    if (urgentPausePromise) return urgentPausePromise;
    const pendingCommand = inFlight?.promise || null;
    urgentPausePromise = (async () => {
      let cleanupError = null;
      try {
        const cleaned = await workerRuntime.pause(reason);
        if (cleaned === false) {
          cleanupError = codedError('worker_pause_rejected');
        }
      } catch (error) {
        cleanupError = error;
      }
      if (pendingCommand) await pendingCommand.catch(() => {});
      const checkpoint = currentCheckpoint();
      if (checkpoint.status !== 'running') {
        if (cleanupError) throw cleanupError;
        return checkpoint;
      }
      if (cleanupError) {
        return recoverPersistedWorkerFailure({
          command: reason,
          batchId: checkpoint.batchId,
          checkpoint,
          error: cleanupError,
          cleanupWorker: false
        });
      }
      return persistPauseWithRecovery(checkpoint, reason);
    })().finally(() => {
      urgentPausePromise = null;
    });
    return urgentPausePromise;
  }

  function handleOffline() {
    return urgentPause('offline');
  }

  function handleOnline() {
    if (cancellationReason === 'offline') cancellationReason = null;
    publish({
      online: true,
      requiresUserResume: true
    });
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
      handleOnline();
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
    handleOnline,
    attachOnlineListeners,
    detachOnlineListeners,
    subscribe
  };
}
