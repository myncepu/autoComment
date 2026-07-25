import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportableSettings,
  createStorageChangeMutations,
  loadSyncableSettings,
  migratePasswordToLocal,
  saveRemoteSettings,
  splitImportedSettings
} from '../lib/cloud-sync-settings.mjs';

function createObservedStorage({ sync = {}, local = {}, failLocalSet = false } = {}) {
  const syncData = { ...sync };
  const localData = { ...local };
  const events = [];

  const getValues = (target, keys) => {
    const requestedKeys = keys === null || keys === undefined
      ? Object.keys(target)
      : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requestedKeys
        .filter((key) => Object.hasOwn(target, key))
        .map((key) => [key, target[key]])
    );
  };

  return {
    syncData,
    localData,
    events,
    sync: {
      async get(keys) {
        return getValues(syncData, keys);
      },
      async remove(key) {
        events.push(['sync.remove', key]);
        delete syncData[key];
      },
      async set(values) {
        events.push(['sync.set', values]);
        Object.assign(syncData, values);
      }
    },
    local: {
      async get(keys) {
        return getValues(localData, keys);
      },
      async set(values) {
        if (failLocalSet) throw new Error('local write failed');
        events.push(['local.set', values]);
        Object.assign(localData, values);
      }
    }
  };
}

test('copies the password to local before removing it from sync', async () => {
  const storage = createObservedStorage({
    sync: { auto_fill_user_password: 'secret' },
    local: {}
  });

  assert.deepEqual(await migratePasswordToLocal(storage), { status: 'migrated' });
  assert.equal(storage.localData.auto_fill_user_password, 'secret');
  assert.equal(Object.hasOwn(storage.syncData, 'auto_fill_user_password'), false);
  assert.deepEqual(storage.events, [
    ['local.set', { auto_fill_user_password: 'secret' }],
    ['sync.remove', 'auto_fill_user_password'],
    ['local.set', { cloudSyncPasswordMigrationVersion: 1 }]
  ]);
});

test('keeps the sync password when the local write fails', async () => {
  const storage = createObservedStorage({
    sync: { auto_fill_user_password: 'secret' },
    local: {},
    failLocalSet: true
  });

  await assert.rejects(migratePasswordToLocal(storage), /local write failed/);
  assert.equal(storage.syncData.auto_fill_user_password, 'secret');
});

test('preserves a local password while removing the legacy sync copy', async () => {
  const storage = createObservedStorage({
    sync: { auto_fill_user_password: 'sync-secret' },
    local: { auto_fill_user_password: 'local-secret' }
  });

  await migratePasswordToLocal(storage);

  assert.equal(storage.localData.auto_fill_user_password, 'local-secret');
  assert.equal(Object.hasOwn(storage.syncData, 'auto_fill_user_password'), false);
});

test('loads only allowlisted cloud settings from sync storage', async () => {
  const storage = createObservedStorage({
    sync: {
      promotion_website_url: 'https://promo.test',
      auto_fill_user_password: 'must-not-leave',
      llm_api_key: 'sk-secret'
    }
  });

  assert.deepEqual(await loadSyncableSettings(storage), {
    promotion_website_url: 'https://promo.test'
  });
});

test('new configuration exports omit passwords and API keys', () => {
  assert.deepEqual(buildExportableSettings({
    promotion_website_url: 'https://promo.test',
    auto_fill_user_password: 'sync-secret'
  }, {
    llm_api_key: 'sk-local',
    auto_fill_user_password: 'local-secret'
  }), {
    promotion_website_url: 'https://promo.test'
  });
});

test('imports a legacy password into local storage only', () => {
  assert.deepEqual(splitImportedSettings({
    promotion_website_url: 'https://promo.test',
    auto_fill_user_password: 'legacy-password',
    llm_api_key: 'legacy-api-key'
  }), {
    syncValues: { promotion_website_url: 'https://promo.test' },
    localValues: { auto_fill_user_password: 'legacy-password' }
  });
});

test('consumes a remote setting echo before creating another mutation', async () => {
  const storage = createObservedStorage();
  const echoGuard = new Set();
  await saveRemoteSettings(storage, { promotion_website_url: 'https://remote.test' }, echoGuard);

  assert.deepEqual(createStorageChangeMutations({
    promotion_website_url: { newValue: 'https://remote.test' }
  }, 'sync', {
    now: () => 500,
    createMutationId: () => 'unused',
    echoGuard
  }), []);
  assert.deepEqual(createStorageChangeMutations({
    promotion_website_url: { newValue: 'https://remote.test' }
  }, 'sync', {
    now: () => 500,
    createMutationId: () => 'mutation-a',
    echoGuard
  }), [{
    mutationId: 'mutation-a',
    entityType: 'setting',
    entityId: 'promotion_website_url',
    operation: 'upsert',
    payload: { value: 'https://remote.test' },
    createdAt: 500
  }]);
});

test('creates one normalized mutation for an allowed local setting change', () => {
  assert.deepEqual(createStorageChangeMutations({
    batch_concurrency: { newValue: 3 }
  }, 'sync', {
    now: () => 500,
    createMutationId: () => 'mutation-a'
  }), [{
    mutationId: 'mutation-a',
    entityType: 'setting',
    entityId: 'batch_concurrency',
    operation: 'upsert',
    payload: { value: 3 },
    createdAt: 500
  }]);
});

test('never creates mutations for local passwords or API keys', () => {
  assert.deepEqual(createStorageChangeMutations({
    auto_fill_user_password: { newValue: 'new-password' },
    llm_api_key: { newValue: 'sk-new' }
  }, 'local', {
    now: () => 500,
    createMutationId: () => 'unused'
  }), []);
});
