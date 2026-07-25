import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_RUNTIME_VERSION,
  applyBatchRuntimeEvent,
  createBatchRuntimeCheckpoint,
  normalizeInterruptedBatch,
  validateBatchRuntimeCheckpoint
} from '../lib/batch-runtime-checkpoint.mjs';

function createItems(count) {
  return Array.from({ length: count }, (_, originalIndex) => ({
    originalIndex,
    url: `https://example.test/${originalIndex}`,
    sourceDomain: 'example.test',
    originalRow: [
      String(originalIndex),
      `https://example.test/${originalIndex}`
    ]
  }));
}

test('creates a versioned checkpoint with the complete dataset', () => {
  const items = createItems(125);
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-1',
    source: {
      fileName: 'input.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    }
  }, 1000);

  assert.equal(checkpoint.version, BATCH_RUNTIME_VERSION);
  assert.equal(checkpoint.status, 'paused_recovery');
  assert.equal(checkpoint.createdAt, 1000);
  assert.equal(checkpoint.updatedAt, 1000);
  assert.equal(checkpoint.source.rows.length, 125);
  assert.equal(checkpoint.source.parsedUrls.length, 125);
  assert.equal(checkpoint.results.length, 0);
  assert.equal(Object.keys(checkpoint.tasks).length, 125);
  assert.ok(
    Object.values(checkpoint.tasks).every((task) => task.state === 'queued')
  );
  assert.equal(validateBatchRuntimeCheckpoint(checkpoint).ok, true);

  items[0].originalRow[0] = 'mutated';
  assert.equal(checkpoint.source.rows[0][0], '0');
  assert.equal(checkpoint.source.parsedUrls[0].originalRow[0], '0');
});

test('rejects malformed and unsupported checkpoints', () => {
  assert.deepEqual(
    validateBatchRuntimeCheckpoint(null),
    { ok: false, error: 'invalid_checkpoint' }
  );
  assert.deepEqual(
    validateBatchRuntimeCheckpoint({ version: 99 }),
    { ok: false, error: 'unsupported_version' }
  );
});

function createCheckpoint(count = 4) {
  const items = createItems(count);
  return createBatchRuntimeCheckpoint({
    batchId: 'batch-1',
    source: {
      fileName: 'input.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    }
  }, 1000);
}

test('moves one task through active, submitting, and terminal states', () => {
  const initial = createCheckpoint(2);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);
  const active = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    tabId: 41,
    windowId: 51,
    startedAt: 1200
  }, 1200);
  const submitting = applyBatchRuntimeEvent(active.checkpoint, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 0
  }, 1300);
  const terminal = applyBatchRuntimeEvent(submitting.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    result: {
      result: 'success',
      aiContent: 'saved comment',
      errorMessage: null
    }
  }, 1400);

  assert.equal(started.ok, true);
  assert.equal(started.checkpoint.status, 'running');
  assert.deepEqual(
    active.checkpoint.tasks['0'],
    {
      urlIndex: 0,
      state: 'active',
      phase: null,
      tabId: 41,
      windowId: 51,
      startedAt: 1200,
      updatedAt: 1200
    }
  );
  assert.equal(submitting.checkpoint.tasks['0'].state, 'submitting');
  assert.equal(terminal.checkpoint.tasks['0'].state, 'terminal');
  assert.equal(terminal.checkpoint.results.length, 1);
  assert.deepEqual(
    terminal.checkpoint.results[0],
    {
      originalIndex: 0,
      url: 'https://example.test/0',
      sourceDomain: 'example.test',
      result: 'success',
      aiContent: 'saved comment',
      errorMessage: null,
      timestamp: 1400,
      elapsed: 0,
      originalRow: ['0', 'https://example.test/0']
    }
  );
  assert.equal(terminal.checkpoint.cursor.nextIndex, 1);
  assert.equal(initial.status, 'paused_recovery');
  assert.equal(initial.tasks['0'].state, 'queued');
});

