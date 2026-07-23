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
          return responses[message.type] || { ok: true };
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

test('saves, restores, and clears through background messages', async () => {
  const restored = { batchId: 'a', urlIndex: 2 };
  const { client, messages } = loadClient({
    BATCH_GET_SUBMIT_CONTEXT: { ok: true, context: restored }
  });

  await client.save(restored);
  assert.deepEqual(await client.restore(), restored);
  await client.clear();

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: restored },
    { type: 'BATCH_GET_SUBMIT_CONTEXT' },
    { type: 'BATCH_CLEAR_SUBMIT_CONTEXT' }
  ]);
});
