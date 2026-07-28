import {
  BatchScheduler,
  isBatchConfirmationFor,
  isDurableBatchConfirmation
} from './batch-scheduler.mjs';
import {
  hasUrlCredentials,
  sanitizeBatchUrl,
  sanitizeDiagnosticText
} from './batch-url-sanitizer.mjs';
import { BatchTabManager } from './batch-window-manager.mjs';
import {
  createBatchTaskDeadlines
} from './batch-task-deadlines.mjs';
import {
  createWorkerTabRemovalResult
} from './batch-worker-tab-removal.mjs';
import {
  validateBatchRuntimeCheckpoint
} from './batch-runtime-checkpoint.mjs';

const TASK_STATE_PROGRESS = Object.freeze({
  queued: 0,
  active: 1,
  submitting: 2,
  terminal: 3
});
const TASK_PHASE_PROGRESS = Object.freeze({
  opening: 0,
  loading: 1,
  detecting: 2,
  generating: 3,
  filling: 4,
  submitting: 5,
  confirming: 6,
  closing: 7
});
const MANUAL_PROGRESS = Object.freeze({
  idle: 0,
  in_progress: 1,
  resolved: 2,
  unresolved: 2
});
const OWNERSHIP_FIELDS = Object.freeze([
  'tabId',
  'windowId',
  'ownerPageTabId',
  'ownershipEpoch',
  'requestId',
  'startedAt'
]);

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => (
      key === rightKeys[index] && valuesEqual(left[key], right[key])
    ));
}

function exactTaskIdentity(currentTask, nextTask, version) {
  if (
    currentTask?.urlIndex !== nextTask?.urlIndex ||
    currentTask?.attempt !== nextTask?.attempt
  ) {
    return false;
  }
  if (version !== 3) return true;
  return [
    'taskId',
    'profileId',
    'promotionSiteId',
    'assignmentPairId',
    'assignmentSource'
  ].every((key) => currentTask[key] === nextTask[key]);
}

function immutableTaskIdentityMatches(currentTask, nextTask, version) {
  if (currentTask?.urlIndex !== nextTask?.urlIndex) return false;
  if (version !== 3) return true;
  return [
    'taskId',
    'profileId',
    'promotionSiteId',
    'assignmentPairId',
    'assignmentSource'
  ].every((key) => currentTask[key] === nextTask[key]);
}

function manualResolutionDidNotRegress(currentTask, nextTask) {
  const current = currentTask?.manualResolution || {
    status: 'idle',
    updatedAt: null
  };
  const next = nextTask?.manualResolution || {
    status: 'idle',
    updatedAt: null
  };
  const currentRank = MANUAL_PROGRESS[current.status];
  const nextRank = MANUAL_PROGRESS[next.status];
  if (!Number.isInteger(currentRank) || !Number.isInteger(nextRank)) {
    return false;
  }
  if (nextRank < currentRank) return false;
  if (
    currentRank === 2 &&
    nextRank === 2 &&
    current.status !== next.status
  ) {
    return false;
  }
  return !Number.isFinite(current.updatedAt) ||
    (
      Number.isFinite(next.updatedAt) &&
      next.updatedAt >= current.updatedAt
    );
}

function taskDidNotRegress(currentTask, nextTask, version) {
  if (
    !immutableTaskIdentityMatches(currentTask, nextTask, version) ||
    !Number.isInteger(currentTask?.attempt) ||
    !Number.isInteger(nextTask?.attempt) ||
    nextTask.attempt < currentTask.attempt ||
    (
      Number.isFinite(currentTask.updatedAt) &&
      (
        !Number.isFinite(nextTask.updatedAt) ||
        nextTask.updatedAt < currentTask.updatedAt
      )
    )
  ) {
    return false;
  }
  if (nextTask.attempt > currentTask.attempt) {
    return currentTask.state === 'terminal' &&
      Number(nextTask.attemptCount || nextTask.attempt) >=
        Number(currentTask.attemptCount || currentTask.attempt);
  }

  const currentRank = TASK_STATE_PROGRESS[currentTask.state];
  const nextRank = TASK_STATE_PROGRESS[nextTask.state];
  if (
    !Number.isInteger(currentRank) ||
    !Number.isInteger(nextRank) ||
    nextRank < currentRank
  ) {
    return false;
  }
  if (
    currentTask.phase !== null &&
    nextTask.state !== 'terminal' &&
    (
      !Number.isInteger(TASK_PHASE_PROGRESS[nextTask.phase]) ||
      TASK_PHASE_PROGRESS[nextTask.phase] <
        TASK_PHASE_PROGRESS[currentTask.phase]
    )
  ) {
    return false;
  }
  if (
    ['queued', 'terminal'].includes(currentTask.state) &&
    currentTask.state === nextTask.state &&
    !OWNERSHIP_FIELDS.every(
      (field) => valuesEqual(currentTask[field], nextTask[field])
    )
  ) {
    return false;
  }
  if (
    ['active', 'submitting'].includes(currentTask.state) &&
    ['active', 'submitting'].includes(nextTask.state) &&
    !OWNERSHIP_FIELDS.every(
      (field) => valuesEqual(currentTask[field], nextTask[field])
    )
  ) {
    return false;
  }
  if (
    currentTask.state === 'terminal' &&
    !manualResolutionDidNotRegress(currentTask, nextTask)
  ) {
    return false;
  }
  return true;
}

function resultsDidNotRegress(currentResults, nextResults) {
  const nextByIdentity = new Map(
    (Array.isArray(nextResults) ? nextResults : []).map((result) => [
      `${result?.originalIndex}:${result?.attempt}`,
      result
    ])
  );
  return (Array.isArray(currentResults) ? currentResults : []).every(
    (result) => valuesEqual(
      result,
      nextByIdentity.get(`${result?.originalIndex}:${result?.attempt}`)
    )
  );
}

function reservationDidNotRegress(current, next, nextTasks) {
  if (!next) {
    const task = nextTasks?.[String(current?.urlIndex)];
    return task?.attempt > current?.attempt ||
      (
        task?.attempt === current?.attempt &&
        ['active', 'submitting', 'terminal'].includes(task?.state)
      );
  }
  if (
    ![
      'batchId',
      'urlIndex',
      'attempt',
      'requestId',
      'windowId',
      'ownerPageTabId',
      'ownershipEpoch'
    ].every((field) => current?.[field] === next?.[field]) ||
    (
      Number.isFinite(current?.updatedAt) &&
      (
        !Number.isFinite(next?.updatedAt) ||
        next.updatedAt < current.updatedAt
      )
    ) ||
    (current?.cleanupOnly === true && next?.cleanupOnly !== true) ||
    (
      current?.createCompletionUnknown === true &&
      next?.createCompletionUnknown !== true
    ) ||
    (
      Number.isInteger(current?.tabId) &&
      next?.tabId !== current.tabId
    ) ||
    (
      Number.isFinite(current?.cleanupObservedAt) &&
      (
        !Number.isFinite(next?.cleanupObservedAt) ||
        next.cleanupObservedAt < current.cleanupObservedAt
      )
    )
  ) {
    return false;
  }
  return true;
}

