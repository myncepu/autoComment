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
    store.save(11, { batchId: 'a', urlIndex: 0, attempt: 1 }),
    store.save(22, { batchId: 'a', urlIndex: 1, attempt: 1 })
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
  await store.save(11, { batchId: 'a', urlIndex: 0, attempt: 1 });

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
    attempt: 1,
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
    attempt: 2,
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
    attempt: 1,
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
    attempt: 2,
    historyRevision: replacement.history.historyRevision
  }), true);
  assert.equal(await store.get(11), null);
});

test('a delayed attempt 1 clear cannot remove attempt 2 for the same tab and task', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => 1000,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  await store.save(11, {
    batchId: 'batch-same',
    urlIndex: 3,
    attempt: 2
  });

  assert.equal(await store.clearIfMatches(11, {
    batchId: 'batch-same',
    urlIndex: 3,
    attempt: 1
  }), false);
  assert.equal((await store.get(11)).attempt, 2);

  assert.equal(await store.clearIfMatches(11, {
    batchId: 'batch-same',
    urlIndex: 3,
    attempt: 2
  }), true);
  assert.equal(await store.get(11), null);
});

test('rejects an incomplete context identity without changing the saved context', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => 1000,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  await store.save(11, {
    batchId: 'batch-complete',
    urlIndex: 3,
    attempt: 2
  });

  await assert.rejects(
    store.save(11, {
      batchId: 'batch-incomplete',
      urlIndex: 4
    }),
    /invalid_submit_context_identity/
  );
  assert.deepEqual(await store.get(11), {
    batchId: 'batch-complete',
    urlIndex: 3,
    attempt: 2,
    timestamp: 1000
  });
});

test('rejects a delayed older attempt without replacing the current tab context', async () => {
  const storage = createStorageArea();
  let now = 1000;
  const store = createBatchSubmitContextStore(storage, {
    now: () => now,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  await store.save(11, {
    batchId: 'batch-retry',
    urlIndex: 3,
    attempt: 2
  });

  now += 1;
  await assert.rejects(
    store.save(11, {
      batchId: 'batch-retry',
      urlIndex: 3,
      attempt: 1
    }),
    /stale_submit_context_attempt/
  );
  assert.deepEqual(await store.get(11), {
    batchId: 'batch-retry',
    urlIndex: 3,
    attempt: 2,
    timestamp: 1000
  });
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
    attempt: 1,
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
    urlIndex: 4,
    attempt: 1
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
    urlIndex: 2,
    attempt: 1
  }, 'timeout'), {
    sealed: true,
    recovered: false
  });
  await store.save(99, {
    batchId: 'batch-late',
    urlIndex: 2,
    attempt: 1,
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

  await store.save(55, {
    batchId: 'batch-replacement',
    urlIndex: 9,
    attempt: 2
  });
  await store.sealAndRecover(55, {
    batchId: 'batch-old',
    urlIndex: 1,
    attempt: 1
  }, 'timeout');
  now += 1;
  await store.save(55, {
    batchId: 'batch-old',
    urlIndex: 1,
    attempt: 1,
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
    urlIndex: 5,
    attempt: 1
  }]]);
  const store = {
    async save(tabId, context) { saved.push({ tabId, context }); },
    async get(tabId) { return contexts.get(tabId) || null; },
    async clear(tabId) { cleared.push(tabId); },
    async hasMatching(tabId, expected) {
      const context = contexts.get(tabId);
      return context?.batchId === expected.batchId
        && context?.urlIndex === expected.urlIndex
        && context?.attempt === expected.attempt;
    },
    async sealAndRecover(tabId, expected, reason) {
      recovered.push({ tabId, expected, reason });
      return { sealed: true, recovered: true };
    }
  };
  installBatchSubmitContextListener(chromeApi, store, {
    async runProofBoundTaskHook(_identity, sender, hook) {
      if (sender?.tab?.id !== 42) {
        return { ok: false, error: 'stale_worker_tab' };
      }
      return {
        ok: true,
        changed: false,
        sideEffect: await hook()
      };
    },
    async runOwnerPageRecoveryHook(_identity, sender, targetTabId, hook) {
      if (
        sender?.tab?.id !== 70 ||
        sender?.url !==
          'chrome-extension://extension-id/batch.html?recovery=1' ||
        targetTabId !== 77
      ) {
        return { ok: false, error: 'invalid_recovery_target' };
      }
      return {
        ok: true,
        changed: false,
        sideEffect: await hook()
      };
    }
  });

  const valid = await new Promise((resolve) => {
    listener(
      {
        type: 'BATCH_SAVE_SUBMIT_CONTEXT',
        tabId: 99,
        context: { batchId: 'a', urlIndex: 1, attempt: 1 }
      },
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
      urlIndex: 5,
      attempt: 1
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
      attempt: 1,
      reason: 'timeout'
    },
    {
      id: 'extension-id',
      tab: { id: 70, windowId: 52 },
      url: 'chrome-extension://extension-id/batch.html?recovery=1'
    },
    (response) => { recoveryResponse = response; }
  );
  await new Promise(setImmediate);

  assert.deepEqual(saved, [{
    tabId: 42,
    context: { batchId: 'a', urlIndex: 1, attempt: 1 }
  }]);
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
    expected: { batchId: 'batch-query', urlIndex: 5, attempt: 1 },
    reason: 'timeout'
  }]);
  assert.equal(tabRemovedListener, undefined);
  assert.deepEqual(cleared, []);
});

