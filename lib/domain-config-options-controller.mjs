import {
  applyDomainConfigImport,
  buildDomainConfigExport,
  previewDomainConfigImport
} from './domain-config-import-export.mjs';
import { assertNoSensitiveFields } from './domain-config-schema.mjs';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, visited));
  return Object.freeze(value);
}

function immutableClone(value) {
  return deepFreeze(structuredClone(value));
}

function identifier(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedError(code);
  }
  return value.trim();
}

export function createDomainConfigOptionsController({
  configRepository,
  secretRepository,
  now = Date.now
}) {
  if (
    typeof configRepository?.load !== 'function'
    || typeof configRepository?.saveProfile !== 'function'
    || typeof configRepository?.savePromotionSite !== 'function'
    || typeof configRepository?.saveAssignmentPolicy !== 'function'
    || typeof secretRepository?.setPassword !== 'function'
    || typeof secretRepository?.clearPassword !== 'function'
    || typeof secretRepository?.getConfiguredStates !== 'function'
  ) {
    throw codedError('invalid_domain_options_dependencies');
  }

  let previewSequence = 0;
  const importPreviews = new Map();

  async function requireProfile(profileId) {
    const id = identifier(profileId, 'invalid_profile_id');
    const config = await configRepository.load();
    if (!config.profiles.some((profile) => profile.id === id)) {
      throw codedError('profile_not_found');
    }
    return id;
  }

  async function snapshot() {
    const config = await configRepository.load();
    assertNoSensitiveFields(config);
    const profileIds = config.profiles.map(({ id }) => id);
    const passwordConfigured =
      await secretRepository.getConfiguredStates(profileIds);
    const value = {
      version: config.version,
      revision: config.revision,
      profiles: structuredClone(config.profiles),
      promotionSites: structuredClone(config.promotionSites),
      pairs: structuredClone(config.assignmentPolicy.pairs),
      defaultPairId: config.assignmentPolicy.defaultPairId,
      quotas: structuredClone(config.assignmentPolicy.quotas),
      passwordConfigured
    };
    return immutableClone(value);
  }

  async function savePair(pair) {
    const config = await configRepository.load();
    const existing = config.assignmentPolicy.pairs.some(
      ({ id }) => id === pair?.id
    );
    const pairs = existing
      ? config.assignmentPolicy.pairs.map(
          (item) => item.id === pair.id ? structuredClone(pair) : item
        )
      : [...config.assignmentPolicy.pairs, structuredClone(pair)];
    await configRepository.saveAssignmentPolicy({
      ...config.assignmentPolicy,
      pairs,
      defaultPairId:
        config.assignmentPolicy.defaultPairId ?? pair.id
    });
    return snapshot();
  }

  async function savePolicy(policy) {
    const config = await configRepository.load();
    await configRepository.saveAssignmentPolicy({
      defaultPairId: Object.hasOwn(policy, 'defaultPairId')
        ? policy.defaultPairId
        : config.assignmentPolicy.defaultPairId,
      pairs: Object.hasOwn(policy, 'pairs')
        ? structuredClone(policy.pairs)
        : structuredClone(config.assignmentPolicy.pairs),
      quotas: Object.hasOwn(policy, 'quotas')
        ? structuredClone(policy.quotas)
        : structuredClone(config.assignmentPolicy.quotas)
    });
    return snapshot();
  }

  async function previewImport(input) {
    const current = await configRepository.load();
    const rawPreview = previewDomainConfigImport(current, input);
    previewSequence += 1;
    const previewId = `domain-import-preview-${previewSequence}`;
    importPreviews.set(previewId, structuredClone(rawPreview));
    return immutableClone({
      previewId,
      creates: rawPreview.creates,
      updates: rawPreview.updates,
      conflicts: rawPreview.conflicts,
      mergedConfig: rawPreview.mergedConfig,
      hasLocalPasswordImport: rawPreview.localSecretImport !== null
    });
  }

  async function applyImport(preview) {
    const rawPreview = importPreviews.get(preview?.previewId);
    if (!rawPreview) throw codedError('stale_import_preview');
    importPreviews.delete(preview.previewId);
    await applyDomainConfigImport(rawPreview, {
      configRepository,
      secretRepository
    });
    return snapshot();
  }

  return Object.freeze({
    snapshot,

    async saveProfile(profile) {
      assertNoSensitiveFields(profile);
      await configRepository.saveProfile(structuredClone(profile));
      return snapshot();
    },

    async deleteProfile(profileId) {
      await configRepository.deleteProfile(profileId);
      await secretRepository.clearPassword(profileId);
      return snapshot();
    },

    async savePromotionSite(site) {
      assertNoSensitiveFields(site);
      await configRepository.savePromotionSite(structuredClone(site));
      return snapshot();
    },

    async deletePromotionSite(siteId) {
      await configRepository.deletePromotionSite(siteId);
      return snapshot();
    },

    savePair,

    async deletePair(pairId) {
      const id = identifier(pairId, 'invalid_assignment_pair');
      const config = await configRepository.load();
      if (!config.assignmentPolicy.pairs.some((pair) => pair.id === id)) {
        throw codedError('assignment_pair_not_found');
      }
      const pairs = config.assignmentPolicy.pairs.filter(
        (pair) => pair.id !== id
      );
      const defaultPairId = config.assignmentPolicy.defaultPairId === id
        ? null
        : config.assignmentPolicy.defaultPairId;
      await configRepository.saveAssignmentPolicy({
        ...config.assignmentPolicy,
        pairs,
        defaultPairId
      });
      return snapshot();
    },

    savePolicy,

    async savePassword(profileId, password) {
      const id = await requireProfile(profileId);
      if (typeof password !== 'string' || password === '') {
        throw codedError('invalid_profile_password');
      }
      await secretRepository.setPassword(id, password);
      const state = await secretRepository.getConfiguredStates([id]);
      return { profileId: id, configured: state[id] === true };
    },

    async clearPassword(profileId) {
      const id = await requireProfile(profileId);
      await secretRepository.clearPassword(id);
      return { profileId: id, configured: false };
    },

    async exportConfig() {
      const config = await configRepository.load();
      return immutableClone(buildDomainConfigExport(config, {
        exportedAt: now()
      }));
    },

    previewImport,
    applyImport
  });
}
