const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('batch UI exposes the supported persisted concurrency control', () => {
  const html = read('batch.html');
  const script = read('batch.js');
  assert.match(html, /id="concurrencyInput"/);
  assert.match(html, /min="1"/);
  assert.match(html, /max="10"/);
  assert.match(html, /value="3"/);
  assert.match(script, /batch_concurrency/);
  assert.match(script, /normalizeBatchConcurrency/);
});

test('background confirmations preserve batch identity', () => {
  const background = read('background.js');
  assert.match(
    background,
    /type:\s*'BATCH_CONFIRMED',[\s\S]*?batchId:\s*message\.batchId/
  );
});

test('batch page rejects confirmations that do not match its batch', () => {
  const script = read('batch.js');
  assert.match(script, /isBatchConfirmationFor\(message,\s*\{\s*batchId,\s*totalCount\s*\}\)/);
});

test('batch execution uses the scheduler and isolated Chrome windows', () => {
  const script = read('batch.js');
  assert.match(script, /new BatchScheduler\(/);
  assert.match(script, /new BatchWindowManager\(/);
  assert.match(script, /scheduler\.takeAvailable\(\)/);
  assert.match(script, /windowManager\.create\(/);
  assert.doesNotMatch(script, /activeTabCount\s*>=\s*1/);
  assert.doesNotMatch(script, /chrome\.tabs\.create\(\{\s*url,\s*active:\s*true/);
});

test('terminal paths close a worker window before replenishing the queue', () => {
  const script = read('batch.js');
  const start = script.indexOf('async function finalizeTask(');
  const end = script.indexOf('\nfunction getProcessedCount()', start);
  const finalizeTask = script.slice(start, end);
  const closeIndex = finalizeTask.indexOf('await windowManager.closeByIndex(urlIndex)');
  const settleIndex = finalizeTask.indexOf('scheduler.settle(urlIndex)');
  const refillIndex = finalizeTask.indexOf('fillAvailableWindows()');
  assert.ok(closeIndex >= 0);
  assert.ok(settleIndex > closeIndex);
  assert.ok(refillIndex > settleIndex);
});

test('late window creation stays bound to the batch and manager that opened it', () => {
  const script = read('batch.js');
  const start = script.indexOf('async function openWorkerWindow(');
  const end = script.indexOf('\nfunction sendTaskWhenReady(', start);
  const openWorkerWindow = script.slice(start, end);
  assert.match(openWorkerWindow, /const activityBatchId = batchId/);
  assert.match(openWorkerWindow, /const activityWindowManager = windowManager/);
  assert.match(openWorkerWindow, /windowManager\.create\(/);
  assert.match(openWorkerWindow, /activityWindowManager\.closeByIndex\(urlIndex\)/);
  assert.match(openWorkerWindow, /batchId !== activityBatchId/);
});
