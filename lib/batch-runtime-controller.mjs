import {
  BATCH_RUNTIME_CHECKPOINT_KEY,
  applyBatchRuntimeEvent,
  createBatchRuntimeCheckpoint,
  normalizeInterruptedBatch,
  validateBatchRuntimeCheckpoint
} from './batch-runtime-checkpoint.mjs';

const MESSAGE_TYPES = new Set([
  'BATCH_SESSION_START',
  'BATCH_SESSION_GET',
  'BATCH_SESSION_LOAD_FOR_PAGE',
  'BATCH_SESSION_RESUME',
  'BATCH_SESSION_PAUSE',
  'BATCH_SESSION_STOP',
  'BATCH_SESSION_COMPLETE',
  'BATCH_SESSION_CLEAR',
  'BATCH_TASK_ACTIVE',
  'BATCH_TASK_SUBMITTING',
  'BATCH_TASK_TERMINAL'
]);

function safeError(error, fallback = 'batch_runtime_failed') {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return fallback;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createBatchRuntimeController({
  storageArea,
  power,
  tabs,
  windows,
  runtime,
  now = Date.now
}) {
  let operation = Promise.resolve();
  let keepAwake = false;

  function enqueue(work) {
    const current = operation.then(work);
    operation = current.catch(() => {});
    return current;
  }

  async function readCheckpoint() {
    const data = await storageArea.get([BATCH_RUNTIME_CHECKPOINT_KEY]);
    const checkpoint = data[BATCH_RUNTIME_CHECKPOINT_KEY] || null;
    if (!checkpoint) return { ok: true, checkpoint: null };
    const validation = validateBatchRuntimeCheckpoint(checkpoint);
    if (!validation.ok) return validation;
    return { ok: true, checkpoint };
  }

  async function writeCheckpoint(checkpoint) {
    await storageArea.set({
      [BATCH_RUNTIME_CHECKPOINT_KEY]: checkpoint
    });
    return checkpoint;
  }

  function requestWakefulness() {
    if (keepAwake) return;
    power.requestKeepAwake('system');
    keepAwake = true;
  }

  function releaseWakefulness({ force = false } = {}) {
    if (!keepAwake && !force) return;
    try {
      power.releaseKeepAwake();
    } finally {
      keepAwake = false;
    }
  }

  async function closeOrphanWindows(windowIds) {
    await Promise.all(windowIds.map(async (windowId) => {
      try {
        await windows.remove(windowId);
      } catch (_) {
        // A prior Chrome shutdown or user action may already have removed it.
      }
    }));
  }

  async function mutate(message, event) {
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (!loaded.checkpoint) {
      return { ok: false, error: 'checkpoint_not_found' };
    }
    const transition = applyBatchRuntimeEvent(
      loaded.checkpoint,
      {
        ...event,
        batchId: message.batchId
      },
      now()
    );
    if (!transition.ok) return transition;
    if (transition.changed) {
      await writeCheckpoint(transition.checkpoint);
    }
    return {
      ok: true,
      checkpoint: transition.checkpoint,
      changed: transition.changed
    };
  }

  async function start(message) {
    let checkpoint;
    try {
      checkpoint = createBatchRuntimeCheckpoint({
        batchId: message.batchId,
        source: message.source,
        settings: message.settings
      }, now());
    } catch (_) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
    const validation = validateBatchRuntimeCheckpoint(checkpoint);
    if (!validation.ok) return validation;
    await writeCheckpoint(checkpoint);

    try {
      requestWakefulness();
    } catch (_) {
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: 'power_request_failed',
        checkpoint
      };
    }

    const transition = applyBatchRuntimeEvent(checkpoint, {
      type: 'session_started',
      batchId: message.batchId
    }, now());
    try {
      await writeCheckpoint(transition.checkpoint);
    } catch (_) {
      releaseWakefulness({ force: true });
      throw codedError('checkpoint_write_failed');
    }
    return {
      ok: true,
      checkpoint: transition.checkpoint
    };
  }

  async function resume(message) {
    const loaded = await readCheckpoint();
    if (!loaded.ok || !loaded.checkpoint) {
      return loaded.ok
        ? { ok: false, error: 'checkpoint_not_found' }
        : loaded;
    }
    if (loaded.checkpoint.batchId !== message.batchId) {
      return { ok: false, error: 'stale_batch' };
    }
    if (loaded.checkpoint.status === 'running') {
      return {
        ok: true,
        checkpoint: loaded.checkpoint,
        changed: false
      };
    }
    try {
      requestWakefulness();
    } catch (_) {
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: 'power_request_failed',
        checkpoint: loaded.checkpoint
      };
    }
    const transition = applyBatchRuntimeEvent(loaded.checkpoint, {
      type: 'session_started',
      batchId: message.batchId
    }, now());
    if (!transition.ok) {
      releaseWakefulness({ force: true });
      return transition;
    }
    try {
      await writeCheckpoint(transition.checkpoint);
    } catch (_) {
      releaseWakefulness({ force: true });
      throw codedError('checkpoint_write_failed');
    }
    return {
      ok: true,
      checkpoint: transition.checkpoint,
      changed: true
    };
  }

  async function finishSession(message, eventType) {
    const response = await mutate(message, { type: eventType });
    if (response.ok) releaseWakefulness({ force: true });
    return response;
  }

  async function clear() {
    await storageArea.remove([BATCH_RUNTIME_CHECKPOINT_KEY]);
    releaseWakefulness({ force: true });
    return { ok: true, checkpoint: null };
  }

  async function normalizeForRecovery() {
    const loaded = await readCheckpoint();
    if (!loaded.ok || !loaded.checkpoint) return loaded;
    if (loaded.checkpoint.status !== 'running') {
      return {
        ok: true,
        checkpoint: loaded.checkpoint,
        changed: false
      };
    }
    const normalized = normalizeInterruptedBatch(
      loaded.checkpoint,
      now()
    );
    if (!normalized.ok) return normalized;
    await writeCheckpoint(normalized.checkpoint);
    releaseWakefulness({ force: true });
    await closeOrphanWindows(normalized.orphanWindowIds);
    return normalized;
  }

  function loadForPage() {
    return enqueue(normalizeForRecovery);
  }

  async function ensureRecoveryPage(checkpoint) {
    if (
      !checkpoint ||
      ['completed', 'terminated'].includes(checkpoint.status)
    ) {
      return;
    }
    const pageUrl = runtime.getURL('batch.html');
    const openTabs = await tabs.query({});
    const exists = openTabs.some(
      (tab) => typeof tab.url === 'string' && tab.url.startsWith(pageUrl)
    );
    if (!exists) {
      await tabs.create({ url: `${pageUrl}?recovery=1` });
    }
  }

  function recoverOnStartup() {
    return enqueue(async () => {
      const recovery = await normalizeForRecovery();
      if (!recovery.ok) return recovery;
      await ensureRecoveryPage(recovery.checkpoint);
      return recovery;
    });
  }

  function markTerminal(message) {
    return enqueue(async () => {
      const loaded = await readCheckpoint();
      if (!loaded.ok) return loaded;
      if (!loaded.checkpoint) {
        return {
          ok: true,
          checkpoint: null,
          changed: false,
          untracked: true
        };
      }
      if (loaded.checkpoint.batchId !== message.batchId) {
        return {
          ok: true,
          checkpoint: loaded.checkpoint,
          changed: false,
          untracked: true
        };
      }
      if (!loaded.checkpoint.tasks[String(message.urlIndex)]) {
        return {
          ok: true,
          checkpoint: loaded.checkpoint,
          changed: false,
          untracked: true
        };
      }
      return mutate(message, {
        type: 'task_terminal',
        urlIndex: message.urlIndex,
        result: {
          result: message.result ?? 'success',
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null
        }
      });
    });
  }

  function handleMessage(message) {
    return enqueue(async () => {
      try {
        switch (message?.type) {
          case 'BATCH_SESSION_START':
            return await start(message);
          case 'BATCH_SESSION_GET':
            return await readCheckpoint();
          case 'BATCH_SESSION_LOAD_FOR_PAGE':
            return await normalizeForRecovery();
          case 'BATCH_SESSION_RESUME':
            return await resume(message);
          case 'BATCH_SESSION_PAUSE':
            return await finishSession(message, 'session_paused');
          case 'BATCH_SESSION_STOP':
            return await finishSession(message, 'session_terminated');
          case 'BATCH_SESSION_COMPLETE':
            return await finishSession(message, 'session_completed');
          case 'BATCH_SESSION_CLEAR':
            return await clear();
          case 'BATCH_TASK_ACTIVE':
            return await mutate(message, {
              type: 'task_activated',
              urlIndex: message.urlIndex,
              tabId: message.tabId,
              windowId: message.windowId,
              startedAt: message.startedAt
            });
          case 'BATCH_TASK_SUBMITTING':
            return await mutate(message, {
              type: 'task_submitting',
              urlIndex: message.urlIndex
            });
          case 'BATCH_TASK_TERMINAL':
            return await mutate(message, {
              type: 'task_terminal',
              urlIndex: message.urlIndex,
              result: message.result
            });
          default:
            return { ok: false, error: 'unsupported_message' };
        }
      } catch (error) {
        return {
          ok: false,
          error: safeError(error)
        };
      }
    });
  }

  return {
    handleMessage,
    loadForPage,
    markTerminal,
    recoverOnStartup
  };
}

export function installBatchRuntimeController(chromeApi, controller) {
  chromeApi.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      if (!MESSAGE_TYPES.has(message?.type)) return false;
      if (sender?.id !== chromeApi.runtime.id) {
        sendResponse({ ok: false, error: 'forbidden_sender' });
        return false;
      }
      controller.handleMessage(message, sender)
        .then(sendResponse)
        .catch(() => sendResponse({
          ok: false,
          error: 'batch_runtime_failed'
        }));
      return true;
    }
  );

  chromeApi.runtime.onStartup.addListener(() => {
    void controller.recoverOnStartup().catch(() => {
      console.warn('[background] Batch recovery deferred');
    });
  });
}
