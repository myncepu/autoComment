import { validateDomainConfig } from './domain-config-schema.mjs';

const MAPPING_KEYS = ['targetUrl', 'sourceDomain', 'profileRef', 'promotionSiteRef'];
const HEADER_ALIASES = Object.freeze({
  targetUrl: new Set(['原url', 'url']),
  sourceDomain: new Set(['url对应域名', '来源域名', 'sourcedomain']),
  profileRef: new Set(['profileid', 'profile', '身份id', '身份']),
  promotionSiteRef: new Set([
    'promotionsiteid',
    'promotionsite',
    '推广网站id',
    '推广网站'
  ])
});

function codedError(code, { rowNumber } = {}) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(rowNumber)) error.rowNumber = rowNumber;
  return error;
}

function bytesFrom(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw codedError('invalid_csv_bytes');
}

export function decodeBatchCsv(input) {
  const bytes = bytesFrom(input);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3
      && bytes[0] === 0xef
      && bytes[1] === 0xbb
      && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\ufffd')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    return /[\u3400-\u9fff]/u.test(gbk) ? gbk : utf8;
  } catch {
    return utf8;
  }
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\ufeff/u, '').trim();
}

export function parseBatchCsv(text, parseCsv) {
  if (typeof text !== 'string' || typeof parseCsv !== 'function') {
    throw codedError('invalid_csv_input');
  }
  let result;
  try {
    result = parseCsv(text, { skipEmptyLines: 'greedy' });
  } catch {
    throw codedError('csv_parse_failed');
  }
  const singleColumn = Array.isArray(result?.data)
    && result.data.length > 0
    && result.data.every((row) => Array.isArray(row) && row.length === 1);
  const fatalErrors = Array.isArray(result?.errors)
    ? result.errors.filter((error) => (
        error?.code !== 'UndetectableDelimiter' || !singleColumn
      ))
    : null;
  if (!result || !Array.isArray(result.data) || fatalErrors === null
      || fatalErrors.length > 0) {
    throw codedError('csv_parse_failed');
  }
  const [rawHeaders = [], ...rawRows] = result.data;
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) {
    throw codedError('csv_header_required');
  }
  const headers = rawHeaders.map(normalizeHeader);
  return {
    headers,
    rows: rawRows.map((row, index) => ({
      rowNumber: index + 2,
      originalRow: Array.isArray(row)
        ? row.map((value) => String(value ?? ''))
        : []
    }))
  };
}

function headerKey(value) {
  return normalizeHeader(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replaceAll(/[\s_-]/gu, '');
}

function findHeader(headers, role) {
  const matches = headers.flatMap((header, index) => (
    HEADER_ALIASES[role].has(headerKey(header)) ? [index] : []
  ));
  if (matches.length > 1) {
    throw codedError(`ambiguous_${role === 'targetUrl'
      ? 'target_url'
      : role === 'sourceDomain'
        ? 'source_domain'
        : role === 'profileRef'
          ? 'profile_ref'
          : 'promotion_site_ref'}_column`);
  }
  return matches[0] ?? null;
}

export function inferBatchColumnMapping(headers) {
  if (!Array.isArray(headers)) throw codedError('invalid_csv_headers');
  const targetUrl = findHeader(headers, 'targetUrl');
  if (targetUrl === null) throw codedError('target_url_column_required');
  return {
    targetUrl,
    sourceDomain: findHeader(headers, 'sourceDomain'),
    profileRef: findHeader(headers, 'profileRef'),
    promotionSiteRef: findHeader(headers, 'promotionSiteRef')
  };
}

function normalizeMapping(mapping, columnCount) {
  if (!mapping
      || typeof mapping !== 'object'
      || Array.isArray(mapping)
      || Object.keys(mapping).sort().join('\0') !== [...MAPPING_KEYS].sort().join('\0')) {
    throw codedError('invalid_column_mapping');
  }
  const normalized = {};
  for (const key of MAPPING_KEYS) {
    const index = mapping[key];
    if (index !== null
        && (!Number.isInteger(index) || index < 0 || index >= columnCount)) {
      throw codedError('invalid_column_mapping');
    }
    normalized[key] = index;
  }
  if (normalized.targetUrl === null) throw codedError('target_url_column_required');
  const assigned = Object.values(normalized).filter((index) => index !== null);
  if (new Set(assigned).size !== assigned.length) {
    throw codedError('duplicate_column_mapping');
  }
  if ((normalized.profileRef === null) !== (normalized.promotionSiteRef === null)) {
    throw codedError('assignment_columns_must_both_be_mapped');
  }
  return normalized;
}

function validatedConfig(config) {
  const result = validateDomainConfig(config);
  if (!result.ok) throw codedError(result.error);
  return result.value;
}

function canonicalUrl(value, code, rowNumber) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch {
    throw codedError(code, { rowNumber });
  }
}

