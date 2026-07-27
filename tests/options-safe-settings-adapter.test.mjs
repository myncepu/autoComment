import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSafeOptionsSettingsAdapter
} from '../lib/options-safe-settings-adapter.mjs';

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  const requestedKeys = [];
  const writes = [];
  return {
    data,
    requestedKeys,
    writes,
    async get(keys) {
      requestedKeys.push(structuredClone(keys));
      return Object.fromEntries(keys.flatMap((key) => (
        Object.hasOwn(data, key) ? [[key, structuredClone(data[key])]] : []
      )));
    },
    async set(values) {
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
}

function createPermissions({ contains = false, granted = true } = {}) {
  const calls = [];
  return {
    calls,
    async contains(request) {
      calls.push(['contains', structuredClone(request)]);
      return contains;
    },
    async request(request) {
      calls.push(['request', structuredClone(request)]);
      return granted;
    }
  };
}

function portableSettings(apiBaseUrl) {
  return {
    llm: { apiBaseUrl, model: 'qwen/qwen-plus' },
    batchDefaults: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 60
    },
    preferences: { showExportOutlinksFloatingButton: true }
  };
}

test('loads and saves only the explicit portable sync keys', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    llm_api_key: 'must-not-read',
    cloud_sync_secret: 'must-not-read',
    batch_concurrency: 3,
    batch_timeout_seconds: 120,
    batch_checkbox_settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: false
    },
    show_export_outlinks_floating_button: true
  });
  const permissions = createPermissions({ contains: true });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  const loaded = await adapter.load();
  assert.doesNotMatch(JSON.stringify(loaded), /must-not-read/);
  assert.deepEqual(storage.requestedKeys, [[
    'llm_api_base_url',
    'llm_model',
    'batch_checkbox_settings',
    'batch_concurrency',
    'batch_timeout_seconds',
    'show_export_outlinks_floating_button'
  ]]);

  await adapter.save(loaded);
  assert.deepEqual(permissions.calls, [
    ['contains', { origins: ['https://openrouter.ai/*'] }]
  ]);
  assert.deepEqual(storage.writes, [{
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    batch_checkbox_settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: false
    },
    batch_concurrency: 3,
    batch_timeout_seconds: 120,
    show_export_outlinks_floating_button: true
  }]);
});

test('uses bundle validation for public settings before writing', async () => {
  const storage = createStorageArea();
  const adapter = createSafeOptionsSettingsAdapter(storage);

  await assert.rejects(adapter.save({
    llm: { apiBaseUrl: 'file:///private/config', model: 'model-a' },
    batchDefaults: {
      autoOpenPanel: false,
      autoGenerate: false,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60
    },
    preferences: { showExportOutlinksFloatingButton: false }
  }), (error) => error?.code === 'invalid_config_bundle_llm');
  assert.deepEqual(storage.writes, []);
});

test('defaults the floating outlinks preference to true unless explicitly false', async () => {
  const missing = createStorageArea();
  const explicitlyFalse = createStorageArea({
    show_export_outlinks_floating_button: false
  });

  assert.equal(
    (await createSafeOptionsSettingsAdapter(missing).load())
      .preferences.showExportOutlinksFloatingButton,
    true
  );
  assert.equal(
    (await createSafeOptionsSettingsAdapter(explicitlyFalse).load())
      .preferences.showExportOutlinksFloatingButton,
    false
  );
});

test('requests a changed custom LLM origin before persisting portable settings', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://openrouter.ai/api/v1'
  });
  const permissions = createPermissions({ granted: true });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  await adapter.save(portableSettings('https://models.example/v1'));

  assert.deepEqual(permissions.calls, [
    ['contains', { origins: ['https://models.example/*'] }],
    ['request', { origins: ['https://models.example/*'] }]
  ]);
  assert.equal(storage.data.llm_api_base_url, 'https://models.example/v1');
});

test('denied permission leaves all portable settings unchanged', async () => {
  const initial = {
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'old-model',
    batch_concurrency: 1
  };
  const storage = createStorageArea(initial);
  const permissions = createPermissions({ granted: false });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  await assert.rejects(
    adapter.save(portableSettings('https://models.example/v1')),
    (error) => error?.code === 'PERMISSION_DENIED'
  );
  assert.deepEqual(storage.data, initial);
  assert.deepEqual(storage.writes, []);
});

test('permission service failure is sanitized and leaves settings unchanged', async () => {
  const secret = 'sk-permission-error-secret';
  const initial = {
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'old-model'
  };
  const storage = createStorageArea(initial);
  const adapter = createSafeOptionsSettingsAdapter(storage, {
    permissions: {
      async contains() {
        throw new Error(`permission service echoed ${secret}`);
      },
      async request() {
        throw new Error('must not be reached');
      }
    }
  });

  await assert.rejects(
    adapter.save(portableSettings('https://models.example/v1')),
    (error) => (
      error?.code === 'PERMISSION_UNAVAILABLE'
        && !error.message.includes(secret)
    )
  );
  assert.deepEqual(storage.data, initial);
  assert.deepEqual(storage.writes, []);
});

test('an unchanged custom LLM Base URL requests its missing permission', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://models.example/v1'
  });
  const permissions = createPermissions({ granted: true });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  await adapter.save(portableSettings('https://models.example/v1'));

  assert.deepEqual(permissions.calls, [
    ['contains', { origins: ['https://models.example/*'] }],
    ['request', { origins: ['https://models.example/*'] }]
  ]);
  assert.equal(storage.writes.length, 1);
});

test('an unchanged authorized LLM Base URL checks without prompting', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://models.example/v1'
  });
  const permissions = createPermissions({ contains: true });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  await adapter.save(portableSettings('https://models.example/v1'));

  assert.deepEqual(permissions.calls, [
    ['contains', { origins: ['https://models.example/*'] }]
  ]);
  assert.equal(storage.writes.length, 1);
});

test('a changed default OpenRouter URL follows the permission check path', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://models.example/v1'
  });
  const permissions = createPermissions({ contains: true });
  const adapter = createSafeOptionsSettingsAdapter(storage, { permissions });

  await adapter.save(portableSettings('https://openrouter.ai/api/v1'));

  assert.deepEqual(permissions.calls, [
    ['contains', { origins: ['https://openrouter.ai/*'] }]
  ]);
  assert.equal(storage.data.llm_api_base_url, 'https://openrouter.ai/api/v1');
});
