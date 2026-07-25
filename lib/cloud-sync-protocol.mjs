export const CLOUD_SYNC_PROTOCOL_VERSION = 2;
export const CLOUD_SYNC_DOMAIN_CAPABILITY = 'domain_config_entities_v2';
export const CLOUD_SYNC_COMMENT_ASSIGNMENT_CAPABILITY =
  'comment_assignment_fields_v2';
export const CLOUD_SYNC_LEGACY_SETTING_KEYS = Object.freeze([
  'promotion_website_url',
  'promotion_website_content',
  'auto_fill_user_name',
  'auto_fill_user_email',
]);
export const CLOUD_SYNC_SETTING_KEYS = Object.freeze([
  'llm_api_base_url',
  'llm_model',
  'show_export_outlinks_floating_button',
  'batch_checkbox_settings',
  'batch_concurrency',
  'batch_timeout_seconds',
  'auto_comment_user_id'
]);

export const CLOUD_SYNC_LOCAL_KEYS = Object.freeze({
  enabled: 'cloud_sync_enabled',
  vaultId: 'cloud_sync_vault_id',
  secret: 'cloud_sync_secret',
  deviceId: 'cloud_sync_device_id'
});

const MUTATION_KEYS = Object.freeze([
  'mutationId',
  'entityType',
  'entityId',
  'operation',
  'payload',
  'createdAt'
]);
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const DOMAIN_PAYLOADS = Object.freeze({
  profile: {
    wrapper: 'profile',
    keys: ['id', 'displayName', 'name', 'email', 'createdAt', 'updatedAt']
  },
  promotion_site: {
    wrapper: 'promotionSite',
    keys: ['id', 'name', 'url', 'content', 'enabled', 'createdAt', 'updatedAt']
  },
  assignment_pair: {
    wrapper: 'assignmentPair',
    keys: ['id', 'profileId', 'promotionSiteId', 'weight', 'enabled']
  },
  assignment_policy: {
    wrapper: 'assignmentPolicy',
    keys: ['id', 'defaultPairId', 'quotas']
  }
});

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function nonEmptyString(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw protocolError(code);
  return value;
}

function isValidHistoryRevision(value) {
  return Boolean(
    value
    && Number.isFinite(value.capturedAt)
    && Number.isFinite(value.recordedAt)
    && Number.isInteger(value.sequence)
    && value.sequence >= 0
    && typeof value.id === 'string'
    && PRINTABLE_ASCII_PATTERN.test(value.id)
  );
}

function asciiSafeLegacyCommentId(value) {
  const commentId = typeof value === 'string'
    ? value
    : String(value || '');
  if (/^[\x20-\x7e]*$/.test(commentId)) return commentId;
  const encoded = Array.from(
    new TextEncoder().encode(commentId),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  return `utf8hex-${encoded}`;
}

function isForbiddenPropertyName(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return normalized.includes('password')
    || normalized.includes('cookie')
    || normalized.includes('authorization')
    || normalized.includes('apikey')
    || normalized.includes('token')
    || normalized.includes('credentials')
    || normalized.includes('submitcontext')
    || normalized.includes('recoverycheckpoint')
    || normalized.includes('batchurl')
    || normalized.includes('cloudsyncsecret')
    || normalized === 'secret'
    || normalized === 'syncsecret'
    || normalized === 'synckey';
}

function rejectForbiddenProperties(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw protocolError('INVALID_MUTATION_PAYLOAD');
    return;
  }
  if (typeof value !== 'object') throw protocolError('INVALID_MUTATION_PAYLOAD');
  if (seen.has(value)) throw protocolError('INVALID_MUTATION_PAYLOAD');
  seen.add(value);
  if (
    !Array.isArray(value)
    && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null
  ) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }

  for (const key of Object.keys(value)) {
    if (isForbiddenPropertyName(key)) {
      throw protocolError('SENSITIVE_FIELD_NOT_SYNCABLE');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
    rejectForbiddenProperties(descriptor.value, seen);
  }
}

function requirePayloadKeys(payload, allowedKeys) {
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.includes(key)) throw protocolError('UNKNOWN_MUTATION_PAYLOAD_KEY');
  }
}