test('rejects stale identities, skipped states, and conflicting terminal results', () => {
  const initial = createCheckpoint(1);
  const stale = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'other-batch'
  }, 1100);
  const skipped = applyBatchRuntimeEvent(initial, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 0
  }, 1100);
  const outOfRange = applyBatchRuntimeEvent(initial, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 7,
    tabId: 1,
    windowId: 2
  }, 1100);

  assert.deepEqual(
    { ok: stale.ok, error: stale.error },
    { ok: false, error: 'stale_batch' }
  );
  assert.deepEqual(
    { ok: skipped.ok, error: skipped.error },
    { ok: false, error: 'invalid_transition' }
  );
  assert.deepEqual(
    { ok: outOfRange.ok, error: outOfRange.error },
    { ok: false, error: 'invalid_url_index' }
  );

  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1150);
  const active = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    tabId: 1,
    windowId: 2
  }, 1200);
  const terminal = applyBatchRuntimeEvent(active.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    result: { result: 'fail', errorMessage: 'first' }
  }, 1300);
  const duplicate = applyBatchRuntimeEvent(terminal.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    result: { result: 'fail', errorMessage: 'first' }
  }, 1400);
  const conflict = applyBatchRuntimeEvent(terminal.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    result: { result: 'success' }
  }, 1400);

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.changed, false);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'task_already_terminal');
  assert.equal(terminal.checkpoint.results.length, 1);
});

test('terminal session states cannot be restarted', () => {
  const initial = createCheckpoint(1);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);

  for (const type of ['session_terminated', 'session_completed']) {
    const stopped = applyBatchRuntimeEvent(started.checkpoint, {
      type,
      batchId: 'batch-1'
    }, 1200);
    const restarted = applyBatchRuntimeEvent(stopped.checkpoint, {
      type: 'session_started',
      batchId: 'batch-1'
    }, 1300);

    assert.equal(restarted.ok, false);
    assert.equal(restarted.error, 'invalid_transition');
  }
});

test('a queued task can terminate locally before a worker window opens', () => {
  const initial = createCheckpoint(1);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);
  const terminal = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    result: {
      result: 'blocked_illegal',
      errorMessage: 'blocked before opening'
    }
  }, 1200);

  assert.equal(terminal.ok, true);
  assert.equal(terminal.checkpoint.tasks['0'].state, 'terminal');
  assert.equal(terminal.checkpoint.results[0].result, 'blocked_illegal');
});

test('normalizes active and submitting work into one safe paused checkpoint', () => {
  let checkpoint = createCheckpoint(4);
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 1,
    tabId: 21,
    windowId: 31,
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 2,
    tabId: 22,
    windowId: 32,
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 2
  }, 1300).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 3,
    tabId: 23,
    windowId: 33,
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 3,
    result: { result: 'success', aiContent: 'done' }
  }, 1400).checkpoint;

  const normalized = normalizeInterruptedBatch(checkpoint, 2000);
  const repeated = normalizeInterruptedBatch(normalized.checkpoint, 3000);

  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.orphanWindowIds, [31, 32]);
  assert.equal(normalized.checkpoint.status, 'paused_recovery');
  assert.equal(normalized.checkpoint.tasks['0'].state, 'queued');
  assert.deepEqual(
    normalized.checkpoint.tasks['1'],
    {
      urlIndex: 1,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 2000
    }
  );
  assert.equal(normalized.checkpoint.tasks['2'].state, 'terminal');
  assert.equal(normalized.checkpoint.tasks['3'].state, 'terminal');
  assert.equal(normalized.checkpoint.cursor.nextIndex, 0);
  assert.equal(normalized.checkpoint.results.length, 2);
  assert.deepEqual(
    normalized.checkpoint.results.find(
      (result) => result.originalIndex === 2
    ),
    {
      originalIndex: 2,
      url: 'https://example.test/2',
      sourceDomain: 'example.test',
      result: 'manual_required',
      aiContent: null,
      errorMessage: '任务在提交确认前中断，评论可能已提交，请人工确认',
      timestamp: 2000,
      elapsed: 1,
      originalRow: ['2', 'https://example.test/2']
    }
  );
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.orphanWindowIds, []);
  assert.equal(repeated.checkpoint.results.length, 2);
});
