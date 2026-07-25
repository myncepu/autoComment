import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchSubmitContextStore,
  installBatchSubmitContextListener
} from '../lib/batch-submit-context-store.mjs';

function createStorageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, data[key]]));
    },
    async set(values) { Object.assign(data, values); }
  };
}

test('serializes concurrent contexts by tab id without overwriting', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, { now: () => 1000 });

  await Promise.all([
    store.save(11, { batchId: 'a', urlIndex: 0 }),
    store.save(22, { batchId: 'a', urlIndex: 1 })
  ]);

  assert.equal((await store.get(11)).urlIndex, 0);
  assert.equal((await store.get(22)).urlIndex, 1);
  await store.clear(11);
  assert.equal(await store.get(11), null);
  assert.equal((await store.get(22)).urlIndex, 1);
});

test('keeps contexts at ten minutes and removes contexts older than ten minutes', async () => {
  let now = 1000;
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, { now: () => now });
  await store.save(11, { batchId: 'a', urlIndex: 0 });

  now += 10 * 60 * 1000;
  assert.equal((await store.get(11)).urlIndex, 0);

  now += 1;
  assert.equal(await store.get(11), null);
  assert.deepEqual(storage.data.batchSubmitContextsByTab, {});
});

test('can retain an exact pre-submit history context until durable acknowledgement', async () => {
  let now = 1000;
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => now,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  const context = {
    batchId: 'history-batch',
    urlIndex: 4,
    history: {
      commentHtml: 'Exact submitted body',
      historyRevision: {
        capturedAt: 1000,
        recordedAt: 1001,
        sequence: 1,
        id: 'revision-history'
      }
    }
  };

  await store.save(11, context);
  now += 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await store.get(11), {
    ...context,
    timestamp: 1000
  });
});

test('clearIfMatches cannot remove a replacement context from a delayed acknowledgement', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => 1000,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  const replacement = {
    batchId: 'batch-new',
    urlIndex: 3,
    history: {
      historyRevision: {
        capturedAt: 2000,
        recordedAt: 2001,
        sequence: 2,
        id: 'revision-new'
      }
    }
  };
  await store.save(11, replacement);

  assert.equal(await store.clearIfMatches(11, {
    batchId: 'batch-old',
    urlIndex: 1,
    historyRevision: {
      capturedAt: 1000,
      recordedAt: 1001,
      sequence: 1,
      id: 'revision-old'
    }
  }), false);
  assert.equal((await store.get(11)).batchId, 'batch-new');

  assert.equal(await store.clearIfMatches(11, {
    batchId: 'batch-new',
    urlIndex: 3,
    historyRevision: replacement.history.historyRevision
  }), true);
  assert.equal(await store.get(11), null);
});

test('sealAndRecover atomically moves an unresolved context into the task recovery queue', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => 3000,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  const context = {
    batchId: 'batch-recovery',
    urlIndex: 4,
    history: {
      commentHtml: 'Exact attempted body',
      historyRevision: {
        capturedAt: 2000,
        recordedAt: 2001,
        sequence: 1,
        id: 'revision-recovery'
      }
    }
  };
  await store.save(88, context);

  assert.deepEqual(await store.sealAndRecover(88, {
    batchId: 'batch-recovery',
    urlIndex: 4
  }, 'timeout'), {
    sealed: true,
    recovered: true
  });
  assert.equal(await store.get(88), null);
  assert.deepEqual(Object.values(
    storage.data.batchSubmitRecoveriesByTask
  ), [{
    ...context,
    sourceTabId: 88,
    recoveredAt: 3000,
    recoveryReason: 'timeout'
  }]);
});

test('a seal redirects a context saved after timeout into recovery instead of an orphaned tab key', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => 4000,
    maxAgeMs: Number.POSITIVE_INFINITY
  });

  assert.deepEqual(await store.sealAndRecover(99, {
    batchId: 'batch-late',
    urlIndex: 2
  }, 'timeout'), {
    sealed: true,
    recovered: false
  });
  await store.save(99, {
    batchId: 'batch-late',
    urlIndex: 2,
    history: {
      historyRevision: {
        capturedAt: 4000,
        recordedAt: 4001,
        sequence: 1,
        id: 'revision-late'
      }
    }
  });

  assert.equal(await store.get(99), null);
  assert.equal(
    Object.values(storage.data.batchSubmitRecoveriesByTask).length,
    1
  );
  assert.deepEqual(storage.data.batchSubmitRecoverySealsByTab, {});
});

