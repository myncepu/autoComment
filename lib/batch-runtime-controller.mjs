import {
  BATCH_RUNTIME_CHECKPOINT_KEY,
  applyBatchRuntimeEvent,
  createBatchRuntimeCheckpoint,
  migrateBatchRuntimeCheckpoint,
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
  'BATCH_PAGE_TEARDOWN',
  'BATCH_TASK_ACTIVE',
  'BATCH_TASK_MANUAL_UPDATE',
  'BATCH_TASK_PHASE',
  'BATCH_TASK_RETRY',
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

function isMissingTabError(error) {
  const message = String(error?.message || error || '');
  return /\bNo tab with id(?::|\s)/i.test(message) ||
    /\bTab not found\b/i.test(message);
}

export function createBatchRuntimeController({
  storageArea,
  power,
  tabs,
  runtime,
  now = Date.now,
  logger = console
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
    const migration = migrateBatchRuntimeCheckpoint(checkpoint, now());
    if (!migration.ok) return migration;
    if (migration.changed) {
      await writeCheckpoint(migration.checkpoint);
    }
    return { ok: true, checkpoint: migration.checkpoint };
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
    } catch (_) {
      logger.warn?.('[batch-runtime] Failed to release system wakefulness');
    } finally {
      keepAwake = false;
    }
  }

  function recoveryCleanup(checkpoint, {
    reason,
    orphanTabIds,
    diagnostic = null
  }) {
    return {
      ...checkpoint,
      recoveryCleanup: {
        reason,
        orphanTabIds: [...new Set(orphanTabIds)].filter(Number.isInteger),
        diagnostic,
        updatedAt: now()
      }
    };
  }

  async function teardownPage(message, extraOrphanTabIds = []) {
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (!loaded.checkpoint) {
      return {
        ok: true,
        checkpoint: null,
        cleanupComplete: true,
        orphanTabIds: []
      };
    }
    if (
      typeof message.batchId === 'string' &&
      message.batchId !== loaded.checkpoint.batchId
    ) {
      return {
        ok: false,
        error: 'stale_batch',
        checkpoint: loaded.checkpoint,
        cleanupComplete: false
      };
    }

    const reason = typeof message.reason === 'string'
      ? message.reason
      : 'page_teardown';
    const normalized = normalizeInterruptedBatch(
      loaded.checkpoint,
      now()
    );
    if (!normalized.ok) return normalized;
    const inheritedOrphans = Array.isArray(
      loaded.checkpoint.recoveryCleanup?.orphanTabIds
    )
      ? loaded.checkpoint.recoveryCleanup.orphanTabIds
      : [];
    const orphanTabIds = [
      ...new Set([
        ...inheritedOrphans,
        ...normalized.orphanTabIds,
        ...extraOrphanTabIds
      ])
    ].filter(Number.isInteger);
    const ownedCheckpoint = recoveryCleanup(normalized.checkpoint, {
      reason,
      orphanTabIds
    });

    try {
      await writeCheckpoint(ownedCheckpoint);
    } catch (_) {
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        checkpoint: loaded.checkpoint,
        cleanupComplete: false,
        orphanTabIds
      };
    }

    const failedTabIds = [];
    for (const tabId of orphanTabIds) {
      try {
        await tabs.remove(tabId);
      } catch (error) {
        if (!isMissingTabError(error)) failedTabIds.push(tabId);
      }
    }
    const finalCheckpoint = recoveryCleanup(ownedCheckpoint, {
      reason,
      orphanTabIds: failedTabIds,
      diagnostic: failedTabIds.length > 0 ? 'tab_close_failed' : null
    });
    try {
      await writeCheckpoint(finalCheckpoint);
    } catch (_) {
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        checkpoint: ownedCheckpoint,
        cleanupComplete: false,
        orphanTabIds
      };
    }
    releaseWakefulness({ force: true });
    if (failedTabIds.length > 0) {
      return {
        ok: false,
        error: 'batch_teardown_cleanup_failed',
        checkpoint: finalCheckpoint,
        cleanupComplete: false,
        orphanTabIds: failedTabIds
      };
    }
    return {
      ok: true,
      checkpoint: finalCheckpoint,
      cleanupComplete: true,
      orphanTabIds: []
    };
  }

  async function mutate(
    message,
    event,
    { ensureWakefulness = false } = {}
  ) {
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (!loaded.checkpoint) {
      return { ok: false, error: 'checkpoint_not_found' };
    }
    if (ensureWakefulness && loaded.checkpoint.status === 'running') {
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
    const retryOrphans =
      loaded.checkpoint.recoveryCleanup?.orphanTabIds || [];
    if (
      loaded.checkpoint.status !== 'running' &&
      retryOrphans.length === 0
    ) {
      return {
        ok: true,
        checkpoint: loaded.checkpoint,
        changed: false
      };
    }
    return teardownPage({
      batchId: loaded.checkpoint.batchId,
      reason: loaded.checkpoint.recoveryCleanup?.reason ||
        'startup_recovery'
    });
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
      if (!Number.isInteger(message?.attempt) || message.attempt < 1) {
        return { ok: false, error: 'stale_attempt' };
      }
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
        attempt: message.attempt,
        result: {
          result: message.result ?? 'success',
          aiContent: message.aiContent || null,
          errorCode: message.errorCode || null,
          errorMessage: message.errorMessage || null
        }
      }, { ensureWakefulness: true });
    });
  }

  async function updateTaskPhase(message, sender) {
    const sourceTabId = sender?.tab?.id;
    if (!Number.isInteger(sourceTabId)) {
      return { ok: false, error: 'forbidden_sender' };
    }
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    const task = loaded.checkpoint?.tasks?.[String(message.urlIndex)];
    if (
      loaded.checkpoint?.batchId === message.batchId &&
      task?.attempt === message.attempt &&
      task?.tabId !== sourceTabId
    ) {
      return {
        ok: false,
        error: 'stale_worker_tab',
        checkpoint: loaded.checkpoint
      };
    }
    return mutate(message, {
      type: 'task_phase',
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      phase: message.phase
    }, { ensureWakefulness: true });
  }

  async function activateTask(message) {
    const response = await mutate(message, {
      type: 'task_activated',
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      tabId: message.tabId,
      windowId: message.windowId,
      startedAt: message.startedAt
    }, { ensureWakefulness: true });
    if (response.ok || !Number.isInteger(message.tabId)) return response;
    if (
      response.checkpoint?.batchId !== message.batchId ||
      !['stale_attempt', 'invalid_transition'].includes(response.error)
    ) {
      return response;
    }
    const cancelledByTeardown =
      response.checkpoint.status === 'paused_recovery' &&
      response.checkpoint.recoveryCleanup;
    const cleanup = await teardownPage(
      {
        batchId: message.batchId,
        reason: cancelledByTeardown
          ? response.checkpoint.recoveryCleanup.reason
          : 'invalid_worker_identity'
      },
      [message.tabId]
    );
    return {
      ...cleanup,
      ok: false,
      error: cancelledByTeardown
        ? 'batch_teardown_cancelled'
        : response.error
    };
  }

  function handleMessage(message, sender) {
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
          case 'BATCH_PAGE_TEARDOWN':
            return await teardownPage(message);
          case 'BATCH_TASK_ACTIVE':
            return await activateTask(message);
          case 'BATCH_TASK_SUBMITTING':
            return await mutate(message, {
              type: 'task_submitting',
              urlIndex: message.urlIndex,
              attempt: message.attempt
            }, { ensureWakefulness: true });
          case 'BATCH_TASK_PHASE':
            return await updateTaskPhase(message, sender);
          case 'BATCH_TASK_RETRY':
            return await mutate(message, {
              type: 'task_retried',
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              confirmedRisk: message.confirmedRisk === true
            });
          case 'BATCH_TASK_MANUAL_UPDATE':
            return await mutate(message, {
              type: 'task_manual_updated',
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              status: message.status
            });
          case 'BATCH_TASK_TERMINAL':
            return await mutate(message, {
              type: 'task_terminal',
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              result: message.result
            }, { ensureWakefulness: true });
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
      if (message.type === 'BATCH_PAGE_TEARDOWN') {
        const batchPageUrl = chromeApi.runtime.getURL('batch.html');
        const senderUrl = String(sender?.url || '');
        if (
          sender?.tab ||
          !(
            senderUrl === batchPageUrl ||
            senderUrl.startsWith(`${batchPageUrl}?`) ||
            senderUrl.startsWith(`${batchPageUrl}#`)
          )
        ) {
          sendResponse({ ok: false, error: 'forbidden_sender' });
          return false;
        }
      }
      controller.handleMessage(message, sender)
        .then(async (response) => {
          if (response?.ok && message.type === 'BATCH_TASK_PHASE') {
            await chromeApi.runtime.sendMessage({
              type: 'BATCH_TASK_PHASE_UPDATED',
              batchId: message.batchId,
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              phase: message.phase,
              sourceTabId: sender.tab.id
            }).catch(() => {});
          }
          return response;
        })
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
