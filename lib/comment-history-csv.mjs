export const CSV_EXPORT_CHUNK_SIZE = 500;
export const CSV_ROWS_PER_PART = 50_000;

const COLUMN_NAMES = Object.freeze([
  'id',
  'batchId',
  'urlIndex',
  'submittedAt',
  'targetPageUrl',
  'targetDomain',
  'promotedWebsiteUrl',
  'promotedDomain',
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
  'skipReason',
  'commentHtml',
  'commentText',
  'anchorTexts',
  'anchorHrefRaws',
  'anchorHrefResolveds',
  'submitStatus',
  'source'
]);

function stringValue(value) {
  return value == null ? '' : String(value);
}

export function escapeCsvCell(value) {
  let text = stringValue(value);
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function localIsoWithOffset(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return [
    `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`,
    `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`,
    `${offsetSign}${twoDigits(Math.floor(absoluteOffset / 60))}:${twoDigits(absoluteOffset % 60)}`
  ].join('');
}

function anchorValues(anchors, property) {
  return JSON.stringify(
    (Array.isArray(anchors) ? anchors : []).map((anchor) => stringValue(anchor?.[property]))
  );
}

export const COMMENT_CSV_HEADER = `\ufeff${COLUMN_NAMES.join(',')}\r\n`;

export function buildCommentCsvRow(record = {}, anchors = []) {
  const values = [
    record.id,
    record.batchId,
    record.urlIndex,
    localIsoWithOffset(record.submittedAt),
    record.targetPageUrl,
    record.targetDomain,
    record.promotedWebsiteUrl,
    record.promotedDomain,
    record.profileId,
    record.profileDisplayName,
    record.promotionSiteId,
    record.promotionSiteName,
    record.promotionSiteUrl,
    record.assignmentPairId,
    record.assignmentSource,
    record.configRevision,
    record.attemptCount,
    record.errorCode,
    record.skipReason,
    record.commentHtml,
    record.commentText,
    anchorValues(anchors, 'anchorText'),
    anchorValues(anchors, 'hrefRaw'),
    anchorValues(anchors, 'hrefResolved'),
    record.submitStatus,
    record.source
  ];
  return `${values.map(escapeCsvCell).join(',')}\r\n`;
}

function compactUtcDate(timestamp) {
  if (!Number.isFinite(timestamp)) return 'all';
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}${twoDigits(date.getUTCMonth() + 1)}${twoDigits(date.getUTCDate())}`;
}

export function buildCsvPartName({
  from,
  to,
  exportedBefore,
  part
} = {}) {
  const safePart = Number.isInteger(part) && part > 0 ? part : 1;
  const rangeStart = compactUtcDate(from);
  const rangeEnd = compactUtcDate(Number.isFinite(to) ? to : exportedBefore);
  return `comment-history-${rangeStart}-${rangeEnd}-part-${String(safePart).padStart(3, '0')}.csv`;
}
