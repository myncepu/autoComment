const URL_HEADERS = new Set(['原URL', 'URL', 'url', 'Url']);
const DOMAIN_HEADERS = new Set(['URL对应域名', '来源域名', 'sourceDomain']);

function asHttpUrl(value) {
  const raw = String(value || '').trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (_) {
    return null;
  }
}

function summarize(rows) {
  const summary = {
    raw: rows.length,
    eligible: 0,
    duplicate: 0,
    blocked: 0,
    invalid: 0,
    included: 0
  };
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.included) summary.included += 1;
  }
  return summary;
}

export function decodeBatchCsv(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.slice(2));
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? 3
    : 0;
  return new TextDecoder('utf-8').decode(bytes.slice(offset));
}

export function parseBatchCsv(text, parseCsv) {
  const response = parseCsv(text, { skipEmptyLines: 'greedy' });
  if (response.errors?.length) throw new Error('csv_parse_failed');

  const [headers, ...rows] = response.data || [];
  if (!Array.isArray(headers) || rows.length === 0) {
    throw new Error('csv_empty');
  }
  return {
    headers: headers.map((value) => String(value || '').trim()),
    rows
  };
}

export function preflightBatchRows(document, dependencies) {
  const headers = document.headers || [];
  const urlIndex = headers.findIndex((header) => URL_HEADERS.has(header));
  const domainIndex = headers.findIndex((header) => DOMAIN_HEADERS.has(header));
  const seenUrls = new Set();
  const evaluateUrl = dependencies.evaluateUrl;

  const rows = (document.rows || []).map((originalRow, index) => {
    const rowNumber = index + 2;
    const url = asHttpUrl(urlIndex >= 0 ? originalRow[urlIndex] : '');
    const sourceDomain = domainIndex >= 0
      ? String(originalRow[domainIndex] || '').trim()
      : '';
    const base = {
      rowNumber,
      originalRow: [...originalRow],
      url,
      sourceDomain,
      status: 'invalid',
      reasonCode: 'invalid_url',
      reason: 'URL 无效',
      overridable: false,
      included: false
    };

    if (!url) return base;

    if (seenUrls.has(url)) {
      return {
        ...base,
        status: 'duplicate',
        reasonCode: 'duplicate_url',
        reason: '重复 URL',
        overridable: true
      };
    }
    seenUrls.add(url);

    const evaluated = evaluateUrl(url, { sourceDomain });
    if (evaluated.blocked) {
      return {
        ...base,
        status: 'blocked',
        reasonCode: evaluated.code || 'blocked',
        reason: evaluated.reason || 'URL 被拦截'
      };
    }
    return {
      ...base,
      status: 'eligible',
      reasonCode: 'eligible',
      reason: 'URL 和域名有效',
      included: true
    };
  });

  return { headers: [...headers], rows, summary: summarize(rows) };
}

export function withDuplicateIncluded(preflight, rowNumber, included) {
  const rowIndex = preflight.rows.findIndex((row) => row.rowNumber === rowNumber);
  const row = preflight.rows[rowIndex];
  if (!row || !row.overridable) {
    throw new Error('preflight_row_not_overridable');
  }
  const rows = preflight.rows.map((item, index) => index === rowIndex
    ? { ...item, included: Boolean(included) }
    : { ...item });
  return { ...preflight, headers: [...preflight.headers], rows, summary: summarize(rows) };
}