function oneMatch(matches, missingCode, ambiguousCode, rowNumber) {
  if (matches.length === 0) throw codedError(missingCode, { rowNumber });
  if (matches.length > 1) throw codedError(ambiguousCode, { rowNumber });
  return matches[0];
}

function resolveProfile(reference, profiles, rowNumber) {
  const byId = profiles.find(({ id }) => id === reference);
  if (byId) return byId;
  return oneMatch(
    profiles.filter(({ displayName }) => displayName === reference),
    'profile_not_found',
    'profile_reference_ambiguous',
    rowNumber
  );
}

function resolvePromotionSite(reference, sites, rowNumber) {
  const byId = sites.find(({ id }) => id === reference);
  let site = byId;
  if (!site) {
    const byName = sites.filter(({ name }) => name === reference);
    if (byName.length > 1) {
      throw codedError('promotion_site_reference_ambiguous', { rowNumber });
    }
    site = byName[0];
  }
  if (!site) {
    let referenceUrl;
    try {
      referenceUrl = canonicalUrl(reference, 'promotion_site_not_found', rowNumber);
    } catch {
      throw codedError('promotion_site_not_found', { rowNumber });
    }
    site = oneMatch(
      sites.filter(({ url }) => canonicalUrl(url, 'invalid_promotion_site_url', rowNumber)
        === referenceUrl),
      'promotion_site_not_found',
      'promotion_site_reference_ambiguous',
      rowNumber
    );
  }
  if (!site.enabled) throw codedError('promotion_site_disabled', { rowNumber });
  return site;
}

function rawCell(row, index) {
  return index === null ? '' : String(row.originalRow[index] ?? '').trim();
}

export function resolveBatchRows(parsed, mapping, config) {
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw codedError('invalid_parsed_csv');
  }
  const normalizedMapping = normalizeMapping(mapping, parsed.headers.length);
  const normalizedConfig = validatedConfig(config);

  return parsed.rows.map((row) => {
    const rowNumber = row.rowNumber;
    const targetUrlRaw = rawCell(row, normalizedMapping.targetUrl);
    const sourceDomainRaw = rawCell(row, normalizedMapping.sourceDomain);
    const profileRefRaw = rawCell(row, normalizedMapping.profileRef);
    const promotionSiteRefRaw = rawCell(row, normalizedMapping.promotionSiteRef);
    if (!targetUrlRaw) throw codedError('target_url_required', { rowNumber });
    if (Boolean(profileRefRaw) !== Boolean(promotionSiteRefRaw)) {
      throw codedError('assignment_columns_must_both_be_filled', { rowNumber });
    }

    const resolved = {
      rowNumber,
      originalRow: [...row.originalRow],
      targetUrlRaw,
      sourceDomainRaw,
      profileRefRaw,
      promotionSiteRefRaw,
      profileId: null,
      promotionSiteId: null,
      assignmentPairId: null,
      assignmentSource: 'weighted'
    };
    if (!profileRefRaw) return resolved;

    const profile = resolveProfile(
      profileRefRaw,
      normalizedConfig.profiles,
      rowNumber
    );
    const site = resolvePromotionSite(
      promotionSiteRefRaw,
      normalizedConfig.promotionSites,
      rowNumber
    );
    const pair = normalizedConfig.assignmentPolicy.pairs.find((candidate) => (
      candidate.enabled
      && candidate.profileId === profile.id
      && candidate.promotionSiteId === site.id
    ));
    if (!pair) throw codedError('assignment_pair_not_approved', { rowNumber });
    return {
      ...resolved,
      profileId: profile.id,
      promotionSiteId: site.id,
      assignmentPairId: pair.id,
      assignmentSource: 'explicit'
    };
  });
}

export function buildBatchCsvTemplate(config) {
  const normalized = validatedConfig(config);
  const sitesById = new Map(
    normalized.promotionSites.map((site) => [site.id, site])
  );
  const availablePairs = normalized.assignmentPolicy.pairs.filter((pair) => (
    pair.enabled && sitesById.get(pair.promotionSiteId)?.enabled
  ));
  const profileIds = new Set(availablePairs.map(({ profileId }) => profileId));
  const siteIds = new Set(availablePairs.map(({ promotionSiteId }) => promotionSiteId));

  return {
    csv: '\ufeff原URL,来源域名,profileId,promotionSiteId\r\n',
    references: {
      profiles: normalized.profiles
        .filter(({ id }) => profileIds.has(id))
        .map(({ id, displayName }) => ({ id, displayName })),
      promotionSites: normalized.promotionSites
        .filter(({ id }) => siteIds.has(id))
        .map(({ id, name, url }) => ({ id, name, url })),
      assignmentPairs: availablePairs.map(({
        id,
        profileId,
        promotionSiteId,
        weight
      }) => ({
        id,
        profileId,
        promotionSiteId,
        weight
      }))
    }
  };
}
