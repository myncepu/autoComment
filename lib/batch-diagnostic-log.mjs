import {
  BATCH_RUNTIME_CHECKPOINT_KEY
} from './batch-runtime-checkpoint.mjs';
import {
  isRecentSuccessResult
} from './batch-result-classification.mjs';

export const BATCH_DIAGNOSTIC_LOG_KEY = 'batchDiagnosticLogV1';
export const BATCH_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const MAX_BATCH_DIAGNOSTIC_EVENTS = 12000;

const EVENT_CODES = new Set([
  'task_started',
  'form_detected',
  'comment_generated',
  'form_filled',
  'submit_control_detected',
  'submit_control_unusable',
  'submission_dispatch_started',
  'submission_strategy_selected',
  'submission_dispatch_result',
  'submission_confirmation',
  'submission_restored_confirmation',
  'task_error',
  'deadline_scheduled',
  'deadline_fired',
  'deadline_terminalized',
  'deadline_replenish_notified'
]);
const STRING_DETAIL_KEYS = new Set([
  'phase',
  'generationSource',
  'formMethod',
  'submitTag',
  'submitType',
  'strategy',
  'dispatchResult',
  'confirmationStatus',
  'errorCode'
]);
const BOOLEAN_DETAIL_KEYS = new Set([
  'hasForm',
  'hasTextarea',
  'filled',
  'buttonDisabled',
  'buttonClickable',
  'success',
  'confirmed',
  'navigationPending',
  'submissionDispatched'
]);
const NUMBER_DETAIL_KEYS = new Set([
  'contentLength',
  'missingFieldCount',
  'responseStatus',
  'elapsedMs',
  'deadlineAt',
  'scheduledDelayMs',
  'timeoutSeconds'
]);

function boundedCode(value, maximum = 80) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, maximum);
  return /^[a-z0-9_.:-]+$/i.test(normalized) ? normalized : null;
}

function finiteInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function safeHost(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.hostname.toLowerCase().slice(0, 253)
      : null;
  } catch (_) {
    return null;
  }
}

function safeDetails(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (STRING_DETAIL_KEYS.has(key)) {
      const normalized = boundedCode(value);
      if (normalized !== null) output[key] = normalized;
      continue;
    }
    if (BOOLEAN_DETAIL_KEYS.has(key) && typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    if (NUMBER_DETAIL_KEYS.has(key)) {
      const normalized = finiteInteger(
        value,
        0,
        key === 'deadlineAt' ? Number.MAX_SAFE_INTEGER : 10_000_000
      );
      if (normalized !== null) output[key] = normalized;
    }
  }
  return output;
}

function taskIdentity(event) {
  return `${event.urlIndex}:${event.attempt}`;
}

function uniqueEventCount(events, code) {
  return new Set(
    events
      .filter((event) => event.event === code)
      .map(taskIdentity)
  ).size;
}

function finalSubmissionConfirmations(events) {
  const confirmations = new Map();
  for (const event of events) {
    if (![
      'submission_confirmation',
      'submission_restored_confirmation'
    ].includes(event.event)) continue;
    if (
      event.event === 'submission_confirmation' &&
      event.details?.navigationPending === true
    ) continue;
    const status = event.details?.confirmationStatus;
    if (!['success', 'rejected', 'uncertain'].includes(status)) continue;
    confirmations.set(taskIdentity(event), status);
  }
  return confirmations;
}

function roundRate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function createBatchDiagnosticDocument(batchId, now = Date.now()) {
  return {
    schemaVersion: BATCH_DIAGNOSTIC_SCHEMA_VERSION,
    batchId,
    createdAt: now,
    updatedAt: now,
    droppedEventCount: 0,
    events: []
  };
}

