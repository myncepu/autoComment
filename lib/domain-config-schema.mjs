export const DOMAIN_CONFIG_KEY = 'autoCommentDomainConfig';
export const DOMAIN_CONFIG_VERSION = 2;
export const DEFAULT_QUOTAS = Object.freeze({
  batch: 100,
  perProfile: 50,
  perPromotionSite: 50,
  perTargetDomain: 3
});

const DOMAIN_KEYS = ['version', 'revision', 'profiles', 'promotionSites', 'assignmentPolicy'];
const PROFILE_KEYS = ['id', 'displayName', 'name', 'email', 'createdAt', 'updatedAt'];
const PROMOTION_SITE_KEYS = ['id', 'name', 'url', 'content', 'enabled', 'createdAt', 'updatedAt'];
const POLICY_KEYS = ['defaultPairId', 'pairs', 'quotas'];
const PAIR_KEYS = ['id', 'profileId', 'promotionSiteId', 'weight', 'enabled'];
const QUOTA_KEYS = Object.keys(DEFAULT_QUOTAS);

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

function allowedKeys(value, expected, code) {
  if (!isRecord(value) || Object.keys(value).some((key) => !expected.includes(key))) {
    throw codedError(code);
  }
}

function requiredString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedError(code);
  }
  return value.trim();
}

function timestamp(value, code) {
  if (!Number.isInteger(value) || value < 0) {
    throw codedError(code);
  }
  return value;
}

function normalizeEmail(value) {
  const email = requiredString(value, 'invalid_profile_email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw codedError('invalid_profile_email');
  }
  return email;
}

function normalizePromotionUrl(value) {
  const raw = requiredString(value, 'invalid_promotion_site_url');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw codedError('invalid_promotion_site_url');
    }
    return url.href;
  } catch (error) {
    if (error?.code === 'invalid_promotion_site_url') throw error;
    throw codedError('invalid_promotion_site_url');
  }
}

function normalizeProfile(value) {
  exactKeys(value, PROFILE_KEYS, 'invalid_profile');
  return {
    id: requiredString(value.id, 'invalid_profile'),
    displayName: requiredString(value.displayName, 'invalid_profile'),
    name: requiredString(value.name, 'invalid_profile'),
    email: normalizeEmail(value.email),
    createdAt: timestamp(value.createdAt, 'invalid_profile'),
    updatedAt: timestamp(value.updatedAt, 'invalid_profile')
  };
}

function normalizePromotionSite(value) {
  exactKeys(value, PROMOTION_SITE_KEYS, 'invalid_promotion_site');
  if (typeof value.enabled !== 'boolean') {
    throw codedError('invalid_promotion_site');
  }
  return {
    id: requiredString(value.id, 'invalid_promotion_site'),
    name: requiredString(value.name, 'invalid_promotion_site'),
    url: normalizePromotionUrl(value.url),
    content: requiredString(value.content, 'invalid_promotion_site'),
    enabled: value.enabled,
    createdAt: timestamp(value.createdAt, 'invalid_promotion_site'),
    updatedAt: timestamp(value.updatedAt, 'invalid_promotion_site')
  };
}

function normalizePair(value) {
  exactKeys(value, PAIR_KEYS, 'invalid_assignment_pair');
  if (typeof value.enabled !== 'boolean') {
    throw codedError('invalid_assignment_pair');
  }
  if (!Number.isInteger(value.weight) || value.weight < 1 || value.weight > 100) {
    throw codedError('invalid_assignment_pair_weight');
  }
  return {
    id: requiredString(value.id, 'invalid_assignment_pair'),
    profileId: requiredString(value.profileId, 'invalid_assignment_pair'),
    promotionSiteId: requiredString(value.promotionSiteId, 'invalid_assignment_pair'),
    weight: value.weight,
    enabled: value.enabled
  };
}

function normalizeQuotas(value) {
  allowedKeys(value, QUOTA_KEYS, 'invalid_quotas');
  const quotas = { ...DEFAULT_QUOTAS, ...value };
  if (QUOTA_KEYS.some((key) => !Number.isInteger(quotas[key]) || quotas[key] <= 0)) {
    throw codedError('invalid_quotas');
  }
  return quotas;
}

function normalizePolicy(value) {
  exactKeys(value, POLICY_KEYS, 'invalid_assignment_policy');
  if (value.defaultPairId !== null && typeof value.defaultPairId !== 'string') {
    throw codedError('invalid_default_assignment_pair');
  }
  if (!Array.isArray(value.pairs)) {
    throw codedError('invalid_assignment_policy');
  }
  return {
    defaultPairId: value.defaultPairId === null
      ? null
      : requiredString(value.defaultPairId, 'invalid_default_assignment_pair'),
    pairs: value.pairs.map(normalizePair),
    quotas: normalizeQuotas(value.quotas)
  };
}

