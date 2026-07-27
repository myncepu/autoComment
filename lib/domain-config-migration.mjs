import {
  createDefaultDomainConfig,
  validateDomainConfig
} from './domain-config-schema.mjs';

export const DOMAIN_CONFIG_MIGRATION_VERSION_KEY = 'domainConfigMigrationVersion';
export const DOMAIN_CONFIG_MIGRATION_VERSION = 2;

export const LEGACY_DOMAIN_CONFIG_KEYS = Object.freeze([
  'promotion_website_url',
  'promotion_website_content',
  'auto_fill_user_name',
  'auto_fill_user_email',
  'auto_fill_user_password'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function mergeFixedLegacyEntities(current, legacy, at) {
  const defaults = createDefaultDomainConfig(legacy, { now: () => at });
  if (defaults.profiles.length === 0 || defaults.promotionSites.length === 0) {
    return current;
  }

  const next = structuredClone(current);
  let changed = false;
  const defaultProfile = defaults.profiles[0];
  const defaultSite = defaults.promotionSites[0];
  const defaultPair = defaults.assignmentPolicy.pairs[0];

  if (!next.profiles.some((profile) => profile.id === defaultProfile.id)) {
    next.profiles.push(defaultProfile);
    changed = true;
  }
  if (!next.promotionSites.some((site) => site.id === defaultSite.id)) {
    next.promotionSites.push(defaultSite);
    changed = true;
  }
  if (!next.assignmentPolicy.pairs.some((pair) => pair.id === defaultPair.id)) {
    next.assignmentPolicy.pairs.push(defaultPair);
    changed = true;
  }
  if (next.assignmentPolicy.defaultPairId === null) {
    next.assignmentPolicy.defaultPairId = defaultPair.id;
    changed = true;
  }

  if (!changed) return current;
  const validation = validateDomainConfig(next);
  if (!validation.ok) throw codedError(validation.error);
  return validation.value;
}

export async function migrateLegacyDomainConfig({
  storage,
  configRepository,
  secretRepository,
  now = Date.now
}) {
  const [syncValues, localValues, current] = await Promise.all([
    storage.sync.get(LEGACY_DOMAIN_CONFIG_KEYS),
    storage.local.get([
      ...LEGACY_DOMAIN_CONFIG_KEYS,
      DOMAIN_CONFIG_MIGRATION_VERSION_KEY
    ]),
    configRepository.load()
  ]);

  if (localValues[DOMAIN_CONFIG_MIGRATION_VERSION_KEY]
      === DOMAIN_CONFIG_MIGRATION_VERSION) {
    return { status: 'already_migrated' };
  }

  const mergedLegacy = { ...syncValues, ...localValues };
  const mergedConfig = mergeFixedLegacyEntities(current, mergedLegacy, now());
  if (mergedConfig !== current) {
    await configRepository.replace(mergedConfig);
  }

  const password = Object.hasOwn(localValues, 'auto_fill_user_password')
    ? localValues.auto_fill_user_password
    : syncValues.auto_fill_user_password;
  if (password !== undefined && password !== '') {
    await secretRepository.setPassword('default-profile', password);
    const copied = await secretRepository.getPasswordForBackground('default-profile');
    if (copied !== password) {
      throw codedError('legacy_password_verification_failed');
    }
    await storage.local.remove('auto_fill_user_password');
    await storage.sync.remove('auto_fill_user_password');
  }

  await storage.local.set({
    [DOMAIN_CONFIG_MIGRATION_VERSION_KEY]: DOMAIN_CONFIG_MIGRATION_VERSION
  });
  return { status: 'migrated' };
}
