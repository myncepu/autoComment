import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BatchScheduler,
  isBatchConfirmationFor,
  normalizeBatchConcurrency
} from '../lib/batch-scheduler.mjs';
import * as batchSchedulerModule from '../lib/batch-scheduler.mjs';

test('normalizes batch concurrency to the supported 1 through 10 range', () => {
  assert.equal(normalizeBatchConcurrency(undefined), 3);
  assert.equal(normalizeBatchConcurrency('4'), 4);
  assert.equal(normalizeBatchConcurrency('3.5', 7), 7);
  assert.equal(normalizeBatchConcurrency(0), 3);
  assert.equal(normalizeBatchConcurrency(11), 3);
  assert.equal(normalizeBatchConcurrency('not-a-number', 6), 6);
});

test('takes only the available concurrency slots and replenishes settled work', () => {
  const scheduler = new BatchScheduler({ totalCount: 5, concurrency: 3 });
  scheduler.start();

  assert.deepEqual(scheduler.takeAvailable(), [0, 1, 2]);
  assert.deepEqual(scheduler.takeAvailable(), []);
  assert.equal(scheduler.settle(1), true);
  assert.deepEqual(scheduler.takeAvailable(), [3]);
  assert.deepEqual(scheduler.activeIndices, [0, 2, 3]);
});

test('does not take work while stopped and resumes only unfinished indices', () => {
  const scheduler = new BatchScheduler({ totalCount: 5, concurrency: 2 });
  scheduler.start();
  assert.deepEqual(scheduler.takeAvailable(), [0, 1]);
  scheduler.stop();
  assert.deepEqual(scheduler.takeAvailable(), []);

  scheduler.resume([0, 2, 4]);
  assert.deepEqual(scheduler.takeAvailable(), [1, 3]);
});

test('settling the same index twice is idempotent', () => {
  const scheduler = new BatchScheduler({ totalCount: 1, concurrency: 1 });
  scheduler.start();
  scheduler.takeAvailable();

  assert.equal(scheduler.settle(0), true);
  assert.equal(scheduler.settle(0), false);
  assert.equal(scheduler.isComplete, true);
});

test('accepts confirmations only for the current batch and valid URL index', () => {
  const current = { batchId: 'batch-a', totalCount: 2 };

  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-a',
    urlIndex: 1
  }, current), true);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-b',
    urlIndex: 1
  }, current), false);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-a',
    urlIndex: 2
  }, current), false);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    urlIndex: 0
  }, current), false);
});

test('allows a success window to close only after history is durable', () => {
  assert.equal(
    typeof batchSchedulerModule.isDurableBatchConfirmation,
    'function',
    'batch/history integration must expose one shared close gate'
  );
  const isDurable = batchSchedulerModule.isDurableBatchConfirmation;

  for (const historySaveStatus of ['saved', 'queued', 'not_applicable']) {
    assert.equal(isDurable({ result: 'success', historySaveStatus }), true);
  }
  for (const historySaveStatus of ['failed', undefined, null]) {
    assert.equal(isDurable({ result: 'success', historySaveStatus }), false);
  }
  assert.equal(isDurable({ result: 'fail' }), true);
  assert.equal(isDurable({ result: 'manual_required' }), true);
});
