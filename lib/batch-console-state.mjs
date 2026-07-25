import {
  getBatchError,
  getBatchRetryPolicy
} from './batch-error-policy.mjs';

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
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
    Number.isInteger(task.windowId)) {
    actions.push('focus-window');
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

export function createBatchConsoleSnapshot(checkpoint, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
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

  return {
    batchId: String(checkpoint?.batchId || ''),
    status: checkpoint?.status || null,
    now,
    online: options.online !== false,
    lastCheckpointSavedAt: finiteOrNull(options.lastCheckpointSavedAt) ??
      finiteOrNull(checkpoint?.updatedAt),
    counts,
    slots: rows.filter((row) => row.status === 'running').map((row) => ({
      taskId: row.taskId,
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      phase: row.phase,
      tabId: tasks[String(row.urlIndex)]?.tabId || null,
      windowId: tasks[String(row.urlIndex)]?.windowId || null,
      elapsedMs: row.elapsedMs
    })),
    rows
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
