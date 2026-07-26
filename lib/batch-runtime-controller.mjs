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
  'BATCH_CREATE_WORKER_TAB',
  'BATCH_TASK_ACTIVE',
  'BATCH_TASK_MANUAL_UPDATE',
  'BATCH_TASK_PHASE',
  'BATCH_TASK_RETRY',
  'BATCH_TASK_SUBMITTING',
  'BATCH_TASK_TERMINAL'
]);
const BATCH_PAGE_MESSAGE_TYPES = new Set([
  'BATCH_PAGE_TEARDOWN',
  'BATCH_CREATE_WORKER_TAB'
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

function workerRequestId(message) {
  if (
    typeof message?.requestId === 'string' &&
    message.requestId.length > 0
  ) {
    return message.requestId;
  }
  return `${message?.batchId}:${message?.urlIndex}:${message?.attempt}`;
}

function isBatchPageSender(sender, runtime) {
  if (
    sender?.id !== runtime.id ||
    !Number.isInteger(sender?.tab?.id) ||
    !Number.isInteger(sender?.tab?.windowId)
  ) {
    return false;
  }
  try {
    const expected = new URL(runtime.getURL('batch.html'));
    const actual = new URL(String(sender.url || ''));
    return actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname;
  } catch (_) {
    return false;
  }
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

  async function boundedTabGet(tabId, timeoutMs = 1000) {
    let timeoutId;
    try {
      return await Promise.race([
        tabs.get(tabId),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(codedError('tab_lookup_timeout'));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
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

  function openingReservations(checkpoint) {
    const reservations = checkpoint?.openingReservations;
    return reservations &&
      typeof reservations === 'object' &&
      !Array.isArray(reservations)
      ? reservations
      : {};
  }

  function pendingWorkerUrl(requestId) {
    return `${runtime.getURL('worker-pending.html')}#${encodeURIComponent(
      requestId
    )}`;
  }

  function pendingRequestId(tab) {
    try {
      const expected = new URL(runtime.getURL('worker-pending.html'));
      const actual = new URL(String(tab?.pendingUrl || tab?.url || ''));
      if (
        actual.protocol !== expected.protocol ||
        actual.host !== expected.host ||
        actual.pathname !== expected.pathname ||
        !actual.hash
      ) {
        return null;
      }
      const requestId = decodeURIComponent(actual.hash.slice(1));
      return requestId.length > 0 ? requestId : null;
    } catch (_) {
      return null;
    }
  }

  async function discoverPendingWorkers(checkpoint) {
    const openTabs = await tabs.query({});
    const reservations = openingReservations(checkpoint);
    return openTabs.flatMap((tab) => {
      const requestId = pendingRequestId(tab);
      const reservation = requestId ? reservations[requestId] : null;
      if (
        !reservation ||
        !Number.isInteger(tab?.id) ||
        tab.windowId !== reservation.windowId ||
        (
          Number.isInteger(reservation.tabId) &&
          reservation.tabId !== tab.id
        )
      ) {
        return [];
      }
      return [{ requestId, tabId: tab.id }];
    });
  }

  function ownDiscoveredPending(checkpoint, discovered) {
    let next = structuredClone(checkpoint);
    for (const { requestId, tabId } of discovered) {
      const reservation = openingReservations(next)[requestId];
      if (!reservation) continue;
      next = reserveOpening(next, {
        ...reservation,
        requestId,
        tabId
      });
    }
    return next;
  }

  function reserveOpening(checkpoint, {
    requestId,
    urlIndex,
    attempt,
    windowId,
    tabId = null
  }) {
    const next = structuredClone(checkpoint);
    next.openingReservations = {
      ...openingReservations(next),
      [requestId]: {
        requestId,
        batchId: checkpoint.batchId,
        urlIndex,
        attempt,
        windowId,
        tabId,
        updatedAt: now()
      }
    };
    next.updatedAt = now();
    return next;
  }

  function clearOpening(checkpoint, requestId) {
    const next = structuredClone(checkpoint);
    const reservations = { ...openingReservations(next) };
    delete reservations[requestId];
    next.openingReservations = reservations;
    next.updatedAt = now();
    return next;
  }

  function retainFailedOpenings(checkpoint, failedTabIds) {
    const failed = new Set(failedTabIds);
    const next = structuredClone(checkpoint);
    next.openingReservations = Object.fromEntries(
      Object.entries(openingReservations(next)).filter(
        ([, reservation]) => (
          Number.isInteger(reservation?.tabId) &&
          failed.has(reservation.tabId)
        )
      )
    );
    next.updatedAt = now();
    return next;
  }

  function resetMissingActive(checkpoint, {
    requestId,
    urlIndex,
    attempt,
    windowId
  }) {
    const next = structuredClone(checkpoint);
    Object.assign(next.tasks[String(urlIndex)], {
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: now()
    });
    next.tasks[String(urlIndex)].requestId = null;
    return reserveOpening(next, {
      requestId,
      urlIndex,
      attempt,
      windowId
    });
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
    let discoveredPending;
    try {
      discoveredPending = await discoverPendingWorkers(loaded.checkpoint);
    } catch (_) {
      return {
        ok: false,
        error: 'tab_lookup_failed',
        checkpoint: loaded.checkpoint,
        cleanupComplete: false
      };
    }
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
        ...discoveredPending.map(({ tabId }) => tabId),
        ...extraOrphanTabIds
      ])
    ].filter(Number.isInteger);
    const ownedCheckpoint = recoveryCleanup(
      ownDiscoveredPending(normalized.checkpoint, discoveredPending),
      {
      reason,
      orphanTabIds
      }
    );

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
    const finalCheckpoint = recoveryCleanup(
      retainFailedOpenings(ownedCheckpoint, failedTabIds),
      {
      reason,
      orphanTabIds: failedTabIds,
      diagnostic: failedTabIds.length > 0 ? 'tab_close_failed' : null
      }
    );
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
    const pendingOpenings = Object.keys(
      openingReservations(loaded.checkpoint)
    );
    if (
      loaded.checkpoint.status !== 'running' &&
      retryOrphans.length === 0 &&
      pendingOpenings.length === 0
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

  async function createWorkerTab(message, sender) {
    if (!isBatchPageSender(sender, runtime)) {
      return { ok: false, error: 'forbidden_sender' };
    }
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (!loaded.checkpoint) {
      return { ok: false, error: 'checkpoint_not_found' };
    }
    let checkpoint = loaded.checkpoint;
    if (checkpoint.batchId !== message.batchId) {
      return {
        ok: false,
        error: 'stale_batch',
        checkpoint
      };
    }
    if (checkpoint.status !== 'running') {
      return {
        ok: false,
        error: checkpoint.status === 'paused_recovery'
          ? 'batch_teardown_cancelled'
          : 'invalid_transition',
        checkpoint
      };
    }
    if (
      !Number.isInteger(message.urlIndex) ||
      message.urlIndex < 0 ||
      !Number.isInteger(message.attempt) ||
      message.attempt < 1
    ) {
      return {
        ok: false,
        error: 'invalid_worker_identity',
        checkpoint
      };
    }
    const requestId = workerRequestId(message);
    let task = checkpoint.tasks[String(message.urlIndex)];
    const item = checkpoint.source.parsedUrls[message.urlIndex];
    if (!task || !item) {
      return {
        ok: false,
        error: 'invalid_url_index',
        checkpoint
      };
    }
    if (task.attempt !== message.attempt) {
      return {
        ok: false,
        error: 'stale_attempt',
        checkpoint
      };
    }
    const windowId = sender.tab.windowId;
    const existingReservation = openingReservations(checkpoint)[requestId];
    if (
      existingReservation &&
      (
        existingReservation.urlIndex !== message.urlIndex ||
        existingReservation.attempt !== message.attempt ||
        existingReservation.windowId !== windowId
      )
    ) {
      return {
        ok: false,
        error: 'invalid_worker_identity',
        checkpoint
      };
    }

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

    async function navigate(tabId, ownedCheckpoint) {
      try {
        const updated = await tabs.update(tabId, { url: item.url });
        if (
          Number.isInteger(updated?.id) &&
          (
            updated.id !== tabId ||
            (
              Number.isInteger(updated.windowId) &&
              updated.windowId !== windowId
            )
          )
        ) {
          throw new Error('tab_navigation_identity_mismatch');
        }
      } catch (_) {
        let observed;
        try {
          observed = await boundedTabGet(tabId);
        } catch (lookupError) {
          if (!isMissingTabError(lookupError)) {
            return {
              ok: false,
              error: 'tab_navigation_uncertain',
              recoveryRequired: true,
              checkpoint: ownedCheckpoint
            };
          }
        }
        if (
          observed &&
          (observed.pendingUrl || observed.url) === item.url
        ) {
          return {
            ok: true,
            checkpoint: ownedCheckpoint,
            tab: {
              id: tabId,
              windowId,
              url: item.url,
              active: false
            }
          };
        }
        const cleanup = await teardownPage({
          batchId: message.batchId,
          reason: 'worker_navigation_failed'
        }, [tabId]);
        return {
          ...cleanup,
          ok: false,
          error: 'tab_navigation_failed',
          recoveryRequired: true
        };
      }
      return {
        ok: true,
        checkpoint: ownedCheckpoint,
        tab: {
          id: tabId,
          windowId,
          url: item.url,
          active: false
        }
      };
    }

    if (task.state === 'active') {
      if (
        typeof task.requestId === 'string' &&
        task.requestId !== requestId
      ) {
        return {
          ok: false,
          error: 'invalid_transition',
          checkpoint
        };
      }
      if (task.requestId !== requestId) {
        checkpoint = structuredClone(checkpoint);
        checkpoint.tasks[String(message.urlIndex)].requestId = requestId;
        checkpoint.updatedAt = now();
        try {
          await writeCheckpoint(checkpoint);
        } catch (_) {
          return {
            ok: false,
            error: 'checkpoint_write_failed',
            checkpoint: loaded.checkpoint
          };
        }
        task = checkpoint.tasks[String(message.urlIndex)];
      }
      let existingTab;
      try {
        existingTab = await boundedTabGet(task.tabId);
      } catch (error) {
        if (!isMissingTabError(error)) {
          return {
            ok: false,
            error: 'tab_lookup_failed',
            recoveryRequired: true,
            checkpoint
          };
        }
        checkpoint = resetMissingActive(checkpoint, {
          requestId,
          urlIndex: message.urlIndex,
          attempt: message.attempt,
          windowId
        });
        try {
          await writeCheckpoint(checkpoint);
        } catch (_) {
          return {
            ok: false,
            error: 'checkpoint_write_failed',
            checkpoint: loaded.checkpoint
          };
        }
        task = checkpoint.tasks[String(message.urlIndex)];
      }
      if (existingTab) {
        if (existingTab.windowId !== windowId) {
          return {
            ok: false,
            error: 'invalid_worker_identity',
            checkpoint
          };
        }
        const currentUrl = existingTab.pendingUrl || existingTab.url;
        if (currentUrl !== item.url) {
          return navigate(existingTab.id, checkpoint);
        }
        return {
          ok: true,
          checkpoint,
          tab: {
            id: existingTab.id,
            windowId,
            url: item.url,
            active: false
          }
        };
      }
    }

    if (task.state !== 'queued') {
      return {
        ok: false,
        error: 'invalid_transition',
        checkpoint
      };
    }

    if (!openingReservations(checkpoint)[requestId]) {
      checkpoint = reserveOpening(checkpoint, {
        requestId,
        urlIndex: message.urlIndex,
        attempt: message.attempt,
        windowId
      });
      try {
        await writeCheckpoint(checkpoint);
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint: loaded.checkpoint
        };
      }
    }

    let createdTab;
    try {
      createdTab = await tabs.create({
        windowId,
        url: pendingWorkerUrl(requestId),
        active: false
      });
    } catch (_) {
      const cleared = clearOpening(checkpoint, requestId);
      try {
        await writeCheckpoint(cleared);
        checkpoint = cleared;
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint
        };
      }
      return {
        ok: false,
        error: 'tab_create_failed',
        checkpoint
      };
    }
    if (
      !Number.isInteger(createdTab?.id) ||
      createdTab.windowId !== windowId
    ) {
      if (Number.isInteger(createdTab?.id)) {
        await tabs.remove(createdTab.id).catch(() => {});
      }
      return {
        ok: false,
        error: 'tab_create_failed',
        checkpoint
      };
    }

    const transition = applyBatchRuntimeEvent(checkpoint, {
      type: 'task_activated',
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      requestId,
      tabId: createdTab.id,
      windowId,
      startedAt: now()
    }, now());
    if (!transition.ok) {
      await tabs.remove(createdTab.id).catch(() => {});
      return transition;
    }
    const ownedCheckpoint = clearOpening(
      transition.checkpoint,
      requestId
    );
    try {
      await writeCheckpoint(ownedCheckpoint);
    } catch (_) {
      let closeFailed = false;
      try {
        await tabs.remove(createdTab.id);
      } catch (error) {
        closeFailed = !isMissingTabError(error);
      }
      if (closeFailed) {
        const withTabOwnership = reserveOpening(checkpoint, {
          requestId,
          urlIndex: message.urlIndex,
          attempt: message.attempt,
          windowId,
          tabId: createdTab.id
        });
        const normalized = normalizeInterruptedBatch(
          withTabOwnership,
          now()
        );
        if (normalized.ok) {
          const recoveryCheckpoint = recoveryCleanup(
            normalized.checkpoint,
            {
              reason: 'worker_activation_persist_failed',
              orphanTabIds: [createdTab.id],
              diagnostic: 'tab_close_failed'
            }
          );
          try {
            await writeCheckpoint(recoveryCheckpoint);
            checkpoint = recoveryCheckpoint;
          } catch (_) {
            checkpoint = withTabOwnership;
          }
        }
      } else {
        const cleared = clearOpening(checkpoint, requestId);
        try {
          await writeCheckpoint(cleared);
          checkpoint = cleared;
        } catch (_) {
          // The durable opening reservation is harmless without a live tab.
        }
      }
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        checkpoint
      };
    }
    return navigate(createdTab.id, ownedCheckpoint);
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
          case 'BATCH_CREATE_WORKER_TAB':
            return await createWorkerTab(message, sender);
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
      if (BATCH_PAGE_MESSAGE_TYPES.has(message.type)) {
        if (!isBatchPageSender(sender, chromeApi.runtime)) {
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