function reservationsDidNotRegress(currentCheckpoint, nextCheckpoint) {
  const current = currentCheckpoint?.openingReservations || {};
  const next = nextCheckpoint?.openingReservations || {};
  for (const [requestId, reservation] of Object.entries(current)) {
    if (!reservationDidNotRegress(
      reservation,
      next[requestId],
      nextCheckpoint?.tasks
    )) {
      return false;
    }
  }
  for (const [requestId, reservation] of Object.entries(next)) {
    if (Object.hasOwn(current, requestId)) continue;
    const task = currentCheckpoint?.tasks?.[String(reservation?.urlIndex)];
    if (
      task?.state !== 'queued' ||
      task?.attempt !== reservation?.attempt ||
      (
        Number.isFinite(currentCheckpoint?.updatedAt) &&
        (
          !Number.isFinite(reservation?.updatedAt) ||
          reservation.updatedAt < currentCheckpoint.updatedAt
        )
      )
    ) {
      return false;
    }
  }
  return true;
}

export function isForwardRemovedTabCheckpoint(currentCheckpoint, message) {
  const nextCheckpoint = message?.checkpoint;
  const urlIndex = message?.urlIndex;
  const currentTask = currentCheckpoint?.tasks?.[String(urlIndex)];
  const nextTask = nextCheckpoint?.tasks?.[String(urlIndex)];
  if (
    typeof message?.batchId !== 'string' ||
    message.batchId !== currentCheckpoint?.batchId ||
    nextCheckpoint?.batchId !== message.batchId ||
    nextCheckpoint?.version !== currentCheckpoint?.version ||
    (
      nextCheckpoint?.version === 3 &&
      validateBatchRuntimeCheckpoint(nextCheckpoint).ok !== true
    ) ||
    nextCheckpoint?.status !== 'running' ||
    !Number.isFinite(currentCheckpoint?.updatedAt) ||
    !Number.isFinite(nextCheckpoint?.updatedAt) ||
    nextCheckpoint.updatedAt < currentCheckpoint.updatedAt ||
    !valuesEqual(nextCheckpoint?.source, currentCheckpoint?.source) ||
    !valuesEqual(nextCheckpoint?.settings, currentCheckpoint?.settings) ||
    (
      currentCheckpoint.version === 3 &&
      (
        nextCheckpoint.configRevision !== currentCheckpoint.configRevision ||
        !valuesEqual(nextCheckpoint.profiles, currentCheckpoint.profiles) ||
        !valuesEqual(
          nextCheckpoint.promotionSites,
          currentCheckpoint.promotionSites
        )
      )
    ) ||
    !Number.isInteger(urlIndex) ||
    !Number.isInteger(message?.attempt) ||
    !Number.isInteger(message?.tabId) ||
    !['active', 'submitting'].includes(currentTask?.state) ||
    currentTask.attempt !== message.attempt ||
    currentTask.tabId !== message.tabId ||
    nextTask?.attempt !== message.attempt ||
    nextTask?.state !== 'terminal' ||
    nextTask?.tabId !== null ||
    nextTask?.windowId !== null ||
    nextTask?.startedAt !== null ||
    !exactTaskIdentity(
      currentTask,
      nextTask,
      currentCheckpoint.version
    ) ||
    !Object.keys(currentCheckpoint.tasks || {}).every((key) => (
      key === String(urlIndex) ||
      taskDidNotRegress(
        currentCheckpoint.tasks[key],
        nextCheckpoint.tasks?.[key],
        currentCheckpoint.version
      )
    )) ||
    Object.keys(nextCheckpoint.tasks || {}).length !==
      Object.keys(currentCheckpoint.tasks || {}).length ||
    !resultsDidNotRegress(
      currentCheckpoint.results,
      nextCheckpoint.results
    ) ||
    !reservationsDidNotRegress(currentCheckpoint, nextCheckpoint) ||
    !(nextCheckpoint.results || []).some((result) => (
      result?.originalIndex === urlIndex &&
      result?.attempt === message.attempt
    ))
  ) {
    return false;
  }
  return true;
}

function terminalIndices(checkpoint, excluded = new Set()) {
  return Object.values(checkpoint.tasks || {})
    .filter((task) => (
      task?.state === 'terminal' && !excluded.has(task.urlIndex)
    ))
    .map((task) => task.urlIndex);
}

function errorText(error) {
  return sanitizeDiagnosticText(
    String(error?.message || error || 'unknown_error')
  );
}

function safeError(error, fallbackCode = 'batch_runtime_failed') {
  const safe = new Error(errorText(error));
  safe.code = sanitizeDiagnosticText(
    String(error?.code || fallbackCode)
  );
  return safe;
}

function unavailableReasonForError(error) {
  const message = String(error?.message || error || '');
  if (
    /Cannot access contents|Missing host permission|must request permission|Cannot access a .* URL/i.test(message)
  ) {
    return 'permission_denied';
  }
  if (/No tab with id|Tab not found/i.test(message)) {
    return 'tab_invalid';
  }
  return null;
}

function unavailableReasonForTab(tab) {
  if (tab?.discarded === true) return 'tab_discarded';
  const candidate = tab?.pendingUrl || tab?.url || '';
  if (/^chrome-error:/i.test(candidate)) return 'chrome_error_page';
  if (!candidate) return null;
  try {
    const protocol = new URL(candidate).protocol;
    if (!['http:', 'https:'].includes(protocol)) return 'restricted_scheme';
  } catch (_) {
    return 'invalid_url';
  }
  return null;
}

function sameDocumentUrl(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    return new URL(left).href === new URL(right).href;
  } catch (_) {
    return left === right;
  }
}

function sanitizedNavigation(navigation) {
  return {
    lastTrigger: sanitizeDiagnosticText(
      navigation?.lastTrigger || 'initial'
    ),
    lastUpdatedAt: navigation?.lastUpdatedAt || null,
    lastChangeInfo: navigation?.lastChangeInfo
      ? JSON.parse(sanitizeDiagnosticText(
        JSON.stringify(navigation.lastChangeInfo)
      ))
      : null
  };
}

function createContentScriptUnavailableError(reason, state) {
  const tab = state.tab || {};
  const safeTab = {
    url: tab.url ? sanitizeBatchUrl(tab.url) : null,
    pendingUrl: tab.pendingUrl ? sanitizeBatchUrl(tab.pendingUrl) : null,
    status: tab.status || null,
    discarded: tab.discarded === true
  };
  const lastError = sanitizeDiagnosticText(state.lastError || 'none');
  const navigation = sanitizedNavigation(state.navigation);
  const change = navigation.lastChangeInfo
    ? JSON.stringify(navigation.lastChangeInfo)
    : 'none';
  const message = [
    '目标页面内容脚本不可用',
    `reason=${reason}`,
    `tabId=${state.tabId}`,
    `status=${safeTab.status || 'unknown'}`,
    `url=${safeTab.url || 'unknown'}`,
    `pendingUrl=${safeTab.pendingUrl || 'none'}`,
    `discarded=${safeTab.discarded}`,
    `navigation=${navigation.lastTrigger}:${change}`,
    `elapsedMs=${state.elapsedMs}`,
    `lastError=${lastError}`,
    '请确认目标页为可访问的 http(s) 页面、扩展具有站点权限且内容脚本已加载'
  ].join('; ');
  const error = new Error(message);
  error.code = 'content_script_unavailable';
  error.reason = reason;
  error.diagnostic = {
    reason,
    tabId: state.tabId,
    elapsedMs: state.elapsedMs,
    lastError,
    tab: safeTab,
    navigation
  };
  return error;
}

async function boundedTabSnapshot(tabsApi, tabId, timers, timeoutMs) {
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => tabsApi.get(tabId)).catch(() => null),
      new Promise((resolve) => {
        timeoutId = timers.setTimeout(
          () => resolve(null),
          Math.max(1, Math.min(250, timeoutMs))
        );
      })
    ]);
  } finally {
    if (timeoutId !== null) timers.clearTimeout(timeoutId);
  }
}

