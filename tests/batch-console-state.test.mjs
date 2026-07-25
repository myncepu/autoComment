import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBatchConsoleSnapshot,
  filterBatchTaskRows
} from '../lib/batch-console-state.mjs';

test('derives counters, slots and latest-attempt rows from one checkpoint', () => {
  const checkpoint = createConsoleCheckpointFixture();
  const snapshot = createBatchConsoleSnapshot(checkpoint, {
    now: 70000,
    online: true,
    lastCheckpointSavedAt: 69000
  });

  assert.deepEqual(snapshot.counts, {
    total: 5,
    queued: 1,
    running: 2,
    success: 1,
    failed: 0,
    manual: 1
  });
  assert.deepEqual(snapshot.slots.map((slot) => ({
    urlIndex: slot.urlIndex,
    attempt: slot.attempt,
    phase: slot.phase
  })), [
    { urlIndex: 1, attempt: 1, phase: 'generating' },
    { urlIndex: 2, attempt: 2, phase: 'detecting' }
  ]);
  assert.equal(snapshot.rows[2].result, null);
  assert.equal(snapshot.rows[2].attemptHistory.length, 1);
  assert.deepEqual(snapshot.rows[2].attemptHistory[0], {
    attempt: 1,
    result: 'fail',
    error: {
      code: 'task_timeout',
      message: '处理超时，窗口已安全关闭',
      retryPolicy: 'safe',
      diagnostic: {}
    },
    timestamp: 50000,
    elapsedMs: 60000
  });
});

test('does not count manual resolution as automatic success', () => {
  const checkpoint = createManualResolvedCheckpointFixture();
  const snapshot = createBatchConsoleSnapshot(checkpoint, { now: 70000 });

  assert.equal(snapshot.counts.success, 0);
  assert.equal(snapshot.counts.manual, 1);
  assert.equal(snapshot.rows[0].manualResolution.status, 'resolved');
});

test('filters snapshot rows without mutating rows or their counts', () => {
  const snapshot = createBatchConsoleSnapshot(createConsoleCheckpointFixture(), {
    now: 70000
  });
  const originalRows = structuredClone(snapshot.rows);
  const originalCounts = structuredClone(snapshot.counts);

  assert.deepEqual(filterBatchTaskRows(snapshot.rows, {
    status: 'running',
    domain: 'target.test',
    timeRange: 'all',
    keyword: 'target.test/2'
  }).map((row) => row.urlIndex), [2]);
  assert.deepEqual(filterBatchTaskRows(snapshot.rows, {
    status: 'failed',
    domain: 'all',
    timeRange: 'all',
    keyword: '处理超时'
  }).map((row) => row.urlIndex), []);
  assert.deepEqual(snapshot.rows, originalRows);
  assert.deepEqual(snapshot.counts, originalCounts);
});

test('filters by URL, stored error message, and AI content', () => {
  const checkpoint = createConsoleCheckpointFixture();
  checkpoint.results[1] = {
    ...checkpoint.results[1],
    result: 'fail',
    aiContent: 'The drafted comment contains blue-orchid.',
    errorCode: 'provider_unavailable',
    errorMessage: 'Provider trace Q42'
  };
  const rows = createBatchConsoleSnapshot(checkpoint, { now: 70000 }).rows;

  assert.deepEqual(filterBatchTaskRows(rows, {
    status: 'all', domain: 'all', timeRange: 'all', keyword: '/2'
  }).map((row) => row.urlIndex), [2]);
  assert.deepEqual(filterBatchTaskRows(rows, {
    status: 'all', domain: 'all', timeRange: 'all', keyword: 'q42'
  }).map((row) => row.urlIndex), [3]);
  assert.deepEqual(filterBatchTaskRows(rows, {
    status: 'all', domain: 'all', timeRange: 'all', keyword: 'blue-orchid'
  }).map((row) => row.urlIndex), [3]);
});

test('exposes selected console fields without checkpoint passwords', () => {
  const checkpoint = createConsoleCheckpointFixture();
  checkpoint.settings.assignment.identitySnapshot = {
    displayName: 'Alice',
    password: 'must-not-leak'
  };
  checkpoint.results[0].password = 'must-not-leak';

  const snapshot = createBatchConsoleSnapshot(checkpoint, { now: 70000 });

  assert.equal(JSON.stringify(snapshot).includes('must-not-leak'), false);
});

function createConsoleCheckpointFixture() {
  const parsedUrls = Array.from({ length: 5 }, (_, originalIndex) => ({
    originalIndex,
    url: `https://target.test/${originalIndex}`,
    sourceDomain: 'target.test',
    originalRow: [`https://target.test/${originalIndex}`]
  }));
  const task = (urlIndex, values) => ({
    urlIndex,
    attempt: 1,
    state: 'queued',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 60000,
    manualResolution: { status: 'idle', updatedAt: null },
    ...values
  });
  return {
    version: 2,
    batchId: 'batch-1',
    status: 'running',
    createdAt: 1000,
    updatedAt: 69000,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: {
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site'
      }
    },
    cursor: { nextIndex: 0 },
    tasks: {
      0: task(0, { state: 'queued' }),
      1: task(1, {
        state: 'active',
        phase: 'generating',
        tabId: 11,
        windowId: 21,
        startedAt: 60000
      }),
      2: task(2, {
        attempt: 2,
        state: 'active',
        phase: 'detecting',
        tabId: 12,
        windowId: 22,
        startedAt: 65000
      }),
      3: task(3, { state: 'terminal' }),
      4: task(4, {
        state: 'terminal',
        manualResolution: { status: 'in_progress', updatedAt: 68000 }
      })
    },
    results: [{
      originalIndex: 2,
      attempt: 1,
      url: 'https://target.test/2',
      sourceDomain: 'target.test',
      result: 'fail',
      aiContent: null,
      errorCode: 'task_timeout',
      errorMessage: '处理超时',
      timestamp: 50000,
      elapsed: 60,
      originalRow: ['https://target.test/2']
    }, {
      originalIndex: 3,
      attempt: 1,
      url: 'https://target.test/3',
      sourceDomain: 'target.test',
      result: 'success',
      aiContent: 'saved',
      errorCode: null,
      errorMessage: null,
      timestamp: 67000,
      elapsed: 7,
      originalRow: ['https://target.test/3']
    }, {
      originalIndex: 4,
      attempt: 1,
      url: 'https://target.test/4',
      sourceDomain: 'target.test',
      result: 'manual_required',
      aiContent: null,
      errorCode: 'submission_uncertain',
      errorMessage: '提交确认前中断',
      timestamp: 68000,
      elapsed: 8,
      originalRow: ['https://target.test/4']
    }]
  };
}

function createManualResolvedCheckpointFixture() {
  const checkpoint = createConsoleCheckpointFixture();
  checkpoint.source.rows = checkpoint.source.rows.slice(4, 5);
  checkpoint.source.parsedUrls = checkpoint.source.parsedUrls.slice(4, 5)
    .map((item) => ({ ...item, originalIndex: 0 }));
  checkpoint.tasks = {
    0: {
      ...checkpoint.tasks['4'],
      urlIndex: 0,
      manualResolution: { status: 'resolved', updatedAt: 69000 }
    }
  };
  checkpoint.results = [{
    ...checkpoint.results[2],
    originalIndex: 0
  }];
  checkpoint.cursor.nextIndex = 1;
  return checkpoint;
}
