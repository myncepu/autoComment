import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatCompletionBody,
  extractCompletionText,
  getChatCompletionsUrl,
  requestChatCompletion,
  toPublicLlmError
} from '../lib/openai-client.mjs';

test('appends chat/completions exactly once', () => {
  assert.equal(getChatCompletionsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(getChatCompletionsUrl('https://host/v1/chat/completions/'), 'https://host/v1/chat/completions');
});

test('passes arbitrary OpenRouter model IDs without Qwen branching', () => {
  const body = buildChatCompletionBody('openrouter/auto', [{ role: 'user', content: 'OK' }], 16);
  assert.deepEqual(body, {
    model: 'openrouter/auto',
    messages: [{ role: 'user', content: 'OK' }],
    stream: false,
    max_tokens: 16
  });
});

test('extracts assistant text and rejects malformed success payloads', () => {
  assert.equal(extractCompletionText({ choices: [{ message: { content: ' hello ' } }] }), 'hello');
  assert.throws(() => extractCompletionText({ choices: [] }), { code: 'INVALID_RESPONSE' });
});

test('sends bearer auth and maps 402 without exposing the key', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  await assert.rejects(requestChatCompletion({
    config: { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-plus', apiKey: 'sk-secret' },
    messages: [{ role: 'user', content: 'test' }],
    fetchImpl
  }), { code: 'INSUFFICIENT_CREDITS', status: 402 });
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-secret');
  assert.equal(JSON.stringify(toPublicLlmError(new Error('sk-secret'))).includes('sk-secret'), false);
});

test('does not expose a configured key echoed by 401 or 402 providers', async () => {
  const apiKey = 'sk-current-secret';
  for (const [status, code] of [[401, 'INVALID_API_KEY'], [402, 'INSUFFICIENT_CREDITS']]) {
    const fetchImpl = async () => new Response(JSON.stringify({
      error: { message: `Provider received key: ${apiKey}` }
    }), { status, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
      requestChatCompletion({
        config: { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', apiKey },
        messages: [{ role: 'user', content: 'test' }],
        fetchImpl
      }),
      (error) => {
        const publicError = toPublicLlmError(error);
        assert.equal(publicError.code, code);
        assert.equal(JSON.stringify(publicError).includes(apiKey), false);
        return true;
      }
    );
  }
});
