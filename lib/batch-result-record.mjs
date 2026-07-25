import { escapeCsvCell } from './comment-history-csv.mjs';

export const BATCH_RESULT_ASSIGNMENT_COLUMNS = Object.freeze([
  'profileId',
  'profileDisplayName',
  'promotionSiteId',
  'promotionSiteName',
  'promotionSiteUrl',
  'assignmentPairId',
  'assignmentSource',
  'configRevision',
  'attemptCount',
  'errorCode',
  'skipReason'
]);

function requiredString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function buildBatchResult(task, outcome = {}, timing = {}) {
  const profileId = requiredString(task?.profileId, 'invalid_result_profile');
  const promotionSiteId = requiredString(
    task?.promotionSiteId,
    'invalid_result_promotion_site'
  );
  const attempt = Number.isInteger(timing.attempt) && timing.attempt > 0
    ? timing.attempt
    : 1;
  return {
    originalIndex: Number.isInteger(task.urlIndex) ? task.urlIndex : 0,
    url: typeof task.targetUrl === 'string' ? task.targetUrl : '',
    sourceDomain: typeof task.sourceDomain === 'string' ? task.sourceDomain : '',
    result: typeof outcome.result === 'string' ? outcome.result : 'fail',
    aiContent: optionalString(outcome.aiContent),
    errorMessage: optionalString(outcome.errorMessage),
    timestamp: Number.isFinite(timing.timestamp) ? timing.timestamp : Date.now(),
    elapsed: Number.isFinite(timing.elapsed) ? Math.max(0, timing.elapsed) : null,
    originalRow: Array.isArray(task.originalRow)
      ? structuredClone(task.originalRow)
      : null,
    profileId,
    profileDisplayName: requiredString(
      task.profile?.displayName ?? task.profileDisplayName,
      'invalid_result_profile'
    ),
    promotionSiteId,
    promotionSiteName: requiredString(
      task.promotionSite?.name ?? task.promotionSiteName,
      'invalid_result_promotion_site'
    ),
    promotionSiteUrl: requiredString(
      task.promotionSite?.url ?? task.promotionSiteUrl,
      'invalid_result_promotion_site'
    ),
    assignmentPairId: requiredString(
      task.assignmentPairId,
      'invalid_result_assignment'
    ),
    assignmentSource: requiredString(
      task.assignmentSource,
      'invalid_result_assignment'
    ),
    configRevision: Number.isInteger(task.configRevision) && task.configRevision >= 0
      ? task.configRevision
      : 0,
    attemptCount: Math.max(0, attempt - 1),
    errorCode: optionalString(outcome.errorCode),
    skipReason: optionalString(outcome.skipReason)
  };
}

export function buildBatchResultCsv(headers, results) {
  const sourceHeaders = Array.isArray(headers) ? headers.map(String) : [];
  const allHeaders = [...sourceHeaders, ...BATCH_RESULT_ASSIGNMENT_COLUMNS];
  const rows = (Array.isArray(results) ? results : []).map((result) => {
    const original = Array.isArray(result.originalRow)
      ? sourceHeaders.map((_, index) => result.originalRow[index] ?? '')
      : sourceHeaders.map(() => '');
    const assignments = BATCH_RESULT_ASSIGNMENT_COLUMNS.map(
      (column) => result[column] ?? ''
    );
    return `${[...original, ...assignments].map(escapeCsvCell).join(',')}\r\n`;
  });
  return `\ufeff${allHeaders.map(escapeCsvCell).join(',')}\r\n${rows.join('')}`;
}
