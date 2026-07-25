export const BATCH_RUNTIME_CHECKPOINT_KEY = 'batchRuntimeCheckpoint';
export const BATCH_RUNTIME_VERSION = 1;

export const BATCH_TERMINAL_RESULTS = new Set([
  'success',
  'skipped',
  'no_comment_box',
  'manual_required',
  'blocked_illegal',
  'fail'
]);

const BATCH_STATUSES = new Set([
  'running',
  'paused_recovery',
  'terminated',
  'completed'
]);

const TASK_STATES = new Set([
  'queued',
  'active',
  'submitting',
  'terminal'
]);

function clone(value) {
  return structuredClone(value);
}

function failed(checkpoint, error) {
  return { ok: false, error, checkpoint };
}

function nextCursor(tasks, totalCount) {
  for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
    if (tasks[String(urlIndex)]?.state !== 'terminal') return urlIndex;
  }
  return totalCount;
}

function createResultEntry(checkpoint, urlIndex, result, now, startedAt) {
  const item = checkpoint.source.parsedUrls[urlIndex];
  return {
    originalIndex: urlIndex,
    url: item.url || '',
    sourceDomain: item.sourceDomain || '',
    result: result.result,
    aiContent: result.aiContent || null,
    errorMessage: result.errorMessage || null,
    timestamp: now,
    elapsed: Number.isFinite(startedAt)
      ? Math.max(0, Math.round((now - startedAt) / 1000))
      : null,
    originalRow: Array.isArray(item.originalRow)
      ? clone(item.originalRow)
      : null
  };
}

function resultMatches(existing, candidate) {
  return existing.result === candidate.result &&
    existing.aiContent === candidate.aiContent &&
    existing.errorMessage === candidate.errorMessage;
}

export function createBatchRuntimeCheckpoint(input, now = Date.now()) {
  const source = clone(input.source);
  const settings = clone(input.settings);
  const tasks = {};

  source.parsedUrls.forEach((item, urlIndex) => {
    tasks[String(urlIndex)] = {
      urlIndex,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: now
    };
  });

  return {
    version: BATCH_RUNTIME_VERSION,
    batchId: input.batchId,
    status: 'paused_recovery',
    createdAt: now,
    updatedAt: now,
    source,
    settings,
    cursor: { nextIndex: 0 },
    tasks,
    results: []
  };
}

export function validateBatchRuntimeCheckpoint(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'invalid_checkpoint' };
  }
  if (value.version !== BATCH_RUNTIME_VERSION) {
    return { ok: false, error: 'unsupported_version' };
  }
  if (
    typeof value.batchId !== 'string' ||
    value.batchId.length === 0 ||
    !BATCH_STATUSES.has(value.status) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt) ||
    !value.source ||
    typeof value.source !== 'object' ||
    typeof value.source.fileName !== 'string' ||
    !Array.isArray(value.source.headers) ||
    !Array.isArray(value.source.rows) ||
    !Array.isArray(value.source.parsedUrls) ||
    !value.settings ||
    typeof value.settings !== 'object' ||
    !value.cursor ||
    !Number.isInteger(value.cursor.nextIndex) ||
    !value.tasks ||
    typeof value.tasks !== 'object' ||
    Array.isArray(value.tasks) ||
    !Array.isArray(value.results)
  ) {
    return { ok: false, error: 'invalid_checkpoint' };
  }

  const totalCount = value.source.parsedUrls.length;
  if (
    value.source.rows.length !== totalCount ||
    Object.keys(value.tasks).length !== totalCount ||
    value.cursor.nextIndex < 0 ||
    value.cursor.nextIndex > totalCount
  ) {
    return { ok: false, error: 'invalid_checkpoint' };
  }

  for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
    const task = value.tasks[String(urlIndex)];
    if (
      !task ||
      task.urlIndex !== urlIndex ||
      !TASK_STATES.has(task.state)
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
  }

  const resultIndices = new Set();
  for (const result of value.results) {
    if (
      !result ||
      !Number.isInteger(result.originalIndex) ||
      result.originalIndex < 0 ||
      result.originalIndex >= totalCount ||
      !BATCH_TERMINAL_RESULTS.has(result.result) ||
      resultIndices.has(result.originalIndex)
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
    resultIndices.add(result.originalIndex);
    if (value.tasks[String(result.originalIndex)].state !== 'terminal') {
      return { ok: false, error: 'invalid_checkpoint' };
    }
  }

  return { ok: true, checkpoint: value };
}

