import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLlmMessage, isAllowedLlmSender, LLM_MESSAGE_TYPES } from '../lib/llm-service.mjs';

function storageFixture({
  apiBaseUrl = 'https://openrouter.ai/api/v1',
  model = 'qwen/qwen-plus',
  apiKey = 'sk-test'
} = {}) {
  return {
    sync: { async get() { return { llm_api_base_url: apiBaseUrl, llm_model: model }; } },
    local: { async get() { return { llm_api_key: apiKey }; } }
  };
}

const successFetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: 'generated comment' } }]
}), { status: 200 });

test('connection test uses the saved model and a small real-request shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return successFetch();
  };
  const result = await handleLlmMessage({ type: LLM_MESSAGE_TYPES.test }, {
    storage: storageFixture({ apiBaseUrl: 'https://provider.example/v1/', model: 'vendor/arbitrary-model' }),
    fetchImpl
  });

  assert.deepEqual(result, { success: true, text: 'generated comment' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'vendor/arbitrary-model',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    stream: false,
    max_tokens: 16
  });
});

test('generation accepts bounded system and user prompts', async () => {
  const result = await handleLlmMessage({
    type: LLM_MESSAGE_TYPES.generate,
    payload: { systemPrompt: 'system', userPrompt: 'page context' }
  }, { storage: storageFixture(), fetchImpl: successFetch });
  assert.equal(result.success, true);
});

test('generation rejects oversized page messages before network access', async () => {
  let called = false;
  const result = await handleLlmMessage({
    type: LLM_MESSAGE_TYPES.generate,
    payload: { systemPrompt: 'x', userPrompt: 'y'.repeat(25001) }
  }, { storage: storageFixture(), fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
});

test('accepts only messages sent by this extension', () => {
  assert.equal(isAllowedLlmSender({ id: 'extension-id' }, 'extension-id'), true);
  assert.equal(isAllowedLlmSender({ id: 'other-extension' }, 'extension-id'), false);
  assert.equal(isAllowedLlmSender({}, 'extension-id'), false);
});
