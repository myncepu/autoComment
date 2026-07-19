import test from 'node:test';
import assert from 'node:assert/strict';
import { installLlmMessageListener } from '../lib/llm-message-listener.mjs';

function createChromeFixture() {
  const listeners = [];
  return {
    chrome: {
      runtime: {
        id: 'extension-id',
        onMessage: { addListener(listener) { listeners.push(listener); } }
      },
      storage: { marker: 'storage' }
    },
    listeners
  };
}

test('routes only the two LLM message types to the model handler', async () => {
  const { chrome, listeners } = createChromeFixture();
  const handled = [];
  installLlmMessageListener(chrome, {
    handleMessage: async (message, dependencies) => {
      handled.push({ message, dependencies });
      return { success: true, text: 'OK' };
    }
  });
  const listener = listeners[0];

  for (const type of ['LLM_TEST_CONNECTION', 'LLM_GENERATE_COPY']) {
    const responses = [];
    assert.equal(listener({ type }, { id: 'extension-id' }, (response) => responses.push(response)), true);
    await new Promise(setImmediate);
    assert.deepEqual(responses, [{ success: true, text: 'OK' }]);
  }

  assert.equal(handled.length, 2);
  assert.deepEqual(handled.map(({ message }) => message.type), ['LLM_TEST_CONNECTION', 'LLM_GENERATE_COPY']);
  assert.ok(handled.every(({ dependencies }) => dependencies.storage === chrome.storage));
});

test('rejects missing and external senders without handling their LLM messages', () => {
  const { chrome, listeners } = createChromeFixture();
  let handled = 0;
  installLlmMessageListener(chrome, { handleMessage: async () => { handled += 1; } });
  const listener = listeners[0];

  for (const sender of [{}, { id: 'other-extension' }]) {
    const responses = [];
    assert.equal(listener({ type: 'LLM_TEST_CONNECTION' }, sender, (response) => responses.push(response)), false);
    assert.deepEqual(responses, [{
      success: false,
      error: { code: 'FORBIDDEN_SENDER', message: '拒绝外部模型请求。' }
    }]);
  }

  assert.equal(handled, 0);
});

test('responds asynchronously for a valid sender', async () => {
  const { chrome, listeners } = createChromeFixture();
  let resolveHandler;
  installLlmMessageListener(chrome, {
    handleMessage: () => new Promise((resolve) => { resolveHandler = resolve; })
  });
  const responses = [];

  assert.equal(listeners[0](
    { type: 'LLM_TEST_CONNECTION' },
    { id: 'extension-id' },
    (response) => responses.push(response)
  ), true);
  assert.deepEqual(responses, []);

  resolveHandler({ success: true, text: 'OK' });
  await new Promise(setImmediate);
  assert.deepEqual(responses, [{ success: true, text: 'OK' }]);
});

test('returns false for non-LLM messages without invoking this listener', () => {
  const { chrome, listeners } = createChromeFixture();
  let handled = 0;
  installLlmMessageListener(chrome, { handleMessage: async () => { handled += 1; } });
  const responses = [];

  assert.equal(listeners[0]({ type: 'BATCH_REPORT_RESULT' }, { id: 'extension-id' }, (response) => responses.push(response)), false);
  assert.equal(handled, 0);
  assert.deepEqual(responses, []);
});
