const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadClient(responses = {}) {
  const messages = [];
  const window = {};
  const context = vm.createContext({
    window,
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          const response = responses[message.type];
          if (response instanceof Error) throw response;
          if (typeof response === 'function') return response(message);
          return response || { ok: true };
        }
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../lib/batch-submit-context-client.js'), 'utf8'),
    context
  );
  return { client: window.AutoCommentBatchSubmitContext, messages };
}

test('saves, restores, and clears an exact context through background messages', async () => {
  const restored = {
    batchId: 'a',
    urlIndex: 2,
    attempt: 1,
    history: {
      commentHtml: 'Exact <a href="https://promo.test/">body</a>',
      historyRevision: {
        capturedAt: 1000,
        recordedAt: 1001,
        sequence: 1,
        id: 'revision-a'
      }
    }
  };
  const { client, messages } = loadClient({
    BATCH_GET_SUBMIT_CONTEXT: { ok: true, context: restored }
  });

  await client.save(restored);
  assert.deepEqual(await client.restore(), restored);
  await client.clear({
    batchId: restored.batchId,
    urlIndex: restored.urlIndex,
    attempt: restored.attempt
  });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: restored },
    { type: 'BATCH_GET_SUBMIT_CONTEXT' },
    {
      type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
      match: { batchId: 'a', urlIndex: 2, attempt: 1 }
    }
  ]);
});

test('clears only the submit context matching the acknowledged history revision', async () => {
  const { client, messages } = loadClient();
  const match = {
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 1,
    historyRevision: {
      capturedAt: 1000,
      recordedAt: 1001,
      sequence: 1,
      id: 'revision-a'
    }
  };

  await client.clear(match);

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
    match
  }]);
});

test('acknowledged confirmation relies on the background transaction to clear context', async () => {
  const { client, messages } = loadClient({
    BATCH_HANDLE_CONFIRM: { ok: true }
  });

  await client.confirm({ batchId: 'a', urlIndex: 2, attempt: 1 });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: 'BATCH_HANDLE_CONFIRM',
    batchId: 'a',
    urlIndex: 2,
    attempt: 1
  }]);
});

test('confirmation carries the exact attempt without a second clear message', async () => {
  const { client, messages } = loadClient({
    BATCH_HANDLE_CONFIRM: { ok: true }
  });

  await client.confirm({ batchId: 'a', urlIndex: 2, attempt: 3 });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: 'BATCH_HANDLE_CONFIRM',
    batchId: 'a',
    urlIndex: 2,
    attempt: 3
  }]);
});

test('unscoped submit-context clear is rejected before transport', async () => {
  const { client, messages } = loadClient();

  await assert.rejects(client.clear(), /exact submit context identity required/);

  assert.deepEqual(messages, []);
});

test('negative confirmation preserves the persisted submit context', async () => {
  const { client, messages } = loadClient({
    BATCH_HANDLE_CONFIRM: { ok: false, error: 'not stored' }
  });

  await assert.rejects(
    client.confirm({ batchId: 'a', urlIndex: 2, attempt: 1 }),
    /not stored/
  );

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'BATCH_HANDLE_CONFIRM', batchId: 'a', urlIndex: 2, attempt: 1 }
  ]);
});

test('rejected confirmation preserves the persisted submit context', async () => {
  const { client, messages } = loadClient({
    BATCH_HANDLE_CONFIRM: new Error('message failed')
  });

  await assert.rejects(
    client.confirm({ batchId: 'a', urlIndex: 2, attempt: 1 }),
    /message failed/
  );

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'BATCH_HANDLE_CONFIRM', batchId: 'a', urlIndex: 2, attempt: 1 }
  ]);
});
