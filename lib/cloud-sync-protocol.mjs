export const CLOUD_SYNC_SETTING_KEYS = Object.freeze([
  'promotion_website_url',
  'promotion_website_content',
  'auto_fill_user_name',
  'auto_fill_user_email',
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
const FORBIDDEN_PROPERTY_NAMES = new Set([
  'apikey',
  'llm_api_key',
  'password',
  'cookie',
  'authorization',
  'batch_urls',
  'submit_context'
]);

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
    && value.id
  );
}

function rejectForbiddenProperties(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw protocolError('INVALID_MUTATION_PAYLOAD');
  seen.add(value);

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PROPERTY_NAMES.has(key.toLowerCase())) {
      throw protocolError('SENSITIVE_FIELD_NOT_SYNCABLE');
    }
    rejectForbiddenProperties(value[key], seen);
  }
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
    id: `legacy:${comment?.id || ''}:${capturedAt}`
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
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw protocolError('INVALID_MUTATION_PAYLOAD');
  }
  rejectForbiddenProperties(input.payload);

  const entityType = input.entityType;
  const operation = input.operation;
  if (entityType === 'setting') {
    if (!CLOUD_SYNC_SETTING_KEYS.includes(entityId)) {
      throw protocolError('SETTING_NOT_SYNCABLE');
    }
    if (operation !== 'upsert') throw protocolError('INVALID_MUTATION_OPERATION');
  } else if (entityType === 'comment') {
    if (operation !== 'upsert') throw protocolError('INVALID_MUTATION_OPERATION');
  } else if (entityType === 'comment_delete') {
    if (operation !== 'delete') throw protocolError('INVALID_MUTATION_OPERATION');
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
