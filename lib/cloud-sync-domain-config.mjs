import {
  DOMAIN_CONFIG_VERSION,
  validateDomainConfig
} from './domain-config-schema.mjs';
import { normalizeSyncMutation } from './cloud-sync-protocol.mjs';

export const CLOUD_SYNC_DOMAIN_ENTITY_TYPES = Object.freeze([
  'profile',
  'promotion_site',
  'assignment_pair',
  'assignment_policy'
]);

const DOMAIN_WRAPPERS = Object.freeze({
  profile: 'profile',
  promotion_site: 'promotionSite',
  assignment_pair: 'assignmentPair',
  assignment_policy: 'assignmentPolicy'
});

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(',')}}`;
}

export function domainConfigFingerprint(value) {
  const normalized = normalizeConfig(value);
  return canonical({ ...normalized, revision: 0 });
}

function normalizeConfig(value) {
  const result = validateDomainConfig(value);
  if (!result.ok) throw codedError(result.error);
  return result.value;
}

function policyEntity(config) {
  return {
    id: 'default-assignment-policy',
    defaultPairId: config.assignmentPolicy.defaultPairId,
    quotas: structuredClone(config.assignmentPolicy.quotas)
  };
}

function entityCollections(config) {
  return {
    profile: config.profiles,
    promotion_site: config.promotionSites,
    assignment_pair: config.assignmentPolicy.pairs
  };
}

function mutation({
  entityType,
  entityId,
  operation,
  value,
  createdAt,
  mutationId
}) {
  return normalizeSyncMutation({
    mutationId,
    entityType,
    entityId,
    operation,
    payload: operation === 'delete'
      ? { deletedAt: createdAt }
      : { [DOMAIN_WRAPPERS[entityType]]: structuredClone(value) },
    createdAt
  });
}

export function createDomainConfigMutations(change, {
  now = Date.now,
  createMutationId = () => crypto.randomUUID()
} = {}) {
  if (!change?.oldValue || !change?.newValue) return [];
  let before;
  let after;
  try {
    before = normalizeConfig(change.oldValue);
    after = normalizeConfig(change.newValue);
  } catch {
    return [];
  }

  const createdAt = now();
  const upserts = {
    profile: [],
    promotion_site: [],
    assignment_pair: []
  };
  const deletions = {
    profile: [],
    promotion_site: [],
    assignment_pair: []
  };
  const beforeCollections = entityCollections(before);
  const afterCollections = entityCollections(after);
  for (const entityType of CLOUD_SYNC_DOMAIN_ENTITY_TYPES.slice(0, 3)) {
    const oldById = new Map(
      beforeCollections[entityType].map((value) => [value.id, value])
    );
    const newById = new Map(
      afterCollections[entityType].map((value) => [value.id, value])
    );
    for (const [entityId] of oldById) {
      if (newById.has(entityId)) continue;
      deletions[entityType].push({ entityId });
    }
    for (const [entityId, value] of newById) {
      if (
        oldById.has(entityId)
        && canonical(oldById.get(entityId)) === canonical(value)
      ) {
        continue;
      }
      upserts[entityType].push({ entityId, value });
    }
  }

  const beforePolicy = policyEntity(before);
  const afterPolicy = policyEntity(after);
  const ordered = [
    ...upserts.profile.map((entry) => ({
      entityType: 'profile',
      operation: 'upsert',
      ...entry
    })),
    ...upserts.promotion_site.map((entry) => ({
      entityType: 'promotion_site',
      operation: 'upsert',
      ...entry
    })),
    ...upserts.assignment_pair.map((entry) => ({
      entityType: 'assignment_pair',
      operation: 'upsert',
      ...entry
    }))
  ];
  if (canonical(beforePolicy) !== canonical(afterPolicy)) {
    ordered.push({
      entityType: 'assignment_policy',
      entityId: afterPolicy.id,
      operation: 'upsert',
      value: afterPolicy
    });
  }
  ordered.push(
    ...deletions.assignment_pair.map((entry) => ({
      entityType: 'assignment_pair',
      operation: 'delete',
      ...entry
    })),
    ...deletions.profile.map((entry) => ({
      entityType: 'profile',
      operation: 'delete',
      ...entry
    })),
    ...deletions.promotion_site.map((entry) => ({
      entityType: 'promotion_site',
      operation: 'delete',
      ...entry
    }))
  );
  return ordered.map((entry) => mutation({
    ...entry,
    createdAt,
    mutationId: createMutationId()
  }));
}

function normalizedDomainChange(change) {
  if (
    !change
    || typeof change !== 'object'
    || !CLOUD_SYNC_DOMAIN_ENTITY_TYPES.includes(change.entityType)
  ) {
    throw codedError('INVALID_REMOTE_DOMAIN_CHANGE');
  }
  const normalized = normalizeSyncMutation({
    mutationId: 'remote-domain-change',
    entityType: change.entityType,
    entityId: change.entityId,
    operation: change.operation,
    payload: change.payload,
    createdAt: 0
  });
  return {
    entityType: normalized.entityType,
    entityId: normalized.entityId,
    operation: normalized.operation,
    payload: normalized.payload
  };
}

function upsertById(values, next) {
  const index = values.findIndex(({ id }) => id === next.id);
  if (index < 0) return [...values, structuredClone(next)];
  return values.map((value, currentIndex) => (
    currentIndex === index ? structuredClone(next) : value
  ));
}

function removeById(values, id) {
  return values.filter((value) => value.id !== id);
}

export function applyDomainChanges(currentValue, changes) {
  const current = normalizeConfig(currentValue);
  if (!Array.isArray(changes)) throw codedError('INVALID_REMOTE_DOMAIN_CHANGE');
  const normalizedChanges = changes.map(normalizedDomainChange);
  const candidate = structuredClone(current);

  for (const change of normalizedChanges) {
    const wrapper = DOMAIN_WRAPPERS[change.entityType];
    if (change.entityType === 'profile') {
      candidate.profiles = change.operation === 'delete'
        ? removeById(candidate.profiles, change.entityId)
        : upsertById(candidate.profiles, change.payload[wrapper]);
    } else if (change.entityType === 'promotion_site') {
      candidate.promotionSites = change.operation === 'delete'
        ? removeById(candidate.promotionSites, change.entityId)
        : upsertById(candidate.promotionSites, change.payload[wrapper]);
    } else if (change.entityType === 'assignment_pair') {
      candidate.assignmentPolicy.pairs = change.operation === 'delete'
        ? removeById(candidate.assignmentPolicy.pairs, change.entityId)
        : upsertById(
          candidate.assignmentPolicy.pairs,
          change.payload[wrapper]
        );
    } else {
      const policy = change.payload[wrapper];
      candidate.assignmentPolicy.defaultPairId = policy.defaultPairId;
      candidate.assignmentPolicy.quotas = structuredClone(policy.quotas);
    }
  }

  candidate.version = DOMAIN_CONFIG_VERSION;
  candidate.revision = current.revision;
  const config = normalizeConfig(candidate);
  return {
    config,
    changed: canonical(config) !== canonical(current)
  };
}

export function isDomainEntityType(entityType) {
  return CLOUD_SYNC_DOMAIN_ENTITY_TYPES.includes(entityType);
}