export function sanitizeBatchDiagnosticEvent(
  message,
  {
    now = Date.now(),
    sourceTabId = null,
    sourceUrl = ''
  } = {}
) {
  const batchId = boundedCode(message?.batchId, 160);
  const event = boundedCode(message?.event, 80);
  const urlIndex = finiteInteger(message?.urlIndex);
  const attempt = finiteInteger(message?.attempt, 1);
  if (
    !batchId ||
    !event ||
    !EVENT_CODES.has(event) ||
    urlIndex === null ||
    attempt === null
  ) {
    return null;
  }
  return {
    timestamp: now,
    batchId,
    urlIndex,
    attempt,
    event,
    host: safeHost(sourceUrl),
    sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
    details: safeDetails(message?.details)
  };
}

export function appendBatchDiagnosticEvent(
  current,
  event,
  {
    now = Date.now(),
    maximum = MAX_BATCH_DIAGNOSTIC_EVENTS
  } = {}
) {
  const document = (
    current?.schemaVersion === BATCH_DIAGNOSTIC_SCHEMA_VERSION &&
    current?.batchId === event?.batchId &&
    Array.isArray(current?.events)
  )
    ? structuredClone(current)
    : createBatchDiagnosticDocument(event?.batchId, now);
  document.events.push(structuredClone(event));
  const overflow = Math.max(0, document.events.length - maximum);
  if (overflow > 0) {
    document.events.splice(0, overflow);
    document.droppedEventCount =
      finiteInteger(document.droppedEventCount) + overflow;
  }
  document.updatedAt = now;
  return document;
}