export function waitForContentScriptReady(activity, {
  tabsApi,
  clock = Date.now,
  timers = globalThis,
  timeoutMs = 30000,
  pollIntervalMs = 250
}) {
  const startedAt = clock();
  const state = {
    tabId: activity.tabId,
    tab: null,
    lastError: null,
    elapsedMs: 0,
    navigation: {
      lastTrigger: 'initial',
      lastUpdatedAt: startedAt,
      lastChangeInfo: null
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let probing = false;
    let pendingProbe = false;
    let retryTimer = null;
    let deadlineTimer = null;
    let deadlineRunning = false;
    let deadlineClaimed = false;

    const cleanup = () => {
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      if (deadlineTimer !== null) timers.clearTimeout(deadlineTimer);
      retryTimer = null;
      deadlineTimer = null;
      tabsApi.onUpdated?.removeListener(handleUpdated);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (reason) => {
      if (deadlineClaimed && reason !== 'timeout') return;
      state.elapsedMs = Math.max(0, clock() - startedAt);
      finish(reject, createContentScriptUnavailableError(reason, state));
    };
    const expire = async () => {
      if (settled || deadlineRunning) return;
      deadlineRunning = true;
      deadlineClaimed = true;
      const freshTab = await boundedTabSnapshot(
        tabsApi,
        activity.tabId,
        timers,
        timeoutMs
      );
      if (freshTab) state.tab = freshTab;
      fail('timeout');
    };
    const scheduleProbe = () => {
      if (settled || retryTimer !== null || pendingProbe) return;
      const remaining = timeoutMs - Math.max(0, clock() - startedAt);
      if (remaining <= 0) {
        void expire();
        return;
      }
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        requestProbe('poll');
      }, Math.max(0, Math.min(pollIntervalMs, remaining)));
    };
    const requestProbe = (trigger, changeInfo = null) => {
      if (settled || deadlineClaimed) return;
      state.navigation.lastTrigger = trigger;
      state.navigation.lastUpdatedAt = clock();
      if (changeInfo && Object.keys(changeInfo).length > 0) {
        state.navigation.lastChangeInfo = { ...changeInfo };
      }
      if (probing) {
        pendingProbe = true;
        if (clock() - startedAt >= timeoutMs) void expire();
        return;
      }
      void probe();
    };
    const probe = async () => {
      probing = true;
      try {
        state.elapsedMs = Math.max(0, clock() - startedAt);
        if (state.elapsedMs >= timeoutMs) {
          await expire();
          return;
        }
        try {
          state.tab = await tabsApi.get(activity.tabId);
        } catch (error) {
          if (deadlineClaimed) return;
          state.lastError = errorText(error);
          fail(unavailableReasonForError(error) || 'tab_query_failed');
          return;
        }
        if (settled || deadlineClaimed) return;

        const tabReason = unavailableReasonForTab(state.tab);
        if (tabReason) {
          fail(tabReason);
          return;
        }
        // pendingUrl means the requested navigation has not committed yet, so
        // a PING could still reach the previous document. Once it is cleared,
        // the document-start listener is safe to contact even while the page
        // keeps loading slow or broken subresources.
        if (Boolean(state.tab.pendingUrl)) {
          return;
        }

        try {
          const response = await tabsApi.sendMessage(
            activity.tabId,
            { type: 'PING' }
          );
          if (deadlineClaimed) return;
          if (response?.ok === true) {
            if (
              typeof response.documentUrl === 'string' &&
              !sameDocumentUrl(response.documentUrl, state.tab?.url)
            ) {
              state.lastError = sanitizeDiagnosticText(
                `PING 文档已变化：response=${response.documentUrl}; tab=${state.tab?.url || 'unknown'}`
              );
              return;
            }
            finish(resolve, {
              tab: state.tab,
              elapsedMs: Math.max(0, clock() - startedAt),
              readyState: typeof response.readyState === 'string'
                ? response.readyState
                : null
            });
            return;
          }
          state.lastError = sanitizeDiagnosticText(
            `PING 未确认就绪：${JSON.stringify(response)}`
          );
        } catch (error) {
          state.lastError = errorText(error);
          if (deadlineClaimed) return;
          const fatalReason = unavailableReasonForError(error);
          if (fatalReason) {
            fail(fatalReason);
            return;
          }
        }
      } finally {
        probing = false;
        if (!settled && pendingProbe) {
          pendingProbe = false;
          requestProbe(state.navigation.lastTrigger);
        } else if (!settled) {
          scheduleProbe();
        }
      }
    };
    const handleUpdated = (tabId, changeInfo) => {
      if (tabId !== activity.tabId) return;
      requestProbe('tabs.onUpdated', changeInfo);
    };

    tabsApi.onUpdated?.addListener(handleUpdated);
    deadlineTimer = timers.setTimeout(() => void expire(), timeoutMs);
    requestProbe('initial');
  });
}