export function normalizeDomainConfig(value) {
  exactKeys(value, DOMAIN_KEYS, 'invalid_domain_config');
  if (value.version !== DOMAIN_CONFIG_VERSION) {
    throw codedError('unsupported_domain_config_version');
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw codedError('invalid_domain_config_revision');
  }
  if (!Array.isArray(value.profiles) || !Array.isArray(value.promotionSites)) {
    throw codedError('invalid_domain_config');
  }
  return {
    version: DOMAIN_CONFIG_VERSION,
    revision: value.revision,
    profiles: value.profiles.map(normalizeProfile),
    promotionSites: value.promotionSites.map(normalizePromotionSite),
    assignmentPolicy: normalizePolicy(value.assignmentPolicy)
  };
}

function canonicalName(value) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function assertUnique(items, keyFor, code) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) throw codedError(code);
    seen.add(key);
  }
}

function validateUniqueProfiles(profiles) {
  assertUnique(profiles, (profile) => profile.id, 'duplicate_profile_id');
  assertUnique(profiles, (profile) => canonicalName(profile.displayName),
    'duplicate_profile_display_name');
}

function validateUniqueSites(sites) {
  assertUnique(sites, (site) => site.id, 'duplicate_promotion_site_id');
  assertUnique(sites, (site) => canonicalName(site.name), 'duplicate_promotion_site_name');
}

function validatePolicy(config) {
  const profileIds = new Set(config.profiles.map((profile) => profile.id));
  const sitesById = new Map(config.promotionSites.map((site) => [site.id, site]));
  const pairs = config.assignmentPolicy.pairs;

  assertUnique(pairs, (pair) => pair.id, 'duplicate_assignment_pair_id');
  assertUnique(pairs, (pair) => `${pair.profileId}\0${pair.promotionSiteId}`,
    'duplicate_assignment_combination');

  for (const pair of pairs) {
    if (!profileIds.has(pair.profileId) || !sitesById.has(pair.promotionSiteId)) {
      throw codedError('invalid_assignment_pair');
    }
  }

  const defaultPairId = config.assignmentPolicy.defaultPairId;
  if (pairs.length === 0) {
    if (defaultPairId !== null) throw codedError('invalid_default_assignment_pair');
    return;
  }

  const defaultPair = pairs.find((pair) => pair.id === defaultPairId);
  if (!defaultPair?.enabled || !sitesById.get(defaultPair.promotionSiteId)?.enabled) {
    throw codedError('invalid_default_assignment_pair');
  }
}

const SENSITIVE_KEY_PARTS = ['password', 'secret', 'apikey', 'cookie', 'token'];

export function assertNoSensitiveFields(value) {
  const visited = new WeakSet();

  function visit(current) {
    if (!current || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    for (const [key, child] of Object.entries(current)) {
      const normalizedKey = key.toLocaleLowerCase().replaceAll(/[^a-z0-9]/gu, '');
      if (SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
        throw codedError('sensitive_field_forbidden');
      }
      visit(child);
    }
  }

  visit(value);
}

export function validateDomainConfig(value) {
  try {
    const normalized = normalizeDomainConfig(value);
    validateUniqueProfiles(normalized.profiles);
    validateUniqueSites(normalized.promotionSites);
    validatePolicy(normalized);
    assertNoSensitiveFields(normalized);
    return { ok: true, value: structuredClone(normalized) };
  } catch (error) {
    return { ok: false, error: error?.code || 'invalid_domain_config' };
  }
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isInteger(value) && value >= 0 ? value : Date.now();
}

export function createDefaultDomainConfig(legacy, { now = Date.now } = {}) {
  const config = {
    version: DOMAIN_CONFIG_VERSION,
    revision: 0,
    profiles: [],
    promotionSites: [],
    assignmentPolicy: {
      defaultPairId: null,
      pairs: [],
      quotas: { ...DEFAULT_QUOTAS }
    }
  };
  if (!isRecord(legacy)) return config;

  const profileName = typeof legacy.auto_fill_user_name === 'string'
    ? legacy.auto_fill_user_name.trim()
    : '';
  const profileEmail = typeof legacy.auto_fill_user_email === 'string'
    ? legacy.auto_fill_user_email.trim()
    : '';
  const siteUrl = typeof legacy.promotion_website_url === 'string'
    ? legacy.promotion_website_url.trim()
    : '';
  const siteContent = typeof legacy.promotion_website_content === 'string'
    ? legacy.promotion_website_content.trim()
    : '';

  if (!profileName || !profileEmail || !siteUrl || !siteContent) return config;

  const at = resolveNow(now);
  config.profiles.push({
    id: 'default-profile',
    displayName: '默认身份',
    name: profileName,
    email: profileEmail,
    createdAt: at,
    updatedAt: at
  });
  config.promotionSites.push({
    id: 'default-promotion-site',
    name: '默认推广网站',
    url: siteUrl,
    content: siteContent,
    enabled: true,
    createdAt: at,
    updatedAt: at
  });
  config.assignmentPolicy.defaultPairId = 'default-assignment-pair';
  config.assignmentPolicy.pairs.push({
    id: 'default-assignment-pair',
    profileId: 'default-profile',
    promotionSiteId: 'default-promotion-site',
    weight: 1,
    enabled: true
  });
  return normalizeDomainConfig(config);
}
