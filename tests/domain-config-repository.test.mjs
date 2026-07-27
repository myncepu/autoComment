import assert from 'node:assert/strict';
import test from 'node:test';

import { DOMAIN_CONFIG_KEY, createDefaultDomainConfig } from '../lib/domain-config-schema.mjs';
import { createDomainConfigRepository } from '../lib/domain-config-repository.mjs';

function storageArea(initial = {}, { setDelay = 0 } = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) {
      if (setDelay) await new Promise((resolve) => setTimeout(resolve, setDelay));
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
}

function profile(id, displayName = id) {
  return {
    id,
    displayName,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    createdAt: 999,
    updatedAt: 999
  };
}

function site(id, name = id) {
  return {
    id,
    name,
    url: `https://${id}.example.test`,
    content: `Description ${id}`,
    enabled: true,
    createdAt: 999,
    updatedAt: 999
  };
}

function populatedConfig() {
  return {
    ...createDefaultDomainConfig(),
    profiles: [profile('profile-a', 'Profile A')],
    promotionSites: [site('site-a', 'Site A')],
    assignmentPolicy: {
      defaultPairId: 'pair-a',
      pairs: [{
        id: 'pair-a',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        weight: 1,
        enabled: true
      }],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
}

test('loads a fresh non-sensitive default when storage is empty', async () => {
  const area = storageArea();
  const repository = createDomainConfigRepository(area);

  assert.deepEqual(await repository.load(), createDefaultDomainConfig());
  assert.equal(area.writes.length, 0);
});

test('replaces config after validation and increments from stored revision', async () => {
  const area = storageArea({ [DOMAIN_CONFIG_KEY]: createDefaultDomainConfig() });
  const repository = createDomainConfigRepository(area);
  const replacement = populatedConfig();
  replacement.revision = 88;

  const saved = await repository.replace(replacement);

  assert.equal(saved.revision, 1);
  assert.equal(area.data[DOMAIN_CONFIG_KEY].revision, 1);
  replacement.profiles[0].name = 'Caller mutation';
  saved.profiles[0].name = 'Result mutation';
  assert.equal((await repository.load()).profiles[0].name, 'Name profile-a');
});

test('conditionally replaces only the expected current revision', async () => {
  const initial = populatedConfig();
  const area = storageArea({ [DOMAIN_CONFIG_KEY]: initial });
  const repository = createDomainConfigRepository(area);
  const replacement = populatedConfig();
  replacement.profiles.push(profile('profile-b', 'Profile B'));

  const saved = await repository.replaceIfRevision(0, replacement);
  assert.equal(saved.revision, 1);
  await repository.saveProfile(profile('profile-c', 'Profile C'));

  await assert.rejects(
    repository.replaceIfRevision(1, initial),
    (error) => error.code === 'stale_domain_config_revision'
  );
  assert.deepEqual(
    (await repository.load()).profiles.map(({ id }) => id).sort(),
    ['profile-a', 'profile-b', 'profile-c']
  );
  assert.equal(area.writes.length, 2);
});

test('rejects invalid or sensitive replacement without writing', async () => {
  const area = storageArea();
  const repository = createDomainConfigRepository(area);
  const invalid = populatedConfig();
  invalid.profiles[0].password = 'DO_NOT_STORE';

  await assert.rejects(() => repository.replace(invalid), (error) => (
    error.code === 'invalid_profile' && !error.message.includes('DO_NOT_STORE')
  ));
  assert.equal(area.writes.length, 0);
});

test('serializes concurrent config writes and increments revision', async () => {
  const area = storageArea({}, { setDelay: 5 });
  const repository = createDomainConfigRepository(area, {
    now: (() => {
      let current = 100;
      return () => current++;
    })()
  });

  await Promise.all([
    repository.saveProfile(profile('profile-a', 'Profile A')),
    repository.saveProfile(profile('profile-b', 'Profile B'))
  ]);

  const saved = await repository.load();
  assert.deepEqual(saved.profiles.map((item) => item.id).sort(), ['profile-a', 'profile-b']);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.profiles.map((item) => item.createdAt), [100, 101]);
});

test('updates entities while preserving creation time and applying repository time', async () => {
  const area = storageArea();
  const repository = createDomainConfigRepository(area, { now: () => 500 });
  await repository.saveProfile(profile('profile-a', 'Profile A'));
  await repository.savePromotionSite(site('site-a', 'Site A'));

  const updateProfile = profile('profile-a', 'Renamed Profile');
  const updateSite = { ...site('site-a', 'Renamed Site'), enabled: false };
  await repository.saveProfile(updateProfile);
  await repository.savePromotionSite(updateSite);
  const saved = await repository.load();

  assert.deepEqual(saved.profiles[0], {
    ...updateProfile,
    createdAt: 500,
    updatedAt: 500
  });
  assert.deepEqual(saved.promotionSites[0], {
    ...updateSite,
    url: 'https://site-a.example.test/',
    createdAt: 500,
    updatedAt: 500
  });
  assert.equal(saved.revision, 4);
});

test('saves an assignment policy only when all references and defaults are valid', async () => {
  const area = storageArea();
  const repository = createDomainConfigRepository(area, { now: () => 500 });
  await repository.saveProfile(profile('profile-a', 'Profile A'));
  await repository.savePromotionSite(site('site-a', 'Site A'));

  const saved = await repository.saveAssignmentPolicy({
    defaultPairId: 'pair-a',
    pairs: [{
      id: 'pair-a',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      weight: 2,
      enabled: true
    }],
    quotas: { batch: 10 }
  });

  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.assignmentPolicy.quotas, {
    batch: 10,
    perProfile: 50,
    perPromotionSite: 50,
    perTargetDomain: 3
  });
  await assert.rejects(() => repository.saveAssignmentPolicy({
    ...saved.assignmentPolicy,
    defaultPairId: 'missing'
  }), (error) => error.code === 'invalid_default_assignment_pair');
  assert.equal((await repository.load()).revision, 3);
});