function requireExactKeys(value, keys) {
  if (!isObject(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
}

function validDomainEntity(entityType, entityId, entity) {
  const schema = DOMAIN_PAYLOADS[entityType];
  requireExactKeys(entity, schema.keys);
  if (entity.id !== entityId) throw protocolError('INVALID_MUTATION_PAYLOAD');
  const strings = schema.keys.filter((key) => ![
    'createdAt',
    'updatedAt',
    'enabled',
    'weight',
    'quotas',
    'defaultPairId'
  ].includes(key));
  if (strings.some((key) => typeof entity[key] !== 'string' || !entity[key].trim())) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
  if (entityType === 'profile') {
    if (!Number.isFinite(entity.createdAt) || !Number.isFinite(entity.updatedAt)
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(entity.email)) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
  } else if (entityType === 'promotion_site') {
    let url;
    try {
      url = new URL(entity.url);
    } catch {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || typeof entity.enabled !== 'boolean'
        || !Number.isFinite(entity.createdAt)
        || !Number.isFinite(entity.updatedAt)) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
  } else if (entityType === 'assignment_pair') {
    if (!Number.isInteger(entity.weight) || entity.weight < 1 || entity.weight > 100
        || typeof entity.enabled !== 'boolean') {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
  } else {
    if (entityId !== 'default-assignment-policy') {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
    if (
      entity.defaultPairId !== null
      && (typeof entity.defaultPairId !== 'string' || !entity.defaultPairId.trim())
    ) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
    requireExactKeys(entity.quotas, [
      'batch',
      'perProfile',
      'perPromotionSite',
      'perTargetDomain'
    ]);
    if (Object.values(entity.quotas).some((value) => !Number.isInteger(value) || value <= 0)) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePayload(payload) {
  try {
    return structuredClone(payload);
  } catch {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
}

export function pickCloudSyncSettings(values = {}) {
  return Object.fromEntries(
    CLOUD_SYNC_SETTING_KEYS
      .filter((key) => Object.hasOwn(values, key))
      .map((key) => {
        rejectForbiddenProperties(values[key]);
        return [key, structuredClone(values[key])];
      })
  );
}

export function normalizeCommentRevision(comment) {
  if (isValidHistoryRevision(comment?.historyRevision)) {
    const { capturedAt, recordedAt, sequence, id } = comment.historyRevision;
    return { capturedAt, recordedAt, sequence, id };
  }
  const capturedAt = Number.isFinite(comment?.submittedAt)
    ? comment.submittedAt
    : Number.NEGATIVE_INFINITY;
  return {
    capturedAt,
    recordedAt: capturedAt,
    sequence: 0,
    id: `legacy:${asciiSafeLegacyCommentId(comment?.id)}:${capturedAt}`
  };
}

export function normalizeSyncMutation(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw protocolError('INVALID_MUTATION');
  }
  for (const key of Object.keys(input)) {
    if (!MUTATION_KEYS.includes(key)) throw protocolError('UNKNOWN_MUTATION_KEY');
  }
  for (const key of MUTATION_KEYS) {
    if (!Object.hasOwn(input, key)) throw protocolError('INVALID_MUTATION');
  }

  const mutationId = nonEmptyString(input.mutationId, 'INVALID_MUTATION_ID');
  const entityId = nonEmptyString(input.entityId, 'INVALID_ENTITY_ID');
  if (!Number.isFinite(input.createdAt)) throw protocolError('INVALID_MUTATION_TIMESTAMP');
  if (!isObject(input.payload)) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
  rejectForbiddenProperties(input.payload);

  const entityType = input.entityType;
  const operation = input.operation;
  if (entityType === 'setting') {
    if (![...CLOUD_SYNC_SETTING_KEYS, ...CLOUD_SYNC_LEGACY_SETTING_KEYS].includes(entityId)) {
      throw protocolError('SETTING_NOT_SYNCABLE');
    }
    if (operation !== 'upsert') throw protocolError('INVALID_MUTATION_OPERATION');
    requirePayloadKeys(input.payload, ['value']);
    if (!Object.hasOwn(input.payload, 'value')) throw protocolError('INVALID_MUTATION_PAYLOAD');
  } else if (entityType === 'comment') {
    if (operation !== 'upsert') throw protocolError('INVALID_MUTATION_OPERATION');
    requirePayloadKeys(input.payload, ['comment', 'anchors']);
    if (!isObject(input.payload.comment) || !Array.isArray(input.payload.anchors)) {
      throw protocolError('INVALID_MUTATION_PAYLOAD');
    }
    if (input.payload.comment.id !== entityId) throw protocolError('INVALID_MUTATION_PAYLOAD');
    if (
      Object.hasOwn(input.payload.comment, 'historyRevision')
      && !isValidHistoryRevision(input.payload.comment.historyRevision)
    ) {
      throw protocolError('INVALID_COMMENT_REVISION');
    }
  } else if (entityType === 'comment_delete') {
    if (operation !== 'delete') throw protocolError('INVALID_MUTATION_OPERATION');
    requirePayloadKeys(input.payload, ['deletedAt']);
    if (Object.hasOwn(input.payload, 'deletedAt') && !Number.isFinite(input.payload.deletedAt)) {
      throw protocolError('INVALID_MUTATION_TIMESTAMP');
    }
  } else if (Object.hasOwn(DOMAIN_PAYLOADS, entityType)) {
    if (entityType === 'assignment_policy' && operation !== 'upsert') {
      throw protocolError('INVALID_MUTATION_OPERATION');
    }
    if (!['upsert', 'delete'].includes(operation)) {
      throw protocolError('INVALID_MUTATION_OPERATION');
    }
    if (operation === 'delete') {
      requirePayloadKeys(input.payload, ['deletedAt']);
      if (!Number.isFinite(input.payload.deletedAt)) {
        throw protocolError('INVALID_MUTATION_TIMESTAMP');
      }
    } else {
      const schema = DOMAIN_PAYLOADS[entityType];
      requireExactKeys(input.payload, [schema.wrapper]);
      validDomainEntity(entityType, entityId, input.payload[schema.wrapper]);
    }
  } else {
    throw protocolError('INVALID_ENTITY_TYPE');
  }

  return {
    mutationId,
    entityType,
    entityId,
    operation,
    payload: clonePayload(input.payload),
    createdAt: input.createdAt
  };
}
