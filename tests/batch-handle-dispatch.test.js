const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDispatch() {
  const scheduled = [];
  const context = vm.createContext({
    globalThis: {},
    Promise,
    queueMicrotask(callback) {
      scheduled.push(callback);
    }
  });
  vm.runInContext(
    fs.readFileSync(
      path.resolve(__dirname, '../lib/batch-handle-dispatch.js'),
      'utf8'
    ),
    context
  );
  return {
    api: context.globalThis.AutoCommentBatchHandleDispatch,
    scheduled
  };
}

test('acknowledges an accepted handle synchronously before executing it', async () => {
  const { api, scheduled } = loadDispatch();
  const order = [];
  const dispatcher = api.create({
    accept: (message) => ({ taskConfig: { ...message, accepted: true } }),
    getKey: (task) => `${task.batchId}:${task.urlIndex}:${task.attempt}`,
    execute: async (task) => {
      order.push(['execute', task.accepted]);
    }
  });
  const responses = [];

  const handled = dispatcher.handleMessage({
    type: 'BATCH_HANDLE',
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 1
  }, (response) => {
    order.push(['response', response.ok]);
    responses.push(response);
  });

  assert.equal(handled, true);
  assert.deepEqual(order, [['response', true]]);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    ok: true,
    accepted: true,
    urlIndex: 2
  }]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(order, [
    ['response', true],
    ['execute', true]
  ]);
});

test('rejects invalid and duplicate handles synchronously without a second response', async () => {
  const { api, scheduled } = loadDispatch();
  let release;
  const execution = new Promise((resolve) => {
    release = resolve;
  });
  const dispatcher = api.create({
    accept: (message) => message.valid === false
      ? { ok: false, error: 'invalid_task_config', urlIndex: message.urlIndex }
      : { taskConfig: message },
    getKey: () => 'same-task',
    execute: () => execution
  });
  const invalidResponses = [];
  const firstResponses = [];
  const duplicateResponses = [];

  assert.equal(dispatcher.handleMessage(
    { type: 'BATCH_HANDLE', valid: false, urlIndex: 1 },
    (response) => invalidResponses.push(response)
  ), true);
  assert.equal(dispatcher.handleMessage(
    { type: 'BATCH_HANDLE', valid: true, urlIndex: 1 },
    (response) => firstResponses.push(response)
  ), true);
  assert.equal(dispatcher.handleMessage(
    { type: 'BATCH_HANDLE', valid: true, urlIndex: 1 },
    (response) => duplicateResponses.push(response)
  ), true);

  assert.deepEqual(JSON.parse(JSON.stringify(invalidResponses)), [{
    ok: false,
    error: 'invalid_task_config',
    urlIndex: 1
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(firstResponses)), [{
    ok: true,
    accepted: true,
    urlIndex: 1
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(duplicateResponses)), [{
    ok: false,
    error: 'duplicate_batch_task_running',
    urlIndex: 1
  }]);
  scheduled.shift()();
  release();
  await Promise.resolve();
  await Promise.resolve();
});

test('ignores unrelated messages and reports asynchronous failures out of band', async () => {
  const { api, scheduled } = loadDispatch();
  const errors = [];
  const responses = [];
  const dispatcher = api.create({
    accept: (message) => ({ taskConfig: message }),
    getKey: () => 'task',
    execute: async () => {
      const error = new Error('raw execution detail');
      error.code = 'batch_task_failed';
      throw error;
    },
    onExecutionError: (error) => errors.push(error.code)
  });

  assert.equal(dispatcher.handleMessage(
    { type: 'PING' },
    (response) => responses.push(response)
  ), false);
  assert.equal(dispatcher.handleMessage(
    { type: 'BATCH_HANDLE', urlIndex: 0 },
    (response) => responses.push(response)
  ), true);
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    ok: true,
    accepted: true,
    urlIndex: 0
  }]);
  assert.deepEqual(errors, ['batch_task_failed']);
});

test('production content scripts load the dispatcher before using synchronous acknowledgement', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../manifest.json'),
    'utf8'
  ));
  const scripts = manifest.content_scripts[0].js;
  const dispatcherIndex = scripts.indexOf('lib/batch-handle-dispatch.js');
  const contentIndex = scripts.indexOf('content.js');
  const contentSource = fs.readFileSync(
    path.resolve(__dirname, '../content.js'),
    'utf8'
  );

  assert.ok(dispatcherIndex >= 0);
  assert.ok(dispatcherIndex < contentIndex);
  assert.match(
    contentSource,
    /batchHandleDispatcher\.handleMessage\(message,\s*_sendResponse\);\s*return false;/
  );
  assert.doesNotMatch(
    contentSource,
    /BATCH_HANDLE 处理完成,\s*发送响应/
  );
});
