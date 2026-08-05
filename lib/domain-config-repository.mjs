import {
  DOMAIN_CONFIG_KEY,
  createDefaultDomainConfig,
  validateDomainConfig
} from './domain-config-schema.mjs';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function normalizedId(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw codedError(code);
  return value.trim();
}

function validated(value) {
  const result = validateDomainConfig(value);
  if (!result.ok) throw codedError(result.error);
  return result.value;
}

export function createDomainConfigRepository(storageArea, { now = Date.now } = {}) {
  if (!storageArea?.get || !storageArea?.set) {
    throw codedError('invalid_domain_config_storage');
  }

  let operation = Promise.resolve();

  async function readCurrent() {
    const stored = await storageArea.get([DOMAIN_CONFIG_KEY]);
    if (!Object.hasOwn(stored, DOMAIN_CONFIG_KEY)) {
      return createDefaultDomainConfig();
    }
    return validated(stored[DOMAIN_CONFIG_KEY]);
  }

  async function writeCandidate(candidate, currentRevision) {
    const normalized = validated({
      ...candidate,
      revision: currentRevision + 1
    });
    await storageArea.set({ [DOMAIN_CONFIG_KEY]: clone(normalized) });
    return clone(normalized);
  }

  function enqueue(work) {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  }

  async function load() {
    await operation;
    return clone(await readCurrent());
  }

  function replace(value) {
    return enqueue(async () => {
      const current = await readCurrent();
      const candidate = validated(value);
      return writeCandidate(candidate, current.revision);
    });
  }

  function replaceIfRevision(expectedRevision, value) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return Promise.reject(codedError('invalid_domain_config_revision'));
    }
    return enqueue(async () => {
      const current = await readCurrent();
      if (current.revision !== expectedRevision) {
        throw codedError('stale_domain_config_revision');
      }
      const candidate = validated(value);
      return writeCandidate(candidate, current.revision);
    });
  }

  function saveProfile(profile) {
    return enqueue(async () => {
      const current = await readCurrent();
      const id = normalizedId(profile?.id, 'invalid_profile');
      const existing = current.profiles.find((item) => item.id === id);
      const at = now();
      const nextProfile = {
        ...profile,
        id,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at
      };
      const candidate = {
        ...current,
        profiles: existing
          ? current.profiles.map((item) => item.id === id ? nextProfile : item)
          : [...current.profiles, nextProfile]
      };
      return writeCandidate(candidate, current.revision);
    });
  }

  function deleteProfile(profileId) {
    return enqueue(async () => {
      const id = normalizedId(profileId, 'invalid_profile_id');
      const current = await readCurrent();
      if (!current.profiles.some((profile) => profile.id === id)) {
        throw codedError('profile_not_found');
      }
      const pairs = current.assignmentPolicy.pairs.filter(
        (pair) => pair.profileId !== id
      );
      const defaultPairId = pairs.some(
        ({ id: pairId }) => pairId === current.assignmentPolicy.defaultPairId
      )
        ? current.assignmentPolicy.defaultPairId
        : pairs.find(({ enabled }) => enabled)?.id || null;
      return writeCandidate({
        ...current,
        profiles: current.profiles.filter((profile) => profile.id !== id),
        assignmentPolicy: {
          ...current.assignmentPolicy,
          pairs,
          defaultPairId
        }
      }, current.revision);
    });
  }

  function savePromotionSite(site) {
    return enqueue(async () => {
      const current = await readCurrent();
      const id = normalizedId(site?.id, 'invalid_promotion_site');
      const existing = current.promotionSites.find((item) => item.id === id);
      const at = now();
      const nextSite = {
        ...site,
        id,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at
      };
      const candidate = {
        ...current,
        promotionSites: existing
          ? current.promotionSites.map((item) => item.id === id ? nextSite : item)
          : [...current.promotionSites, nextSite]
      };
      return writeCandidate(candidate, current.revision);
    });
  }

  function deletePromotionSite(siteId) {
    return enqueue(async () => {
      const id = normalizedId(siteId, 'invalid_promotion_site_id');
      const current = await readCurrent();
      if (!current.promotionSites.some((site) => site.id === id)) {
        throw codedError('promotion_site_not_found');
      }
      const pairs = current.assignmentPolicy.pairs.filter(
        (pair) => pair.promotionSiteId !== id
      );
      const defaultPairId = pairs.some(
        ({ id: pairId }) => pairId === current.assignmentPolicy.defaultPairId
      )
        ? current.assignmentPolicy.defaultPairId
        : pairs.find(({ enabled }) => enabled)?.id || null;
      return writeCandidate({
        ...current,
        promotionSites: current.promotionSites.filter((site) => site.id !== id),
        assignmentPolicy: {
          ...current.assignmentPolicy,
          pairs,
          defaultPairId
        }
      }, current.revision);
    });
  }

  function saveAssignmentPolicy(policy) {
    return enqueue(async () => {
      const current = await readCurrent();
      return writeCandidate({
        ...current,
        assignmentPolicy: policy
      }, current.revision);
    });
  }

  return {
    load,
    replace,
    replaceIfRevision,
    saveProfile,
    deleteProfile,
    savePromotionSite,
    deletePromotionSite,
    saveAssignmentPolicy
  };
}
