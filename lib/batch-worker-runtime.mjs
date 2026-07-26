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
        if (
          state.tab.status === 'loading' ||
          Boolean(state.tab.pendingUrl)
        ) {
          return;
        }

        try {
          const response = await tabsApi.sendMessage(
            activity.tabId,
            { type: 'PING' }
          );
          if (deadlineClaimed) return;
          if (response?.ok === true) {
            finish(resolve, {
              tab: state.tab,
              elapsedMs: Math.max(0, clock() - startedAt)
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
    sealSubmitContext = async () => ({ sealed: true, recovered: false }),
    schedulerFactory = (options) => new BatchScheduler(options),
    tabManagerFactory = (options) => new BatchTabManager(options)
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
  }

  function pauseForRuntimeError(owner, error, context) {
    const safe = safeError(error);
    if (!['completed', 'stopped', 'superseded', 'disposed'].includes(owner.status)) {
      owner.status = 'paused_recovery';
    }
    owner.scheduler.stop();
    stopTimeoutChecker(owner);
    emit('runtime-error', owner, {
      error: safe,
      context: sanitizeDiagnosticText(context || 'runtime')
    });
    return safe;
  }

  async function transition(owner, type, payload) {
    try {
      const response = await runtimeRequest(type, payload);
      if (!response?.ok) {
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
      pauseForRuntimeError(owner, error, type);
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
    const messages = {
      timeout: ['处理超时', '处理超时；未确认提交的上下文已保留待人工确认'],
      pause: ['批次已暂停', '批次暂停；未确认提交的上下文已保留待人工确认'],
      shutdown: ['批次已被替换或关闭', '批次替换；未确认提交的上下文已保留待人工确认'],
      unexpected: ['用户关闭了自动 worker 标签页', 'worker 标签页在提交确认期间被关闭']
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
    if (!options.skipSeal && !options.alreadyClosed) {
      try {
        recovery = await sealSubmitContext(activity, options.reason);
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
    const response = await transition(owner, 'BATCH_TASK_TERMINAL', {
      ...taskMessageIdentity(owner.checkpoint, activity.urlIndex),
      result: sanitizeTerminalResult(rawResult)
    });
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
      settled: null
    };
    owner.openings.set(urlIndex, reservation);
    reconcileScheduler(owner);

    const run = (async () => {
      let activity;
      try {
        activity = await owner.manager.create({
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
        });
        reservation.activity = activity;
      } catch (error) {
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
        if (
          lifecycle !== owner &&
          activityAt(owner, urlIndex) !== activity
        ) {
          return false;
        }
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
          opening.cancelled = true;
          await terminalizeOpening(owner, opening, 'timeout');
          continue;
        }
        const activity = activityAt(owner, urlIndex);
        if (!activity || clock() - activity.startTime < timeoutMs) continue;
        await claimFinalizer(owner, activity, {
          reason: 'timeout',
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
    return claimFinalizer(owner, activity, {
      reason: 'unexpected_close',
      skipSeal: true,
      alreadyClosed: true,
      result: (task) => interruptionResult(task, null, 'unexpected')
    });
  }

  async function shutdownOwner(owner, reason) {
    if (!owner || ['superseded', 'disposed'].includes(owner.status)) {
      return true;
    }
    owner.status = 'stopping';
    owner.scheduler.stop();
    stopTimeoutChecker(owner);

    const pendingReservations = [...owner.openings.values()];
    for (const reservation of pendingReservations) {
      reservation.cancelled = true;
    }
    const finalizers = [];
    for (const reservation of pendingReservations) {
      finalizers.push(terminalizeOpening(owner, reservation, 'shutdown'));
    }
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      const activity = activityAt(owner, urlIndex);
      if (!activity) continue;
      finalizers.push(claimFinalizer(owner, activity, {
        reason,
        result: (task, recovery) => (
          interruptionResult(task, recovery, 'shutdown')
        )
      }));
    }
    const finalizerResults = await Promise.all(finalizers);
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
        manager: null,
        openings: new Map(),
        openTasks: new Set(),
        finalizers: new Map(),
        finalizingByIndex: new Map(),
        operationQueue: Promise.resolve(),
        timeoutTimer: null,
        timeoutScan: null
      };
      owner.manager = tabManagerFactory({
        tabsApi,
        windowId,
        now: clock,
        onUnexpectedClose(activity) {
          void handleUnexpectedClose(owner, activity).catch((error) => {
            pauseForRuntimeError(owner, error, 'unexpected_close');
          });
        }
      });
      lifecycle = owner;
      scheduler.start();
      owner.timeoutTimer = timers.setInterval(
        () => checkTimeouts(owner).catch((error) => {
          pauseForRuntimeError(owner, error, 'timeout_scan');
        }),
        1000
      );
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

  async function pauseOwner(owner, reason) {
    if (!owner || owner.status !== 'running') return owner?.checkpoint || null;
    owner.status = 'pausing';
    owner.scheduler.stop();
    stopTimeoutChecker(owner);

    const reservations = [...owner.openings.values()];
    for (const reservation of reservations) reservation.cancelled = true;
    const finalizers = reservations.map(
      (reservation) => terminalizeOpening(owner, reservation, 'pause')
    );
    const totalCount = owner.checkpoint.source.parsedUrls.length;
    for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
      const activity = activityAt(owner, urlIndex);
      if (!activity) continue;
      finalizers.push(claimFinalizer(owner, activity, {
        reason,
        result: (task, recovery) => (
          interruptionResult(task, recovery, 'pause')
        )
      }));
    }
    const finalizerResults = await Promise.all(finalizers);
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
      reconcileScheduler(owner);
      owner.timeoutTimer = timers.setInterval(
        () => checkTimeouts(owner).catch((error) => {
          pauseForRuntimeError(owner, error, 'timeout_scan');
        }),
        1000
      );
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
    owner.scheduler.stop();
    stopTimeoutChecker(owner);
    for (const reservation of owner.openings.values()) {
      reservation.cancelled = true;
    }
    owner.manager.quiesce?.();
    return true;
  }

  function retainAfterFailedBackgroundTeardown() {
    const owner = lifecycle;
    if (!owner) return true;
    owner.status = 'paused_recovery';
    owner.manager.resumeObservation?.();
    return true;
  }

  async function disposeAfterBackgroundTeardown() {
    return enqueueLifecycle(async () => {
      const owner = lifecycle;
      if (!owner) return null;
      owner.status = 'stopping';
      owner.scheduler.stop();
      stopTimeoutChecker(owner);
      const reservations = [...owner.openings.values()];
      for (const reservation of reservations) reservation.cancelled = true;
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
