import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLlmMessage, isAllowedLlmSender, LLM_MESSAGE_TYPES } from '../lib/llm-service.mjs';

function storageFixture() {
  return {
    sync: { async get() { return { llm_api_base_url: 'https://openrouter.ai/api/v1', llm_model: 'qwen/qwen-plus' }; } },
    local: { async get() { return { llm_api_key: 'sk-test' }; } }
  };
}

const successFetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: 'generated comment' } }]
}), { status: 200 });

test('connection test uses the saved model and a small real-request shape', async () => {
  const result = await handleLlmMessage({ type: LLM_MESSAGE_TYPES.test }, { storage: storageFixture(), fetchImpl: successFetch });
  assert.deepEqual(result, { success: true, text: 'generated comment' });
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
