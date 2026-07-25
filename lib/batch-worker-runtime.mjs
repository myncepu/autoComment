import { BatchScheduler } from './batch-scheduler.mjs';
import { BatchTabManager } from './batch-window-manager.mjs';

function terminalIndices(checkpoint) {
  return Object.values(checkpoint.tasks || {})
    .filter((task) => task?.state === 'terminal')
    .map((task) => task.urlIndex);
}

function requireRuntimeResponse(response) {
  if (!response?.ok) {
    const error = new Error(response?.error || 'batch_runtime_failed');
    error.code = response?.error || 'batch_runtime_failed';
    throw error;
  }
  return response;
}

function errorText(error) {
  return String(error?.message || error || 'unknown_error');
}

function unavailableReasonForError(error) {
  const message = errorText(error);
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

function createContentScriptUnavailableError(reason, state) {
  const tab = state.tab || {};
  const lastError = state.lastError || 'none';
  const change = state.navigation.lastChangeInfo
    ? JSON.stringify(state.navigation.lastChangeInfo)
    : 'none';
  const message = [
    '目标页面内容脚本不可用',
    `reason=${reason}`,
    `tabId=${state.tabId}`,
    `status=${tab.status || 'unknown'}`,
    `url=${tab.url || 'unknown'}`,
    `pendingUrl=${tab.pendingUrl || 'none'}`,
    `discarded=${tab.discarded === true}`,
    `navigation=${state.navigation.lastTrigger || 'initial'}:${change}`,
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
    tab: {
      url: tab.url || null,
      pendingUrl: tab.pendingUrl || null,
      status: tab.status || null,
      discarded: tab.discarded === true
    },
    navigation: { ...state.navigation }
  };
  return error;
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

    const cleanup = () => {
      if (retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
      }
      tabsApi.onUpdated?.removeListener(handleUpdated);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (reason) => {
      state.elapsedMs = Math.max(0, clock() - startedAt);
      finish(reject, createContentScriptUnavailableError(reason, state));
    };
    const scheduleProbe = () => {
      if (settled || retryTimer !== null || pendingProbe) return;
      const remaining = timeoutMs - Math.max(0, clock() - startedAt);
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        requestProbe('poll');
      }, Math.max(0, Math.min(pollIntervalMs, remaining)));
    };
    const requestProbe = (trigger, changeInfo = null) => {
      if (settled) return;
      state.navigation.lastTrigger = trigger;
      state.navigation.lastUpdatedAt = clock();
      if (changeInfo && Object.keys(changeInfo).length > 0) {
        state.navigation.lastChangeInfo = { ...changeInfo };
      }
      if (probing) {
        pendingProbe = true;
        return;
      }
      void probe();
    };
    const probe = async () => {
      probing = true;
      try {
        state.elapsedMs = Math.max(0, clock() - startedAt);
        if (state.elapsedMs >= timeoutMs) {
          fail('timeout');
          return;
        }

        try {
          state.tab = await tabsApi.get(activity.tabId);
        } catch (error) {
          state.lastError = errorText(error);
          fail(unavailableReasonForError(error) || 'tab_query_failed');
          return;
        }
        if (settled) return;

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
          if (response?.ok === true) {
            finish(resolve, {
              tab: state.tab,
              elapsedMs: Math.max(0, clock() - startedAt)
            });
            return;
          }
          state.lastError = `PING 未确认就绪：${JSON.stringify(response)}`;
        } catch (error) {
          state.lastError = errorText(error);
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
      urlIndex: activity.urlIndex,
      attempt: activity.attempt,
      url: activity.url
    }),
    clock = Date.now,
    timers = globalThis,
    readinessTimeoutMs = 30000,
    readinessPollIntervalMs = 250,
    sealSubmitContext = async () => ({ sealed: true, recovered: false }),
    schedulerFactory = (options) => new BatchScheduler(options),
    tabManagerFactory = dependencies.windowManagerFactory ||
      ((options) => new BatchTabManager(options))
  } = dependencies;

  let lifecycle = null;
  const listeners = new Set();

  function emit(type, owner, details = {}) {
    const event = {
      type,
      checkpoint: owner.checkpoint,
      ...details
    };
    for (const listener of [...listeners]) listener(event);
    dependencies.onEvent?.(event);
  }

  function stopTimeoutChecker(owner) {
    if (owner?.timeoutTimer !== null && owner?.timeoutTimer !== undefined) {
      timers.clearInterval(owner.timeoutTimer);
      owner.timeoutTimer = null;
    }
  }

  async function closeActivity(manager, activity) {
    if (typeof manager.close === 'function') {
      return manager.close(activity);
    }
    if (
      manager.getByIndex(activity.urlIndex) === activity &&
      typeof manager.closeByIndex === 'function'
    ) {
      return manager.closeByIndex(activity.urlIndex);
    }
    return null;
  }

  async function finishUnavailable(owner, activity, error) {
    if (lifecycle !== owner) {
      await closeActivity(owner.manager, activity);
      owner.scheduler.settle(activity.urlIndex);
      return false;
    }
    if (
      owner.manager.getByIndex(activity.urlIndex) !== activity
    ) {
      return false;
    }
    const response = requireRuntimeResponse(await runtimeRequest(
      'BATCH_TASK_TERMINAL',
      {
        batchId: activity.batchId,
        urlIndex: activity.urlIndex,
        attempt: activity.attempt,
        result: {
          result: 'fail',
          aiContent: null,
          errorCode: 'content_script_unavailable',
          errorMessage: errorText(error)
        }
      }
    ));
    owner.checkpoint = response.checkpoint || owner.checkpoint;
    emit('runtime-error', owner, { error });
    if (lifecycle !== owner) return false;
    await closeActivity(owner.manager, activity);
    owner.scheduler.settle(activity.urlIndex);
    await replenishOrComplete(owner);
    return true;
  }

  async function open(urlIndex, owner) {
    const task = owner.checkpoint.tasks[String(urlIndex)];
    const item = owner.checkpoint.source.parsedUrls[urlIndex];
    const reservation = {
      batchId: owner.checkpoint.batchId,
      urlIndex,
      attempt: task.attempt,
      startTime: clock()
    };
    owner.openings.set(urlIndex, reservation);
    let activity;
    try {
      activity = await owner.manager.create({
        batchId: reservation.batchId,
        urlIndex,
        attempt: reservation.attempt,
        url: item.url
      });
    } catch (error) {
      if (
        lifecycle !== owner ||
        owner.openings.get(urlIndex) !== reservation
      ) {
        return;
      }
      owner.openings.delete(urlIndex);
      const response = requireRuntimeResponse(await runtimeRequest(
        'BATCH_TASK_TERMINAL',
        {
          batchId: reservation.batchId,
          urlIndex,
          attempt: reservation.attempt,
          result: {
            result: 'fail',
            aiContent: null,
            errorCode: 'window_create_failed',
            errorMessage: `标签页创建失败：${errorText(error)}`
          }
        }
      ));
      owner.checkpoint = response.checkpoint || owner.checkpoint;
      owner.scheduler.settle(urlIndex);
      if (owner.status === 'running') await fillAvailable(owner);
      return;
    }
    if (
      lifecycle !== owner ||
      owner.status !== 'running' ||
      owner.openings.get(urlIndex) !== reservation ||
      owner.checkpoint.tasks[String(urlIndex)]?.state === 'terminal'
    ) {
      await closeActivity(owner.manager, activity);
      return;
    }
    owner.openings.delete(urlIndex);
    const response = requireRuntimeResponse(await runtimeRequest(
      'BATCH_TASK_ACTIVE',
      {
        batchId: activity.batchId,
        urlIndex,
        attempt: activity.attempt,
        tabId: activity.tabId,
        windowId: activity.windowId,
        startedAt: activity.startTime
      }
    ));
    owner.checkpoint = response.checkpoint || owner.checkpoint;
    emit('changed', owner);
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
        owner.manager.getByIndex(urlIndex) !== activity
      ) {
        return;
      }
      const handleResponse = await sendHandle(activity);
      if (handleResponse && handleResponse.ok === false) {
        const error = new Error(
          handleResponse.error || 'BATCH_HANDLE 未被内容脚本接受'
        );
        error.code = 'content_script_unavailable';
        error.reason = 'handle_rejected';
        throw error;
      }
      if (lifecycle !== owner || owner.status !== 'running') {
        await closeActivity(owner.manager, activity);
        owner.scheduler.settle(activity.urlIndex);
      }
    } catch (error) {
      if (error?.code !== 'content_script_unavailable') {
        const deliveryError = createContentScriptUnavailableError(
          unavailableReasonForError(error) || 'handle_delivery_failed',
          {
            tabId: activity.tabId,
            tab: await tabsApi.get(activity.tabId).catch(() => null),
            lastError: errorText(error),
            elapsedMs: Math.max(0, clock() - activity.startTime),
            navigation: {
              lastTrigger: 'BATCH_HANDLE',
              lastUpdatedAt: clock(),
              lastChangeInfo: null
            }
          }
        );
        await finishUnavailable(owner, activity, deliveryError);
        return;
      }
      await finishUnavailable(owner, activity, error);
    }
  }

  async function fillAvailable(owner) {
    const indices = owner.scheduler.takeAvailable();
    await Promise.all(indices.map((urlIndex) => open(urlIndex, owner)));
  }

  async function complete(owner) {
    if (
      lifecycle !== owner ||
      owner.status !== 'running' ||
      !owner.scheduler.isComplete
    ) {
      return false;
    }
    owner.status = 'completing';
    stopTimeoutChecker(owner);
    const response = requireRuntimeResponse(await runtimeRequest(
      'BATCH_SESSION_COMPLETE',
      { batchId: owner.checkpoint.batchId }
    ));
    if (lifecycle !== owner) return false;
    owner.checkpoint = response.checkpoint || owner.checkpoint;
    owner.status = 'completed';
    emit('changed', owner);
    return true;
  }

  async function replenishOrComplete(owner) {
    if (lifecycle !== owner || owner.status !== 'running') return false;
    if (owner.scheduler.isComplete) return complete(owner);
    await fillAvailable(owner);
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
      for (const urlIndex of [...owner.scheduler.activeIndices]) {
        if (lifecycle !== owner || owner.status !== 'running') break;
        const activity = owner.manager.getByIndex(urlIndex);
        const opening = owner.openings.get(urlIndex);
        if (!activity && opening && clock() - opening.startTime >= timeoutMs) {
          owner.openings.delete(urlIndex);
          const response = requireRuntimeResponse(await runtimeRequest(
            'BATCH_TASK_TERMINAL',
            {
              batchId: opening.batchId,
              urlIndex,
              attempt: opening.attempt,
              result: {
                result: 'fail',
                aiContent: null,
                errorCode: 'task_timeout',
                errorMessage: '标签页创建超时'
              }
            }
          ));
          owner.checkpoint = response.checkpoint || owner.checkpoint;
          if (lifecycle !== owner) break;
          owner.scheduler.settle(urlIndex);
          await replenishOrComplete(owner);
          continue;
        }
        if (!activity || clock() - activity.startTime < timeoutMs) {
          continue;
        }
        const recovery = await sealSubmitContext(activity, 'timeout');
        if (lifecycle !== owner) {
          await closeActivity(owner.manager, activity);
          owner.scheduler.settle(urlIndex);
          break;
        }
        if (owner.manager.getByIndex(urlIndex) !== activity) {
          break;
        }
        const uncertain = recovery?.recovered ||
          recovery?.sealed === false;
        const response = requireRuntimeResponse(await runtimeRequest(
          'BATCH_TASK_TERMINAL',
          {
            batchId: activity.batchId,
            urlIndex,
            attempt: activity.attempt,
            result: {
              result: uncertain ? 'manual_required' : 'fail',
              aiContent: null,
              errorCode: uncertain
                ? 'submission_uncertain'
                : 'task_timeout',
              errorMessage: uncertain
                ? '处理超时；未确认提交的上下文已保留待人工确认'
                : '处理超时'
            }
          }
        ));
        owner.checkpoint = response.checkpoint || owner.checkpoint;
        if (lifecycle !== owner) {
          await closeActivity(owner.manager, activity);
          owner.scheduler.settle(urlIndex);
          break;
        }
        await closeActivity(owner.manager, activity);
        owner.scheduler.settle(urlIndex);
        await replenishOrComplete(owner);
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
    const task = owner.checkpoint.tasks[String(activity.urlIndex)];
    if (!task || task.attempt !== activity.attempt) return false;
    const response = requireRuntimeResponse(await runtimeRequest(
      'BATCH_TASK_TERMINAL',
      {
        batchId: activity.batchId,
        urlIndex: activity.urlIndex,
        attempt: activity.attempt,
        result: {
          result: 'fail',
          aiContent: null,
          errorCode: 'task_failed',
          errorMessage: '用户关闭了自动 worker 标签页'
        }
      }
    ));
    owner.checkpoint = response.checkpoint || owner.checkpoint;
    if (lifecycle !== owner) return false;
    owner.scheduler.settle(activity.urlIndex);
    await replenishOrComplete(owner);
    return true;
  }

  async function start(checkpoint) {
    const previous = lifecycle;
    if (previous) {
      previous.status = 'superseded';
      stopTimeoutChecker(previous);
      previous.manager.dispose?.();
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
      timeoutTimer: null,
      timeoutScan: null
    };
    owner.manager = tabManagerFactory({
      tabsApi,
      windowId,
      now: clock,
      onUnexpectedClose(activity) {
        void handleUnexpectedClose(owner, activity);
      }
    });
    lifecycle = owner;
    scheduler.start();
    owner.timeoutTimer = timers.setInterval(
      () => checkTimeouts(owner),
      1000
    );
    await fillAvailable(owner);
    return owner.checkpoint;
  }

  async function handleConfirmation(message) {
    const owner = lifecycle;
    if (
      !owner ||
      owner.status !== 'running' ||
      message?.batchId !== owner.checkpoint.batchId
    ) {
      return false;
    }
    const activity = owner.manager.getByIndex(message.urlIndex);
    if (
      !activity ||
      activity.attempt !== message.attempt ||
      (
        Number.isInteger(message.sourceTabId) &&
        activity.tabId !== message.sourceTabId
      )
    ) {
      return false;
    }

    await sealSubmitContext(activity, 'confirmation');
    if (lifecycle !== owner || owner.manager.getByIndex(message.urlIndex) !== activity) {
      if (lifecycle !== owner) {
        await closeActivity(owner.manager, activity);
        owner.scheduler.settle(activity.urlIndex);
      }
      return false;
    }
    const response = requireRuntimeResponse(await runtimeRequest(
      'BATCH_TASK_TERMINAL',
      {
        batchId: activity.batchId,
        urlIndex: activity.urlIndex,
        attempt: activity.attempt,
        result: {
          result: message.result || 'success',
          aiContent: message.aiContent || null,
          errorCode: message.errorCode || null,
          errorMessage: message.errorMessage || null
        }
      }
    ));
    owner.checkpoint = response.checkpoint || owner.checkpoint;
    if (lifecycle !== owner) {
      await closeActivity(owner.manager, activity);
      owner.scheduler.settle(activity.urlIndex);
      return false;
    }
    await closeActivity(owner.manager, activity);
    owner.scheduler.settle(activity.urlIndex);
    emit('confirmed', owner, {
      urlIndex: activity.urlIndex,
      attempt: activity.attempt
    });
    await replenishOrComplete(owner);
    return true;
  }

  async function pause(reason = 'user') {
    const owner = lifecycle;
    if (!owner || owner.status !== 'running') return owner?.checkpoint || null;
    owner.status = 'paused';
    owner.scheduler.stop();
    stopTimeoutChecker(owner);

    const indices = [...owner.scheduler.activeIndices].sort((a, b) => a - b);
    for (const urlIndex of indices) {
      const activity = owner.manager.getByIndex(urlIndex);
      if (!activity) {
        owner.scheduler.settle(urlIndex);
        continue;
      }
      const recovery = await sealSubmitContext(activity, reason);
      if (lifecycle !== owner) {
        await closeActivity(owner.manager, activity);
        owner.scheduler.settle(urlIndex);
        return owner.checkpoint;
      }
      const uncertain = recovery?.recovered || recovery?.sealed === false;
      const response = requireRuntimeResponse(await runtimeRequest(
        'BATCH_TASK_TERMINAL',
        {
          batchId: activity.batchId,
          urlIndex: activity.urlIndex,
          attempt: activity.attempt,
          result: {
            result: uncertain ? 'manual_required' : 'fail',
            aiContent: null,
            errorCode: uncertain ? 'submission_uncertain' : 'task_failed',
            errorMessage: uncertain
              ? '批次暂停；未确认提交的上下文已保留待人工确认'
              : '批次已暂停'
          }
        }
      ));
      owner.checkpoint = response.checkpoint || owner.checkpoint;
      if (lifecycle !== owner) {
        await closeActivity(owner.manager, activity);
        owner.scheduler.settle(urlIndex);
        return owner.checkpoint;
      }
      await closeActivity(owner.manager, activity);
      owner.scheduler.settle(urlIndex);
    }
    return owner.checkpoint;
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
    owner.checkpoint = checkpoint;
    const activeIndices = owner.scheduler.activeIndices.filter(
      (urlIndex) => (
        owner.manager.getByIndex(urlIndex) &&
        checkpoint.tasks[String(urlIndex)]?.state !== 'terminal'
      )
    );
    owner.scheduler.reconcile({
      processedIndices: terminalIndices(checkpoint),
      activeIndices
    });
    await fillAvailable(owner);
    return true;
  }

  async function resume(checkpoint) {
    const owner = lifecycle;
    if (
      !owner ||
      owner.status !== 'paused' ||
      checkpoint?.batchId !== owner.checkpoint.batchId
    ) {
      return false;
    }
    owner.checkpoint = checkpoint;
    owner.scheduler.reconcile({
      processedIndices: terminalIndices(checkpoint),
      activeIndices: []
    });
    owner.scheduler.start();
    owner.status = 'running';
    owner.timeoutTimer = timers.setInterval(
      () => checkTimeouts(owner),
      1000
    );
    await fillAvailable(owner);
    return true;
  }

  async function stop() {
    const owner = lifecycle;
    if (!owner) return null;
    if (owner.status === 'running') {
      await pause('stop');
    }
    if (lifecycle === owner) owner.status = 'stopped';
    return owner.checkpoint;
  }

  async function focus(urlIndex) {
    const owner = lifecycle;
    if (!owner) return null;
    if (typeof owner.manager.focusByIndex === 'function') {
      return owner.manager.focusByIndex(urlIndex);
    }
    const activity = owner.manager.getByIndex(urlIndex);
    if (!activity) return null;
    await tabsApi.update(activity.tabId, { active: true });
    return activity;
  }

  function dispose() {
    const owner = lifecycle;
    if (!owner) return;
    lifecycle = null;
    owner.status = 'disposed';
    stopTimeoutChecker(owner);
    owner.manager.dispose?.();
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
    subscribe
  };
}
