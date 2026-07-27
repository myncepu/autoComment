import { getBatchRetryPolicy } from './batch-error-policy.mjs';
import { assertNoSensitiveFields } from './domain-config-schema.mjs';
import {
  hasUrlCredentials,
  sanitizeBatchUrl,
  sanitizeDiagnosticText
} from './batch-url-sanitizer.mjs';
import {
  normalizeBatchResultPreview
} from './batch-result-preview.mjs';

export const BATCH_RUNTIME_CHECKPOINT_KEY = 'batchRuntimeCheckpoint';
export const BATCH_RUNTIME_VERSION = 3;

const DEFAULT_PROFILE_ID = 'default-profile';
const DEFAULT_PROMOTION_SITE_ID = 'default-promotion-site';
const DEFAULT_ASSIGNMENT_PAIR_ID = 'default-assignment-pair';

export const BATCH_TERMINAL_RESULTS = new Set([
  'success',
  'skipped',
  'no_comment_box',
  'manual_required',
  'blocked_illegal',
  'fail'
]);

export const BATCH_TASK_PHASES = new Set([
  'opening',
  'loading',
  'detecting',
  'generating',
  'filling',
  'submitting',
  'confirming',
  'closing'
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

const MANUAL_RESOLUTION_STATUSES = new Set([
  'idle',
  'in_progress',
  'resolved',
  'unresolved'
]);

const LEGACY_RESULT_ERROR_CODES = {
  success: null,
  skipped: null,
  no_comment_box: 'no_comment_box',
  manual_required: 'submission_uncertain',
  blocked_illegal: 'illegal_site',
  fail: 'task_failed'
};
const AUTOMATIC_RETRY_ERROR_CODES = new Set([
  'task_timeout',
  'window_create_failed',
  'content_script_unavailable'
]);
const SUBMIT_RISK_PHASES = new Set([
  'submitting',
  'confirming',
  'closing'
]);

function clone(value) {
  return structuredClone(value);
}

function canonicalRequestId(batchId, urlIndex, attempt) {
  return `${batchId}:${urlIndex}:${attempt}`;
}

function hasVerifiedOwner(ownerPageTabId, ownershipEpoch) {
  return Number.isInteger(ownerPageTabId) &&
    ownerPageTabId > 0 &&
    typeof ownershipEpoch === 'string' &&
    ownershipEpoch.length > 0;
}

function sanitizeUrlCell(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) {
    return value;
  }
  if (hasUrlCredentials(value)) {
    throw new Error('batch_url_credentials_forbidden');
  }
  return sanitizeBatchUrl(value);
}

function sanitizeSource(source) {
  const safe = clone(source);
  safe.rows = safe.rows.map((row) => (
    Array.isArray(row) ? row.map(sanitizeUrlCell) : row
  ));
  safe.parsedUrls = safe.parsedUrls.map((item) => ({
    ...item,
    url: sanitizeUrlCell(item.url),
    originalRow: Array.isArray(item.originalRow)
      ? item.originalRow.map(sanitizeUrlCell)
      : item.originalRow
  }));
  return safe;
}

function sanitizeVersion2Checkpoint(value) {
  let checkpoint;
  try {
    checkpoint = clone(value);
  } catch (_) {
    return { ok: false, error: 'invalid_checkpoint' };
  }

  let changed = false;
  let ownershipUnverified = false;
  try {
    if (
      checkpoint?.tasks &&
      typeof checkpoint.tasks === 'object' &&
      !Array.isArray(checkpoint.tasks)
    ) {
      for (const task of Object.values(checkpoint.tasks)) {
        if (task && !Object.hasOwn(task, 'requestId')) {
          task.requestId = ['active', 'submitting'].includes(task.state) &&
            Number.isInteger(task.urlIndex) &&
            Number.isInteger(task.attempt)
            ? canonicalRequestId(
                checkpoint.batchId,
                task.urlIndex,
                task.attempt
              )
            : null;
          changed = true;
        }
        if (
          task?.requestId === null &&
          ['active', 'submitting'].includes(task.state) &&
          Number.isInteger(task.urlIndex) &&
          Number.isInteger(task.attempt) &&
          Number.isInteger(task.tabId) &&
          task.tabId > 0 &&
          Number.isInteger(task.windowId) &&
          task.windowId > 0 &&
          Number.isFinite(task.startedAt) &&
          task.startedAt > 0
        ) {
          task.requestId = canonicalRequestId(
            checkpoint.batchId,
            task.urlIndex,
            task.attempt
          );
          changed = true;
        }
        if (task && !Object.hasOwn(task, 'ownerPageTabId')) {
          task.ownerPageTabId = null;
          changed = true;
        }
        if (task && !Object.hasOwn(task, 'ownershipEpoch')) {
          task.ownershipEpoch = null;
          changed = true;
        }
        if (
          ['active', 'submitting'].includes(task?.state) &&
          !hasVerifiedOwner(
            task.ownerPageTabId,
            task.ownershipEpoch
          )
        ) {
          ownershipUnverified = true;
        }
      }
    }
    if (checkpoint && !Object.hasOwn(checkpoint, 'openingReservations')) {
      checkpoint.openingReservations = {};
      changed = true;
    }
    if (
      checkpoint?.openingReservations &&
      typeof checkpoint.openingReservations === 'object' &&
      !Array.isArray(checkpoint.openingReservations)
    ) {
      for (const [key, reservation] of Object.entries(
        checkpoint.openingReservations
      )) {
        if (
          reservation &&
          typeof reservation === 'object' &&
          !Object.hasOwn(reservation, 'ownerPageTabId')
        ) {
          reservation.ownerPageTabId = null;
          changed = true;
          ownershipUnverified = true;
        }
        if (
          reservation &&
          typeof reservation === 'object' &&
          !Object.hasOwn(reservation, 'ownershipEpoch')
        ) {
          reservation.ownershipEpoch = null;
          changed = true;
          ownershipUnverified = true;
        }
        if (
          reservation &&
          typeof reservation === 'object' &&
          !Object.hasOwn(reservation, 'cleanupOnly')
        ) {
          reservation.cleanupOnly = false;
          changed = true;
        }
        if (
          reservation &&
          typeof reservation === 'object' &&
          !Object.hasOwn(reservation, 'createCompletionUnknown')
        ) {
          reservation.createCompletionUnknown = true;
          changed = true;
        }
        if (
          reservation &&
          typeof reservation === 'object' &&
          Object.hasOwn(reservation, 'cleanupObservedAt') &&
          (
            reservation.cleanupObservedAt === null ||
            Number.isFinite(reservation.cleanupObservedAt)
          )
        ) {
          delete reservation.cleanupObservedAt;
          changed = true;
        }
        if (
          !reservation ||
          typeof reservation !== 'object' ||
          Object.hasOwn(reservation, 'batchId')
        ) {
          continue;
        }
        const task = checkpoint.tasks?.[String(reservation.urlIndex)];
        const legacyFields = [
          'attempt',
          'cleanupOnly',
          'createCompletionUnknown',
          'ownerPageTabId',
          'ownershipEpoch',
          'requestId',
          'tabId',
          'updatedAt',
          'urlIndex',
          'windowId'
        ];
        const safe = Object.keys(reservation).sort().join(',') ===
            legacyFields.join(',') &&
          reservation.requestId === key &&
          key === canonicalRequestId(
            checkpoint.batchId,
            reservation.urlIndex,
            reservation.attempt
          ) &&
          Number.isInteger(reservation.urlIndex) &&
          reservation.urlIndex >= 0 &&
          reservation.urlIndex < checkpoint.source?.parsedUrls?.length &&
          Number.isInteger(reservation.attempt) &&
          reservation.attempt > 0 &&
          Number.isInteger(reservation.windowId) &&
          reservation.windowId > 0 &&
          (
            reservation.tabId === null ||
            (
              Number.isInteger(reservation.tabId) &&
              reservation.tabId > 0
            )
          ) &&
          Number.isFinite(reservation.updatedAt) &&
          reservation.cleanupOnly === false &&
          reservation.createCompletionUnknown === true &&
          task?.urlIndex === reservation.urlIndex &&
          task?.attempt === reservation.attempt &&
          task?.state === 'queued' &&
          task?.requestId === null &&
          task?.tabId === null &&
          task?.windowId === null &&
          task?.startedAt === null;
        if (safe) {
          reservation.batchId = checkpoint.batchId;
        } else {
          delete checkpoint.openingReservations[key];
        }
        changed = true;
      }
    }
    if (ownershipUnverified) {
      if (checkpoint.status !== 'paused_recovery') {
        checkpoint.status = 'paused_recovery';
        changed = true;
      }
      if (
        checkpoint.recoveryCleanup?.reason !== 'ownership_unverified'
      ) {
        checkpoint.recoveryCleanup = {
          reason: 'ownership_unverified',
          diagnostic: null,
          updatedAt: checkpoint.updatedAt
        };
        changed = true;
      }
    }
    if (checkpoint?.source) {
      const sanitizedSource = sanitizeSource(checkpoint.source);
      if (
        JSON.stringify(sanitizedSource) !== JSON.stringify(checkpoint.source)
      ) {
        changed = true;
      }
      checkpoint.source = sanitizedSource;
    }
    if (Array.isArray(checkpoint?.results)) {
      for (const result of checkpoint.results) {
        if (typeof result?.url === 'string') {
          const sanitizedUrl = sanitizeUrlCell(result.url);
          if (sanitizedUrl !== result.url) {
            result.url = sanitizedUrl;
            changed = true;
          }
        }
        if (Array.isArray(result?.originalRow)) {
          const sanitizedRow = result.originalRow.map(sanitizeUrlCell);
          if (
            JSON.stringify(sanitizedRow) !==
            JSON.stringify(result.originalRow)
          ) {
            result.originalRow = sanitizedRow;
            changed = true;
          }
        }
        if (typeof result?.errorMessage !== 'string') continue;
        const sanitizedMessage = sanitizeDiagnosticText(result.errorMessage);
        if (sanitizedMessage !== result.errorMessage) {
          result.errorMessage = sanitizedMessage;
          changed = true;
        }
      }
      for (const result of checkpoint.results) {
        const preview = normalizeBatchResultPreview(result);
        if (
          preview.commentText !== result.commentText ||
          JSON.stringify(preview.anchorTexts) !==
            JSON.stringify(result.anchorTexts) ||
          preview.promotedWebsiteUrl !== result.promotedWebsiteUrl
        ) {
          Object.assign(result, preview);
          changed = true;
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.message === 'batch_url_credentials_forbidden'
        ? error.message
        : 'invalid_checkpoint'
    };
  }

  return { ok: true, checkpoint, changed };
}

function isSanitizedUrlCell(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) {
    return true;
  }
  return !hasUrlCredentials(value) && sanitizeBatchUrl(value) === value;
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

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function legacyAssignmentSnapshot(batchId, settings = {}) {
  const assignment = settings.assignment || {};
  const identity = assignment.identitySnapshot || {};
  const promotion = assignment.promotionSiteSnapshot || {};
  const profileName = stringValue(
    identity.displayName,
    stringValue(settings.userName)
  );
  const promotionUrl = stringValue(
    promotion.url,
    stringValue(settings.websiteUrl)
  );
  return {
    profiles: {
      [DEFAULT_PROFILE_ID]: {
        id: DEFAULT_PROFILE_ID,
        displayName: profileName || '默认身份',
        name: profileName,
        email: stringValue(identity.email, stringValue(settings.userEmail))
      }
    },
    promotionSites: {
      [DEFAULT_PROMOTION_SITE_ID]: {
        id: DEFAULT_PROMOTION_SITE_ID,
        name: stringValue(promotion.label) || '默认推广网站',
        url: promotionUrl,
        content: stringValue(
          settings.websiteContent,
          stringValue(promotion.contentSummary)
        )
      }
    }
  };
}

function legacyTaskAssignment(batchId, urlIndex) {
  return {
    taskId: `${batchId}:legacy:${urlIndex}`,
    profileId: DEFAULT_PROFILE_ID,
    promotionSiteId: DEFAULT_PROMOTION_SITE_ID,
    assignmentPairId: DEFAULT_ASSIGNMENT_PAIR_ID,
    assignmentSource: 'legacy_default',
    attemptCount: 1,
    lastFailurePhase: null,
    lastErrorCode: null
  };
}

function assignmentFields(checkpoint, task) {
  const profile = checkpoint.profiles?.[task.profileId] || {};
  const promotionSite =
    checkpoint.promotionSites?.[task.promotionSiteId] || {};
  return {
    taskId: task.taskId,
    profileId: task.profileId,
    profileDisplayName: profile.displayName || '',
    promotionSiteId: task.promotionSiteId,
    promotionSiteName: promotionSite.name || '',
    promotionSiteUrl: promotionSite.url || '',
    assignmentPairId: task.assignmentPairId,
    assignmentSource: task.assignmentSource,
    configRevision: checkpoint.configRevision,
    attemptCount: task.attempt
  };
}

function createResultEntry(checkpoint, urlIndex, result, now, startedAt) {
  const item = checkpoint.source.parsedUrls[urlIndex];
  const task = checkpoint.tasks[String(urlIndex)];
  const preview = normalizeBatchResultPreview(result.resultPreview);
  return {
    originalIndex: urlIndex,
    attempt: task.attempt,
    url: item.url || '',
    sourceDomain: item.sourceDomain || '',
    result: result.result,
    aiContent: result.aiContent || null,
    ...preview,
    errorCode: result.errorCode || null,
    errorMessage: result.errorMessage
      ? sanitizeDiagnosticText(result.errorMessage)
      : null,
    timestamp: now,
    elapsed: Number.isFinite(startedAt)
      ? Math.max(0, Math.round((now - startedAt) / 1000))
      : null,
    originalRow: Array.isArray(item.originalRow)
      ? clone(item.originalRow)
      : null,
    ...assignmentFields(checkpoint, task),
    skipReason: result.skipReason || null
  };
}

function resultMatches(existing, candidate) {
  return existing.attempt === candidate.attempt &&
    existing.result === candidate.result &&
    existing.aiContent === candidate.aiContent &&
    existing.commentText === candidate.commentText &&
    JSON.stringify(existing.anchorTexts) ===
      JSON.stringify(candidate.anchorTexts) &&
    existing.promotedWebsiteUrl === candidate.promotedWebsiteUrl &&
    existing.errorCode === candidate.errorCode &&
    existing.errorMessage === candidate.errorMessage;
}

function planSource(plan) {
  const headers = [
    '原URL',
    '来源域名',
    'profileId',
    'promotionSiteId'
  ];
  const parsedUrls = plan.tasks.map((task) => {
    const originalRow = [
      task.targetUrl,
      task.sourceDomain,
      task.profileId,
      task.promotionSiteId
    ];
    return {
      originalIndex: task.urlIndex,
      url: task.targetUrl,
      sourceDomain: task.sourceDomain,
      originalRow
    };
  });
  return {
    fileName: 'confirmed-batch-plan.csv',
    headers,
    rows: parsedUrls.map(({ originalRow }) => [...originalRow]),
    parsedUrls
  };
}

function runtimeTask(planTask, now) {
  return {
    taskId: planTask.taskId,
    urlIndex: planTask.urlIndex,
    profileId: planTask.profileId,
    promotionSiteId: planTask.promotionSiteId,
    assignmentPairId: planTask.assignmentPairId,
    assignmentSource: planTask.assignmentSource,
    attemptCount: 1,
    lastFailurePhase: null,
    lastErrorCode: planTask.blockReason || null,
    attempt: 1,
    state: planTask.state === 'blocked' ? 'terminal' : 'queued',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: now,
    requestId: null,
    ownerPageTabId: null,
    ownershipEpoch: null,
    manualResolution: {
      status: 'idle',
      updatedAt: null
    }
  };
}

function checkpointFromPlan(input, now) {
  const plan = clone(input.plan);
  const confirmation = clone(input.confirmation);
  assertNoSensitiveFields({ plan, confirmation, settings: input.settings });
  if (
    plan?.version !== 2 ||
    typeof plan.planId !== 'string' ||
    plan.planId !== input.batchId ||
    typeof plan.planFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(plan.planFingerprint) ||
    !Number.isInteger(plan.configRevision) ||
    plan.configRevision < 0 ||
    !plan.profiles ||
    typeof plan.profiles !== 'object' ||
    Array.isArray(plan.profiles) ||
    !plan.promotionSites ||
    typeof plan.promotionSites !== 'object' ||
    Array.isArray(plan.promotionSites) ||
    !Array.isArray(plan.tasks)
  ) {
    throw new Error('invalid_batch_plan');
  }
  const source = sanitizeSource(planSource(plan));
  const settings = clone(input.settings);
  const tasks = Object.fromEntries(plan.tasks.map((task, index) => {
    if (
      task?.urlIndex !== index ||
      typeof task.taskId !== 'string' ||
      !['eligible', 'blocked'].includes(task.state) ||
      typeof task.profileId !== 'string' ||
      !plan.profiles[task.profileId] ||
      typeof task.promotionSiteId !== 'string' ||
      !plan.promotionSites[task.promotionSiteId] ||
      typeof task.assignmentPairId !== 'string' ||
      typeof task.assignmentSource !== 'string'
    ) {
      throw new Error('invalid_batch_plan');
    }
    return [String(index), runtimeTask(task, now)];
  }));
  const checkpoint = {
    version: BATCH_RUNTIME_VERSION,
    batchId: input.batchId,
    status: 'paused_recovery',
    createdAt: now,
    updatedAt: now,
    planFingerprint: plan.planFingerprint,
    confirmationSummary: confirmation,
    configRevision: plan.configRevision,
    profiles: clone(plan.profiles),
    promotionSites: clone(plan.promotionSites),
    source,
    settings,
    cursor: { nextIndex: nextCursor(tasks, plan.tasks.length) },
    tasks,
    openingReservations: {},
    results: []
  };
  for (const task of plan.tasks) {
    if (task.state !== 'blocked') continue;
    checkpoint.results.push(createResultEntry(
      checkpoint,
      task.urlIndex,
      {
        result: task.blockReason === 'blocked_illegal'
          ? 'blocked_illegal'
          : 'skipped',
        errorCode: task.blockReason,
        errorMessage: null,
        skipReason: task.blockReason
      },
      now,
      null
    ));
  }
  return checkpoint;
}

export function createBatchRuntimeCheckpoint(input, now = Date.now()) {
  if (input?.plan) return checkpointFromPlan(input, now);
  assertNoSensitiveFields(input);
  const source = sanitizeSource(input.source);
  const settings = clone(input.settings);
  const snapshots = legacyAssignmentSnapshot(input.batchId, settings);
  const tasks = {};

  source.parsedUrls.forEach((item, urlIndex) => {
    tasks[String(urlIndex)] = {
      urlIndex,
      ...legacyTaskAssignment(input.batchId, urlIndex),
      attempt: 1,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: now,
      requestId: null,
      ownerPageTabId: null,
      ownershipEpoch: null,
      manualResolution: {
        status: 'idle',
        updatedAt: null
      }
    };
  });

  return {
    version: BATCH_RUNTIME_VERSION,
    batchId: input.batchId,
    status: 'paused_recovery',
    createdAt: now,
    updatedAt: now,
    planFingerprint: null,
    confirmationSummary: null,
    configRevision: 0,
    ...snapshots,
    source,
    settings,
    cursor: { nextIndex: 0 },
    tasks,
    openingReservations: {},
    results: []
  };
}

function validateVersion1Checkpoint(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'invalid_checkpoint' };
  }
  if (value.version !== 1) {
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

export function validateBatchRuntimeCheckpoint(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'invalid_checkpoint' };
  }
  if (value.version !== BATCH_RUNTIME_VERSION) {
    return { ok: false, error: 'unsupported_version' };
  }
  try {
    assertNoSensitiveFields(value);
  } catch {
    return { ok: false, error: 'sensitive_field_forbidden' };
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
    (
      value.planFingerprint !== null &&
      (
        typeof value.planFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.planFingerprint)
      )
    ) ||
    !Number.isInteger(value.configRevision) ||
    value.configRevision < 0 ||
    !value.profiles ||
    typeof value.profiles !== 'object' ||
    Array.isArray(value.profiles) ||
    !value.promotionSites ||
    typeof value.promotionSites !== 'object' ||
    Array.isArray(value.promotionSites) ||
    !value.cursor ||
    !Number.isInteger(value.cursor.nextIndex) ||
    !value.tasks ||
    typeof value.tasks !== 'object' ||
    Array.isArray(value.tasks) ||
    !value.openingReservations ||
    typeof value.openingReservations !== 'object' ||
    Array.isArray(value.openingReservations) ||
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
    const item = value.source.parsedUrls[urlIndex];
    const ownsTab = ['active', 'submitting'].includes(task?.state);
    const canonical = canonicalRequestId(
      value.batchId,
      urlIndex,
      task?.attempt
    );
    if (
      !task ||
      task.urlIndex !== urlIndex ||
      typeof task.taskId !== 'string' ||
      task.taskId.length === 0 ||
      typeof task.profileId !== 'string' ||
      !value.profiles[task.profileId] ||
      typeof task.promotionSiteId !== 'string' ||
      !value.promotionSites[task.promotionSiteId] ||
      typeof task.assignmentPairId !== 'string' ||
      task.assignmentPairId.length === 0 ||
      typeof task.assignmentSource !== 'string' ||
      task.assignmentSource.length === 0 ||
      !Number.isInteger(task.attemptCount) ||
      task.attemptCount !== task.attempt ||
      (
        task.lastFailurePhase !== null &&
        !BATCH_TASK_PHASES.has(task.lastFailurePhase)
      ) ||
      (
        task.lastErrorCode !== null &&
        typeof task.lastErrorCode !== 'string'
      ) ||
      !Number.isInteger(task.attempt) ||
      task.attempt < 1 ||
      !TASK_STATES.has(task.state) ||
      (
        ownsTab &&
        (
          task.requestId !== canonical ||
          !Number.isInteger(task.tabId) ||
          task.tabId <= 0 ||
          !Number.isInteger(task.windowId) ||
          task.windowId <= 0 ||
          !Number.isFinite(task.startedAt) ||
          task.startedAt <= 0 ||
          !(
            hasVerifiedOwner(
              task.ownerPageTabId,
              task.ownershipEpoch
            ) ||
            (
              task.ownerPageTabId === null &&
              task.ownershipEpoch === null &&
              value.status === 'paused_recovery' &&
              value.recoveryCleanup?.reason ===
                'ownership_unverified'
            )
          )
        )
      ) ||
      (
        !ownsTab &&
        (
          task.requestId !== null ||
          task.tabId !== null ||
          task.windowId !== null ||
          task.startedAt !== null ||
          task.ownerPageTabId !== null ||
          task.ownershipEpoch !== null
        )
      ) ||
      (task.phase !== null && !BATCH_TASK_PHASES.has(task.phase)) ||
      !task.manualResolution ||
      typeof task.manualResolution !== 'object' ||
      !MANUAL_RESOLUTION_STATUSES.has(task.manualResolution.status) ||
      (
        task.manualResolution.updatedAt !== null &&
        !Number.isFinite(task.manualResolution.updatedAt)
      ) ||
      !isSanitizedUrlCell(item?.url) ||
      (
        Array.isArray(item?.originalRow) &&
        !item.originalRow.every(isSanitizedUrlCell)
      ) ||
      (
        Array.isArray(value.source.rows[urlIndex]) &&
        !value.source.rows[urlIndex].every(isSanitizedUrlCell)
      )
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
  }

  const reservationFields = [
    'attempt',
    'batchId',
    'cleanupOnly',
    'createCompletionUnknown',
    'ownerPageTabId',
    'ownershipEpoch',
    'requestId',
    'tabId',
    'updatedAt',
    'urlIndex',
    'windowId'
  ];
  for (const [key, reservation] of Object.entries(
    value.openingReservations
  )) {
    const task = value.tasks[String(reservation?.urlIndex)];
    if (
      !reservation ||
      typeof reservation !== 'object' ||
      Array.isArray(reservation) ||
      Object.keys(reservation).sort().join(',') !==
        reservationFields.join(',') ||
      reservation.requestId !== key ||
      reservation.batchId !== value.batchId ||
      reservation.requestId !== canonicalRequestId(
        value.batchId,
        reservation.urlIndex,
        reservation.attempt
      ) ||
      !Number.isInteger(reservation.urlIndex) ||
      reservation.urlIndex < 0 ||
      reservation.urlIndex >= totalCount ||
      !Number.isInteger(reservation.attempt) ||
      reservation.attempt < 1 ||
      !Number.isInteger(reservation.windowId) ||
      reservation.windowId <= 0 ||
      (
        reservation.tabId !== null &&
        (
          !Number.isInteger(reservation.tabId) ||
          reservation.tabId <= 0
        )
      ) ||
      !Number.isFinite(reservation.updatedAt) ||
      typeof reservation.cleanupOnly !== 'boolean' ||
      typeof reservation.createCompletionUnknown !== 'boolean' ||
      !(
        hasVerifiedOwner(
          reservation.ownerPageTabId,
          reservation.ownershipEpoch
        ) ||
        (
          reservation.ownerPageTabId === null &&
          reservation.ownershipEpoch === null &&
          value.status === 'paused_recovery' &&
          value.recoveryCleanup?.reason === 'ownership_unverified'
        )
      ) ||
      task?.attempt !== reservation.attempt ||
      (
        reservation.cleanupOnly
          ? task?.state !== 'terminal'
          : task?.state !== 'queued'
      ) ||
      task?.requestId !== null
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
  }

  const resultAttempts = new Set();
  const currentAttemptResultCounts = new Map();
  for (const result of value.results) {
    const task = value.tasks[String(result?.originalIndex)];
    const resultKey = `${result?.originalIndex}:${result?.attempt}`;
    if (
      !result ||
      !Number.isInteger(result.originalIndex) ||
      result.originalIndex < 0 ||
      result.originalIndex >= totalCount ||
      !Number.isInteger(result.attempt) ||
      result.attempt < 1 ||
      !BATCH_TERMINAL_RESULTS.has(result.result) ||
      (
        result.commentText !== null &&
        typeof result.commentText !== 'string'
      ) ||
      !Array.isArray(result.anchorTexts) ||
      !result.anchorTexts.every((text) => typeof text === 'string') ||
      (
        result.promotedWebsiteUrl !== null &&
        typeof result.promotedWebsiteUrl !== 'string'
      ) ||
      (typeof result.errorCode !== 'string' && result.errorCode !== null) ||
      (
        typeof result.errorMessage !== 'string' &&
        result.errorMessage !== null
      ) ||
      (
        typeof result.errorMessage === 'string' &&
        sanitizeDiagnosticText(result.errorMessage) !== result.errorMessage
      ) ||
      resultAttempts.has(resultKey) ||
      result.attempt > task.attempt ||
      !isSanitizedUrlCell(result.url) ||
      (
        Array.isArray(result.originalRow) &&
        !result.originalRow.every(isSanitizedUrlCell)
      ) ||
      result.taskId !== task.taskId ||
      result.profileId !== task.profileId ||
      result.promotionSiteId !== task.promotionSiteId ||
      result.assignmentPairId !== task.assignmentPairId ||
      result.assignmentSource !== task.assignmentSource ||
      result.configRevision !== value.configRevision ||
      result.attemptCount !== result.attempt ||
      typeof result.profileDisplayName !== 'string' ||
      typeof result.promotionSiteName !== 'string' ||
      typeof result.promotionSiteUrl !== 'string' ||
      (
        result.skipReason !== null &&
        typeof result.skipReason !== 'string'
      )
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
    resultAttempts.add(resultKey);
    if (result.attempt === task.attempt) {
      currentAttemptResultCounts.set(
        result.originalIndex,
        (currentAttemptResultCounts.get(result.originalIndex) || 0) + 1
      );
    }
  }

  for (let urlIndex = 0; urlIndex < totalCount; urlIndex += 1) {
    const task = value.tasks[String(urlIndex)];
    const currentResultCount = currentAttemptResultCounts.get(urlIndex) || 0;
    if (
      (task.state === 'terminal' && currentResultCount !== 1) ||
      (task.state !== 'terminal' && currentResultCount !== 0)
    ) {
      return { ok: false, error: 'invalid_checkpoint' };
    }
  }

  return { ok: true, checkpoint: value };
}

function addLegacyAssignmentFields(checkpoint) {
  const snapshots = legacyAssignmentSnapshot(
    checkpoint.batchId,
    checkpoint.settings
  );
  checkpoint.planFingerprint = null;
  checkpoint.confirmationSummary = null;
  checkpoint.configRevision = 0;
  checkpoint.profiles = snapshots.profiles;
  checkpoint.promotionSites = snapshots.promotionSites;
  for (const task of Object.values(checkpoint.tasks)) {
    Object.assign(
      task,
      legacyTaskAssignment(checkpoint.batchId, task.urlIndex),
      {
        attemptCount: task.attempt,
        lastFailurePhase: task.state === 'terminal'
          ? task.phase
          : null,
        lastErrorCode: null
      }
    );
  }
  for (const result of checkpoint.results) {
    const task = checkpoint.tasks[String(result.originalIndex)];
    Object.assign(result, assignmentFields(checkpoint, task), {
      skipReason: null,
      ...normalizeBatchResultPreview(result)
    });
    if (task.state === 'terminal') {
      task.lastErrorCode = result.errorCode;
    }
  }
}

export function migrateBatchRuntimeCheckpoint(value, now = Date.now()) {
  if (value?.version === BATCH_RUNTIME_VERSION) {
    const sanitized = sanitizeVersion2Checkpoint(value);
    if (!sanitized.ok) {
      return {
        ...failed(null, sanitized.error),
        changed: false
      };
    }
    const { checkpoint, changed } = sanitized;
    const validation = validateBatchRuntimeCheckpoint(checkpoint);
    if (!validation.ok) {
      return {
        ...failed(null, validation.error),
        changed: false
      };
    }
    return {
      ok: true,
      checkpoint,
      changed
    };
  }

  if (![1, 2].includes(value?.version)) {
    return {
      ...failed(
        null,
        value && typeof value === 'object'
          ? 'unsupported_version'
          : 'invalid_checkpoint'
      ),
      changed: false
    };
  }

  const checkpoint = clone(value);
  try {
    if (checkpoint.version === 1) {
      const validation = validateVersion1Checkpoint(checkpoint);
      if (!validation.ok) {
        return {
          ...failed(null, validation.error),
          changed: false
        };
      }
      checkpoint.source = sanitizeSource(checkpoint.source);
      let ownershipUnverified = false;
      for (const task of Object.values(checkpoint.tasks)) {
        task.attempt = 1;
        task.requestId = ['active', 'submitting'].includes(task.state)
          ? canonicalRequestId(
              checkpoint.batchId,
              task.urlIndex,
              task.attempt
            )
          : null;
        task.ownerPageTabId = null;
        task.ownershipEpoch = null;
        if (['active', 'submitting'].includes(task.state)) {
          ownershipUnverified = true;
        }
        task.manualResolution = {
          status: 'idle',
          updatedAt: null
        };
      }
      checkpoint.openingReservations = {};
      if (ownershipUnverified) {
        checkpoint.status = 'paused_recovery';
        checkpoint.recoveryCleanup = {
          reason: 'ownership_unverified',
          diagnostic: null,
          updatedAt: now
        };
      }
      for (const result of checkpoint.results) {
        result.url = sanitizeUrlCell(result.url);
        if (Array.isArray(result.originalRow)) {
          result.originalRow = result.originalRow.map(sanitizeUrlCell);
        }
        result.attempt = 1;
        result.errorCode = typeof result.errorCode === 'string'
          ? result.errorCode
          : LEGACY_RESULT_ERROR_CODES[result.result];
        result.errorMessage = typeof result.errorMessage === 'string' ||
          result.errorMessage === null
          ? (
              typeof result.errorMessage === 'string'
                ? sanitizeDiagnosticText(result.errorMessage)
                : null
            )
          : null;
      }
    } else {
      const sanitized = sanitizeVersion2Checkpoint(checkpoint);
      if (!sanitized.ok) {
        return {
          ...failed(null, sanitized.error),
          changed: false
        };
      }
      Object.assign(checkpoint, sanitized.checkpoint);
      if (
        checkpoint.status === 'running' &&
        !checkpoint.recoveryCleanup
      ) {
        checkpoint.status = 'paused_recovery';
        checkpoint.recoveryCleanup = {
          reason: 'checkpoint_migrated',
          diagnostic: null,
          updatedAt: now
        };
      }
    }
    checkpoint.version = BATCH_RUNTIME_VERSION;
    addLegacyAssignmentFields(checkpoint);
    assertNoSensitiveFields(checkpoint);
  } catch (error) {
    return {
      ...failed(null, error?.code || error.message || 'invalid_checkpoint'),
      changed: false
    };
  }

  const migratedValidation = validateBatchRuntimeCheckpoint(checkpoint);
  if (!migratedValidation.ok) {
    return {
      ...failed(null, migratedValidation.error),
      changed: false
    };
  }
  return {
    ok: true,
    checkpoint,
    changed: true
  };
}

export function applyBatchRuntimeEvent(checkpoint, event, now = Date.now()) {
  const sanitized = sanitizeVersion2Checkpoint(checkpoint);
  if (!sanitized.ok) return failed(null, sanitized.error);
  checkpoint = sanitized.checkpoint;
  const validation = validateBatchRuntimeCheckpoint(checkpoint);
  if (!validation.ok) return failed(null, validation.error);
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
  if (
    taskEvent &&
    (
      (event.taskId !== undefined && event.taskId !== task.taskId) ||
      (
        event.profileId !== undefined &&
        event.profileId !== task.profileId
      ) ||
      (
        event.promotionSiteId !== undefined &&
        event.promotionSiteId !== task.promotionSiteId
      )
    )
  ) {
    return failed(checkpoint, 'stale_task_assignment');
  }
  if (taskEvent && event.attempt !== task.attempt) {
    return failed(checkpoint, 'stale_attempt');
  }

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
          changed: sanitized.changed
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
          changed: sanitized.changed
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
          changed: sanitized.changed
        };
      }
      next.status = 'completed';
      break;

    case 'task_activated':
      event.requestId ??= canonicalRequestId(
        checkpoint.batchId,
        event.urlIndex,
        event.attempt
      );
      if (
        checkpoint.status !== 'running' ||
        task.state !== 'queued' ||
        !Number.isInteger(event.tabId) ||
        event.tabId <= 0 ||
        !Number.isInteger(event.windowId) ||
        event.windowId <= 0 ||
        !Number.isInteger(event.ownerPageTabId) ||
        event.ownerPageTabId <= 0 ||
        typeof event.ownershipEpoch !== 'string' ||
        event.ownershipEpoch.length === 0 ||
        !Number.isFinite(event.startedAt) ||
        event.startedAt <= 0 ||
        (
          event.requestId !== canonicalRequestId(
            checkpoint.batchId,
            event.urlIndex,
            event.attempt
          )
        )
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      Object.assign(task, {
        state: 'active',
        phase: null,
        tabId: event.tabId,
        windowId: event.windowId,
        ownerPageTabId: event.ownerPageTabId,
        ownershipEpoch: event.ownershipEpoch,
        startedAt: event.startedAt,
        updatedAt: now,
        requestId: event.requestId
      });
      break;

    case 'task_phase':
      if (
        checkpoint.status !== 'running' ||
        !['active', 'submitting'].includes(task.state) ||
        !BATCH_TASK_PHASES.has(event.phase)
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      task.phase = event.phase;
      task.updatedAt = now;
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
          (result) => result.originalIndex === event.urlIndex &&
            result.attempt === event.attempt
        );
        if (existing && resultMatches(existing, candidate)) {
          return {
            ok: true,
            checkpoint,
            changed: sanitized.changed
          };
        }
        return failed(checkpoint, 'task_already_terminal');
      }
      const normalTerminal =
        checkpoint.status === 'running' &&
        ['queued', 'active', 'submitting'].includes(task.state);
      const terminalCleanupRetry =
        checkpoint.status === 'paused_recovery' &&
        [
          'terminal_cleanup_failed',
          'ownership_unverified'
        ].includes(checkpoint.recoveryCleanup?.reason) &&
        event.terminalCleanupRetry === true &&
        ['active', 'submitting'].includes(task.state);
      if (!normalTerminal && !terminalCleanupRetry) {
        return failed(checkpoint, 'invalid_transition');
      }
      const failedPhase = task.phase;
      Object.assign(task, {
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        ownerPageTabId: null,
        ownershipEpoch: null,
        startedAt: null,
        updatedAt: now,
        attemptCount: task.attempt,
        lastFailurePhase: event.result.result === 'success'
          ? null
          : failedPhase,
        lastErrorCode: event.result.errorCode || null
      });
      task.requestId = null;
      if (event.retainOpeningRequestId !== undefined) {
        const reservation =
          next.openingReservations[event.retainOpeningRequestId];
        if (
          !reservation ||
          reservation.requestId !== event.retainOpeningRequestId ||
          reservation.urlIndex !== task.urlIndex ||
          reservation.attempt !== task.attempt ||
          reservation.cleanupOnly !== false
        ) {
          return failed(checkpoint, 'invalid_opening_reservation');
        }
        reservation.cleanupOnly = true;
        reservation.updatedAt = now;
      }
      next.results.push(candidate);
      break;
    }

    case 'task_retried': {
      if (
        !['running', 'paused_recovery'].includes(checkpoint.status) ||
        task.state !== 'terminal'
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      const currentResult = checkpoint.results.find(
        (result) => result.originalIndex === event.urlIndex &&
          result.attempt === task.attempt
      );
      if (!currentResult) {
        return failed(checkpoint, 'invalid_transition');
      }
      if (
        event.automatic === true &&
        (
          task.attempt !== 1 ||
          event.retryable !== true ||
          event.hasSubmitContext !== false ||
          !AUTOMATIC_RETRY_ERROR_CODES.has(currentResult.errorCode) ||
          SUBMIT_RISK_PHASES.has(task.lastFailurePhase)
        )
      ) {
        return failed(checkpoint, 'automatic_retry_blocked');
      }
      const retryPolicy = getBatchRetryPolicy(currentResult);
      if (retryPolicy === 'blocked') {
        return failed(checkpoint, 'retry_blocked');
      }
      if (retryPolicy === 'confirm' && event.confirmedRisk !== true) {
        return failed(checkpoint, 'retry_confirmation_required');
      }
      Object.assign(task, {
        attempt: task.attempt + 1,
        attemptCount: task.attempt + 1,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        ownerPageTabId: null,
        ownershipEpoch: null,
        startedAt: null,
        updatedAt: now,
        manualResolution: {
          status: 'idle',
          updatedAt: null
        }
      });
      task.requestId = null;
      break;
    }

    case 'task_manual_updated': {
      const currentResult = checkpoint.results.find(
        (result) => result.originalIndex === event.urlIndex &&
          result.attempt === task.attempt
      );
      if (
        task.state !== 'terminal' ||
        !['manual_required', 'no_comment_box'].includes(
          currentResult?.result
        ) ||
        !MANUAL_RESOLUTION_STATUSES.has(event.status)
      ) {
        return failed(checkpoint, 'invalid_transition');
      }
      task.manualResolution = {
        status: event.status,
        updatedAt: now
      };
      task.updatedAt = now;
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
  const sanitized = sanitizeVersion2Checkpoint(checkpoint);
  if (!sanitized.ok) {
    return {
      ...failed(null, sanitized.error),
      orphanTabIds: []
    };
  }
  checkpoint = sanitized.checkpoint;
  const validation = validateBatchRuntimeCheckpoint(checkpoint);
  if (!validation.ok) {
    return {
      ...failed(null, validation.error),
      orphanTabIds: []
    };
  }
  if (checkpoint.status !== 'running') {
    return {
      ok: true,
      checkpoint,
      changed: sanitized.changed,
      orphanTabIds: []
    };
  }

  const next = clone(checkpoint);
  const orphanTabIds = [];
  for (const task of Object.values(next.tasks)) {
    if (!['active', 'submitting'].includes(task.state)) continue;
    if (
      Number.isInteger(task.tabId) &&
      !orphanTabIds.includes(task.tabId)
    ) {
      orphanTabIds.push(task.tabId);
    }
    if (task.state === 'submitting') {
      next.results.push(createResultEntry(
        checkpoint,
        task.urlIndex,
        {
          result: 'manual_required',
          errorCode: 'submission_uncertain',
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
        ownerPageTabId: null,
        ownershipEpoch: null,
        startedAt: null,
        updatedAt: now
      });
      task.requestId = null;
    } else {
      Object.assign(task, {
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        ownerPageTabId: null,
        ownershipEpoch: null,
        startedAt: null,
        updatedAt: now
      });
      task.requestId = null;
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
    orphanTabIds
  };
}