export function createBatchDiagnosticExport(
  checkpoint,
  diagnosticDocument,
  now = Date.now()
) {
  const allResults = Array.isArray(checkpoint?.results)
    ? checkpoint.results
    : [];
  const terminalTasks = Object.values(checkpoint?.tasks || {})
    .filter((task) => task?.state === 'terminal');
  const results = terminalTasks.length > 0
    ? terminalTasks.flatMap((task) => {
        const result = allResults.find((candidate) => (
          candidate?.originalIndex === task.urlIndex &&
          candidate?.attempt === task.attempt
        ));
        return result ? [result] : [];
      })
    : allResults;
  const events = (
    diagnosticDocument?.batchId === checkpoint?.batchId &&
    Array.isArray(diagnosticDocument?.events)
  )
    ? diagnosticDocument.events.map((event) => structuredClone(event))
    : [];
  const resultCounts = {};
  const skipReasonCounts = {};
  for (const result of results) {
    const key = boundedCode(result?.result, 80) || 'unknown';
    resultCounts[key] = (resultCounts[key] || 0) + 1;
    if (result?.result === 'skipped') {
      const reason = boundedCode(result?.skipReason, 80) || 'unknown';
      skipReasonCounts[reason] = (skipReasonCounts[reason] || 0) + 1;
    }
  }
  const recentSuccessResults = results.filter(isRecentSuccessResult).length;
  const publishedResults =
    (resultCounts.success || 0) + recentSuccessResults;
  const attemptedResults = [
    'success',
    'fail',
    'no_comment_box',
    'manual_required'
  ].reduce((total, key) => total + (resultCounts[key] || 0), 0);
  const terminalResults = results.length;
  const generated = uniqueEventCount(events, 'comment_generated');
  const filled = uniqueEventCount(events, 'form_filled');
  const submitControlDetected =
    uniqueEventCount(events, 'submit_control_detected');
  const finalConfirmations = finalSubmissionConfirmations(events);
  const confirmationEvents = events.filter((event) => (
    ['submission_confirmation', 'submission_restored_confirmation']
      .includes(event.event)
  ));
  const dispatchAttemptedIdentities = new Set(
    events
      .filter((event) => (
        [
          'submission_dispatch_started',
          'submission_dispatch_result',
          'submission_confirmation',
          'submission_restored_confirmation'
        ].includes(event.event)
      ))
      .map(taskIdentity)
  );
  const dispatchAttempted = dispatchAttemptedIdentities.size;
  const dispatchedIdentities = new Set([
    ...events
      .filter((event) => (
        event.event === 'submission_dispatch_result' &&
        event.details?.success === true
      ))
      .map(taskIdentity),
    ...confirmationEvents.map(taskIdentity)
  ]);
  const submitDispatched = dispatchedIdentities.size;
  const confirmationCount = (status) => (
    [...finalConfirmations.values()]
      .filter((candidate) => candidate === status)
      .length
  );
  const serverConfirmed = confirmationCount('success');
  const submissionRejected = confirmationCount('rejected');
  const submissionUncertain = confirmationCount('uncertain');
  const submissionWithoutFinalConfirmation = [...dispatchedIdentities]
    .filter((identity) => !finalConfirmations.has(identity))
    .length;
  const timeoutSeconds = finiteInteger(
    checkpoint?.settings?.timeoutSeconds,
    0,
    86_400
  );
  const nonTerminalTasks = Object.values(checkpoint?.tasks || {})
    .filter((task) => task?.state !== 'terminal')
    .map((task) => ({
      urlIndex: finiteInteger(task?.urlIndex),
      attempt: finiteInteger(task?.attempt, 1),
      state: boundedCode(task?.state, 40),
      phase: boundedCode(task?.phase, 40),
      startedAt: finiteInteger(task?.startedAt),
      updatedAt: finiteInteger(task?.updatedAt),
      elapsedMs: Number.isFinite(task?.startedAt)
        ? Math.max(0, now - task.startedAt)
        : null,
      deadlineAt:
        Number.isFinite(task?.startedAt) && timeoutSeconds !== null
          ? task.startedAt + (timeoutSeconds * 1000)
          : null,
      deadlineExceeded: (
        Number.isFinite(task?.startedAt) &&
        timeoutSeconds !== null &&
        now >= task.startedAt + (timeoutSeconds * 1000)
      )
    }));
  return {
    schemaVersion: BATCH_DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: now,
    privacy: {
      commentsIncluded: false,
      credentialsIncluded: false,
      fullUrlsIncluded: false
    },
    batch: {
      batchId: checkpoint?.batchId || diagnosticDocument?.batchId || null,
      status: checkpoint?.status || null,
      totalTasks: Object.keys(checkpoint?.tasks || {}).length,
      concurrency: finiteInteger(checkpoint?.settings?.concurrency),
      timeoutSeconds: finiteInteger(checkpoint?.settings?.timeoutSeconds)
    },
    summary: {
      resultCounts,
      skipReasonCounts,
      publishedEvidence: {
        currentBatchSuccess: resultCounts.success || 0,
        recentSuccess: recentSuccessResults,
        total: publishedResults
      },
      funnel: {
        generated,
        filled,
        submitControlDetected,
        dispatchAttempted,
        submitDispatched,
        serverConfirmed,
        submissionRejected,
        submissionUncertain,
        submissionWithoutFinalConfirmation
      },
      rates: {
        confirmedResultPercent: roundRate(
          publishedResults,
          terminalResults
        ),
        newTaskSuccessPercent: roundRate(
          resultCounts.success || 0,
          attemptedResults
        ),
        submitConfirmationPercent: roundRate(
          serverConfirmed,
          submitDispatched
        ),
        generatedToDispatchPercent: roundRate(
          submitDispatched,
          generated
        )
      },
      terminalResults,
      diagnosticEvents: events.length,
      droppedDiagnosticEvents:
        finiteInteger(diagnosticDocument?.droppedEventCount) || 0
    },
    runtimeSnapshot: {
      nonTerminalTasks
    },
    events
  };
}