export function applyBatchRuntimeEvent(checkpoint, event, now = Date.now()) {
  const validation = validateBatchRuntimeCheckpoint(checkpoint);
  if (!validation.ok) return failed(checkpoint, validation.error);
  if (event?.batchId !== checkpoint.batchId) {
    return failed(checkpoint, 'stale_batch');
  }

  const totalCount = checkpoint.source.parsedUrls.length;
  const taskEvent = event.type?.startsWith('task_');
  if (
    taskEvent &&
    (
      !Number.isInteger(event.urlIndex) ||
      event.urlIndex < 0 ||
      event.urlIndex >= totalCount
    )
  ) {
    return failed(checkpoint, 'invalid_url_index');
  }

  const next = clone(checkpoint);
  const task = taskEvent ? next.tasks[String(event.urlIndex)] : null;

  switch (event.type) {
    case 'session_started':
      if (
        checkpoint.status === 'terminated' ||
        checkpoint.status === 'completed'
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      if (checkpoint.status === 'running') {
        return {
          ok: true,
          checkpoint,
          changed: false
        };
      }
      next.status = 'running';
      break;

    case 'session_paused':
      if (checkpoint.status !== 'running') {
        return failed(checkpoint, 'invalid_transition');
      }
      next.status = 'paused_recovery';
      break;

    case 'session_terminated':
      if (
        checkpoint.status === 'terminated' ||
        checkpoint.status === 'completed'
      ) {
        return {
          ok: checkpoint.status === 'terminated',
          ...(checkpoint.status === 'completed'
            ? { error: 'invalid_transition' }
            : {}),
          checkpoint,
          changed: false
        };
      }
      next.status = 'terminated';
      break;

    case 'session_completed':
      if (
        checkpoint.status === 'completed' ||
        checkpoint.status === 'terminated'
      ) {
        return {
          ok: checkpoint.status === 'completed',
          ...(checkpoint.status === 'terminated'
            ? { error: 'invalid_transition' }
            : {}),
          checkpoint,
          changed: false
        };
      }
      next.status = 'completed';
      break;

    case 'task_activated':
      if (
        checkpoint.status !== 'running' ||
        task.state !== 'queued' ||
        !Number.isInteger(event.tabId) ||
        !Number.isInteger(event.windowId)
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      Object.assign(task, {
        state: 'active',
        phase: null,
        tabId: event.tabId,
        windowId: event.windowId,
        startedAt: Number.isFinite(event.startedAt) ? event.startedAt : now,
        updatedAt: now
      });
      break;

    case 'task_submitting':
      if (
        checkpoint.status !== 'running' ||
        task.state !== 'active'
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      task.state = 'submitting';
      task.phase = 'submitting';
      task.updatedAt = now;
      break;

    case 'task_terminal': {
      if (!BATCH_TERMINAL_RESULTS.has(event.result?.result)) {
        return failed(checkpoint, 'invalid_result');
      }
      const candidate = createResultEntry(
        checkpoint,
        event.urlIndex,
        event.result,
        now,
        task.startedAt
      );
      if (task.state === 'terminal') {
        const existing = checkpoint.results.find(
          (result) => result.originalIndex === event.urlIndex
        );
        if (existing && resultMatches(existing, candidate)) {
          return {
            ok: true,
            checkpoint,
            changed: false
          };
        }
        return failed(checkpoint, 'task_already_terminal');
      }
      if (
        checkpoint.status !== 'running' ||
        !['queued', 'active', 'submitting'].includes(task.state)
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      Object.assign(task, {
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: now
      });
      next.results.push(candidate);
      break;
    }

    default:
      return failed(checkpoint, 'unknown_event');
  }

  next.cursor.nextIndex = nextCursor(next.tasks, totalCount);
  next.updatedAt = now;
  return {
    ok: true,
    checkpoint: next,
    changed: true
  };
}

export function normalizeInterruptedBatch(checkpoint, now = Date.now()) {
  const validation = validateBatchRuntimeCheckpoint(checkpoint);
  if (!validation.ok) {
    return {
      ...failed(checkpoint, validation.error),
      orphanWindowIds: []
    };
  }
  if (checkpoint.status !== 'running') {
    return {
      ok: true,
      checkpoint,
      changed: false,
      orphanWindowIds: []
    };
  }

  const next = clone(checkpoint);
  const orphanWindowIds = [];
  for (const task of Object.values(next.tasks)) {
    if (!['active', 'submitting'].includes(task.state)) continue;
    if (
      Number.isInteger(task.windowId) &&
      !orphanWindowIds.includes(task.windowId)
    ) {
      orphanWindowIds.push(task.windowId);
    }
    if (task.state === 'submitting') {
      next.results.push(createResultEntry(
        checkpoint,
        task.urlIndex,
        {
          result: 'manual_required',
          errorMessage: '任务在提交确认前中断，评论可能已提交，请人工确认'
        },
        now,
        task.startedAt
      ));
      Object.assign(task, {
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: now
      });
    } else {
      Object.assign(task, {
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: now
      });
    }
  }

  next.status = 'paused_recovery';
  next.cursor.nextIndex = nextCursor(
    next.tasks,
    next.source.parsedUrls.length
  );
  next.updatedAt = now;
  return {
    ok: true,
    checkpoint: next,
    changed: true,
    orphanWindowIds
  };
}
