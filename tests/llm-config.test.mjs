import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LLM_CONFIG,
  LLM_LOCAL_KEYS,
  LLM_SYNC_KEYS,
  getHostPermissionPattern,
  loadLlmConfig,
  normalizeLlmConfig,
  saveLlmConfig,
  toExportableLlmSettings,
  validateLlmConfig
} from '../lib/llm-config.mjs';

function createStorage(syncSeed = {}, localSeed = {}) {
  const sync = { ...syncSeed };
  const local = { ...localSeed };
  const area = (target) => ({
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in target).map((key) => [key, target[key]]));
    },
    async set(values) {
      Object.assign(target, values);
    }
  });
  return { storage: { sync: area(sync), local: area(local) }, sync, local };
}

test('uses OpenRouter Qwen-Plus defaults and trims user settings', () => {
  assert.deepEqual(normalizeLlmConfig({}), DEFAULT_LLM_CONFIG);
  assert.deepEqual(normalizeLlmConfig({
    apiBaseUrl: ' https://example.com/v1/ ',
    model: ' openai/gpt-4.1-mini ',
    apiKey: ' secret '
  }), {
    apiBaseUrl: 'https://example.com/v1',
    model: 'openai/gpt-4.1-mini',
    apiKey: 'secret'
  });
});

test('validates only http(s) OpenAI-compatible configuration', () => {
  assert.equal(validateLlmConfig(DEFAULT_LLM_CONFIG).valid, false);
  assert.equal(validateLlmConfig({ ...DEFAULT_LLM_CONFIG, apiKey: 'sk-test' }).valid, true);
  assert.equal(validateLlmConfig({ apiBaseUrl: 'file:///tmp/api', model: 'x', apiKey: 'y' }).code, 'INVALID_API_URL');
});

test('creates an origin-scoped permission pattern', () => {
  assert.equal(getHostPermissionPattern('https://openrouter.ai/api/v1'), 'https://openrouter.ai/*');
  assert.equal(getHostPermissionPattern('http://127.0.0.1:3000/v1'), 'http://127.0.0.1:3000/*');
});

test('stores key locally and exports only non-secret settings', async () => {
  const fixture = createStorage();
  const config = {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen-plus',
    apiKey: 'sk-or-private'
  };
  await saveLlmConfig(fixture.storage, config);
  assert.equal(fixture.sync[LLM_SYNC_KEYS.apiBaseUrl], config.apiBaseUrl);
  assert.equal(fixture.sync[LLM_SYNC_KEYS.model], config.model);
  assert.equal(fixture.sync[LLM_LOCAL_KEYS.apiKey], undefined);
  assert.equal(fixture.local[LLM_LOCAL_KEYS.apiKey], config.apiKey);
  assert.deepEqual(await loadLlmConfig(fixture.storage), config);
  assert.equal(JSON.stringify(toExportableLlmSettings(config)).includes(config.apiKey), false);
});

test('export payload never exposes local key storage name', () => {
  const exported = toExportableLlmSettings({
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    apiKey: 'sk-private'
  });
  assert.deepEqual(Object.keys(exported).sort(), Object.values(LLM_SYNC_KEYS).sort());
  assert.equal(JSON.stringify(exported).includes('llm_api_key'), false);
});
