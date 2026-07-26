import {
  getBatchError,
  getBatchRetryPolicy
} from './batch-error-policy.mjs';

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function clampInteger(value, minimum, maximum, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(Number(value))));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function elapsedFromResult(result) {
  return Number.isFinite(result?.elapsed)
    ? Math.max(0, Math.round(result.elapsed * 1000))
    : null;
}

function elapsedForTask(task, result, now) {
  if (result) return elapsedFromResult(result);
  if (['active', 'submitting'].includes(task?.state) &&
    Number.isFinite(task.startedAt)) {
    return Math.max(0, now - task.startedAt);
  }
  return null;
}

function errorForResult(result) {
  if (!result?.errorCode) return null;
  return getBatchError(result.errorCode);
}

function resultForAttempt(resultsByTask, urlIndex, attempt) {
  return resultsByTask.get(`${urlIndex}:${attempt}`) || null;
}

function attemptHistory(results, currentAttempt) {
  return results
    .filter((result) => result.attempt < currentAttempt)
    .sort((left, right) => left.attempt - right.attempt)
    .map((result) => ({
      attempt: result.attempt,
      result: result.result,
      error: errorForResult(result),
      timestamp: finiteOrNull(result.timestamp),
      elapsedMs: elapsedFromResult(result)
    }));
}

function rowStatus(task, result) {
  if (task.state === 'queued') return 'queued';
  if (task.state === 'active' || task.state === 'submitting') return 'running';
  if (task.manualResolution?.status !== 'idle' ||
    ['manual_required', 'no_comment_box'].includes(result?.result)) {
    return 'manual';
  }
  if (['success', 'skipped'].includes(result?.result)) return 'success';
  return 'failed';
}

function actionsForRow(task, retryPolicy) {
  const actions = ['details'];
  if (['active', 'submitting'].includes(task.state) &&
    Number.isInteger(task.tabId)) {
    actions.push('focus-tab');
  }
  if (task.state === 'terminal' && retryPolicy !== 'blocked') {
    actions.push('retry');
  }
  return actions;
}

function timestampForRow(task, result) {
  return finiteOrNull(result?.timestamp) ?? finiteOrNull(task.updatedAt);
}

function makeRow({ batchId, item, task, results, resultsByTask, now }) {
  const currentResult = resultForAttempt(resultsByTask, task.urlIndex, task.attempt);
  const retryPolicy = getBatchRetryPolicy(currentResult || {});
  return {
    taskId: `${batchId}:${task.urlIndex}:${task.attempt}`,
    urlIndex: task.urlIndex,
    attempt: task.attempt,
    url: String(item?.url || ''),
    domain: String(item?.sourceDomain || ''),
    state: task.state,
    phase: task.phase || null,
    elapsedMs: elapsedForTask(task, currentResult, now),
    result: currentResult?.result || null,
    error: errorForResult(currentResult),
    errorMessage: typeof currentResult?.errorMessage === 'string'
      ? currentResult.errorMessage
      : null,
    retryPolicy,
    actions: actionsForRow(task, retryPolicy),
    manualResolution: {
      status: task.manualResolution?.status || 'idle',
      updatedAt: finiteOrNull(task.manualResolution?.updatedAt)
    },
    attemptHistory: attemptHistory(results, task.attempt),
    aiContent: currentResult?.aiContent || null,
    timestamp: timestampForRow(task, currentResult),
    status: rowStatus(task, currentResult)
  };
}

function assignmentFor(checkpoint, options, concurrency, timeoutSeconds) {
  const settings = checkpoint?.settings || {};
  const source = options.assignment || settings.assignment || {};
  const identityId = text(source.identityId);
  const identityName = text(source.identitySnapshot?.displayName);
  const promotionId = text(source.promotionSiteId);
  const promotionLabel = text(source.promotionSiteSnapshot?.label);
  let identityLabel = text(source.identityLabel);
  if (!identityLabel && identityName) {
    identityLabel = identityId === 'default-identity'
      ? `默认身份 · ${identityName}`
      : identityName;
  }
  identityLabel ||= identityId || '未分配';

  const autoSubmit = settings.autoSubmit === true;
  const autoGenerate = autoSubmit || settings.autoGenerate === true;
  const automationLabel = text(source.automationLabel) || (
    autoSubmit
      ? '生成并自动提交'
      : autoGenerate
        ? '仅自动生成'
        : '人工处理'
  );
  return {
    identityLabel,
    promotionSiteLabel: text(source.promotionSiteLabel) ||
      promotionLabel ||
      promotionId ||
      '未分配',
    automationLabel,
    limitsLabel: text(source.limitsLabel) ||
      `并发 ${concurrency} · 超时 ${timeoutSeconds}s`
  };
}

