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
  const adapter = createSafeOptionsSettingsAdapter(storage);

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
