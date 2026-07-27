import {
  BATCH_RUNTIME_CHECKPOINT_KEY,
  applyBatchRuntimeEvent,
  createBatchRuntimeCheckpoint,
  migrateBatchRuntimeCheckpoint,
  normalizeInterruptedBatch,
  validateBatchRuntimeCheckpoint
} from './batch-runtime-checkpoint.mjs';
import {
  fingerprintBatchPlan,
  validatePlanConfirmation
} from './batch-plan-confirmation.mjs';
import { canonicalizeBatchTargetUrl } from './batch-plan-compiler.mjs';
import {
  normalizeBatchResultPreview
} from './batch-result-preview.mjs';
import {
  createWorkerTabRemovalResult
} from './batch-worker-tab-removal.mjs';

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
  'BATCH_TASK_MANUAL_UPDATE',
  'BATCH_TASK_PHASE',
  'BATCH_TASK_RETRY',
  'BATCH_TASK_SUBMITTING',
  'BATCH_TASK_TERMINAL',
  'BATCH_GET_TAB_MODE'
]);
const BATCH_PAGE_MESSAGE_TYPES = new Set([
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
  'BATCH_TASK_MANUAL_UPDATE',
  'BATCH_TASK_RETRY'
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
  sessionJournal,
  power,
  tabs,
  runtime,
  now = Date.now,
  generateOwnershipEpoch = () => crypto.randomUUID(),
  loadDomainConfig = async () => {
    throw codedError('domain_config_unavailable');
  },
  loadRecentSuccessUrls = async () => {
    throw codedError('recent_success_history_unavailable');
  },
  prepareStartStoragePatch = async () => ({}),
  cleanupPreparedStart = async () => {},
  tabCreateTimeoutMs = 5000,
  logger = console
}) {
  let operation = Promise.resolve();
  let keepAwake = false;
  const pendingCreateRequestIds = new Set();

  function enqueue(work) {
    const current = operation.then(work);
    operation = current.catch(() => {});
    return current;
  }

  async function settleWithin(promise, timeoutMs) {
    let timeoutId;
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ kind: 'fulfilled', value }),
          (error) => ({ kind: 'rejected', error })
        ),
        new Promise((resolve) => {
          timeoutId = setTimeout(
            () => resolve({ kind: 'timeout' }),
            Math.max(1, timeoutMs)
          );
          timeoutId?.unref?.();
        })
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
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

  async function writeCheckpoint(checkpoint, storagePatch = {}) {
    if (
      !storagePatch ||
      typeof storagePatch !== 'object' ||
      Array.isArray(storagePatch)
    ) {
      throw codedError('invalid_start_storage_patch');
    }
    await storageArea.set({
      ...storagePatch,
      [BATCH_RUNTIME_CHECKPOINT_KEY]: checkpoint
    });
    return checkpoint;
  }

  async function cleanupUnstartedPlan(message) {
    try {
      await cleanupPreparedStart({
        batchId: message.batchId,
        plan: message.plan
      });
      await storageArea.remove([BATCH_RUNTIME_CHECKPOINT_KEY]);
      return true;
    } catch (_) {
      return false;
    }
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

  function openingReservations(checkpoint) {
    const reservations = checkpoint?.openingReservations;
    return reservations &&
      typeof reservations === 'object' &&
      !Array.isArray(reservations)
      ? reservations
      : {};
  }

  function hasDurableOwnership(checkpoint) {
    return Boolean(checkpoint) && (
      Object.values(checkpoint.tasks || {}).some(
        (task) => ['active', 'submitting'].includes(task.state)
      ) ||
      Object.keys(openingReservations(checkpoint)).length > 0
    );
  }

  function pendingWorkerUrl(requestId) {
    return `${runtime.getURL('worker-pending.html')}#${encodeURIComponent(
      requestId
    )}`;
  }

  function reserveOpening(checkpoint, {
    requestId,
    urlIndex,
    attempt,
    windowId,
    ownerPageTabId,
    ownershipEpoch,
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
        ownerPageTabId,
        ownershipEpoch,
        tabId,
        cleanupOnly: false,
        createCompletionUnknown: false,
        updatedAt: now()
      }
    };
    next.updatedAt = now();
    return next;
  }

  function updateOpeningTabId(checkpoint, requestId, tabId) {
    const next = structuredClone(checkpoint);
    const reservation = openingReservations(next)[requestId];
    if (!reservation) return next;
    reservation.tabId = tabId;
    reservation.updatedAt = now();
    next.updatedAt = now();
    return next;
  }

  function markOpeningCreateUnknown(checkpoint, requestId) {
    const next = structuredClone(checkpoint);
    const reservation = openingReservations(next)[requestId];
    if (!reservation) return next;
    reservation.createCompletionUnknown = true;
    reservation.updatedAt = now();
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

  function resetMissingActive(checkpoint, {
    requestId,
    urlIndex,
    attempt,
    windowId,
    ownerPageTabId,
    ownershipEpoch
  }) {
    const next = structuredClone(checkpoint);
    Object.assign(next.tasks[String(urlIndex)], {
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      ownerPageTabId: null,
      ownershipEpoch: null,
      startedAt: null,
      updatedAt: now()
    });
    next.tasks[String(urlIndex)].requestId = null;
    return reserveOpening(next, {
      requestId,
      urlIndex,
      attempt,
      windowId,
      ownerPageTabId,
      ownershipEpoch
    });
  }

  function journalMatchesIdentity(journal, identity, tabId) {
    return journal?.requestId === identity.requestId &&
      journal.batchId === identity.batchId &&
      journal.urlIndex === identity.urlIndex &&
      journal.attempt === identity.attempt &&
      journal.tabId === tabId &&
      journal.windowId === identity.windowId &&
      journal.ownerPageTabId === identity.ownerPageTabId &&
      journal.ownershipEpoch === identity.ownershipEpoch;
  }

  function taskIdentity(checkpoint, task) {
    return {
      requestId: task.requestId,
      batchId: checkpoint.batchId,
      taskId: task.taskId,
      urlIndex: task.urlIndex,
      profileId: task.profileId,
      promotionSiteId: task.promotionSiteId,
      attempt: task.attempt,
      tabId: task.tabId,
      windowId: task.windowId,
      ownerPageTabId: task.ownerPageTabId,
      ownershipEpoch: task.ownershipEpoch
    };
  }

  function reservationIdentity(checkpoint, reservation) {
    return {
      requestId: reservation.requestId,
      batchId: checkpoint.batchId,
      urlIndex: reservation.urlIndex,
      attempt: reservation.attempt,
      tabId: reservation.tabId,
      windowId: reservation.windowId,
      ownerPageTabId: reservation.ownerPageTabId,
      ownershipEpoch: reservation.ownershipEpoch
    };
  }

  function pendingLookalikeRequestId(tab) {
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
      return decodeURIComponent(actual.hash.slice(1));
    } catch (_) {
      return null;
    }
  }

  function pausedOwnershipCheckpoint(checkpoint, reason, diagnostic) {
    const next = structuredClone(checkpoint);
    next.status = 'paused_recovery';
    next.recoveryCleanup = {
      reason,
      diagnostic,
      updatedAt: now()
    };
    next.updatedAt = now();
    return next;
  }

  function finalizedCheckpoint(checkpoint, reason) {
    const sourceStatus = checkpoint.status;
    const normalizable = structuredClone(checkpoint);
    if (normalizable.status !== 'running') {
      normalizable.status = 'running';
    }
    const normalized = normalizeInterruptedBatch(normalizable, now());
    if (!normalized.ok) return normalized;
    const next = structuredClone(normalized.checkpoint);
    next.openingReservations = {};
    if (['terminated', 'completed'].includes(sourceStatus)) {
      next.status = sourceStatus;
    }
    next.recoveryCleanup = {
      reason,
      diagnostic: null,
      updatedAt: now()
    };
    next.updatedAt = now();
    const validation = validateBatchRuntimeCheckpoint(next);
    return validation.ok
      ? { ok: true, checkpoint: next }
      : validation;
  }

  async function proveTaskOwnership(checkpoint, task) {
    const identity = taskIdentity(checkpoint, task);
    let liveTab;
    let missing = false;
    try {
      liveTab = await boundedTabGet(identity.tabId);
    } catch (error) {
      if (!isMissingTabError(error)) {
        return {
          ok: false,
          reason: 'ownership_unverified',
          diagnostic: 'tab_lookup_failed'
        };
      }
      missing = true;
    }
    if (missing) {
      return {
        ok: true,
        missing: true,
        identity,
        liveTab: null
      };
    }
    let journal;
    try {
      journal = await sessionJournal.read(identity.requestId);
    } catch (_) {
      return {
        ok: false,
        reason: 'ownership_unverified',
        diagnostic: 'session_journal_lookup_failed'
      };
    }
    if (
      !journalMatchesIdentity(journal, identity, identity.tabId) ||
      (
        !missing &&
        (
          liveTab.windowId !== identity.windowId ||
          liveTab.openerTabId !== identity.ownerPageTabId
        )
      )
    ) {
      return {
        ok: false,
        reason: 'ownership_unverified',
        diagnostic: 'ownership_proof_mismatch'
      };
    }
    return {
      ok: true,
      missing,
      identity,
      liveTab
    };
  }

  async function removeTaskWithProof(checkpoint, task) {
    const proof = await proveTaskOwnership(checkpoint, task);
    if (!proof.ok || proof.missing) {
      return proof.ok
        ? {
            ok: true,
            missing: true,
            requestId: proof.identity.requestId
          }
        : proof;
    }
    try {
      await tabs.remove(proof.identity.tabId);
      return {
        ok: true,
        missing: false,
        requestId: proof.identity.requestId
      };
    } catch (error) {
      return isMissingTabError(error)
        ? {
            ok: true,
            missing: true,
            requestId: proof.identity.requestId
          }
        : {
            ok: false,
            reason: 'tab_close_failed',
            diagnostic: 'tab_close_failed'
          };
    }
  }

  async function teardownPage(
    message,
    { browserStartup = false } = {}
  ) {
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
    const checkpoint = loaded.checkpoint;
    const activeTasks = Object.values(checkpoint.tasks).filter(
      (task) => ['active', 'submitting'].includes(task.state)
    );
    const reservations = Object.values(openingReservations(checkpoint));
    const journalRequestIds = new Set([
      ...activeTasks.map((task) => task.requestId),
      ...reservations.map((reservation) => reservation.requestId)
    ]);
    const failures = [];

    async function closeProvenTab(tabId) {
      try {
        await tabs.remove(tabId);
        return true;
      } catch (error) {
        if (isMissingTabError(error)) return true;
        failures.push({
          reason: 'tab_close_failed',
          diagnostic: 'tab_close_failed'
        });
        return false;
      }
    }

    for (const task of activeTasks) {
      const removal = await removeTaskWithProof(checkpoint, task);
      if (!removal.ok) failures.push(removal);
    }

    let openTabs = [];
    if (reservations.length > 0) {
      try {
        openTabs = await tabs.query({});
      } catch (_) {
        failures.push({
          reason: 'ownership_unverified',
          diagnostic: 'tab_lookup_failed'
        });
      }
    }
    if (
      reservations.length > 0 &&
      !failures.some(({ diagnostic }) => diagnostic === 'tab_lookup_failed')
    ) {
      for (const reservation of reservations) {
        const identity = reservationIdentity(checkpoint, reservation);
        const exactUrl = pendingWorkerUrl(identity.requestId);
        const exactTabs = openTabs.filter(
          (tab) => (tab?.pendingUrl || tab?.url) === exactUrl
        );
        const lookalikes = openTabs.filter(
          (tab) => pendingLookalikeRequestId(tab) === identity.requestId
        );
        if (exactTabs.length === 0) {
          if (lookalikes.length > 0) {
            failures.push({
              reason: 'ownership_unverified',
              diagnostic: 'pending_url_mismatch'
            });
          } else if (
            pendingCreateRequestIds.has(identity.requestId) ||
            (
              !browserStartup &&
              (
                reservation.cleanupOnly ||
                reservation.createCompletionUnknown
              )
            )
          ) {
            failures.push({
              reason: 'tab_close_failed',
              diagnostic: pendingCreateRequestIds.has(identity.requestId)
                ? 'late_create_still_pending'
                : 'late_create_completion_unknown'
            });
          }
          continue;
        }
        if (exactTabs.length !== 1) {
          failures.push({
            reason: 'ownership_unverified',
            diagnostic: 'pending_identity_ambiguous'
          });
          continue;
        }
        const liveTab = exactTabs[0];
        let journal;
        try {
          journal = await sessionJournal.read(identity.requestId);
        } catch (_) {
          failures.push({
            reason: 'ownership_unverified',
            diagnostic: 'session_journal_lookup_failed'
          });
          continue;
        }
        const journalTabMatches =
          journalMatchesIdentity(journal, identity, null) ||
          journalMatchesIdentity(journal, identity, liveTab.id);
        const durableTabMatches =
          identity.tabId === null || identity.tabId === liveTab.id;
        if (
          !journalTabMatches ||
          !durableTabMatches ||
          liveTab.windowId !== identity.windowId ||
          liveTab.openerTabId !== identity.ownerPageTabId
        ) {
          failures.push({
            reason: 'ownership_unverified',
            diagnostic: 'ownership_proof_mismatch'
          });
          continue;
        }
        await closeProvenTab(liveTab.id);
      }
    }

    if (failures.length > 0) {
      const unverified = failures.some(
        ({ reason: failureReason }) =>
          failureReason === 'ownership_unverified'
      );
      const recovery = pausedOwnershipCheckpoint(
        checkpoint,
        unverified ? 'ownership_unverified' : reason,
        failures[0].diagnostic
      );
      const validation = validateBatchRuntimeCheckpoint(recovery);
      if (!validation.ok) {
        return {
          ...validation,
          checkpoint,
          cleanupComplete: false,
          recoveryRequired: true
        };
      }
      try {
        await writeCheckpoint(recovery);
      } catch (_) {
        releaseWakefulness({ force: true });
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint,
          cleanupComplete: false,
          recoveryRequired: true
        };
      }
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: unverified
          ? 'batch_ownership_unverified'
          : 'batch_teardown_cleanup_failed',
        checkpoint: recovery,
        cleanupComplete: false,
        recoveryRequired: true
      };
    }

    const finalized = finalizedCheckpoint(checkpoint, reason);
    if (!finalized.ok) return finalized;
    try {
      await writeCheckpoint(finalized.checkpoint);
    } catch (_) {
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        checkpoint,
        cleanupComplete: false,
        recoveryRequired: true
      };
    }
    for (const requestId of journalRequestIds) {
      try {
        await sessionJournal.remove(requestId);
      } catch (_) {
        // A journal without matching durable ownership is non-authoritative.
      }
    }
    releaseWakefulness({ force: true });
    return {
      ok: true,
      checkpoint: finalized.checkpoint,
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
    const existing = await readCheckpoint();
    if (!existing.ok) return existing;
    if (hasDurableOwnership(existing.checkpoint)) {
      return {
        ok: false,
        error: 'batch_ownership_active',
        checkpoint: existing.checkpoint,
        recoveryRequired: true
      };
    }
    if (message.plan) {
      let currentConfig;
      try {
        currentConfig = await loadDomainConfig();
      } catch (_) {
        return { ok: false, error: 'domain_config_unavailable' };
      }
      if (
        !Number.isInteger(currentConfig?.revision)
        || currentConfig.revision !== message.plan.configRevision
      ) {
        return { ok: false, error: 'domain_config_changed' };
      }
      let recentSuccessUrls;
      try {
        recentSuccessUrls = await loadRecentSuccessUrls();
        if (!Array.isArray(recentSuccessUrls)) throw new Error();
      } catch (_) {
        return { ok: false, error: 'recent_success_history_unavailable' };
      }
      let recentSet;
      try {
        recentSet = new Set(
          recentSuccessUrls.map(canonicalizeBatchTargetUrl)
        );
      } catch (_) {
        return { ok: false, error: 'recent_success_history_unavailable' };
      }
      const newlyRecent = message.plan.tasks.some((task) => (
        task?.state === 'eligible'
        && task.recentSuccessOverride !== true
        && recentSet.has(task.canonicalTargetUrl)
      ));
      if (newlyRecent) {
        return { ok: false, error: 'recent_success_history_changed' };
      }
      let actualFingerprint;
      try {
        actualFingerprint = await fingerprintBatchPlan(message.plan);
      } catch (_) {
        return { ok: false, error: 'invalid_batch_plan' };
      }
      if (actualFingerprint !== message.plan.planFingerprint) {
        return { ok: false, error: 'plan_fingerprint_changed' };
      }
      const confirmation = validatePlanConfirmation(
        message.plan,
        message.confirmation,
        { now }
      );
      if (!confirmation.ok) return confirmation;
    }
    let checkpoint;
    try {
      checkpoint = createBatchRuntimeCheckpoint({
        batchId: message.batchId,
        plan: message.plan,
        confirmation: message.confirmation,
        source: message.source,
        settings: message.settings
      }, now());
    } catch (_) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
    const validation = validateBatchRuntimeCheckpoint(checkpoint);
    if (!validation.ok) return validation;
    let startStoragePatch = {};
    if (message.plan) {
      try {
        const eligibleProfileIds = [...new Set(message.plan.tasks
          .filter((task) => task.state === 'eligible')
          .map((task) => task.profileId))];
        startStoragePatch = await prepareStartStoragePatch({
          message: structuredClone(message),
          checkpoint: structuredClone(checkpoint),
          eligibleProfileIds
        });
        await writeCheckpoint(checkpoint, startStoragePatch);
      } catch (error) {
        return {
          ok: false,
          error: safeError(error, 'start_preparation_failed')
        };
      }
    } else {
      await writeCheckpoint(checkpoint);
    }

    try {
      requestWakefulness();
    } catch (_) {
      releaseWakefulness({ force: true });
      if (message.plan && !(await cleanupUnstartedPlan(message))) {
        return {
          ok: false,
          error: 'start_cleanup_failed',
          checkpoint,
          recoveryRequired: true
        };
      }
      return {
        ok: false,
        error: 'power_request_failed',
        ...(message.plan ? {} : { checkpoint })
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
      if (message.plan && !(await cleanupUnstartedPlan(message))) {
        throw codedError('start_cleanup_failed');
      }
      throw codedError('checkpoint_write_failed');
    }
    return {
      ok: true,
      checkpoint: transition.checkpoint
    };
  }

  async function getTabMode(sender) {
    if (!Number.isInteger(sender?.tab?.id)) {
      return { ok: false, error: 'forbidden_sender' };
    }
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    const batchOwned = Boolean(loaded.checkpoint) && Object.values(
      loaded.checkpoint.tasks || {}
    ).some((task) => (
      ['active', 'submitting'].includes(task?.state)
      && task.tabId === sender.tab.id
    ));
    return { ok: true, batchOwned };
  }

  async function normalizeStaleSession(
    checkpoint,
    { status, reason }
  ) {
    const activeTasks = Object.values(checkpoint.tasks || {}).filter(
      (task) => ['active', 'submitting'].includes(task.state)
    );
    const requestIds = activeTasks
      .map((task) => task.requestId)
      .filter((requestId) => typeof requestId === 'string');

    for (const task of activeTasks) {
      const removal = await removeTaskWithProof(checkpoint, task);
      if (!removal.ok) continue;
    }

    const normalizable = structuredClone(checkpoint);
    normalizable.status = 'running';
    const normalized = normalizeInterruptedBatch(normalizable, now());
    if (!normalized.ok) return normalized;
    const next = structuredClone(normalized.checkpoint);
    next.status = status;
    next.openingReservations = {};
    next.recoveryCleanup = {
      reason,
      diagnostic: null,
      updatedAt: now()
    };
    next.updatedAt = now();
    const validation = validateBatchRuntimeCheckpoint(next);
    if (!validation.ok) return validation;
    try {
      await writeCheckpoint(next);
    } catch (_) {
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        checkpoint
      };
    }
    for (const requestId of requestIds) {
      await sessionJournal.remove(requestId).catch(() => {});
    }
    return {
      ok: true,
      checkpoint: next,
      changed: true
    };
  }

  async function resume(message) {
    let loaded = await readCheckpoint();
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
    if (
      loaded.checkpoint.status === 'paused_recovery' &&
      hasDurableOwnership(loaded.checkpoint)
    ) {
      const recovered = await normalizeForRecovery();
      if (!recovered.ok) return recovered;
      if (!recovered.checkpoint) {
        return { ok: false, error: 'checkpoint_not_found' };
      }
      loaded = recovered;
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

  async function stopSession(message) {
    const loaded = await readCheckpoint();
    if (!loaded.ok || !loaded.checkpoint) {
      return loaded.ok
        ? { ok: false, error: 'checkpoint_not_found' }
        : loaded;
    }
    if (loaded.checkpoint.batchId !== message.batchId) {
      return {
        ok: false,
        error: 'stale_batch',
        checkpoint: loaded.checkpoint
      };
    }
    if (loaded.checkpoint.status === 'completed') {
      return {
        ok: false,
        error: 'invalid_transition',
        checkpoint: loaded.checkpoint
      };
    }
    if (loaded.checkpoint.status === 'terminated') {
      releaseWakefulness({ force: true });
      return {
        ok: true,
        checkpoint: loaded.checkpoint,
        changed: false
      };
    }
    const stopped = await normalizeStaleSession(loaded.checkpoint, {
      status: 'terminated',
      reason: 'session_terminated'
    });
    releaseWakefulness({ force: true });
    return stopped;
  }

  async function finishSession(message, eventType) {
    const response = await mutate(message, { type: eventType });
    if (response.ok) releaseWakefulness({ force: true });
    return response;
  }

  async function clear() {
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (hasDurableOwnership(loaded.checkpoint)) {
      return {
        ok: false,
        error: 'batch_ownership_active',
        checkpoint: loaded.checkpoint,
        recoveryRequired: true
      };
    }
    await storageArea.remove([BATCH_RUNTIME_CHECKPOINT_KEY]);
    releaseWakefulness({ force: true });
    return { ok: true, checkpoint: null };
  }

  async function normalizeForRecovery({ browserStartup = false } = {}) {
    const loaded = await readCheckpoint();
    if (!loaded.ok || !loaded.checkpoint) return loaded;
    const pendingTasks = Object.values(loaded.checkpoint.tasks).some(
      (task) => ['active', 'submitting'].includes(task.state)
    );
    const pendingOpenings = Object.keys(
      openingReservations(loaded.checkpoint)
    );
    if (
      loaded.checkpoint.status !== 'running' &&
      !pendingTasks &&
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
    }, { browserStartup });
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
      const recovery = await normalizeForRecovery({
        browserStartup: true
      });
      try {
        await ensureRecoveryPage(recovery.checkpoint);
      } catch (_) {
        // Recovery visibility is best effort and never replaces ownership.
      }
      return recovery;
    });
  }

  async function validateProofBoundTask(
    message,
    sender,
    { senderRole = 'content', targetTabId } = {}
  ) {
    if (!Number.isInteger(message?.attempt) || message.attempt < 1) {
      return { ok: false, error: 'stale_attempt' };
    }
    if (!Number.isInteger(message?.urlIndex) || message.urlIndex < 0) {
      return { ok: false, error: 'invalid_url_index' };
    }
    const loaded = await readCheckpoint();
    if (!loaded.ok) return loaded;
    if (!loaded.checkpoint) {
      return { ok: false, error: 'checkpoint_not_found' };
    }
    const checkpoint = loaded.checkpoint;
    if (checkpoint.batchId !== message.batchId) {
      return { ok: false, error: 'stale_batch', checkpoint };
    }
    const task = checkpoint.tasks[String(message.urlIndex)];
    if (!task) {
      return { ok: false, error: 'invalid_url_index', checkpoint };
    }
    if (task.attempt !== message.attempt) {
      return { ok: false, error: 'stale_attempt', checkpoint };
    }
    const assignmentFields = [
      'taskId',
      'profileId',
      'promotionSiteId'
    ];
    const suppliedAssignmentFields = assignmentFields.filter(
      (field) => Object.hasOwn(message, field)
    );
    const expectedAssignment = suppliedAssignmentFields.length === 0
      ? {
          taskId: `${checkpoint.batchId}:legacy:${task.urlIndex}`,
          profileId: 'default-profile',
          promotionSiteId: 'default-promotion-site'
        }
      : message;
    if (
      suppliedAssignmentFields.length !== 0 &&
      suppliedAssignmentFields.length !== assignmentFields.length
    ) {
      return { ok: false, error: 'invalid_task_identity', checkpoint };
    }
    if (assignmentFields.some(
      (field) => expectedAssignment[field] !== task[field]
    )) {
      return { ok: false, error: 'stale_task_assignment', checkpoint };
    }
    if (task.state === 'terminal') {
      return { ok: false, error: 'task_already_terminal', checkpoint };
    }
    if (!['active', 'submitting'].includes(task.state)) {
      return { ok: false, error: 'invalid_transition', checkpoint };
    }
    const contentOwnsTask =
      sender?.id === runtime.id &&
      sender?.tab?.id === task.tabId;
    const pageOwnsTask =
      isBatchPageSender(sender, runtime) &&
      sender.tab.id === task.ownerPageTabId;
    if (senderRole === 'owner_page' && !pageOwnsTask) {
      return { ok: false, error: 'stale_worker_tab', checkpoint };
    }
    if (
      senderRole === 'owner_page' &&
      targetTabId !== task.tabId
    ) {
      return {
        ok: false,
        error: 'invalid_recovery_target',
        checkpoint
      };
    }
    if (senderRole === 'content' && !contentOwnsTask) {
      return { ok: false, error: 'stale_worker_tab', checkpoint };
    }
    if (!['content', 'owner_page'].includes(senderRole)) {
      return { ok: false, error: 'invalid_sender_role', checkpoint };
    }
    const proof = await proveTaskOwnership(checkpoint, task);
    if (!proof.ok || proof.missing) {
      return {
        ok: false,
        error: 'batch_ownership_unverified',
        checkpoint,
        task,
        proofFailure: proof.ok
          ? {
              ok: false,
              reason: 'ownership_unverified',
              diagnostic: 'tab_missing'
            }
          : proof,
        recoveryRequired: true
      };
    }
    return {
      ok: true,
      checkpoint,
      task,
      proof
    };
  }

  async function proofBoundTaskHook(
    message,
    sender,
    sideEffectHook,
    options
  ) {
    if (typeof sideEffectHook !== 'function') {
      return { ok: false, error: 'invalid_side_effect_hook' };
    }
    const validation = await validateProofBoundTask(
      message,
      sender,
      options
    );
    if (!validation.ok) return validation;
    const { checkpoint, task } = validation;
    try {
      const sideEffect = await sideEffectHook({
        checkpoint: structuredClone(checkpoint),
        task: structuredClone(task)
      });
      return {
        ok: true,
        checkpoint,
        changed: false,
        ...(sideEffect === undefined ? {} : { sideEffect })
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error, 'proof_side_effect_failed'),
        checkpoint,
        recoveryRequired: true
      };
    }
  }

  function runProofBoundTaskHook(
    message,
    sender,
    sideEffectHook
  ) {
    return enqueue(() => proofBoundTaskHook(
      message,
      sender,
      sideEffectHook
    ));
  }

  async function runOwnerPageRecoveryHook(
    message,
    sender,
    targetTabId,
    sideEffectHook
  ) {
    if (typeof sideEffectHook !== 'function') {
      return { ok: false, error: 'invalid_side_effect_hook' };
    }
    const validation = await enqueue(() => validateProofBoundTask(
      message,
      sender,
      {
        senderRole: 'owner_page',
        targetTabId
      }
    ));
    if (!validation.ok) return validation;
    const { checkpoint, task } = validation;
    try {
      const sideEffect = await sideEffectHook({
        checkpoint: structuredClone(checkpoint),
        task: structuredClone(task)
      });
      return {
        ok: true,
        checkpoint,
        changed: false,
        ...(sideEffect === undefined ? {} : { sideEffect })
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error, 'proof_side_effect_failed'),
        checkpoint,
        recoveryRequired: true
      };
    }
  }

  async function terminalTask(message, sender, result, sideEffectHook) {
    if (!Number.isInteger(message?.attempt) || message.attempt < 1) {
      return { ok: false, error: 'stale_attempt' };
    }
    if (!Number.isInteger(message?.urlIndex) || message.urlIndex < 0) {
      return { ok: false, error: 'invalid_url_index' };
    }
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      return { ok: false, error: 'invalid_result' };
    }
    if (
      ['aiContent', 'errorCode', 'errorMessage'].some(
        (field) =>
          result[field] != null &&
          typeof result[field] !== 'string'
      )
    ) {
      return { ok: false, error: 'invalid_result' };
    }
    let normalizedResult;
    try {
      normalizedResult = {
        result: result.result,
        aiContent: result.aiContent || null,
        errorCode: result.errorCode || null,
        errorMessage: result.errorMessage || null,
        resultPreview: normalizeBatchResultPreview(result.resultPreview)
      };
    } catch (_) {
      return { ok: false, error: 'invalid_result' };
    }
    let checkpoint;
    let task;
    let openingRequestId = null;
    let ownershipProofSucceeded = false;
    async function retainTerminalCleanupFailure(failure) {
      const recovery = pausedOwnershipCheckpoint(
        checkpoint,
        failure.reason === 'ownership_unverified'
          ? 'ownership_unverified'
          : 'terminal_cleanup_failed',
        failure.diagnostic
      );
      try {
        await writeCheckpoint(recovery);
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint,
          recoveryRequired: true
        };
      }
      return {
        ok: false,
        error: failure.reason === 'ownership_unverified'
          ? 'batch_ownership_unverified'
          : 'batch_teardown_cleanup_failed',
        checkpoint: recovery,
        recoveryRequired: true
      };
    }

    if (typeof sideEffectHook === 'function') {
      const validation = await validateProofBoundTask(message, sender);
      if (!validation.ok) {
        if (
          validation.error === 'batch_ownership_unverified' &&
          validation.checkpoint &&
          validation.proofFailure
        ) {
          checkpoint = validation.checkpoint;
          task = validation.task;
          return retainTerminalCleanupFailure(validation.proofFailure);
        }
        return validation;
      }
      checkpoint = validation.checkpoint;
      task = validation.task;
      ownershipProofSucceeded = true;
    } else {
      const loaded = await readCheckpoint();
      if (!loaded.ok) return loaded;
      if (!loaded.checkpoint) {
        return { ok: false, error: 'checkpoint_not_found' };
      }
      checkpoint = loaded.checkpoint;
      if (checkpoint.batchId !== message.batchId) {
        return { ok: false, error: 'stale_batch', checkpoint };
      }
      task = checkpoint.tasks[message.urlIndex];
      if (!task) {
        return { ok: false, error: 'invalid_url_index', checkpoint };
      }
      if (task.attempt !== message.attempt) {
        return { ok: false, error: 'stale_attempt', checkpoint };
      }
    }

    const ownsTab = ['active', 'submitting'].includes(task.state);
    if (ownsTab && !ownershipProofSucceeded) {
      const internal = sender == null;
      const contentOwnsTask =
        sender?.id === runtime.id &&
        sender?.tab?.id === task.tabId;
      const pageOwnsTask =
        isBatchPageSender(sender, runtime) &&
        sender.tab.id === task.ownerPageTabId;
      const hookRequiresContent =
        typeof sideEffectHook === 'function' &&
        !contentOwnsTask;
      if (
        hookRequiresContent ||
        (
          typeof sideEffectHook !== 'function' &&
          !internal &&
          !contentOwnsTask &&
          !pageOwnsTask
        )
      ) {
        return {
          ok: false,
          error: 'stale_worker_tab',
          checkpoint
        };
      }
      const proof = await proveTaskOwnership(checkpoint, task);
      if (!proof.ok || proof.missing) {
        const failure = proof.ok
          ? {
              ok: false,
              reason: 'ownership_unverified',
              diagnostic: 'tab_missing'
            }
          : proof;
        return retainTerminalCleanupFailure(failure);
      }
      ownershipProofSucceeded = true;
    } else if (
      task.state === 'queued' &&
      sender != null &&
      !(
        isBatchPageSender(sender, runtime) &&
        sender.tab.id > 0
      )
    ) {
      return { ok: false, error: 'forbidden_sender', checkpoint };
    }
    if (task.state === 'queued') {
      const requestId = `${checkpoint.batchId}:${task.urlIndex}:${task.attempt}`;
      const reservation = openingReservations(checkpoint)[requestId];
      if (reservation) {
        if (
          !isBatchPageSender(sender, runtime) ||
          sender.tab.id !== reservation.ownerPageTabId ||
          reservation.urlIndex !== task.urlIndex ||
          reservation.attempt !== task.attempt
        ) {
          return {
            ok: false,
            error: 'batch_ownership_unverified',
            checkpoint,
            recoveryRequired: true
          };
        }
        openingRequestId = requestId;
      }
    }
    const candidate = applyBatchRuntimeEvent(checkpoint, {
      type: 'task_terminal',
      batchId: checkpoint.batchId,
      taskId: message.taskId,
      urlIndex: task.urlIndex,
      profileId: message.profileId,
      promotionSiteId: message.promotionSiteId,
      attempt: task.attempt,
      ...(openingRequestId ? { retainOpeningRequestId: openingRequestId } : {}),
      terminalCleanupRetry:
        ownershipProofSucceeded &&
        checkpoint.status === 'paused_recovery' &&
        [
          'terminal_cleanup_failed',
          'ownership_unverified'
        ].includes(checkpoint.recoveryCleanup?.reason),
      result: normalizedResult
    }, now());
    if (!candidate.ok) return candidate;
    if (
      candidate.checkpoint.tasks[String(task.urlIndex)]?.state !==
        'terminal' ||
      !validateBatchRuntimeCheckpoint(candidate.checkpoint).ok
    ) {
      return {
        ok: false,
        error: 'invalid_checkpoint',
        checkpoint
      };
    }
    if (checkpoint.status === 'running') {
      try {
        requestWakefulness();
      } catch (_) {
        return {
          ok: false,
          error: 'power_request_failed',
          checkpoint
        };
      }
    }
    let sideEffect;
    if (typeof sideEffectHook === 'function') {
      try {
        sideEffect = await sideEffectHook({
          checkpoint: structuredClone(checkpoint),
          task: structuredClone(task)
        });
      } catch (error) {
        return {
          ok: false,
          error: safeError(error, 'terminal_side_effect_failed'),
          checkpoint,
          recoveryRequired: ownsTab
        };
      }
    }
    if (ownsTab) {
      const removal = await removeTaskWithProof(checkpoint, task);
      if (!removal.ok) {
        return retainTerminalCleanupFailure(removal);
      }
    }
    if (candidate.changed) {
      try {
        await writeCheckpoint(candidate.checkpoint);
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint,
          recoveryRequired: ownsTab
        };
      }
    }
    if (ownsTab) {
      try {
        await sessionJournal.remove(task.requestId);
      } catch (_) {
        // Durable ownership is already cleared; the journal cannot act alone.
      }
    }
    return {
      ok: true,
      checkpoint: candidate.checkpoint,
      changed: candidate.changed,
      ...(sideEffect === undefined ? {} : { sideEffect })
    };
  }

  function markTerminal(message, sender, sideEffectHook) {
    return enqueue(() => terminalTask(message, sender, {
      result: message.result ?? 'success',
      aiContent: message.aiContent ?? null,
      errorCode: message.errorCode ?? null,
      errorMessage: message.errorMessage ?? null,
      resultPreview: message.resultPreview ?? message.history
    }, sideEffectHook));
  }

  function handleWorkerTabRemoved(tabId) {
    return enqueue(async () => {
      const loaded = await readCheckpoint();
      if (!loaded.ok) return loaded;
      const checkpoint = loaded.checkpoint;
      if (!checkpoint) {
        return {
          ok: true,
          changed: false,
          checkpoint: null
        };
      }
      const tasks = Object.values(checkpoint.tasks || {}).filter(
        (task) => (
          ['active', 'submitting'].includes(task?.state) &&
          task.tabId === tabId
        )
      );
      if (tasks.length !== 1) {
        return {
          ok: true,
          changed: false,
          checkpoint
        };
      }
      const recoveryRace =
        checkpoint.status === 'paused_recovery' &&
        checkpoint.recoveryCleanup?.reason === 'ownership_unverified' &&
        checkpoint.recoveryCleanup?.diagnostic === 'tab_missing';
      if (checkpoint.status !== 'running' && !recoveryRace) {
        return {
          ok: true,
          changed: false,
          checkpoint
        };
      }
      const task = tasks[0];
      const removal = {
        batchId: checkpoint.batchId,
        urlIndex: task.urlIndex,
        attempt: task.attempt,
        tabId
      };
      const candidate = applyBatchRuntimeEvent(checkpoint, {
        type: 'task_terminal',
        batchId: checkpoint.batchId,
        taskId: task.taskId,
        urlIndex: task.urlIndex,
        profileId: task.profileId,
        promotionSiteId: task.promotionSiteId,
        attempt: task.attempt,
        terminalCleanupRetry: recoveryRace,
        result: createWorkerTabRemovalResult(task)
      }, now());
      if (!candidate.ok) return candidate;
      if (recoveryRace) {
        candidate.checkpoint.status = 'running';
        delete candidate.checkpoint.recoveryCleanup;
      }
      if (
        candidate.checkpoint.tasks[String(task.urlIndex)]?.state !==
          'terminal' ||
        !validateBatchRuntimeCheckpoint(candidate.checkpoint).ok
      ) {
        return {
          ok: false,
          error: 'invalid_checkpoint',
          checkpoint
        };
      }
      try {
        await writeCheckpoint(candidate.checkpoint);
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          checkpoint
        };
      }
      try {
        requestWakefulness();
      } catch (_) {
        // Removed ownership is already durable; wakefulness is best-effort.
      }
      try {
        await sessionJournal.remove(task.requestId);
      } catch (_) {
        // Durable ownership is already cleared; the journal cannot act alone.
      }
      return {
        ok: true,
        changed: candidate.changed,
        checkpoint: candidate.checkpoint,
        removal
      };
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
      taskId: message.taskId,
      urlIndex: message.urlIndex,
      profileId: message.profileId,
      promotionSiteId: message.promotionSiteId,
      attempt: message.attempt,
      phase: message.phase
    }, { ensureWakefulness: true });
  }

  async function updateTaskSubmitting(message, sender) {
    if (sender != null) {
      const sourceTabId = sender?.tab?.id;
      if (!Number.isInteger(sourceTabId)) {
        return { ok: false, error: 'forbidden_sender' };
      }
      const loaded = await readCheckpoint();
      if (!loaded.ok) return loaded;
      const task =
        loaded.checkpoint?.tasks?.[String(message.urlIndex)];
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
    }
    return mutate(message, {
      type: 'task_submitting',
      taskId: message.taskId,
      urlIndex: message.urlIndex,
      profileId: message.profileId,
      promotionSiteId: message.promotionSiteId,
      attempt: message.attempt
    }, { ensureWakefulness: true });
  }

  async function activateTask(message) {
    const response = await mutate(message, {
      type: 'task_activated',
      taskId: message.taskId,
      urlIndex: message.urlIndex,
      profileId: message.profileId,
      promotionSiteId: message.promotionSiteId,
      attempt: message.attempt,
      tabId: message.tabId,
      windowId: message.windowId,
      ownerPageTabId: message.ownerPageTabId,
      ownershipEpoch: message.ownershipEpoch,
      startedAt: Number.isFinite(message.startedAt) &&
        message.startedAt > 0
        ? message.startedAt
        : now()
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
      message
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
    const canonicalRequestId =
      `${message.batchId}:${message.urlIndex}:${message.attempt}`;
    if (requestId !== canonicalRequestId) {
      return {
        ok: false,
        error: 'invalid_worker_identity',
        checkpoint
      };
    }
    let task = checkpoint.tasks[String(message.urlIndex)];
    let explicitlyMissingTabId = null;
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
    const ownerPageTabId = sender.tab.id;
    const existingReservation = openingReservations(checkpoint)[requestId];
    if (
      existingReservation &&
      (
        existingReservation.urlIndex !== message.urlIndex ||
        existingReservation.attempt !== message.attempt ||
        existingReservation.windowId !== windowId ||
        existingReservation.ownerPageTabId !== ownerPageTabId
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
        });
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
      if (
        task.ownerPageTabId !== ownerPageTabId ||
        typeof task.ownershipEpoch !== 'string' ||
        task.ownershipEpoch.length === 0
      ) {
        return {
          ok: false,
          error: 'batch_ownership_unverified',
          recoveryRequired: true,
          checkpoint
        };
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
        explicitlyMissingTabId = task.tabId;
        checkpoint = resetMissingActive(checkpoint, {
          requestId,
          urlIndex: message.urlIndex,
          attempt: message.attempt,
          windowId,
          ownerPageTabId: task.ownerPageTabId,
          ownershipEpoch: task.ownershipEpoch
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
        let journal;
        try {
          journal = await sessionJournal.read(requestId);
        } catch (_) {
          return {
            ok: false,
            error: 'batch_ownership_unverified',
            recoveryRequired: true,
            checkpoint
          };
        }
        if (
          !journalMatchesIdentity(
            journal,
            taskIdentity(checkpoint, task),
            task.tabId
          ) ||
          existingTab.windowId !== windowId ||
          existingTab.openerTabId !== ownerPageTabId
        ) {
          return {
            ok: false,
            error: 'batch_ownership_unverified',
            recoveryRequired: true,
            checkpoint
          };
        }
        const currentUrl = existingTab.pendingUrl || existingTab.url;
        if (currentUrl === pendingWorkerUrl(requestId)) {
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

    let createdReservation = false;
    if (!openingReservations(checkpoint)[requestId]) {
      let ownershipEpoch;
      try {
        ownershipEpoch = generateOwnershipEpoch();
      } catch (_) {
        return {
          ok: false,
          error: 'ownership_epoch_failed',
          checkpoint
        };
      }
      if (
        typeof ownershipEpoch !== 'string' ||
        ownershipEpoch.length === 0
      ) {
        return {
          ok: false,
          error: 'ownership_epoch_failed',
          checkpoint
        };
      }
      checkpoint = reserveOpening(checkpoint, {
        requestId,
        urlIndex: message.urlIndex,
        attempt: message.attempt,
        windowId,
        ownerPageTabId,
        ownershipEpoch
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
      createdReservation = true;
    }
    let reservation = openingReservations(checkpoint)[requestId];
    if (
      !reservation ||
      reservation.ownerPageTabId !== ownerPageTabId ||
      typeof reservation.ownershipEpoch !== 'string' ||
      reservation.ownershipEpoch.length === 0
    ) {
      return {
        ok: false,
        error: 'ownership_unverified',
        recoveryRequired: true,
        checkpoint
      };
    }
    const journalRecord = {
      requestId,
      batchId: checkpoint.batchId,
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      tabId: null,
      windowId,
      ownerPageTabId,
      ownershipEpoch: reservation.ownershipEpoch,
      createdAt: reservation.updatedAt
    };

    async function cleanupLateCreation(lateTab) {
      return enqueue(async () => {
        const loaded = await readCheckpoint();
        if (
          !loaded.ok ||
          loaded.checkpoint?.batchId !== message.batchId
        ) {
          logger.warn?.(
            '[batch-runtime] Retained an unowned late-created pending tab'
          );
          return false;
        }
        let durableCheckpoint = loaded.checkpoint;
        let durableReservation =
          openingReservations(durableCheckpoint)[requestId];
        if (
          !durableReservation ||
          durableReservation.urlIndex !== message.urlIndex ||
          durableReservation.attempt !== message.attempt ||
          durableReservation.windowId !== windowId ||
          durableReservation.ownerPageTabId !== ownerPageTabId ||
          durableReservation.ownershipEpoch !== reservation.ownershipEpoch ||
          !Number.isInteger(lateTab?.id)
        ) {
          logger.warn?.(
            '[batch-runtime] Refused to close an unverified late tab'
          );
          return false;
        }

        try {
          await sessionJournal.write({
            ...journalRecord,
            tabId: lateTab.id
          });
          durableCheckpoint = updateOpeningTabId(
            durableCheckpoint,
            requestId,
            lateTab.id
          );
          await writeCheckpoint(durableCheckpoint);
        } catch (_) {
          logger.warn?.(
            '[batch-runtime] Failed to persist late-tab cleanup ownership'
          );
          return false;
        }

        durableReservation =
          openingReservations(durableCheckpoint)[requestId];
        let liveTab;
        try {
          liveTab = await boundedTabGet(lateTab.id);
        } catch (error) {
          if (!isMissingTabError(error)) {
            const recovery = pausedOwnershipCheckpoint(
              durableCheckpoint,
              'ownership_unverified',
              'late_created_tab_lookup_failed'
            );
            await writeCheckpoint(recovery).catch(() => {});
            return false;
          }
        }
        if (!liveTab) {
          const cleaned = clearOpening(durableCheckpoint, requestId);
          try {
            await writeCheckpoint(cleaned);
            await sessionJournal.remove(requestId).catch(() => {});
            return true;
          } catch (_) {
            return false;
          }
        }

        let durableJournal;
        try {
          durableJournal = await sessionJournal.read(requestId);
        } catch (_) {
          durableJournal = null;
        }
        const identity = reservationIdentity(
          durableCheckpoint,
          durableReservation
        );
        if (
          !journalMatchesIdentity(
            durableJournal,
            identity,
            liveTab.id
          ) ||
          liveTab.windowId !== windowId ||
          liveTab.openerTabId !== ownerPageTabId ||
          (liveTab.pendingUrl || liveTab.url) !==
            pendingWorkerUrl(requestId)
        ) {
          const recovery = pausedOwnershipCheckpoint(
            durableCheckpoint,
            'ownership_unverified',
            'late_created_tab_proof_mismatch'
          );
          await writeCheckpoint(recovery).catch(() => {});
          return false;
        }

        try {
          await tabs.remove(liveTab.id);
        } catch (error) {
          if (!isMissingTabError(error)) {
            const recovery = pausedOwnershipCheckpoint(
              durableCheckpoint,
              'terminal_cleanup_failed',
              'late_created_tab_cleanup_failed'
            );
            await writeCheckpoint(recovery).catch(() => {});
            return false;
          }
        }
        const cleaned = clearOpening(durableCheckpoint, requestId);
        try {
          await writeCheckpoint(cleaned);
          await sessionJournal.remove(requestId).catch(() => {});
          return true;
        } catch (_) {
          return false;
        }
      });
    }

    async function cleanupRejectedCreation() {
      return enqueue(async () => {
        const loaded = await readCheckpoint();
        if (
          !loaded.ok ||
          loaded.checkpoint?.batchId !== message.batchId
        ) {
          return false;
        }
        const durableReservation =
          openingReservations(loaded.checkpoint)[requestId];
        if (!durableReservation) return true;
        if (
          durableReservation.urlIndex !== message.urlIndex ||
          durableReservation.attempt !== message.attempt ||
          durableReservation.ownershipEpoch !== reservation.ownershipEpoch
        ) {
          return false;
        }
        const cleaned = clearOpening(loaded.checkpoint, requestId);
        try {
          await writeCheckpoint(cleaned);
          await sessionJournal.remove(requestId).catch(() => {});
          return true;
        } catch (_) {
          return false;
        }
      });
    }

    let createdTab;
    let createdFreshTab = false;
    let journal = null;
    if (createdReservation) {
      try {
        await sessionJournal.write(journalRecord);
        journal = journalRecord;
      } catch (_) {
        return {
          ok: false,
          error: 'session_journal_write_failed',
          recoveryRequired: true,
          checkpoint
        };
      }
    } else {
      try {
        journal = await sessionJournal.read(requestId);
      } catch (_) {
        return {
          ok: false,
          error: 'batch_ownership_unverified',
          recoveryRequired: true,
          checkpoint
        };
      }
      const identity = reservationIdentity(checkpoint, reservation);
      if (
        !journal ||
        !journalMatchesIdentity(journal, identity, journal.tabId)
      ) {
        return {
          ok: false,
          error: 'batch_ownership_unverified',
          recoveryRequired: true,
          checkpoint
        };
      }
      if (Number.isInteger(journal.tabId)) {
        if (journal.tabId !== explicitlyMissingTabId) {
          try {
            createdTab = await boundedTabGet(journal.tabId);
          } catch (error) {
            if (!isMissingTabError(error)) {
              return {
                ok: false,
                error: 'batch_ownership_unverified',
                recoveryRequired: true,
                checkpoint
              };
            }
          }
        }
        if (!createdTab) {
          journal = journalRecord;
          try {
            await sessionJournal.write(journal);
          } catch (_) {
            return {
              ok: false,
              error: 'session_journal_write_failed',
              recoveryRequired: true,
              checkpoint
            };
          }
        }
      } else {
        let openTabs;
        try {
          openTabs = await tabs.query({});
        } catch (_) {
          return {
            ok: false,
            error: 'batch_ownership_unverified',
            recoveryRequired: true,
            checkpoint
          };
        }
        const exactPendingTabs = openTabs.filter(
          (tab) => (tab?.pendingUrl || tab?.url) ===
            pendingWorkerUrl(requestId)
        );
        if (exactPendingTabs.length > 1) {
          return {
            ok: false,
            error: 'batch_ownership_unverified',
            recoveryRequired: true,
            checkpoint
          };
        }
        if (exactPendingTabs.length === 1) {
          [createdTab] = exactPendingTabs;
        }
      }
    }

    if (createdTab && (
      createdTab.windowId !== windowId ||
      createdTab.openerTabId !== ownerPageTabId ||
      (createdTab.pendingUrl || createdTab.url) !==
        pendingWorkerUrl(requestId)
    )) {
      return {
        ok: false,
        error: 'batch_ownership_unverified',
        recoveryRequired: true,
        checkpoint
      };
    }
    if (
      !createdTab &&
      !createdReservation &&
      explicitlyMissingTabId === null &&
      reservation.createCompletionUnknown
    ) {
      return {
        ok: false,
        error: 'tab_create_timeout',
        recoveryRequired: true,
        checkpoint
      };
    }
    if (!createdTab) {
      if (!reservation.createCompletionUnknown) {
        const unknownCheckpoint = markOpeningCreateUnknown(
          checkpoint,
          requestId
        );
        try {
          await writeCheckpoint(unknownCheckpoint);
        } catch (_) {
          return {
            ok: false,
            error: 'checkpoint_write_failed',
            recoveryRequired: true,
            checkpoint
          };
        }
        checkpoint = unknownCheckpoint;
        reservation = openingReservations(checkpoint)[requestId];
      }
      pendingCreateRequestIds.add(requestId);
      const creation = Promise.resolve().then(() => tabs.create({
        windowId,
        openerTabId: ownerPageTabId,
        url: pendingWorkerUrl(requestId),
        active: false
      }));
      const outcome = await settleWithin(creation, tabCreateTimeoutMs);
      if (outcome.kind === 'timeout') {
        void creation
          .then(
            (lateTab) => cleanupLateCreation(lateTab),
            () => cleanupRejectedCreation()
          )
          .catch(() => {
            logger.warn?.(
              '[batch-runtime] Late-tab cleanup could not be completed'
            );
          })
          .finally(() => {
            pendingCreateRequestIds.delete(requestId);
          });
        return {
          ok: false,
          error: 'tab_create_timeout',
          checkpoint
        };
      }
      if (outcome.kind === 'rejected') {
        pendingCreateRequestIds.delete(requestId);
        const cleaned = clearOpening(checkpoint, requestId);
        try {
          await writeCheckpoint(cleaned);
          await sessionJournal.remove(requestId).catch(() => {});
        } catch (_) {
          return {
            ok: false,
            error: 'checkpoint_write_failed',
            recoveryRequired: true,
            checkpoint
          };
        }
        return {
          ok: false,
          error: 'tab_create_failed',
          checkpoint: cleaned
        };
      }
      pendingCreateRequestIds.delete(requestId);
      try {
        createdTab = outcome.value;
        createdFreshTab = true;
      } catch (_) {
        return {
          ok: false,
          error: 'tab_create_failed',
          recoveryRequired: true,
          checkpoint
        };
      }
    }
    async function retainUnverifiedCreatedTab(diagnostic) {
      const recovery = pausedOwnershipCheckpoint(
        checkpoint,
        'ownership_unverified',
        diagnostic
      );
      try {
        await writeCheckpoint(recovery);
      } catch (_) {
        return {
          ok: false,
          error: 'checkpoint_write_failed',
          recoveryRequired: true,
          checkpoint
        };
      }
      releaseWakefulness({ force: true });
      return {
        ok: false,
        error: 'batch_ownership_unverified',
        recoveryRequired: true,
        checkpoint: recovery
      };
    }
    if (
      createdFreshTab &&
      (!Number.isInteger(createdTab?.id) || createdTab.id <= 0)
    ) {
      return retainUnverifiedCreatedTab(
        'created_tab_identity_invalid'
      );
    }
    if (createdFreshTab) {
      let liveCreatedTab;
      try {
        liveCreatedTab = await boundedTabGet(createdTab.id);
      } catch (_) {
        return retainUnverifiedCreatedTab(
          'created_tab_lookup_failed'
        );
      }
      if (
        createdTab.windowId !== windowId ||
        createdTab.openerTabId !== ownerPageTabId ||
        (createdTab.pendingUrl || createdTab.url) !==
          pendingWorkerUrl(requestId) ||
        liveCreatedTab?.id !== createdTab.id ||
        liveCreatedTab.windowId !== windowId ||
        liveCreatedTab.openerTabId !== ownerPageTabId ||
        (liveCreatedTab.pendingUrl || liveCreatedTab.url) !==
          pendingWorkerUrl(requestId)
      ) {
        return retainUnverifiedCreatedTab(
          'created_tab_proof_mismatch'
        );
      }
      createdTab = liveCreatedTab;
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
        recoveryRequired: true,
        checkpoint
      };
    }
    if (journal?.tabId !== createdTab.id) {
      try {
        await sessionJournal.write({
          ...journalRecord,
          tabId: createdTab.id
        });
      } catch (_) {
        return {
          ok: false,
          error: 'session_journal_write_failed',
          recoveryRequired: true,
          checkpoint
        };
      }
    }

    const transition = applyBatchRuntimeEvent(checkpoint, {
      type: 'task_activated',
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      requestId,
      tabId: createdTab.id,
      windowId,
      ownerPageTabId,
      ownershipEpoch: reservation.ownershipEpoch,
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
      return {
        ok: false,
        error: 'checkpoint_write_failed',
        recoveryRequired: true,
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
            return await stopSession(message);
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
            return await updateTaskSubmitting(message, sender);
          case 'BATCH_TASK_PHASE':
            return await updateTaskPhase(message, sender);
          case 'BATCH_TASK_RETRY':
            return await mutate(message, {
              type: 'task_retried',
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              confirmedRisk: message.confirmedRisk === true,
              automatic: message.automatic === true,
              retryable: message.retryable === true,
              hasSubmitContext: message.hasSubmitContext === true
            });
          case 'BATCH_TASK_MANUAL_UPDATE':
            return await mutate(message, {
              type: 'task_manual_updated',
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              status: message.status
            });
          case 'BATCH_TASK_TERMINAL':
            return await terminalTask(
              message,
              sender,
              message.result
            );
          case 'BATCH_GET_TAB_MODE':
            return await getTabMode(sender);
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
    handleWorkerTabRemoved,
    handleMessage,
    loadForPage,
    markTerminal,
    recoverOnStartup,
    runProofBoundTaskHook,
    runOwnerPageRecoveryHook
  };
}

export function installBatchRuntimeController(chromeApi, controller) {
  chromeApi.tabs.onRemoved.addListener((tabId) => {
    void controller.handleWorkerTabRemoved(tabId).then((response) => {
      if (!response?.ok || !response.changed || !response.removal) return;
      return chromeApi.runtime.sendMessage({
        type: 'BATCH_WORKER_TAB_REMOVED',
        ...response.removal,
        checkpoint: response.checkpoint
      }).catch(() => {});
    }).catch(() => {});
  });

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