test('listener rejects a save without a complete attempt identity', async () => {
  let listener;
  let saveCalls = 0;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  installBatchSubmitContextListener(chromeApi, {
    async save() {
      saveCalls += 1;
    }
  });

  const response = await new Promise((resolve) => {
    listener({
      type: 'BATCH_SAVE_SUBMIT_CONTEXT',
      context: {
        batchId: 'batch-incomplete',
        urlIndex: 2
      }
    }, {
      id: 'extension-id',
      tab: { id: 42 }
    }, resolve);
  });

  assert.deepEqual(response, {
    ok: false,
    error: 'invalid_submit_context_identity'
  });
  assert.equal(saveCalls, 0);
});

test('listener rejects a matched clear without a complete attempt identity', async () => {
  let listener;
  let clearCalls = 0;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  installBatchSubmitContextListener(chromeApi, {
    async clearIfMatches() {
      clearCalls += 1;
      return true;
    }
  });

  const response = await new Promise((resolve) => {
    listener({
      type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
      match: {
        batchId: 'batch-incomplete',
        urlIndex: 2
      }
    }, {
      id: 'extension-id',
      tab: { id: 42 }
    }, resolve);
  });

  assert.deepEqual(response, {
    ok: false,
    error: 'invalid_submit_context_match'
  });
  assert.equal(clearCalls, 0);
});

test('submit-context mutations use the proof-bound task hook before storage', async () => {
  let listener;
  const saved = [];
  const cleared = [];
  const proofCalls = [];
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  const store = {
    async save(tabId, context) {
      saved.push({ tabId, context });
    },
    async clearIfMatches(tabId, match) {
      cleared.push({ tabId, match });
      return true;
    }
  };
  installBatchSubmitContextListener(chromeApi, store, {
    async runProofBoundTaskHook(identity, sender, hook, options) {
      proofCalls.push({ identity, sender, options });
      if (sender.tab.id !== 42) {
        return { ok: false, error: 'stale_worker_tab' };
      }
      await hook();
      return { ok: true, changed: false };
    }
  });
  const identity = {
    batchId: 'batch-proof',
    urlIndex: 4,
    attempt: 2
  };
  async function dispatch(message, tabId) {
    return new Promise((resolve) => {
      listener(
        message,
        { id: 'extension-id', tab: { id: tabId } },
        resolve
      );
    });
  }

  assert.deepEqual(await dispatch({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: identity
  }, 999), {
    ok: false,
    error: 'stale_worker_tab'
  });
  assert.deepEqual(await dispatch({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
    match: identity
  }, 999), {
    ok: false,
    error: 'stale_worker_tab'
  });
  assert.deepEqual(saved, []);
  assert.deepEqual(cleared, []);

  assert.deepEqual(await dispatch({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: identity
  }, 42), { ok: true });
  assert.deepEqual(await dispatch({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
    match: identity
  }, 42), { ok: true });
  assert.deepEqual(saved, [{ tabId: 42, context: identity }]);
  assert.deepEqual(cleared, [{ tabId: 42, match: identity }]);
  assert.equal(proofCalls.length, 4);
});