function commandFor({
  status,
  batchId,
  rowCount,
  online,
  persistencePending,
  inFlight,
  resultMessage
}) {
  const busy = Boolean(inFlight);
  const hasBatch = Boolean(batchId);
  const isRunning = status === 'running';
  const isPaused = status === 'paused_recovery';
  return {
    inFlight,
    canPause: !busy && isRunning && online,
    canResume: !busy && isPaused && online && !persistencePending,
    canStop: !busy && hasBatch &&
      (isRunning || isPaused),
    canExport: !busy && hasBatch && rowCount > 0,
    canCreate: !busy && (!hasBatch || !isRunning),
    resultMessage
  };
}

function bannersFor(checkpoint, options, {
  online,
  persistencePending,
  status
}) {
  if (Array.isArray(options.banners)) {
    return options.banners.map((banner) => ({
      kind: text(banner?.kind) || 'notice',
      title: text(banner?.title),
      message: text(banner?.message)
    }));
  }
  const banners = [];
  if (!online) {
    banners.push({
      kind: 'offline',
      title: '当前离线',
      message: '批次已安全暂停；恢复在线后仍需手动继续。'
    });
  }
  if (persistencePending) {
    banners.push({
      kind: 'persistence',
      title: '恢复检查点尚未持久化',
      message: '继续处理已锁定，请保留当前页面并重试保存。'
    });
  } else if (status === 'paused_recovery' && online) {
    banners.push({
      kind: 'recovery',
      title: '已从检查点安全恢复',
      message: '任务不会自动继续；请检查后手动恢复。'
    });
  }
  const runtimeError = options.runtimeError;
  if (runtimeError) {
    banners.push({
      kind: 'error',
      title: '运行时发生错误',
      message: text(runtimeError.errorCode || runtimeError) ||
        'batch_runtime_failed'
    });
  }
  return banners;
}

