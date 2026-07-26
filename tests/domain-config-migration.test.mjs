import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultDomainConfig } from '../lib/domain-config-schema.mjs';
import {
  DOMAIN_CONFIG_MIGRATION_VERSION,
  DOMAIN_CONFIG_MIGRATION_VERSION_KEY,
  migrateLegacyDomainConfig
} from '../lib/domain-config-migration.mjs';

function legacySettings(overrides = {}) {
  return {
    auto_fill_user_name: 'Legacy Alice',
    auto_fill_user_email: 'alice@example.test',
    auto_fill_user_password: 'runtime-secret',
    promotion_website_url: 'https://legacy-product.example',
    promotion_website_content: 'Legacy product summary',
    ...overrides
  };
}

function area(name, initial, events, { failRemove = false } = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, data[key]]));
    },
    async set(values) {
      events.push([`${name}.set`, structuredClone(values)]);
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      events.push([`${name}.remove`, keys]);
      if (failRemove) throw new Error(`${name}_remove_failed`);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function migrationHarness({
  sync = legacySettings(),
  local = {},
  current = createDefaultDomainConfig(),
  failSecretReadback = false,
  failLocalRemove = false,
  failSyncRemove = false
} = {}) {
  const events = [];
  let config = structuredClone(current);
  const passwords = {};
  const storage = {
    sync: area('sync', sync, events, { failRemove: failSyncRemove }),
    local: area('local', local, events, { failRemove: failLocalRemove })
  };
  const configRepository = {
    async load() {
      return structuredClone(config);
    },
    async replace(value) {
      events.push(['domain.replace', structuredClone(value)]);
      config = structuredClone(value);
      config.revision += 1;
      return structuredClone(config);
    }
  };
  const secretRepository = {
    async setPassword(profileId, password) {
      events.push(['profileSecrets.set', profileId]);
      passwords[profileId] = password;
    },
    async getPasswordForBackground(profileId) {
      events.push(['profileSecrets.read', profileId]);
      return failSecretReadback ? 'wrong-value' : passwords[profileId];
    }
  };
  return {
    events,
    storage,
    passwords,
    get config() {
      return config;
    },
    dependencies: {
      storage,
      configRepository,
      secretRepository,
      now: () => 123
    }
  };
}

test('migrates deterministic default entities and then secures the legacy password', async () => {
  const harness = migrationHarness();

  assert.deepEqual(await migrateLegacyDomainConfig(harness.dependencies), {
    status: 'migrated'
  });

  assert.deepEqual(harness.config.profiles, [{
    id: 'default-profile',
    displayName: '默认身份',
    name: 'Legacy Alice',
    email: 'alice@example.test',
    createdAt: 123,
    updatedAt: 123
  }]);
  assert.equal(harness.config.promotionSites[0].url, 'https://legacy-product.example/');
  assert.deepEqual(harness.config.assignmentPolicy.pairs, [{
    id: 'default-assignment-pair',
    profileId: 'default-profile',
    promotionSiteId: 'default-promotion-site',
    weight: 1,
    enabled: true
  }]);
  assert.equal(harness.passwords['default-profile'], 'runtime-secret');
  assert.equal(Object.hasOwn(harness.storage.sync.data, 'auto_fill_user_password'), false);
  assert.equal(harness.storage.local.data[DOMAIN_CONFIG_MIGRATION_VERSION_KEY],
    DOMAIN_CONFIG_MIGRATION_VERSION);
  assert.deepEqual(harness.events.map(([name]) => name), [
    'domain.replace',
    'profileSecrets.set',
    'profileSecrets.read',
    'local.remove',
    'sync.remove',
    'local.set'
  ]);
});

test('prefers the local password and verifies it before deleting either legacy copy', async () => {
  const harness = migrationHarness({
    sync: legacySettings({ auto_fill_user_password: 'sync-secret' }),
    local: { auto_fill_user_password: ' local-secret ' }
  });

  await migrateLegacyDomainConfig(harness.dependencies);

  assert.equal(harness.passwords['default-profile'], ' local-secret ');
  const sequence = harness.events.map(([name]) => name);
  assert.ok(sequence.indexOf('profileSecrets.read') < sequence.indexOf('local.remove'));
  assert.ok(sequence.indexOf('local.remove') < sequence.indexOf('sync.remove'));
});

test('does not delete a legacy password or mark complete after verification failure', async () => {
  const harness = migrationHarness({ failSecretReadback: true });

  await assert.rejects(() => migrateLegacyDomainConfig(harness.dependencies),
    (error) => error.code === 'legacy_password_verification_failed'
      && !error.message.includes('runtime-secret'));

  assert.equal(harness.storage.sync.data.auto_fill_user_password, 'runtime-secret');
  assert.equal(Object.hasOwn(harness.storage.local.data, DOMAIN_CONFIG_MIGRATION_VERSION_KEY), false);
  assert.equal(harness.events.some(([name]) => name.endsWith('.remove')), false);
});

test('does not mark complete when either legacy password removal fails', async () => {
  for (const failure of [{ failLocalRemove: true }, { failSyncRemove: true }]) {
    const harness = migrationHarness(failure);

    await assert.rejects(() => migrateLegacyDomainConfig(harness.dependencies));

    assert.equal(Object.hasOwn(
      harness.storage.local.data,
      DOMAIN_CONFIG_MIGRATION_VERSION_KEY
    ), false);
  }
});

test('does not overwrite existing entities and is idempotent after completion', async () => {
  const current = createDefaultDomainConfig(legacySettings({
    auto_fill_user_name: 'Current Name',
    auto_fill_user_email: 'current@example.test',
    promotion_website_url: 'https://current.example',
    promotion_website_content: 'Current content'
  }), { now: () => 50 });
  const harness = migrationHarness({
    current,
    local: { [DOMAIN_CONFIG_MIGRATION_VERSION_KEY]: DOMAIN_CONFIG_MIGRATION_VERSION }
  });

  assert.deepEqual(await migrateLegacyDomainConfig(harness.dependencies), {
    status: 'already_migrated'
  });
  assert.equal(harness.config.profiles[0].name, 'Current Name');
  assert.deepEqual(harness.events, []);
});

test('adds only missing fixed entities and does not repeatedly rewrite them after a failed run', async () => {
  const current = createDefaultDomainConfig();
  current.profiles.push({
    id: 'default-profile',
    displayName: 'Existing default',
    name: 'Existing Alice',
    email: 'existing@example.test',
    createdAt: 10,
    updatedAt: 10
  });
  const harness = migrationHarness({ current, failSecretReadback: true });

  await assert.rejects(() => migrateLegacyDomainConfig(harness.dependencies));
  await assert.rejects(() => migrateLegacyDomainConfig(harness.dependencies));

  assert.equal(harness.config.profiles[0].name, 'Existing Alice');
  assert.equal(harness.config.promotionSites.length, 1);
  assert.equal(harness.events.filter(([name]) => name === 'domain.replace').length, 1);
});

test('marks migration complete without creating invalid partial legacy entities', async () => {
  const harness = migrationHarness({
    sync: {
      auto_fill_user_name: 'Only a name',
      auto_fill_user_password: ''
    }
  });

  await migrateLegacyDomainConfig(harness.dependencies);

  assert.deepEqual(harness.config, createDefaultDomainConfig());
  assert.equal(harness.storage.local.data[DOMAIN_CONFIG_MIGRATION_VERSION_KEY], 2);
  assert.equal(Object.hasOwn(harness.passwords, 'default-profile'), false);
});
