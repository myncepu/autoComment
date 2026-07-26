import { assertNoSensitiveFields } from './domain-config-schema.mjs';
import {
  hasUrlCredentials,
  sanitizeBatchUrl
} from './batch-url-sanitizer.mjs';

export const BATCH_RESULT_PREVIEW_LIMITS = Object.freeze({
  commentText: 20_000,
  anchorText: 1_000,
  anchorCount: 100,
  promotedWebsiteUrl: 2_048
});

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeAnchorTexts(anchors) {
  if (!Array.isArray(anchors)) return [];
  const seen = new Set();
  const texts = [];
  for (const anchor of anchors) {
    const source = typeof anchor === 'string'
      ? anchor
      : anchor?.anchorText ?? anchor?.text;
    const text = normalizeText(
      source,
      BATCH_RESULT_PREVIEW_LIMITS.anchorText
    );
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
    if (texts.length >= BATCH_RESULT_PREVIEW_LIMITS.anchorCount) break;
  }
  return texts;
}

function normalizePromotedWebsiteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (hasUrlCredentials(parsed.href)) {
    const error = new Error(
      'batch_result_preview_url_credentials_forbidden'
    );
    error.code = error.message;
    throw error;
  }
  return sanitizeBatchUrl(parsed.href).slice(
    0,
    BATCH_RESULT_PREVIEW_LIMITS.promotedWebsiteUrl
  );
}

export function normalizeBatchResultPreview(value = {}) {
  assertNoSensitiveFields(value);
  return {
    commentText: normalizeText(
      value?.commentText,
      BATCH_RESULT_PREVIEW_LIMITS.commentText
    ),
    anchorTexts: normalizeAnchorTexts(
      value?.anchorTexts ?? value?.anchors
    ),
    promotedWebsiteUrl: normalizePromotedWebsiteUrl(
      value?.promotedWebsiteUrl
    )
  };
}