export function createBatchConsoleSnapshot(checkpoint, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const status = checkpoint?.batchId
    ? checkpoint?.status || 'paused_recovery'
    : 'empty';
  const batchId = String(checkpoint?.batchId || '');
  const online = options.online !== false;
  const persistencePending = checkpoint?.persistencePending === true ||
    options.persistencePending === true;
  const concurrency = clampInteger(
    checkpoint?.settings?.concurrency,
    1,
    10,
    3
  );
  const timeoutSeconds = clampInteger(
    checkpoint?.settings?.timeoutSeconds,
    10,
    600,
    60
  );
  const parsedUrls = Array.isArray(checkpoint?.source?.parsedUrls)
    ? checkpoint.source.parsedUrls
    : [];
  const tasks = checkpoint?.tasks && typeof checkpoint.tasks === 'object'
    ? checkpoint.tasks
    : {};
  const results = Array.isArray(checkpoint?.results) ? checkpoint.results : [];
  const resultsByTask = new Map();
  const resultsByUrlIndex = new Map();

  for (const result of results) {
    if (!Number.isInteger(result?.originalIndex) ||
      !Number.isInteger(result?.attempt)) continue;
    resultsByTask.set(`${result.originalIndex}:${result.attempt}`, result);
    const prior = resultsByUrlIndex.get(result.originalIndex) || [];
    prior.push(result);
    resultsByUrlIndex.set(result.originalIndex, prior);
  }

  const rows = parsedUrls.map((item, urlIndex) => {
    const task = tasks[String(urlIndex)] || {
      urlIndex,
      attempt: 1,
      state: 'queued',
      phase: null,
      windowId: null,
      startedAt: null,
      updatedAt: null,
      manualResolution: { status: 'idle', updatedAt: null }
    };
    return makeRow({
      batchId: String(checkpoint?.batchId || ''),
      item,
      task,
      results: resultsByUrlIndex.get(urlIndex) || [],
      resultsByTask,
      now
    });
  });

  const counts = {
    total: rows.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    manual: 0
  };
  for (const row of rows) counts[row.status] += 1;

  const filters = {
    status: text(options.filters?.status) || 'all',
    domain: text(options.filters?.domain) || 'all',
    timeRange: options.filters?.timeRange || 'all',
    keyword: String(options.filters?.keyword || '')
  };
  const lastCheckpointSavedAt = finiteOrNull(options.lastCheckpointSavedAt) ??
    finiteOrNull(checkpoint?.updatedAt);
  const keepAlive = typeof options.keepAlive === 'boolean'
    ? options.keepAlive
    : status === 'running' && online && !persistencePending;
  const checkpointState = persistencePending
    ? 'pending'
    : text(options.checkpointState) || 'saved';
  const inFlight = text(options.inFlight || options.command?.inFlight) || null;
  const resultMessage = text(
    options.command?.resultMessage || options.commandResult
  );
  const assignment = assignmentFor(
    checkpoint,
    options,
    concurrency,
    timeoutSeconds
  );
  const banners = bannersFor(checkpoint, options, {
    online,
    persistencePending,
    status
  });
  const command = commandFor({
    status,
    batchId,
    rowCount: rows.length,
    online,
    persistencePending,
    inFlight,
    resultMessage
  });

  return {
    batchId,
    status,
    batchName: text(options.batchName) ||
      text(checkpoint?.batchName) ||
      text(checkpoint?.source?.fileName) ||
      batchId,
    now,
    online,
    lastCheckpointSavedAt,
    checkpointState,
    persistencePending,
    keepAlive,
    health: {
      online,
      lastCheckpointSavedAt,
      checkpointState,
      persistencePending,
      keepAlive
    },
    concurrency,
    slotCapacity: concurrency,
    assignment,
    counts,
    slots: rows.filter((row) => row.status === 'running').map((row) => ({
      taskId: row.taskId,
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      url: row.url,
      domain: row.domain,
      phase: row.phase,
      tabId: Number.isInteger(tasks[String(row.urlIndex)]?.tabId)
        ? tasks[String(row.urlIndex)].tabId
        : null,
      tabLabel: Number.isInteger(tasks[String(row.urlIndex)]?.tabId)
        ? `标签页 ${tasks[String(row.urlIndex)].tabId}`
        : 'worker 标签页',
      elapsedMs: row.elapsedMs
    })),
    rows,
    filteredRows: filterBatchTaskRows(rows, filters),
    filters,
    banners,
    command
  };
}

function matchesTimeRange(row, timeRange, latestTimestamp) {
  if (!timeRange || timeRange === 'all') return true;
  const timestamp = row.timestamp;
  if (!Number.isFinite(timestamp)) return false;
  if (typeof timeRange === 'object') {
    const from = finiteOrNull(timeRange.from) ?? -Infinity;
    const to = finiteOrNull(timeRange.to) ?? Infinity;
    return timestamp >= from && timestamp <= to;
  }
  const duration = {
    'last-hour': 60 * 60 * 1000,
    'last-day': 24 * 60 * 60 * 1000,
    'last-week': 7 * 24 * 60 * 60 * 1000
  }[timeRange];
  return Number.isFinite(duration) && timestamp >= latestTimestamp - duration;
}

export function filterBatchTaskRows(rows, filters = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const status = filters.status || 'all';
  const domain = filters.domain || 'all';
  const timeRange = filters.timeRange || 'all';
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
  const latestTimestamp = sourceRows.reduce((latest, row) => Math.max(
    latest,
    finiteOrNull(row?.timestamp) ?? -Infinity
  ), -Infinity);

  return sourceRows.filter((row) => {
    if (status !== 'all' && row.status !== status) return false;
    if (domain !== 'all' && row.domain !== domain) return false;
    if (!matchesTimeRange(row, timeRange, latestTimestamp)) return false;
    if (!keyword) return true;
    const searchable = [
      row.url,
      row.error?.message,
      row.errorMessage,
      row.aiContent,
      ...row.attemptHistory.map((attempt) => attempt.error?.message)
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return searchable.includes(keyword);
  });
}