test('refuses to delete entities referenced by assignment pairs', async () => {
  const area = storageArea({ [DOMAIN_CONFIG_KEY]: populatedConfig() });
  const repository = createDomainConfigRepository(area);

  await assert.rejects(() => repository.deleteProfile('profile-a'),
    (error) => error.code === 'profile_in_use');
  await assert.rejects(() => repository.deletePromotionSite('site-a'),
    (error) => error.code === 'promotion_site_in_use');
  assert.equal((await repository.load()).revision, 0);
});

test('deletes unreferenced entities and rejects missing IDs without writes', async () => {
  const initial = populatedConfig();
  initial.profiles.push(profile('profile-b', 'Profile B'));
  initial.promotionSites.push(site('site-b', 'Site B'));
  const area = storageArea({ [DOMAIN_CONFIG_KEY]: initial });
  const repository = createDomainConfigRepository(area);

  await repository.deleteProfile('profile-b');
  await repository.deletePromotionSite('site-b');
  assert.deepEqual((await repository.load()).profiles.map(({ id }) => id), ['profile-a']);
  assert.deepEqual((await repository.load()).promotionSites.map(({ id }) => id), ['site-a']);
  assert.equal((await repository.load()).revision, 2);

  await assert.rejects(() => repository.deleteProfile('missing'),
    (error) => error.code === 'profile_not_found');
  await assert.rejects(() => repository.deletePromotionSite('missing'),
    (error) => error.code === 'promotion_site_not_found');
  assert.equal(area.writes.length, 2);
});

test('rejects corrupt stored config rather than silently replacing it', async () => {
  const corrupt = createDefaultDomainConfig();
  corrupt.password = 'DO_NOT_ECHO';
  const repository = createDomainConfigRepository(storageArea({
    [DOMAIN_CONFIG_KEY]: corrupt
  }));

  await assert.rejects(() => repository.load(), (error) => (
    error.code === 'invalid_domain_config' && !error.message.includes('DO_NOT_ECHO')
  ));
});