test('a delayed sealed save recovers the old task without deleting a replacement tab context', async () => {
  const storage = createStorageArea();
  let now = 5000;
  const store = createBatchSubmitContextStore(storage, {
    now: () => now,
    maxAgeMs: Number.POSITIVE_INFINITY
  });

  await store.save(55, { batchId: 'batch-replacement', urlIndex: 9 });
  await store.sealAndRecover(55, {
    batchId: 'batch-old',
    urlIndex: 1
  }, 'timeout');
  now += 1;
  await store.save(55, {
    batchId: 'batch-old',
    urlIndex: 1,
    history: {
      historyRevision: {
        capturedAt: 4000,
        recordedAt: 4001,
        sequence: 1,
        id: 'revision-old-late'
      }
    }
  });

  assert.equal((await store.get(55)).batchId, 'batch-replacement');
  assert.equal(
    Object.values(storage.data.batchSubmitRecoveriesByTask)[0].batchId,
    'batch-old'
  );
});

test('listener preserves unacknowledged context when its tab closes', async () => {
  let listener;
  let tabRemovedListener;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(fn) { listener = fn; } }
    },
    tabs: { onRemoved: { addListener(fn) { tabRemovedListener = fn; } } }
  };
  const saved = [];
  const cleared = [];
  const recovered = [];
  const contexts = new Map([[77, {
    batchId: 'batch-query',
    urlIndex: 5
  }]]);
  const store = {
    async save(tabId, context) { saved.push({ tabId, context }); },
    async get(tabId) { return contexts.get(tabId) || null; },
    async clear(tabId) { cleared.push(tabId); },
    async hasMatching(tabId, expected) {
      const context = contexts.get(tabId);
      return context?.batchId === expected.batchId
        && context?.urlIndex === expected.urlIndex;
    },
    async sealAndRecover(tabId, expected, reason) {
      recovered.push({ tabId, expected, reason });
      return { sealed: true, recovered: true };
    }
  };
  installBatchSubmitContextListener(chromeApi, store);

  const valid = await new Promise((resolve) => {
    listener(
      { type: 'BATCH_SAVE_SUBMIT_CONTEXT', tabId: 99, context: { batchId: 'a' } },
      { tab: { id: 42 } },
      resolve
    );
  });
  const invalid = await new Promise((resolve) => {
    listener(
      { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: { batchId: 'a' } },
      {},
      resolve
    );
  });
  let unresolved;
  const queryHandled = listener(
    {
      type: 'BATCH_HAS_SUBMIT_CONTEXT',
      tabId: 77,
      batchId: 'batch-query',
      urlIndex: 5
    },
    { id: 'extension-id' },
    (response) => { unresolved = response; }
  );
  let recoveryResponse;
  const recoveryHandled = listener(
    {
      type: 'BATCH_RECOVER_SUBMIT_CONTEXT',
      tabId: 77,
      batchId: 'batch-query',
      urlIndex: 5,
      reason: 'timeout'
    },
    { id: 'extension-id' },
    (response) => { recoveryResponse = response; }
  );
  await new Promise(setImmediate);

  assert.deepEqual(saved, [{ tabId: 42, context: { batchId: 'a' } }]);
  assert.deepEqual(valid, { ok: true });
  assert.deepEqual(invalid, { ok: false, error: 'missing_sender_tab' });
  assert.equal(queryHandled, true);
  assert.deepEqual(unresolved, { ok: true, unresolved: true });
  assert.equal(recoveryHandled, true);
  assert.deepEqual(recoveryResponse, {
    ok: true,
    sealed: true,
    recovered: true
  });
  assert.deepEqual(recovered, [{
    tabId: 77,
    expected: { batchId: 'batch-query', urlIndex: 5 },
    reason: 'timeout'
  }]);
  assert.equal(tabRemovedListener, undefined);
  assert.deepEqual(cleared, []);
});