function isBatchPageSender(sender, runtime) {
  if (
    sender?.id !== runtime.id ||
    !Number.isInteger(sender?.tab?.id)
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

export function createBatchDiagnosticService({
  storageArea,
  runtime,
  now = Date.now
}) {
  let operation = Promise.resolve();

  function enqueue(work) {
    const current = operation.then(work, work);
    operation = current.catch(() => {});
    return current;
  }

  async function append(message, sender) {
    return enqueue(async () => {
      const sourceTabId = sender?.tab?.id;
      if (sender?.id !== runtime.id || !Number.isInteger(sourceTabId)) {
        return { ok: false, error: 'forbidden_sender' };
      }
      const stored = await storageArea.get([
        BATCH_RUNTIME_CHECKPOINT_KEY,
        BATCH_DIAGNOSTIC_LOG_KEY
      ]);
      const checkpoint = stored[BATCH_RUNTIME_CHECKPOINT_KEY];
      const task = checkpoint?.tasks?.[String(message?.urlIndex)];
      const timestamp = now();
      const event = sanitizeBatchDiagnosticEvent(message, {
        now: timestamp,
        sourceTabId,
        sourceUrl: sender?.tab?.url || sender?.url || ''
      });
      if (!event) return { ok: false, error: 'invalid_diagnostic_event' };
      const priorOwnedEvent = (
        stored[BATCH_DIAGNOSTIC_LOG_KEY]?.batchId === message.batchId &&
        Array.isArray(stored[BATCH_DIAGNOSTIC_LOG_KEY]?.events)
      ) && stored[BATCH_DIAGNOSTIC_LOG_KEY].events.some((candidate) => (
        candidate?.urlIndex === message.urlIndex &&
        candidate?.attempt === message.attempt &&
        candidate?.sourceTabId === sourceTabId
      ));
      const terminalContinuation = (
        task?.state === 'terminal' &&
        priorOwnedEvent &&
        [
          'submission_confirmation',
          'submission_restored_confirmation',
          'task_error'
        ].includes(event.event)
      );
      if (
        checkpoint?.batchId !== message?.batchId ||
        task?.attempt !== message?.attempt ||
        !(
          (
            task?.tabId === sourceTabId &&
            ['active', 'submitting'].includes(task?.state)
          ) ||
          terminalContinuation
        )
      ) {
        return { ok: false, error: 'stale_worker_tab' };
      }
      const document = appendBatchDiagnosticEvent(
        stored[BATCH_DIAGNOSTIC_LOG_KEY],
        event,
        { now: timestamp }
      );
      await storageArea.set({ [BATCH_DIAGNOSTIC_LOG_KEY]: document });
      return { ok: true };
    });
  }

  async function exportLog(message, sender) {
    return enqueue(async () => {
      if (!isBatchPageSender(sender, runtime)) {
        return { ok: false, error: 'forbidden_sender' };
      }
      const stored = await storageArea.get([
        BATCH_RUNTIME_CHECKPOINT_KEY,
        BATCH_DIAGNOSTIC_LOG_KEY
      ]);
      const checkpoint = stored[BATCH_RUNTIME_CHECKPOINT_KEY] || null;
      if (
        typeof message?.batchId === 'string' &&
        checkpoint?.batchId !== message.batchId
      ) {
        return { ok: false, error: 'stale_batch' };
      }
      return {
        ok: true,
        diagnostics: createBatchDiagnosticExport(
          checkpoint,
          stored[BATCH_DIAGNOSTIC_LOG_KEY],
          now()
        )
      };
    });
  }

  async function appendSystem(
    message,
    { sourceTabId = null, sourceUrl = '' } = {}
  ) {
    return enqueue(async () => {
      const timestamp = now();
      const event = sanitizeBatchDiagnosticEvent(message, {
        now: timestamp,
        sourceTabId,
        sourceUrl
      });
      if (!event) return { ok: false, error: 'invalid_diagnostic_event' };
      const stored = await storageArea.get([BATCH_DIAGNOSTIC_LOG_KEY]);
      const document = appendBatchDiagnosticEvent(
        stored[BATCH_DIAGNOSTIC_LOG_KEY],
        event,
        { now: timestamp }
      );
      await storageArea.set({ [BATCH_DIAGNOSTIC_LOG_KEY]: document });
      return { ok: true };
    });
  }

  return { append, appendSystem, exportLog };
}

export function installBatchDiagnosticListener(
  chromeApi,
  service
) {
  chromeApi.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      let request;
      if (message?.type === 'BATCH_DIAGNOSTIC_EVENT') {
        request = service.append(message, sender);
      } else if (message?.type === 'BATCH_DIAGNOSTICS_EXPORT') {
        request = service.exportLog(message, sender);
      } else {
        return false;
      }
      request
        .then(sendResponse)
        .catch(() => sendResponse({
          ok: false,
          error: 'batch_diagnostic_failed'
        }));
      return true;
    }
  );
}
