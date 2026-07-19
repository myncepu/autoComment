import test from 'node:test';
import assert from 'node:assert/strict';
import { saveOptionsModelConfig, testOptionsModelConfig } from '../lib/llm-options-controller.mjs';

function dependencies({ granted = true, response = { success: true, text: 'OK' }, sendError } = {}) {
  const sync = {};
  const local = {};
  return {
    sync,
    local,
    value: {
      storage: {
        sync: { async get() { return sync; }, async set(values) { Object.assign(sync, values); } },
        local: { async get() { return local; }, async set(values) { Object.assign(local, values); } }
      },
      permissions: {
        async contains() { return false; },
        async request(request) {
          assert.deepEqual(request, { origins: ['https://openrouter.ai/*'] });
          return granted;
        }
      },
      runtime: {
        async sendMessage(message) {
          assert.deepEqual(message, { type: 'LLM_TEST_CONNECTION' });
          if (sendError) throw sendError;
          return response;
        }
      }
    }
  };
}

const config = {
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen-plus',
  apiKey: 'sk-test'
};

test('requests only the configured origin then saves split storage', async () => {
  const fixture = dependencies();
  await saveOptionsModelConfig(fixture.value, config);
  assert.equal(fixture.sync.llm_api_base_url, 'https://openrouter.ai/api/v1');
  assert.equal(fixture.sync.llm_model, 'qwen/qwen-plus');
  assert.equal(fixture.local.llm_api_key, 'sk-test');
});

test('does not save when the user denies host permission', async () => {
  const fixture = dependencies({ granted: false });
  await assert.rejects(saveOptionsModelConfig(fixture.value, config), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(fixture.sync, {});
  assert.deepEqual(fixture.local, {});
});

test('saves then runs the real connection message contract', async () => {
  const fixture = dependencies();
  assert.equal(await testOptionsModelConfig(fixture.value, config), 'OK');
});

test('throws a safe response error when the connection test fails', async () => {
  const fixture = dependencies({
    response: { success: false, error: { code: 'INVALID_API_KEY', message: 'API Key 无效。' } }
  });
  await assert.rejects(testOptionsModelConfig(fixture.value, config), {
    code: 'INVALID_API_KEY',
    message: 'API Key 无效。'
  });
  assert.equal(fixture.local.llm_api_key, 'sk-test');
});

test('removes the saved key from a failed connection message', async () => {
  const fixture = dependencies({
    response: { success: false, error: { code: 'UPSTREAM_ERROR', message: 'Request rejected: sk-test' } }
  });
  await assert.rejects(testOptionsModelConfig(fixture.value, config), (error) => {
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.message.includes(config.apiKey), false);
    return true;
  });
});

test('removes the saved key from a rejected connection message', async () => {
  const fixture = dependencies({ sendError: new Error('Could not send sk-test') });
  await assert.rejects(testOptionsModelConfig(fixture.value, config), (error) => {
    assert.equal(error.code, 'UNKNOWN_ERROR');
    assert.equal(error.message.includes(config.apiKey), false);
    return true;
  });
});
