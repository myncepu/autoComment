import {
  DOMAIN_CONFIG_VERSION,
  assertNoSensitiveFields,
  createDefaultDomainConfig,
  validateDomainConfig
} from './domain-config-schema.mjs';

export const DOMAIN_CONFIG_EXPORT_FORMAT = 'autocomment-domain-config';
export const DOMAIN_CONFIG_EXPORT_VERSION = 2;

const EXPORT_KEYS = ['format', 'version', 'exportedAt', 'data'];
const LEGACY_PASSWORD_KEY = 'auto_fill_user_password';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validatedConfig(value) {
  const validation = validateDomainConfig(value);
  if (!validation.ok) throw codedError(validation.error);
  return validation.value;
}

function emptyConflict(code) {
  return {
    creates: [],
    updates: [],
    conflicts: [{ code }],
    mergedConfig: null,
    localSecretImport: null
  };
}

function mergeById(current, imported, entityType, creates, updates) {
  const importedIds = new Set(imported.map(({ id }) => id));
  const currentIds = new Set(current.map(({ id }) => id));
  for (const { id } of imported) {
    (currentIds.has(id) ? updates : creates).push({ entityType, id });
  }
  return [
    ...current.filter(({ id }) => !importedIds.has(id)),
    ...structuredClone(imported)
  ];
}

function mergeConfig(current, imported) {
  const creates = [];
  const updates = [];
  const profiles = mergeById(
    current.profiles,
    imported.profiles,
    'profile',
    creates,
    updates
  );
  const promotionSites = mergeById(
    current.promotionSites,
    imported.promotionSites,
    'promotion_site',
    creates,
    updates
  );
  const pairs = mergeById(
    current.assignmentPolicy.pairs,
    imported.assignmentPolicy.pairs,
    'assignment_pair',
    creates,
    updates
  );
  const mergedConfig = validatedConfig({
    version: DOMAIN_CONFIG_VERSION,
    revision: current.revision,
    profiles,
    promotionSites,
    assignmentPolicy: {
      ...structuredClone(imported.assignmentPolicy),
      pairs
    }
  });
  return { creates, updates, mergedConfig };
}

function parseNewFormat(input) {
  if (!exactKeys(input, EXPORT_KEYS)
      || input.format !== DOMAIN_CONFIG_EXPORT_FORMAT
      || input.version !== DOMAIN_CONFIG_EXPORT_VERSION
      || !Number.isInteger(input.exportedAt)
      || input.exportedAt < 0) {
    throw codedError('invalid_import_format');
  }
  assertNoSensitiveFields(input.data);
  return {
    importedConfig: validatedConfig(input.data),
    localSecretImport: null
  };
}

function legacyData(input) {
  if (!isRecord(input)) throw codedError('invalid_import_format');
  if (Object.hasOwn(input, 'data')) {
    if (!isRecord(input.data)) throw codedError('invalid_import_format');
    return input.data;
  }
  return input;
}

function parseLegacyFormat(input) {
  const data = legacyData(input);
  const defined = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  );
  const password = defined[LEGACY_PASSWORD_KEY];
  delete defined[LEGACY_PASSWORD_KEY];
  assertNoSensitiveFields(defined);

  const importedConfig = createDefaultDomainConfig(data);
  if (importedConfig.profiles.length === 0
      || importedConfig.promotionSites.length === 0) {
    throw codedError('legacy_config_incomplete');
  }
  if (password !== undefined && typeof password !== 'string') {
    throw codedError('invalid_legacy_password');
  }
  return {
    importedConfig,
    localSecretImport: typeof password === 'string' && password !== ''
      ? {
          profileId: 'default-profile',
          password
        }
      : null
  };
}

export function buildDomainConfigExport(config, { exportedAt = Date.now() } = {}) {
  assertNoSensitiveFields(config);
  const normalized = validatedConfig(config);
  if (!Number.isInteger(exportedAt) || exportedAt < 0) {
    throw codedError('invalid_export_timestamp');
  }
  return {
    format: DOMAIN_CONFIG_EXPORT_FORMAT,
    version: DOMAIN_CONFIG_EXPORT_VERSION,
    exportedAt,
    data: structuredClone(normalized)
  };
}

export function previewDomainConfigImport(current, input) {
  let normalizedCurrent;
  try {
    assertNoSensitiveFields(current);
    normalizedCurrent = validatedConfig(current);
  } catch (error) {
    return emptyConflict(error?.code || 'invalid_domain_config');
  }

  try {
    const parsed = isRecord(input) && Object.hasOwn(input, 'format')
      ? parseNewFormat(input)
      : parseLegacyFormat(input);
    const merged = mergeConfig(normalizedCurrent, parsed.importedConfig);
    return {
      creates: merged.creates,
      updates: merged.updates,
      conflicts: [],
      mergedConfig: structuredClone(merged.mergedConfig),
      localSecretImport: parsed.localSecretImport
        ? structuredClone(parsed.localSecretImport)
        : null
    };
  } catch (error) {
    return emptyConflict(error?.code || 'invalid_import_format');
  }
}

export async function applyDomainConfigImport(
  preview,
  { configRepository, secretRepository }
) {
  if (!isRecord(preview)
      || !Array.isArray(preview.conflicts)
      || !configRepository?.replace
      || !secretRepository) {
    throw codedError('invalid_import_preview');
  }
  if (preview.conflicts.length > 0) {
    throw codedError(preview.conflicts[0]?.code || 'import_conflict');
  }

  assertNoSensitiveFields(preview.mergedConfig);
  const mergedConfig = validatedConfig(preview.mergedConfig);
  const secretImport = preview.localSecretImport;
  if (secretImport !== null) {
    if (!exactKeys(secretImport, ['profileId', 'password'])
        || secretImport.profileId !== 'default-profile'
        || typeof secretImport.password !== 'string'
        || secretImport.password === ''
        || !mergedConfig.profiles.some(({ id }) => id === secretImport.profileId)
        || typeof secretRepository.setPassword !== 'function'
        || typeof secretRepository.getConfiguredStates !== 'function') {
      throw codedError('invalid_legacy_password_import');
    }
    await secretRepository.setPassword(secretImport.profileId, secretImport.password);
    const states = await secretRepository.getConfiguredStates([secretImport.profileId]);
    if (states[secretImport.profileId] !== true) {
      throw codedError('legacy_password_verification_failed');
    }
  }

  return configRepository.replace(mergedConfig);
}