export function createBatchWorkerRuntime(dependencies) {
  const {
    tabsApi,
    windowId,
    runtimeRequest,
    sendHandle = (activity) => tabsApi.sendMessage(activity.tabId, {
      type: 'BATCH_HANDLE',
      batchId: activity.batchId,
      ...(activity.taskId
        ? {
            taskId: activity.taskId,
            profileId: activity.profileId,
            promotionSiteId: activity.promotionSiteId,
            assignmentPairId: activity.assignmentPairId,
            assignmentSource: activity.assignmentSource,
            configRevision: activity.configRevision,
            automation: structuredClone(activity.automation),
            profile: structuredClone(activity.profile),
            promotionSite: structuredClone(activity.promotionSite)
          }
        : {}),
      urlIndex: activity.urlIndex,
      attempt: activity.attempt,
      url: sanitizeBatchUrl(activity.url)
    }),
    clock = Date.now,
    timers = globalThis,
    readinessTimeoutMs = 30000,
    readinessPollIntervalMs = 250,
    handleDeliveryTimeoutMs = readinessTimeoutMs,
    sealTimeoutMs = Math.max(1, Math.min(1000, readinessTimeoutMs)),
    sealSubmitContext = async () => ({ sealed: true, recovered: false }),
    schedulerFactory = (options) => new BatchScheduler(options),
    tabManagerFactory = (options) => new BatchTabManager(options),
    taskDeadlineFactory = (options) => createBatchTaskDeadlines(options)
  } = dependencies;

  let lifecycle = null;
  let lifecycleOperationQueue = Promise.resolve();
  const listeners = new Set();

  function enqueueLifecycle(operation) {
    const run = lifecycleOperationQueue.then(operation, operation);
    lifecycleOperationQueue = run.catch(() => {});
    return run;
  }

  function emit(type, owner, details = {}) {
    const event = {
      type,
      checkpoint: owner.checkpoint,
      ...details
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (_) {
        // An observer cannot break worker ownership.
      }
    }
    try {
      dependencies.onEvent?.(event);
    } catch (_) {
      // An observer cannot break worker ownership.
    }
  }

  function stopTimeoutChecker(owner) {
    if (owner?.timeoutTimer !== null && owner?.timeoutTimer !== undefined) {
      timers.clearInterval(owner.timeoutTimer);
      owner.timeoutTimer = null;
    }
    owner?.deadlines?.clearAll();
  }

  function startTimeoutChecker(owner) {
    if (
      !owner ||
      owner.timeoutTimer !== null &&
        owner.timeoutTimer !== undefined
    ) {
      return;
    }
    owner.timeoutTimer = timers.setInterval(
      () => checkTimeouts(owner).catch((error) => {
        pauseForRuntimeError(owner, error, 'timeout_scan');
      }),
      1000
    );
  }

  function restoreRemovedRaceOwner(owner) {
    owner.status = 'running';
    owner.recoveryPause = null;
    const timeoutMs = owner.checkpoint.settings.timeoutSeconds * 1000;
    for (const reservation of owner.openings.values()) {
      owner.deadlines.arm(reservation, reservation.startTime, timeoutMs);
    }
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      const activity = activityAt(owner, urlIndex);
      if (!activity) continue;
      owner.deadlines.arm(
        activity,
        Number.isFinite(activity.startTime)
          ? activity.startTime
          : owner.checkpoint.tasks[String(urlIndex)]?.startedAt,
        timeoutMs
      );
    }
    startTimeoutChecker(owner);
  }

  function pauseForRuntimeError(owner, error, context, recovery = null) {
    const safe = safeError(error);
    if (!['completed', 'stopped', 'superseded', 'disposed'].includes(owner.status)) {
      owner.status = 'paused_recovery';
      owner.recoveryPause = {
        context: sanitizeDiagnosticText(context || 'runtime'),
        removedActivityKey:
          typeof recovery?.removedActivityKey === 'string'
            ? recovery.removedActivityKey
            : null
      };
    }
    owner.scheduler.stop();
    stopTimeoutChecker(owner);
    emit('runtime-error', owner, {
      error: safe,
      context: sanitizeDiagnosticText(context || 'runtime')
    });
    return safe;
  }

  async function transition(owner, type, payload, recovery = null) {
    try {
      const response = await runtimeRequest(type, payload);
      if (!response?.ok) {
        const currentTask =
          owner.checkpoint.tasks?.[String(payload?.urlIndex)];
        if (
          type === 'BATCH_TASK_TERMINAL' &&
          response?.error === 'task_already_terminal' &&
          Number.isInteger(currentTask?.tabId) &&
          isForwardRemovedTabCheckpoint(owner.checkpoint, {
            batchId: owner.checkpoint.batchId,
            urlIndex: payload.urlIndex,
            attempt: payload.attempt,
            tabId: currentTask.tabId,
            checkpoint: response.checkpoint
          })
        ) {
          owner.checkpoint = response.checkpoint;
          emit('changed', owner, {
            transition: type,
            alreadyTerminal: true
          });
          return {
            ...response,
            ok: true,
            changed: false,
            alreadyTerminal: true
          };
        }
        const error = new Error(response?.error || 'batch_runtime_failed');
        error.code = response?.error || 'batch_runtime_failed';
        throw error;
      }
      if (
        response.checkpoint &&
        response.checkpoint.batchId !== owner.checkpoint.batchId
      ) {
        throw new Error('batch_runtime_stale_checkpoint');
      }
      owner.checkpoint = response.checkpoint || owner.checkpoint;
      emit('changed', owner, { transition: type });
      return response;
    } catch (error) {
      pauseForRuntimeError(owner, error, type, recovery);
      return null;
    }
  }

  function enqueue(owner, operation) {
    const run = owner.operationQueue.then(operation, operation);
    owner.operationQueue = run.catch(() => {});
    return run;
  }

  function identityKey(activity) {
    return `${activity.batchId}:${activity.urlIndex}:${activity.attempt}`;
  }

  function activityAt(owner, urlIndex) {
    return owner.manager.getByIndex(urlIndex);
  }

  function isCurrentRunningActivity(owner, activity) {
    return Boolean(
      activity &&
      lifecycle === owner &&
      owner.status === 'running' &&
      !owner.finalizingByIndex.has(activity.urlIndex) &&
      activityAt(owner, activity.urlIndex) === activity
    );
  }

  function taskMessageIdentity(checkpoint, urlIndex) {
    const task = checkpoint.tasks[String(urlIndex)];
    const identity = {
      batchId: checkpoint.batchId,
      urlIndex,
      attempt: task?.attempt
    };
    return checkpoint.version === 3
      ? {
          ...identity,
          taskId: task.taskId,
          profileId: task.profileId,
          promotionSiteId: task.promotionSiteId
        }
      : identity;
  }

  function acceptBackgroundCheckpoint(owner, activity) {
    if (activity?.backgroundCheckpointed !== true) return false;
    const checkpoint = activity.runtimeCheckpoint;
    const task = checkpoint?.tasks?.[String(activity.urlIndex)];
    if (
      checkpoint?.batchId !== activity.batchId ||
      checkpoint?.status !== 'running' ||
      task?.attempt !== activity.attempt ||
      task?.state !== 'active' ||
      task?.tabId !== activity.tabId ||
      task?.windowId !== activity.windowId
    ) {
      return false;
    }
    owner.checkpoint = checkpoint;
    emit('changed', owner, { transition: 'BATCH_CREATE_WORKER_TAB' });
    return true;
  }

  function occupiedIndices(owner) {
    const occupied = new Set(owner.openings.keys());
    for (const urlIndex of owner.finalizingByIndex.keys()) {
      occupied.add(urlIndex);
    }
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      if (activityAt(owner, urlIndex)) occupied.add(urlIndex);
    }
    return occupied;
  }

  function reconcileScheduler(owner) {
    const occupied = occupiedIndices(owner);
    owner.scheduler.reconcile({
      processedIndices: terminalIndices(owner.checkpoint, occupied),
      activeIndices: [...occupied]
    });
    if (owner.status === 'running') owner.scheduler.start();
    else owner.scheduler.stop();
  }

  async function closeActivity(owner, activity) {
    if (!activity || activityAt(owner, activity.urlIndex) !== activity) {
      return true;
    }
    try {
      if (typeof owner.manager.close === 'function') {
        await owner.manager.close(activity);
      } else if (typeof owner.manager.closeByIndex === 'function') {
        await owner.manager.closeByIndex(activity.urlIndex);
      }
      return true;
    } catch (error) {
      pauseForRuntimeError(owner, error, 'worker_tab_close');
      return false;
    }
  }

  function taskIsSubmissionUncertain(task, recovery) {
    return task?.state === 'submitting' ||
      task?.phase === 'submitting' ||
      task?.phase === 'confirming' ||
      recovery?.recovered === true ||
      recovery?.sealed === false;
  }

  function interruptionResult(task, recovery, kind) {
    const uncertain = taskIsSubmissionUncertain(task, recovery);
    if (kind === 'unexpected' && !uncertain) {
      return createWorkerTabRemovalResult(task);
    }
    const messages = {
      timeout: ['处理超时', '处理超时；未确认提交的上下文已保留待人工确认'],
      pause: ['批次已暂停', '批次暂停；未确认提交的上下文已保留待人工确认'],
      shutdown: ['批次已被替换或关闭', '批次替换；未确认提交的上下文已保留待人工确认'],
      unexpected: [
        'Worker 标签页已关闭',
        'Worker 标签页已关闭；未确认提交的上下文已保留待人工确认'
      ]
    };
    const [safeMessage, uncertainMessage] = messages[kind] || messages.pause;
    return {
      result: uncertain ? 'manual_required' : 'fail',
      aiContent: null,
      errorCode: uncertain
        ? 'submission_uncertain'
        : kind === 'timeout'
          ? 'task_timeout'
          : 'task_failed',
      errorMessage: uncertain ? uncertainMessage : safeMessage
    };
  }

  function confirmationResult(message) {
    return {
      result: message.result || 'success',
      aiContent: message.aiContent || null,
      errorCode: message.errorCode || null,
      errorMessage: message.errorMessage || null,
      resultPreview: message.resultPreview
    };
  }

  function sanitizeTerminalResult(result) {
    return {
      ...result,
      errorMessage: result.errorMessage
        ? sanitizeDiagnosticText(result.errorMessage)
        : null
    };
  }

  async function boundedSealSubmitContext(activity, reason) {
    let timeoutId = null;
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => sealSubmitContext(activity, reason))
          .then(
            (recovery) => ({ kind: 'recovery', recovery }),
            (error) => ({ kind: 'error', error })
          ),
        new Promise((resolve) => {
          timeoutId = timers.setTimeout(
            () => resolve({ kind: 'timeout' }),
            Math.max(1, sealTimeoutMs)
          );
          timeoutId?.unref?.();
        })
      ]);
      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.kind === 'timeout') {
        return {
          sealed: false,
          recovered: false,
          timedOut: true
        };
      }
      return outcome.recovery;
    } finally {
      if (timeoutId !== null) timers.clearTimeout(timeoutId);
    }
  }

  async function performFinalizer(owner, activity, options) {
    const task = owner.checkpoint.tasks[String(activity.urlIndex)];
    if (!task) return false;
    if (task.attempt !== activity.attempt) {
      return closeActivity(owner, activity);
    }
    if (task.state === 'terminal') {
      return options.alreadyClosed ? true : closeActivity(owner, activity);
    }

    let recovery = null;
    if (!options.skipSeal) {
      try {
        recovery = await boundedSealSubmitContext(
          activity,
          options.reason
        );
      } catch (error) {
        pauseForRuntimeError(owner, error, 'seal_submit_context');
        return false;
      }
    }

    const latestTask = owner.checkpoint.tasks[String(activity.urlIndex)];
    if (!latestTask || latestTask.attempt !== activity.attempt) {
      return options.alreadyClosed ? false : closeActivity(owner, activity);
    }
    const rawResult = typeof options.result === 'function'
      ? options.result(latestTask, recovery)
      : options.result;
    const response = await transition(
      owner,
      'BATCH_TASK_TERMINAL',
      {
        ...taskMessageIdentity(owner.checkpoint, activity.urlIndex),
        result: sanitizeTerminalResult(rawResult)
      },
      options.reason === 'unexpected_close' && options.alreadyClosed
        ? { removedActivityKey: identityKey(activity) }
        : null
    );
    if (!response) return false;

    if (!options.alreadyClosed) {
      const closed = await closeActivity(owner, activity);
      if (!closed) return false;
    }
    if (options.eventType) {
      emit(options.eventType, owner, {
        urlIndex: activity.urlIndex,
        attempt: activity.attempt
      });
    }
    return true;
  }

  function claimFinalizer(owner, activity, options) {
    const key = identityKey(activity);
    owner.deadlines?.clear(activity);
    const existing = owner.finalizers.get(key);
    if (existing) return existing;

    const execution = enqueue(
      owner,
      () => performFinalizer(owner, activity, options)
    );
    let finalizer;
    finalizer = execution.finally(async () => {
      if (owner.finalizers.get(key) === finalizer) {
        owner.finalizers.delete(key);
      }
      if (owner.finalizingByIndex.get(activity.urlIndex) === key) {
        owner.finalizingByIndex.delete(activity.urlIndex);
      }
      reconcileScheduler(owner);
      if (lifecycle === owner && owner.status === 'running') {
        await enqueue(owner, () => replenishOrComplete(owner));
      }
    });
    owner.finalizers.set(key, finalizer);
    owner.finalizingByIndex.set(activity.urlIndex, key);
    reconcileScheduler(owner);
    return finalizer;
  }

  async function complete(owner) {
    reconcileScheduler(owner);
    if (
      lifecycle !== owner ||
      owner.status !== 'running' ||
      !owner.scheduler.isComplete ||
      occupiedIndices(owner).size > 0
    ) {
      return false;
    }
    owner.status = 'completing';
    owner.recoveryPause = null;
    owner.scheduler.stop();
    stopTimeoutChecker(owner);
    const response = await transition(owner, 'BATCH_SESSION_COMPLETE', {
      batchId: owner.checkpoint.batchId
    });
    if (!response || lifecycle !== owner) return false;
    owner.status = 'completed';
    emit('changed', owner);
    return true;
  }

  async function replenishOrComplete(owner) {
    if (lifecycle !== owner || owner.status !== 'running') return false;
    reconcileScheduler(owner);
    if (owner.scheduler.isComplete && occupiedIndices(owner).size === 0) {
      return complete(owner);
    }
    return fillAvailable(owner);
  }

  function terminalizeOpening(owner, reservation, kind) {
    const finalizer = claimFinalizer(owner, reservation, {
      reason: kind,
      skipSeal: true,
      alreadyClosed: true,
      result: (task) => interruptionResult(task, null, kind)
    });
    reservation.finalizer = finalizer;
    return finalizer;
  }

  function cancelOpeningReservation(owner, reservation) {
    reservation.cancelled = true;
    if (owner.openings.get(reservation.urlIndex) === reservation) {
      owner.openings.delete(reservation.urlIndex);
    }
    reservation.resolveCancellation?.();
    reservation.resolveCancellation = null;
  }

  async function expireTask(owner, identity) {
    if (
      lifecycle !== owner ||
      owner.status !== 'running' ||
      owner.checkpoint.batchId !== identity.batchId
    ) {
      return false;
    }
    const task = owner.checkpoint.tasks[String(identity.urlIndex)];
    if (task?.attempt !== identity.attempt || task.state === 'terminal') {
      return false;
    }
    const opening = owner.openings.get(identity.urlIndex);
    if (
      opening &&
      opening.attempt === identity.attempt &&
      !opening.cancelled
    ) {
      cancelOpeningReservation(owner, opening);
      return terminalizeOpening(owner, opening, 'timeout');
    }
    const activity = activityAt(owner, identity.urlIndex);
    if (!activity || activity.attempt !== identity.attempt) return false;
    return claimFinalizer(owner, activity, {
      reason: 'timeout',
      skipSeal: false,
      result: (currentTask, recovery) => (
        interruptionResult(currentTask, recovery, 'timeout')
      )
    });
  }

  async function unavailableErrorFor(activity, reason, error) {
    const tab = await boundedTabSnapshot(
      tabsApi,
      activity.tabId,
      timers,
      readinessTimeoutMs
    );
    return createContentScriptUnavailableError(reason, {
      tabId: activity.tabId,
      tab,
      lastError: errorText(error),
      elapsedMs: Math.max(0, clock() - activity.startTime),
      navigation: {
        lastTrigger: 'BATCH_HANDLE',
        lastUpdatedAt: clock(),
        lastChangeInfo: null
      }
    });
  }

  async function deliverHandleWithDeadline(activity) {
    let timeoutId = null;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => sendHandle(activity))
          .then(
            (response) => ({ kind: 'response', response }),
            (error) => ({ kind: 'error', error })
          ),
        new Promise((resolve) => {
          timeoutId = timers.setTimeout(
            () => resolve({ kind: 'timeout' }),
            Math.max(1, handleDeliveryTimeoutMs)
          );
        })
      ]);
    } finally {
      if (timeoutId !== null) timers.clearTimeout(timeoutId);
    }
  }

  async function finishUnavailable(owner, activity, error) {
    if (!isCurrentRunningActivity(owner, activity)) return false;
    emit('runtime-error', owner, { error: safeError(error) });
    return claimFinalizer(owner, activity, {
      reason: 'content_script_unavailable',
      skipSeal: true,
      result: {
        result: 'fail',
        aiContent: null,
        errorCode: 'content_script_unavailable',
        errorMessage: errorText(error)
      }
    });
  }

  async function open(urlIndex, owner) {
    const task = owner.checkpoint.tasks[String(urlIndex)];
    const item = owner.checkpoint.source.parsedUrls[urlIndex];
    if (!task || !item) {
      if (task && Number.isInteger(task.attempt)) {
        const response = await transition(owner, 'BATCH_TASK_TERMINAL', {
          ...taskMessageIdentity(owner.checkpoint, urlIndex),
          result: {
            result: 'fail',
            aiContent: null,
            errorCode: 'batch_source_missing',
            errorMessage: '批次源数据缺失'
          }
        });
        if (response && lifecycle === owner && owner.status === 'running') {
          await replenishOrComplete(owner);
        }
      } else {
        pauseForRuntimeError(
          owner,
          new Error('batch_source_missing'),
          'worker_tab_open'
        );
      }
      return false;
    }
    if (hasUrlCredentials(item.url)) {
      pauseForRuntimeError(
        owner,
        new Error('batch_url_credentials_forbidden'),
        'worker_tab_open'
      );
      return false;
    }
    const reservation = {
      batchId: owner.checkpoint.batchId,
      urlIndex,
      attempt: task.attempt,
      startTime: clock(),
      cancelled: false,
      activity: null,
      settled: null,
      resolveCancellation: null
    };
    reservation.cancellation = new Promise((resolve) => {
      reservation.resolveCancellation = resolve;
    });
    owner.openings.set(urlIndex, reservation);
    owner.deadlines.arm(
      {
        batchId: reservation.batchId,
        urlIndex: reservation.urlIndex,
        attempt: reservation.attempt
      },
      reservation.startTime,
      owner.checkpoint.settings.timeoutSeconds * 1000
    );
    reconcileScheduler(owner);

    const run = (async () => {
      let activity;
      try {
        const creation = Promise.resolve().then(() => owner.manager.create({
          batchId: reservation.batchId,
          ...(owner.checkpoint.version === 3
            ? {
                taskId: task.taskId,
                profileId: task.profileId,
                promotionSiteId: task.promotionSiteId,
                assignmentPairId: task.assignmentPairId,
                assignmentSource: task.assignmentSource,
                configRevision: owner.checkpoint.configRevision,
                automation: {
                  autoGenerate:
                    owner.checkpoint.settings.autoGenerate === true ||
                    owner.checkpoint.settings.autoSubmit === true,
                  autoSubmit:
                    owner.checkpoint.settings.autoSubmit === true
                },
                profile: structuredClone(
                  owner.checkpoint.profiles[task.profileId]
                ),
                promotionSite: structuredClone(
                  owner.checkpoint.promotionSites[task.promotionSiteId]
                )
              }
            : {}),
          urlIndex,
          attempt: reservation.attempt,
          url: sanitizeBatchUrl(item.url)
        }));
        const outcome = await Promise.race([
          creation.then(
            (created) => ({ kind: 'created', activity: created }),
            (error) => ({ kind: 'error', error })
          ),
          reservation.cancellation.then(() => ({ kind: 'cancelled' }))
        ]);
        if (outcome.kind === 'cancelled') {
          void creation.then(
            async (lateActivity) => {
              reservation.activity = lateActivity;
              if (
                reservation.finalizer &&
                !await reservation.finalizer
              ) {
                reconcileScheduler(owner);
                return;
              }
              await closeActivity(owner, lateActivity);
              reconcileScheduler(owner);
            },
            () => {}
          );
          return false;
        }
        if (outcome.kind === 'error') throw outcome.error;
        activity = outcome.activity;
        reservation.activity = activity;
      } catch (error) {
        owner.deadlines.clear(reservation);
        if (owner.openings.get(urlIndex) === reservation) {
          owner.openings.delete(urlIndex);
        }
        reconcileScheduler(owner);
        if (reservation.cancelled) return false;
        if (error?.recoveryRequired === true) {
          const checkpoint = error.runtimeCheckpoint;
          const ownedTask = checkpoint?.tasks?.[String(urlIndex)];
          if (
            checkpoint?.batchId === reservation.batchId &&
            ownedTask?.attempt === reservation.attempt
          ) {
            owner.checkpoint = checkpoint;
          }
          pauseForRuntimeError(
            owner,
            error,
            'worker_tab_create_recovery_required'
          );
          reconcileScheduler(owner);
          return false;
        }
        const response = await transition(owner, 'BATCH_TASK_TERMINAL', {
          ...taskMessageIdentity(owner.checkpoint, urlIndex),
          result: {
            result: 'fail',
            aiContent: null,
            errorCode: 'tab_create_failed',
            errorMessage: sanitizeDiagnosticText(
              `标签页创建失败：${errorText(error)}`
            )
          }
        });
        if (response && lifecycle === owner && owner.status === 'running') {
          await replenishOrComplete(owner);
        }
        return false;
      }

      if (owner.openings.get(urlIndex) === reservation) {
        owner.openings.delete(urlIndex);
      }
      reconcileScheduler(owner);
      if (
        reservation.cancelled ||
        lifecycle !== owner ||
        owner.status !== 'running' ||
        owner.checkpoint.tasks[String(urlIndex)]?.state === 'terminal'
      ) {
        if (
          reservation.cancelled &&
          reservation.finalizer &&
          !await reservation.finalizer
        ) {
          reconcileScheduler(owner);
          return false;
        }
        await closeActivity(owner, activity);
        reconcileScheduler(owner);
        if (lifecycle === owner && owner.status === 'running') {
          await replenishOrComplete(owner);
        }
        return false;
      }

      const activeResponse = acceptBackgroundCheckpoint(owner, activity)
        ? { ok: true, checkpoint: owner.checkpoint }
        : await transition(owner, 'BATCH_TASK_ACTIVE', {
            ...taskMessageIdentity(owner.checkpoint, urlIndex),
            tabId: activity.tabId,
            windowId: activity.windowId,
            startedAt: activity.startTime
          });
      if (!activeResponse) {
        await closeActivity(owner, activity);
        reconcileScheduler(owner);
        return false;
      }

      try {
        await waitForContentScriptReady(activity, {
          tabsApi,
          clock,
          timers,
          timeoutMs: readinessTimeoutMs,
          pollIntervalMs: readinessPollIntervalMs
        });
        if (
          lifecycle !== owner ||
          owner.status !== 'running' ||
          activityAt(owner, urlIndex) !== activity
        ) {
          return false;
        }
        const delivery = await deliverHandleWithDeadline({
          ...activity,
          url: sanitizeBatchUrl(activity.url)
        });
        if (!isCurrentRunningActivity(owner, activity)) return false;
        if (delivery.kind === 'timeout') {
          const error = await unavailableErrorFor(
            activity,
            'handle_delivery_timeout',
            'BATCH_HANDLE 发送超时'
          );
          await finishUnavailable(owner, activity, error);
          return false;
        }
        if (delivery.kind === 'error') throw delivery.error;
        const handleResponse = delivery.response;
        if (handleResponse && handleResponse.ok === false) {
          const error = await unavailableErrorFor(
            activity,
            'handle_rejected',
            handleResponse.error || 'BATCH_HANDLE 未被内容脚本接受'
          );
          await finishUnavailable(owner, activity, error);
          return false;
        }
        return true;
      } catch (error) {
        if (!isCurrentRunningActivity(owner, activity)) return false;
        const unavailable = error?.code === 'content_script_unavailable'
          ? error
          : await unavailableErrorFor(
            activity,
            unavailableReasonForError(error) || 'handle_delivery_failed',
            error
          );
        await finishUnavailable(owner, activity, unavailable);
        return false;
      }
    })();
    reservation.settled = run;
    owner.openTasks.add(run);
    try {
      return await run;
    } finally {
      owner.openTasks.delete(run);
    }
  }

  async function fillAvailable(owner) {
    if (lifecycle !== owner || owner.status !== 'running') return false;
    reconcileScheduler(owner);
    const indices = owner.scheduler.takeAvailable();
    if (indices.length === 0) {
      if (owner.scheduler.isComplete && occupiedIndices(owner).size === 0) {
        return complete(owner);
      }
      return true;
    }
    await Promise.all(indices.map((urlIndex) => open(urlIndex, owner)));
    return true;
  }

  async function checkTimeouts(owner) {
    if (
      lifecycle !== owner ||
      owner.status !== 'running' ||
      owner.timeoutScan
    ) {
      return owner?.timeoutScan || false;
    }
    owner.timeoutScan = (async () => {
      const timeoutMs = owner.checkpoint.settings.timeoutSeconds * 1000;
      const indices = [...occupiedIndices(owner)].sort((a, b) => a - b);
      for (const urlIndex of indices) {
        if (lifecycle !== owner || owner.status !== 'running') break;
        const opening = owner.openings.get(urlIndex);
        if (
          opening &&
          !opening.cancelled &&
          clock() - opening.startTime >= timeoutMs
        ) {
          cancelOpeningReservation(owner, opening);
          await terminalizeOpening(owner, opening, 'timeout');
          continue;
        }
        const activity = activityAt(owner, urlIndex);
        if (!activity || clock() - activity.startTime < timeoutMs) continue;
        const task = owner.checkpoint.tasks[String(urlIndex)];
        await claimFinalizer(owner, activity, {
          reason: 'timeout',
          skipSeal: false,
          result: (task, recovery) => (
            interruptionResult(task, recovery, 'timeout')
          )
        });
      }
      return true;
    })();
    try {
      return await owner.timeoutScan;
    } finally {
      owner.timeoutScan = null;
    }
  }

  async function handleUnexpectedClose(owner, activity) {
    if (lifecycle !== owner || owner.status !== 'running') return false;
    const handled = await claimFinalizer(owner, activity, {
      reason: 'unexpected_close',
      skipSeal: false,
      alreadyClosed: true,
      result: (task, recovery) => (
        interruptionResult(task, recovery, 'unexpected')
      )
    });
    if (handled) {
      owner.removedActivities.delete(identityKey(activity));
    }
    return handled;
  }

  async function shutdownOwner(owner, reason) {
    if (!owner || ['superseded', 'disposed'].includes(owner.status)) {
      return true;
    }
    owner.status = 'stopping';
    owner.recoveryPause = null;
    owner.scheduler.stop();
    stopTimeoutChecker(owner);

    const pendingReservations = [...owner.openings.values()];
    for (const reservation of pendingReservations) {
      cancelOpeningReservation(owner, reservation);
    }
    const finalizers = new Set(owner.finalizers.values());
    for (const reservation of pendingReservations) {
      finalizers.add(terminalizeOpening(owner, reservation, 'shutdown'));
    }
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      const activity = activityAt(owner, urlIndex);
      if (!activity) continue;
      finalizers.add(claimFinalizer(owner, activity, {
        reason,
        result: (task, recovery) => (
          interruptionResult(task, recovery, 'shutdown')
        )
      }));
    }
    const finalizerResults = await Promise.all([...finalizers]);
    await Promise.all(pendingReservations.map(
      (reservation) => reservation.settled || Promise.resolve()
    ));

    const unsafeResources = occupiedIndices(owner);
    if (
      finalizerResults.some((result) => result !== true) ||
      unsafeResources.size > 0
    ) {
      owner.status = 'paused_recovery';
      reconcileScheduler(owner);
      return false;
    }
    owner.manager.dispose?.();
    owner.status = reason === 'dispose' ? 'disposed' : 'superseded';
    return true;
  }

  async function start(checkpoint) {
    const entry = await enqueueLifecycle(async () => {
      const previous = lifecycle;
      if (previous) {
        const stopped = await shutdownOwner(previous, 'superseded');
        if (!stopped) {
          return { owner: previous, completion: null };
        }
        if (lifecycle === previous) lifecycle = null;
      }
      const scheduler = schedulerFactory({
        totalCount: checkpoint.source.parsedUrls.length,
        concurrency: checkpoint.settings.concurrency,
        processedIndices: terminalIndices(checkpoint)
      });
      const owner = {
        checkpoint,
        scheduler,
        status: 'running',
        recoveryPause: null,
        manager: null,
        removedActivities: new Map(),
        openings: new Map(),
        openTasks: new Set(),
        finalizers: new Map(),
        finalizingByIndex: new Map(),
        operationQueue: Promise.resolve(),
        timeoutTimer: null,
        timeoutScan: null,
        deadlines: null
      };
      owner.deadlines = taskDeadlineFactory({
        timers,
        now: clock,
        onExpire: (identity) => expireTask(owner, identity)
      });
      owner.manager = tabManagerFactory({
        tabsApi,
        windowId,
        now: clock,
        onUnexpectedClose(activity) {
          owner.removedActivities.set(identityKey(activity), activity);
          void handleUnexpectedClose(owner, activity).catch((error) => {
            pauseForRuntimeError(owner, error, 'unexpected_close');
          });
        }
      });
      lifecycle = owner;
      scheduler.start();
      startTimeoutChecker(owner);
      return {
        owner,
        completion: fillAvailable(owner)
      };
    });
    if (entry.completion) await entry.completion;
    return entry.owner.checkpoint;
  }

  async function handleConfirmation(message) {
    const owner = lifecycle;
    if (
      !owner ||
      owner.status !== 'running' ||
      !isBatchConfirmationFor(message, {
        batchId: owner.checkpoint.batchId,
        totalCount: owner.checkpoint.source.parsedUrls.length
      }) ||
      !Number.isInteger(message.attempt) ||
      !Number.isInteger(message.sourceTabId) ||
      !isDurableBatchConfirmation(message)
    ) {
      return false;
    }
    const activity = activityAt(owner, message.urlIndex);
    if (
      !activity ||
      activity.attempt !== message.attempt ||
      activity.tabId !== message.sourceTabId
    ) {
      return false;
    }
    return claimFinalizer(owner, activity, {
      reason: 'confirmation',
      result: confirmationResult(message),
      eventType: 'confirmed'
    });
  }

  async function acceptRemovedTabCheckpoint(message) {
    return enqueueLifecycle(async () => {
      const owner = lifecycle;
      if (!owner || ['disposed', 'superseded'].includes(owner.status)) {
        return false;
      }
      const removalKey = [
        message?.batchId || '',
        message?.urlIndex ?? '',
        message?.attempt ?? ''
      ].join(':');
      const pendingFinalizer = owner.finalizers.get(removalKey);
      if (pendingFinalizer) {
        await pendingFinalizer.catch(() => {});
      }
      return enqueue(owner, async () => {
        if (lifecycle !== owner) return false;
        const currentCheckpoint = owner.checkpoint;
        const urlIndex = message?.urlIndex;
        const activity = Number.isInteger(urlIndex)
          ? activityAt(owner, urlIndex)
          : null;
        const removedActivity =
          owner.removedActivities.get(removalKey) || null;
        const evidence = activity || removedActivity;
        const pausedRemovalAdoption =
          !activity &&
          removedActivity !== null &&
          owner.status === 'paused_recovery';
        const pageFirstRecovery =
          pausedRemovalAdoption &&
          owner.recoveryPause?.context === 'BATCH_TASK_TERMINAL' &&
          owner.recoveryPause?.removedActivityKey === removalKey;
        if (
          !evidence ||
          !['running', 'paused_recovery'].includes(owner.status) ||
          (
            owner.status === 'paused_recovery' &&
            !pausedRemovalAdoption
          ) ||
          evidence.batchId !== message?.batchId ||
          evidence.urlIndex !== urlIndex ||
          evidence.attempt !== message?.attempt ||
          evidence.tabId !== message?.tabId ||
          !isForwardRemovedTabCheckpoint(currentCheckpoint, message)
        ) {
          return false;
        }
        const forgotten = owner.manager.forgetRemoved?.(message.tabId);
        if (
          activity
            ? forgotten !== activity
            : forgotten !== null && forgotten !== undefined
        ) {
          return false;
        }
        owner.removedActivities.delete(removalKey);
        owner.deadlines?.clear(evidence);
        owner.checkpoint = message.checkpoint;
        if (pageFirstRecovery) restoreRemovedRaceOwner(owner);
        reconcileScheduler(owner);
        emit('changed', owner, {
          transition: 'BATCH_WORKER_TAB_REMOVED',
          recovered: pageFirstRecovery
        });
        if (
          owner.status === 'running' &&
          owner.checkpoint.status === 'running'
        ) {
          await replenishOrComplete(owner);
        }
        return true;
      });
    });
  }

  async function pauseOwner(owner, reason) {
    if (!owner || owner.status !== 'running') return owner?.checkpoint || null;
    owner.status = 'pausing';
    owner.recoveryPause = null;
    owner.scheduler.stop();
    stopTimeoutChecker(owner);

    const reservations = [...owner.openings.values()];
    for (const reservation of reservations) {
      cancelOpeningReservation(owner, reservation);
    }
    const finalizers = new Set(owner.finalizers.values());
    for (const reservation of reservations) {
      finalizers.add(terminalizeOpening(owner, reservation, 'pause'));
    }
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      const activity = activityAt(owner, urlIndex);
      if (!activity) continue;
      finalizers.add(claimFinalizer(owner, activity, {
        reason,
        result: (task, recovery) => (
          interruptionResult(task, recovery, 'pause')
        )
      }));
    }
    const finalizerResults = await Promise.all([...finalizers]);
    await Promise.all(reservations.map(
      (reservation) => reservation.settled || Promise.resolve()
    ));
    if (
      finalizerResults.some((result) => result !== true) ||
      occupiedIndices(owner).size > 0
    ) {
      owner.status = 'paused_recovery';
      reconcileScheduler(owner);
      return false;
    }
    if (lifecycle === owner && owner.status !== 'paused_recovery') {
      owner.status = 'paused';
    }
    reconcileScheduler(owner);
    return owner.checkpoint;
  }

  async function pause(reason = 'user') {
    return enqueueLifecycle(() => pauseOwner(lifecycle, reason));
  }

  async function refill(checkpoint) {
    const owner = lifecycle;
    if (
      !owner ||
      owner.status !== 'running' ||
      checkpoint?.batchId !== owner.checkpoint.batchId
    ) {
      return false;
    }
    return enqueue(owner, async () => {
      if (lifecycle !== owner || owner.status !== 'running') return false;
      owner.checkpoint = checkpoint;
      reconcileScheduler(owner);
      await replenishOrComplete(owner);
      return true;
    });
  }

  async function resume(checkpoint) {
    const entry = await enqueueLifecycle(() => {
      const owner = lifecycle;
      if (
        !owner ||
        !['paused', 'paused_recovery'].includes(owner.status) ||
        checkpoint?.batchId !== owner.checkpoint.batchId ||
        occupiedIndices(owner).size > 0
      ) {
        return { accepted: false, completion: null };
      }
      owner.checkpoint = checkpoint;
      owner.status = 'running';
      owner.recoveryPause = null;
      reconcileScheduler(owner);
      startTimeoutChecker(owner);
      return {
        accepted: true,
        completion: replenishOrComplete(owner)
      };
    });
    if (!entry.accepted) return false;
    await entry.completion;
    return true;
  }

  async function stop() {
    return enqueueLifecycle(async () => {
      const owner = lifecycle;
      if (!owner) return null;
      if (owner.status === 'running') {
        const paused = await pauseOwner(owner, 'stop');
        if (paused === false) return false;
      }
      if (owner.status === 'paused_recovery') return false;
      if (lifecycle === owner && owner.status !== 'paused_recovery') {
        owner.status = 'stopped';
        owner.manager.dispose?.();
      }
      return owner.checkpoint;
    });
  }

  async function focus(urlIndex) {
    const owner = lifecycle;
    if (!owner) return null;
    try {
      if (typeof owner.manager.focusByIndex === 'function') {
        return await owner.manager.focusByIndex(urlIndex);
      }
      const activity = activityAt(owner, urlIndex);
      if (!activity) return null;
      await tabsApi.update(activity.tabId, { active: true });
      return activity;
    } catch (error) {
      pauseForRuntimeError(owner, error, 'worker_tab_focus');
      return null;
    }
  }

  async function dispose() {
    return enqueueLifecycle(async () => {
      const owner = lifecycle;
      if (!owner) return null;
      const stopped = await shutdownOwner(owner, 'dispose');
      if (!stopped) return false;
      if (lifecycle === owner) lifecycle = null;
      return owner.checkpoint;
    });
  }

  function quiesce() {
    const owner = lifecycle;
    if (!owner || ['disposed', 'superseded'].includes(owner.status)) {
      return true;
    }
    owner.status = 'quiescing';
    owner.recoveryPause = null;
    owner.scheduler.stop();
    stopTimeoutChecker(owner);
    for (const reservation of owner.openings.values()) {
      cancelOpeningReservation(owner, reservation);
    }
    owner.manager.quiesce?.();
    return true;
  }

  function retainAfterFailedBackgroundTeardown() {
    const owner = lifecycle;
    if (!owner) return true;
    owner.status = 'paused_recovery';
    owner.recoveryPause = null;
    owner.manager.resumeObservation?.();
    return true;
  }

  async function disposeAfterBackgroundTeardown() {
    return enqueueLifecycle(async () => {
      const owner = lifecycle;
      if (!owner) return null;
      owner.status = 'stopping';
      owner.recoveryPause = null;
      owner.scheduler.stop();
      stopTimeoutChecker(owner);
      const reservations = [...owner.openings.values()];
      for (const reservation of reservations) {
        cancelOpeningReservation(owner, reservation);
      }
      await Promise.all(reservations.map(
        (reservation) => reservation.settled || Promise.resolve()
      ));
      let cleanupComplete = true;
      const totalCount = owner.checkpoint.source.parsedUrls.length;
      for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
        const activity = activityAt(owner, urlIndex);
        if (!activity) continue;
        if (!await closeActivity(owner, activity)) cleanupComplete = false;
      }
      if (!cleanupComplete || occupiedIndices(owner).size > 0) {
        owner.status = 'paused_recovery';
        return false;
      }
      owner.manager.dispose?.();
      owner.status = 'disposed';
      if (lifecycle === owner) lifecycle = null;
      return owner.checkpoint;
    });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    handleConfirmation,
    acceptRemovedTabCheckpoint,
    pause,
    resume,
    refill,
    stop,
    focus,
    dispose,
    quiesce,
    retainAfterFailedBackgroundTeardown,
    disposeAfterBackgroundTeardown,
    subscribe
  };
}
