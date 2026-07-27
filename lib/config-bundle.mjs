import { validateDomainConfig } from './domain-config-schema.mjs';

export const CONFIG_BUNDLE_FORMAT = 'autocomment-config-bundle';
export const CONFIG_BUNDLE_VERSION = 3;

const BUNDLE_KEYS = ['format', 'version', 'exportedAt', 'data'];
const PORTABLE_DATA_KEYS = ['domainConfig', 'llm', 'batchDefaults', 'preferences'];
const LLM_KEYS = ['apiBaseUrl', 'model'];
const BATCH_DEFAULT_KEYS = [
  'autoOpenPanel',
  'autoGenerate',
  'autoSubmit',
  'concurrency',
  'timeoutSeconds'
];
const PREFERENCE_KEYS = ['showExportOutlinksFloatingButton'];
const SENSITIVE_KEY_PARTS = [
  'password',
  'secret',
  'apikey',
  'cookie',
  'token',
  'checkpoint',
  'submitcontext',
  'urlqueue',
  'authorization',
  'credential'
];

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)
      || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw codedError(code);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isSensitiveName(value) {
  const normalized = String(value)
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function assertNoSensitiveConfigFields(value) {
  const visited = new WeakSet();

  function visit(current) {
    if (!current || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveName(key)) {
        throw codedError('sensitive_config_bundle_field');
      }
      visit(child);
    }
  }

  visit(value);
}

function assertNoCredentialBearingUrl(
  url,
  code = 'sensitive_config_bundle_url'
) {
  const names = [
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.slice(1)).keys()
  ];
  if (url.username || url.password || names.some(isSensitiveName)) {
    throw codedError(code);
  }
}

function normalizedDomainConfig(value) {
  const result = validateDomainConfig(value);
  if (!result.ok) throw codedError(result.error);
  for (const site of result.value.promotionSites) {
    assertNoCredentialBearingUrl(new URL(site.url));
  }
  return result.value;
}

function normalizeLlm(value) {
  exactKeys(value, LLM_KEYS, 'invalid_config_bundle_format');
  if (typeof value.apiBaseUrl !== 'string' || typeof value.model !== 'string') {
    throw codedError('invalid_config_bundle_llm');
  }

  const apiBaseUrl = value.apiBaseUrl.trim().replace(/\/+$/u, '');
  const model = value.model.trim();
  let url;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw codedError('invalid_config_bundle_llm');
  }
  assertNoCredentialBearingUrl(url, 'invalid_config_bundle_llm');
  if (!['http:', 'https:'].includes(url.protocol)
      || url.search
      || url.hash
      || !model) {
    throw codedError('invalid_config_bundle_llm');
  }
  return { apiBaseUrl, model };
}

function normalizeBatchDefaults(value) {
  exactKeys(value, BATCH_DEFAULT_KEYS, 'invalid_config_bundle_format');
  if (typeof value.autoOpenPanel !== 'boolean'
      || typeof value.autoGenerate !== 'boolean'
      || typeof value.autoSubmit !== 'boolean'
      || !Number.isInteger(value.concurrency)
      || value.concurrency < 1
      || value.concurrency > 10
      || !Number.isInteger(value.timeoutSeconds)
      || value.timeoutSeconds < 10
      || value.timeoutSeconds > 600
      || (value.autoSubmit && !value.autoGenerate)) {
    throw codedError('invalid_config_bundle_batch_defaults');
  }
  return {
    autoOpenPanel: value.autoOpenPanel,
    autoGenerate: value.autoGenerate,
    autoSubmit: value.autoSubmit,
    concurrency: value.concurrency,
    timeoutSeconds: value.timeoutSeconds
  };
}

function normalizePreferences(value) {
  exactKeys(value, PREFERENCE_KEYS, 'invalid_config_bundle_format');
  if (typeof value.showExportOutlinksFloatingButton !== 'boolean') {
    throw codedError('invalid_config_bundle_preferences');
  }
  return {
    showExportOutlinksFloatingButton: value.showExportOutlinksFloatingButton
  };
}

function parsePortableData(data) {
  assertNoSensitiveConfigFields(data);
  exactKeys(data, PORTABLE_DATA_KEYS, 'invalid_config_bundle_format');
  return {
    domainConfig: normalizedDomainConfig(data.domainConfig),
    llm: normalizeLlm(data.llm),
    batchDefaults: normalizeBatchDefaults(data.batchDefaults),
    preferences: normalizePreferences(data.preferences)
  };
}

export function isConfigBundle(input) {
  return Boolean(input && input.format === CONFIG_BUNDLE_FORMAT);
}

export function parseConfigBundle(input) {
  assertNoSensitiveConfigFields(input);
  exactKeys(input, BUNDLE_KEYS, 'invalid_config_bundle_format');
  if (input.format !== CONFIG_BUNDLE_FORMAT || !Number.isInteger(input.exportedAt)
      || input.exportedAt < 0) {
    throw codedError('invalid_config_bundle_format');
  }
  if (input.version !== CONFIG_BUNDLE_VERSION) {
    throw codedError('unsupported_config_bundle_version');
  }
  return deepFreeze(structuredClone(parsePortableData(input.data)));
}

export function buildConfigBundle(data, { exportedAt = Date.now() } = {}) {
  if (!Number.isInteger(exportedAt) || exportedAt < 0) {
    throw codedError('invalid_config_bundle_format');
  }
  const normalized = parsePortableData(data);
  return deepFreeze({
    format: CONFIG_BUNDLE_FORMAT,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt,
    data: structuredClone(normalized)
  });
}
