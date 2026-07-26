const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadReporter() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.resolve(__dirname, '../lib/batch-phase-reporter.js'),
      'utf8'
    ),
    context
  );
  return context.AutoCommentBatchPhaseReporter;
}

test('reports only controlled phases with complete task identity', async () => {
  const sent = [];
  const reporter = loadReporter();

  await reporter.report({
    sendMessage(message) {
      sent.push(message);
      return Promise.resolve({ ok: true });
    }
  }, {
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3
  }, 'generating');

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    type: 'BATCH_TASK_PHASE',
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3,
    phase: 'generating'
  }]);
  await assert.rejects(
    reporter.report({ sendMessage() {} }, {
      batchId: 'batch-1',
      urlIndex: 2,
      attempt: 3
    }, 'arbitrary-dom-state'),
    /invalid_batch_phase/
  );
});

test('rejects incomplete attempt identity before sending a phase', async () => {
  let sent = false;
  const reporter = loadReporter();

  await assert.rejects(
    reporter.report({
      sendMessage() {
        sent = true;
      }
    }, {
      batchId: 'batch-1',
      urlIndex: 2
    }, 'loading'),
    /invalid_batch_identity/
  );

  assert.equal(sent, false);
});
