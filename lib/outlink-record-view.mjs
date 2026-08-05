export const OUTLINK_PAGE_SIZES = Object.freeze([50, 100, 200, 500, 1000, 2000]);

export function normalizeOutlinkPageSize(value) {
  const parsed = Number.parseInt(value, 10);
  return OUTLINK_PAGE_SIZES.includes(parsed) ? parsed : OUTLINK_PAGE_SIZES[0];
}

export function sourcePageLinkLabel(record = {}) {
  const storedHost = typeof record.sourceHost === 'string'
    ? record.sourceHost.trim()
    : '';
  if (storedHost) return storedHost;

  try {
    const url = new URL(record.sourceUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname;
    }
  } catch (_) {
    // Fall through to the bounded raw value for malformed legacy records.
  }

  const rawValue = typeof record.sourceUrl === 'string'
    ? record.sourceUrl.trim()
    : '';
  return rawValue || '—';
}
