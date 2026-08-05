import { sanitizeBatchUrl } from './batch-url-sanitizer.mjs';

export const BATCH_OUTLINK_HEADERS = Object.freeze(['原URL', '来源域名']);
export const BATCH_OUTLINK_MAPPING = Object.freeze({
  targetUrl: 0,
  sourceDomain: 1,
  profileRef: null,
  promotionSiteRef: null
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceDomain(record) {
  const stored = text(record?.sourceHost).toLowerCase();
  if (stored) return stored;
  try {
    return new URL(record?.sourceUrl).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

export function normalizeBatchOutlinkRecord(record) {
  const sanitized = sanitizeBatchUrl(record?.url);
  let url;
  try {
    const parsed = new URL(sanitized);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    url = parsed.href;
  } catch (_) {
    return null;
  }
  let host = text(record?.host).toLowerCase();
  if (!host) {
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (_) {
      host = '';
    }
  }
  return {
    id: text(record?.id) || url,
    url,
    host,
    sourceHost: sourceDomain(record),
    isDofollow: record?.isDofollow === true,
    lastCapturedAt: Number.isFinite(record?.lastCapturedAt)
      ? record.lastCapturedAt
      : null,
    successCount: Number.isInteger(record?.successCount)
      ? Math.max(0, record.successCount)
      : 0,
    lastSuccessAt: Number.isFinite(record?.lastSuccessAt)
      ? record.lastSuccessAt
      : null,
    successfulPromotionSiteIds: Array.isArray(record?.successfulPromotionSiteIds)
      ? [...new Set(record.successfulPromotionSiteIds.map(text).filter(Boolean))]
      : [],
    successfulPromotedDomains: Array.isArray(record?.successfulPromotedDomains)
      ? [...new Set(record.successfulPromotedDomains.map(text).filter(Boolean))]
      : []
  };
}

export function normalizeBatchOutlinkRecords(records) {
  const byUrl = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizeBatchOutlinkRecord(record);
    if (!normalized || byUrl.has(normalized.url)) continue;
    byUrl.set(normalized.url, normalized);
  }
  return [...byUrl.values()];
}

export function buildBatchOutlinkParsedCsv(records) {
  const normalized = normalizeBatchOutlinkRecords(records);
  return {
    headers: [...BATCH_OUTLINK_HEADERS],
    rows: normalized.map((record, index) => ({
      rowNumber: index + 2,
      originalRow: [record.url, record.sourceHost]
    }))
  };
}

export function buildLegacyBatchOutlinkDocument(records) {
  const parsed = buildBatchOutlinkParsedCsv(records);
  return {
    headers: parsed.headers,
    rows: parsed.rows.map(({ originalRow }) => [...originalRow])
  };
}
