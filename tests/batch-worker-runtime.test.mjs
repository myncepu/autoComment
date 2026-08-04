import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchWorkerRuntime,
  isForwardRuntimeCheckpoint,
  waitForContentScriptReady
} from '../lib/batch-worker-runtime.mjs';

test('accepts only forward runtime checkpoints across concurrent worker creates', () => {
  const harness = createWorkerHarness({ concurrency: 2, taskCount: 2 });
  const initial = structuredClone(harness.checkpoint);
  const firstActive = structuredClone(initial);
  Object.assign(firstActive.tasks['0'], {
    state: 'active',
    tabId: 100,
    windowId: 42,
    startedAt: 1100,
    updatedAt: 1100
  });
  firstActive.updatedAt = 1100;
  firstActive.cursor.nextIndex = 1;
  const bothActive = structuredClone(firstActive);
  Object.assign(bothActive.tasks['1'], {
    state: 'active',
    tabId: 101,
    windowId: 42,
    startedAt: 1200,
    updatedAt: 1200
  });
  bothActive.updatedAt = 1200;
  bothActive.cursor.nextIndex = 2;

  assert.equal(
    isForwardRuntimeCheckpoint(initial, firstActive),
    true
  );
  assert.equal(
    isForwardRuntimeCheckpoint(firstActive, bothActive),
    true
  );
  assert.equal(
    isForwardRuntimeCheckpoint(bothActive, firstActive),
    false
  );
});

test('opens no more than three attempt-aware background worker tabs in the console window', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 5 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.deepEqual(harness.tabsApi.createCalls, [
    { windowId: 42, url: 'https://target.test/0', active: false },
    { windowId: 42, url: 'https://target.test/1', active: false },
    { windowId: 42, url: 'https://target.test/2', active: false }
  ]);
  assert.deepEqual(harness.sentHandles.map(({ urlIndex, attempt }) => ({
    urlIndex,
    attempt
  })), [
    { urlIndex: 0, attempt: 1 },
    { urlIndex: 1, attempt: 1 },
    { urlIndex: 2, attempt: 1 }
  ]);
});

test('uses a background-checkpointed create without a duplicate ACTIVE continuation', async () => {
  let harness;
  harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      create(details) {
        const checkpoint = structuredClone(harness.checkpoint);
        Object.assign(checkpoint.tasks['0'], {
          state: 'active',
          tabId: 100,
          windowId: 42,
          startedAt: 1000
        });
        return {
          id: 100,
          windowId: 42,
          url: 'https://target.test/0',
          pendingUrl: null,
          status: 'complete',
          discarded: false,
          backgroundCheckpointed: true,
          runtimeCheckpoint: checkpoint
        };
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.equal(
    harness.calls.some(
      ([kind, type]) => kind === 'runtime' && type === 'BATCH_TASK_ACTIVE'
    ),
    false
  );
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex, attempt, tabId, windowId }) => ({
      urlIndex,
      attempt,
      tabId,
      windowId
    })),
    [{ urlIndex: 0, attempt: 1, tabId: 100, windowId: 42 }]
  );
});

test('owned recovery-required create failure pauses without terminalizing or delivering a handle', async () => {
  let harness;
  harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      create() {
        const checkpoint = structuredClone(harness.checkpoint);
        Object.assign(checkpoint.tasks['0'], {
          state: 'active',
          requestId: 'batch-1:0:1',
          tabId: 100,
          windowId: 42,
          startedAt: 1000
        });
        const error = new Error('tab_navigation_uncertain');
        error.code = 'tab_navigation_uncertain';
        error.recoveryRequired = true;
        error.runtimeCheckpoint = checkpoint;
        throw error;
      }
    }
  });
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));

  await runtime.start(harness.checkpoint);

  assert.equal(harness.terminalPayloads.length, 0);
  assert.equal(harness.sentHandles.length, 0);
  assert.equal(
    harness.calls.some(([, type]) => type === 'BATCH_TASK_TERMINAL'),
    false
  );
  assert.equal(
    events.some(({ type }) => type === 'runtime-error'),
    true
  );
});

test('confirmation seals and closes its tab before replenishing one worker slot', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 5 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 1,
    attempt: 1,
    sourceTabId: 101,
    result: 'success',
    aiContent: 'saved',
    resultPreview: {
      commentText: 'Visible comment',
      anchorTexts: ['Product'],
      promotedWebsiteUrl: 'https://promo.test/'
    },
    historySaveStatus: 'saved'
  });

  assert.deepEqual(harness.calls, [
    ['seal', 1, 1, 'confirmation'],
    ['runtime', 'BATCH_TASK_TERMINAL', 1, 1],
    ['close', 101],
    ['runtime', 'BATCH_TASK_ACTIVE', 3, 1],
    ['handle', 3, 1]
  ]);
  assert.equal(harness.tabsApi.createCalls.length, 4);
  assert.deepEqual(harness.terminalPayloads[0].result.resultPreview, {
    commentText: 'Visible comment',
    anchorTexts: ['Product'],
    promotedWebsiteUrl: 'https://promo.test/'
  });
});

test('authoritative confirmation checkpoint closes the terminal tab without a duplicate terminal transition', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  const authoritative = structuredClone(harness.checkpoint);
  authoritative.updatedAt = 1001;
  Object.assign(authoritative.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 1001
  });
  authoritative.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'success',
    aiContent: 'saved',
    errorCode: null,
    errorMessage: null,
    timestamp: 1001
  });
  harness.calls.length = 0;

  assert.equal(await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    aiContent: 'saved',
    historySaveStatus: 'saved',
    checkpoint: authoritative
  }), true);

  assert.deepEqual(harness.calls, [
    ['close', 100],
    ['runtime', 'BATCH_TASK_ACTIVE', 1, 1],
    ['handle', 1, 1]
  ]);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('one authoritative confirmation reconciles every terminal activity and refills all freed slots', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 6 });
  const baseRuntimeRequest = harness.dependencies.runtimeRequest;
  let authoritativeState = null;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (!authoritativeState) return baseRuntimeRequest(type, payload);
    harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
    if (type === 'BATCH_TASK_ACTIVE') {
      Object.assign(authoritativeState.tasks[String(payload.urlIndex)], {
        state: 'active',
        tabId: payload.tabId,
        windowId: payload.windowId,
        startedAt: payload.startedAt
      });
    }
    return { ok: true, checkpoint: authoritativeState };
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  authoritativeState = structuredClone(harness.checkpoint);
  authoritativeState.updatedAt = 1001;
  for (const urlIndex of [0, 1, 2]) {
    Object.assign(authoritativeState.tasks[String(urlIndex)], {
      state: 'terminal',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 1001
    });
    authoritativeState.results.push({
      originalIndex: urlIndex,
      attempt: 1,
      result: 'success',
      aiContent: `saved-${urlIndex}`,
      errorCode: null,
      errorMessage: null,
      timestamp: 1001
    });
  }
  harness.calls.length = 0;

  assert.equal(await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    aiContent: 'saved-0',
    historySaveStatus: 'saved',
    checkpoint: authoritativeState
  }), true);

  assert.deepEqual(harness.tabsApi.removeCalls, [100, 101, 102]);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1, 2, 3, 4, 5]
  );
  assert.equal(harness.terminalPayloads.length, 0);
});

test('manual authoritative reconcile releases a stale page activity and refills its slot', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  const authoritative = structuredClone(harness.checkpoint);
  authoritative.updatedAt = 1001;
  Object.assign(authoritative.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 1001
  });
  authoritative.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'success',
    aiContent: 'saved',
    errorCode: null,
    errorMessage: null,
    timestamp: 1001
  });
  harness.calls.length = 0;

  assert.equal(await runtime.reconcile(authoritative), true);
  assert.deepEqual(harness.calls, [
    ['close', 100],
    ['runtime', 'BATCH_TASK_ACTIVE', 1, 1],
    ['handle', 1, 1]
  ]);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('manual reconcile recovers a removed activity after its terminal race paused the page', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const baseRuntimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (type === 'BATCH_TASK_TERMINAL') {
      harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
      return { ok: false, error: 'task_already_terminal' };
    }
    return baseRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  harness.tabsApi.emitRemoved(100);
  await waitFor(
    () => harness.calls.some(([, type]) => type === 'BATCH_TASK_TERMINAL'),
    'failed page terminal race'
  );

  const authoritative = structuredClone(harness.checkpoint);
  authoritative.updatedAt = 1001;
  Object.assign(authoritative.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 1001
  });
  authoritative.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'manual_required',
    errorCode: 'submission_uncertain',
    errorMessage: 'Task deadline exceeded',
    timestamp: 1001
  });

  assert.equal(await runtime.reconcile(authoritative), true);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
});

test('accepts removed-tab checkpoint and replenishes the freed worker slot', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);
  const terminalCheckpoint = structuredClone(harness.checkpoint);
  Object.assign(terminalCheckpoint.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null
  });
  terminalCheckpoint.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'fail',
    errorCode: 'worker_tab_closed',
    errorMessage: 'Worker tab closed'
  });
  assert.equal(
    await runtime.acceptRemovedTabCheckpoint({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 100,
      checkpoint: terminalCheckpoint
    }),
    true
  );
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
  assert.equal(
    events.some(
      ({ type, checkpoint }) => (
        type === 'changed' &&
        checkpoint.tasks['0'].state === 'terminal'
      )
    ),
    true
  );
  assert.deepEqual(harness.tabsApi.removeCalls, []);
});

test('keeps an unrelated recovery pause after adopting a removed-tab checkpoint', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);
  harness.tabsApi.update = async () => {
    throw new Error('focus failed before worker removal');
  };

  assert.equal(await runtime.focus(0), null);
  harness.tabsApi.emitRemoved(100);
  await Promise.resolve();

  const terminalCheckpoint = structuredClone(harness.checkpoint);
  terminalCheckpoint.updatedAt += 1;
  Object.assign(terminalCheckpoint.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: terminalCheckpoint.updatedAt
  });
  terminalCheckpoint.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'fail',
    errorCode: 'task_failed',
    errorMessage: 'Worker tab closed',
    timestamp: terminalCheckpoint.updatedAt
  });

  assert.equal(await runtime.acceptRemovedTabCheckpoint({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 100,
    checkpoint: terminalCheckpoint
  }), true);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0],
    'an unrelated safety pause must not refill automatically'
  );
  assert.equal(harness.intervalCallbacks.length, 1);
  assert.equal(
    events.some(
      ({ transition, recovered }) => (
        transition === 'BATCH_WORKER_TAB_REMOVED' &&
        recovered === true
      )
    ),
    false
  );

  assert.equal(await runtime.resume(terminalCheckpoint), true);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
});

test('ignores stale removed-tab checkpoint identities and duplicate delivery', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  const terminalCheckpoint = structuredClone(harness.checkpoint);
  Object.assign(terminalCheckpoint.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null
  });
  terminalCheckpoint.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'fail',
    errorCode: 'worker_tab_closed',
    errorMessage: 'Worker tab closed'
  });
  const staleBatchCheckpoint = structuredClone(terminalCheckpoint);
  staleBatchCheckpoint.batchId = 'batch-stale';
  const staleAttemptCheckpoint = structuredClone(terminalCheckpoint);
  staleAttemptCheckpoint.tasks['0'].attempt = 2;

  assert.equal(await runtime.acceptRemovedTabCheckpoint({
    batchId: 'batch-stale',
    urlIndex: 0,
    attempt: 1,
    tabId: 100,
    checkpoint: staleBatchCheckpoint
  }), false);
  assert.equal(await runtime.acceptRemovedTabCheckpoint({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 2,
    tabId: 100,
    checkpoint: staleAttemptCheckpoint
  }), false);

  const message = {
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 100,
    checkpoint: terminalCheckpoint
  };
  assert.equal(await runtime.acceptRemovedTabCheckpoint(message), true);
  assert.equal(await runtime.acceptRemovedTabCheckpoint(message), false);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
});

test('rejects equal-time removed snapshots that regress unrelated task, result, or reservation state', async () => {
  async function runProbe(regress) {
    const harness = createWorkerHarness({ concurrency: 2, taskCount: 3 });
    const runtime = createBatchWorkerRuntime(harness.dependencies);
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.start(harness.checkpoint);
    await runtime.handleConfirmation({
      type: 'BATCH_CONFIRMED',
      batchId: 'batch-1',
      urlIndex: 1,
      attempt: 1,
      sourceTabId: 101,
      result: 'success',
      aiContent: 'saved',
      historySaveStatus: 'saved'
    });
    harness.checkpoint.updatedAt = 5000;
    harness.checkpoint.openingReservations = {
      'batch-1:2:1': {
        batchId: 'batch-1',
        urlIndex: 2,
        attempt: 1,
        requestId: 'batch-1:2:1',
        cleanupOnly: true,
        createCompletionUnknown: true,
        cleanupObservedAt: 4900,
        updatedAt: 5000
      }
    };
    const candidate = structuredClone(harness.checkpoint);
    Object.assign(candidate.tasks['0'], {
      state: 'terminal',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 5000
    });
    candidate.results.push({
      originalIndex: 0,
      attempt: 1,
      result: 'fail',
      errorCode: 'task_failed',
      errorMessage: 'Worker tab closed',
      timestamp: 5000
    });
    regress(candidate);

    assert.equal(await runtime.acceptRemovedTabCheckpoint({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 100,
      checkpoint: candidate
    }), false);
    assert.deepEqual(
      harness.sentHandles.map(({ urlIndex }) => urlIndex),
      [0, 1, 2]
    );
    assert.equal((await runtime.focus(0))?.tabId, 100);
    assert.equal(
      events.some(({ type }) => type === 'runtime-error'),
      false
    );
  }

  await runProbe((candidate) => {
    Object.assign(candidate.tasks['1'], {
      state: 'active',
      phase: 'generating',
      tabId: 101,
      windowId: 42,
      startedAt: 1000,
      updatedAt: 4000
    });
  });
  await runProbe((candidate) => {
    const unrelated = candidate.results.find(
      ({ originalIndex }) => originalIndex === 1
    );
    unrelated.aiContent = 'stale unrelated result';
  });
  await runProbe((candidate) => {
    candidate.openingReservations['batch-1:2:1'].cleanupOnly = false;
    candidate.openingReservations['batch-1:2:1'].updatedAt = 4000;
  });
  for (const field of ['windowId', 'ownerPageTabId', 'ownershipEpoch']) {
    await runProbe((candidate) => {
      candidate.openingReservations['batch-1:2:1'][field] =
        Number(candidate.openingReservations['batch-1:2:1'][field] || 0) + 1;
    });
  }
});

test('ignores removed-tab checkpoint with a different frozen profile identity', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  harness.checkpoint.version = 3;
  harness.checkpoint.configRevision = 7;
  harness.checkpoint.profiles = {
    'profile-a': {
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice',
      email: 'alice@example.test'
    },
    'profile-b': {
      id: 'profile-b',
      displayName: '作者 B',
      name: 'Bob',
      email: 'bob@example.test'
    }
  };
  harness.checkpoint.promotionSites = {
    'site-a': {
      id: 'site-a',
      name: '站点 A',
      url: 'https://promo-a.test/',
      content: 'Promotion A'
    }
  };
  for (const task of Object.values(harness.checkpoint.tasks)) {
    Object.assign(task, {
      taskId: `batch-1:${task.urlIndex + 1}`,
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      assignmentPairId: 'pair-a',
      assignmentSource: 'weighted'
    });
  }
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  const terminalCheckpoint = structuredClone(harness.checkpoint);
  Object.assign(terminalCheckpoint.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    profileId: 'profile-b'
  });

  assert.equal(await runtime.acceptRemovedTabCheckpoint({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 100,
    checkpoint: terminalCheckpoint
  }), false);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0]
  );
});

test('pause stops replenishment and seals each activity before closing its tab', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 5 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  await runtime.pause('user');

  assert.deepEqual(harness.calls, [
    ['seal', 0, 1, 'user'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1],
    ['close', 100],
    ['seal', 1, 1, 'user'],
    ['runtime', 'BATCH_TASK_TERMINAL', 1, 1],
    ['close', 101],
    ['seal', 2, 1, 'user'],
    ['runtime', 'BATCH_TASK_TERMINAL', 2, 1],
    ['close', 102]
  ]);
  assert.equal(harness.tabsApi.createCalls.length, 3);
});

test('dispose propagates cleanup failure and retains reachable tab ownership', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      async remove() {
        throw new Error('tab cleanup unavailable');
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const disposed = await runtime.dispose();

  assert.equal(disposed, false);
  assert.equal(harness.tabsApi.removedListenerCount(), 1);
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
});

test('waits for a slow content script beyond the former fixed retry window', async () => {
  let now = 0;
  let pingCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    clock: () => now,
    tabsOptions: {
      async sendMessage(_tabId, message) {
        if (message.type !== 'PING') return { ok: true };
        pingCount += 1;
        if (now < 12000) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true };
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await waitFor(() => pingCount === 1, 'first PING');
  now = 12000;
  harness.tabsApi.emitUpdated(100, {
    status: 'complete'
  });
  await starting;

  assert.equal(pingCount, 2);
  assert.equal(harness.sentHandles.length, 1);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('delivers a handle while the committed target page is still loading', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      createdTab: {
        url: 'https://target.test/0',
        pendingUrl: null,
        status: 'loading'
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.deepEqual(
    harness.tabsApi.sendMessageCalls.map(([, message]) => message.type),
    ['PING']
  );
  assert.equal(harness.sentHandles.length, 1);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('does not PING the previous document before pending navigation commits', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      createdTab: {
        url: 'chrome-extension://fixture/worker-pending.html',
        pendingUrl: 'https://target.test/0',
        status: 'loading'
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.tabsApi.sendMessageCalls.length, 0);

  harness.tabsApi.emitUpdated(100, {
    url: 'https://target.test/0',
    pendingUrl: null,
    status: 'loading'
  });
  await starting;

  assert.deepEqual(
    harness.tabsApi.sendMessageCalls.map(([, message]) => message.type),
    ['PING']
  );
  assert.equal(harness.sentHandles.length, 1);
});

test('waits while a worker still reports its placeholder before pendingUrl appears', async () => {
  const tabsApi = createFakeTabsApi({
    createdTab: {
      url: 'chrome-extension://fixture/worker-pending.html',
      pendingUrl: null,
      status: 'loading'
    }
  });
  const tab = await tabsApi.create({
    windowId: 42,
    url: 'chrome-extension://fixture/worker-pending.html',
    active: false
  });

  const readiness = waitForContentScriptReady(
    { tabId: tab.id, startTime: Date.now() },
    { tabsApi, timeoutMs: 100, pollIntervalMs: 5 }
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tabsApi.sendMessageCalls.length, 0);

  tabsApi.emitUpdated(tab.id, {
    url: 'https://target.test/0',
    pendingUrl: null,
    status: 'loading'
  });
  const result = await readiness;

  assert.equal(result.tab.url, 'https://target.test/0');
});

test('retries when PING answers from a document that no longer matches the tab', async () => {
  let pingCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      createdTab: {
        url: 'https://target.test/redirecting',
        pendingUrl: null,
        status: 'loading'
      },
      async sendMessage(_tabId, message) {
        if (message.type !== 'PING') return { ok: true };
        pingCount += 1;
        return {
          ok: true,
          documentUrl: 'https://target.test/final',
          readyState: 'loading'
        };
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await waitFor(() => pingCount === 1, 'first mismatched PING');
  assert.equal(harness.sentHandles.length, 0);

  harness.tabsApi.emitUpdated(100, {
    url: 'https://target.test/final',
    status: 'loading'
  });
  await starting;

  assert.equal(pingCount, 2);
  assert.equal(harness.sentHandles.length, 1);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('content-script timeout keeps the final raw error and fresh tab diagnostics', async () => {
  let now = 0;
  let pingCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    clock: () => now,
    readinessTimeoutMs: 30000,
    tabsOptions: {
      async sendMessage(_tabId, message) {
        if (message.type !== 'PING') return { ok: true };
        pingCount += 1;
        throw new Error(`raw receiver error ${pingCount}`);
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await waitFor(() => pingCount === 1, 'first rejected PING');
  now = 30001;
  harness.tabsApi.emitUpdated(100, {
    status: 'complete',
    url: 'https://target.test/final'
  });
  await starting;

  assert.equal(harness.sentHandles.length, 0);
  assert.equal(harness.terminalPayloads.length, 1);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'content_script_unavailable'
  );
  assert.match(harness.terminalPayloads[0].result.errorMessage, /raw receiver error 1/);
  assert.match(harness.terminalPayloads[0].result.errorMessage, /tabId=100/);
  assert.match(harness.terminalPayloads[0].result.errorMessage, /status=complete/);
  assert.match(harness.terminalPayloads[0].result.errorMessage, /target\.test\/final/);
  assert.match(harness.terminalPayloads[0].result.errorMessage, /discarded=false/);
  assert.match(harness.terminalPayloads[0].result.errorMessage, /elapsedMs=30001/);
});

test('classifies Chrome error pages before sending BATCH_HANDLE', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      createdTab: {
        url: 'chrome-error://chromewebdata/',
        status: 'complete'
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.equal(harness.tabsApi.sendMessageCalls.length, 0);
  assert.equal(harness.sentHandles.length, 0);
  assert.match(
    harness.terminalPayloads[0].result.errorMessage,
    /reason=chrome_error_page/
  );
});

test('classifies a host-permission denial without continuing to BATCH_HANDLE', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      async sendMessage() {
        throw new Error('Cannot access contents of url. Extension manifest must request permission.');
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.equal(harness.sentHandles.length, 0);
  assert.match(
    harness.terminalPayloads[0].result.errorMessage,
    /reason=permission_denied/
  );
  assert.match(
    harness.terminalPayloads[0].result.errorMessage,
    /Cannot access contents/
  );
});

test('missing parsed URL terminalizes the task with safe source defaults', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  harness.checkpoint.source.parsedUrls[0] = null;
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  assert.equal(harness.tabsApi.createCalls.length, 0);
  assert.equal(harness.terminalPayloads.length, 1);
  assert.deepEqual(harness.terminalPayloads[0].result, {
    result: 'fail',
    aiContent: null,
    errorCode: 'batch_source_missing',
    errorMessage: '批次源数据缺失'
  });
});

test('refill reclaims a safely retried attempt after current terminal tasks', async () => {
  const harness = createWorkerHarness({ concurrency: 2, taskCount: 3 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  Object.assign(harness.checkpoint.tasks['0'], {
    attempt: 2,
    state: 'queued'
  });

  await runtime.refill(harness.checkpoint);
  await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 1,
    attempt: 1,
    sourceTabId: 101,
    result: 'success',
    historySaveStatus: 'saved'
  });

  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex, attempt }) => [urlIndex, attempt]),
    [[0, 1], [1, 1], [2, 1], [0, 2]]
  );
  assert.deepEqual(harness.tabsApi.createCalls.at(-1), {
    windowId: 42,
    url: 'https://target.test/0',
    active: false
  });
});

test('authoritative capacity recovery bypasses a stuck terminal operation and refills all slots', async () => {
  const harness = createWorkerHarness({ concurrency: 2, taskCount: 4 });
  const baseRuntimeRequest = harness.dependencies.runtimeRequest;
  let blockTerminal = false;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (blockTerminal && type === 'BATCH_TASK_TERMINAL') {
      harness.calls.push(['runtime-blocked', type, payload.urlIndex]);
      return new Promise(() => {});
    }
    return baseRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const authoritative = structuredClone(harness.checkpoint);
  for (const urlIndex of [0, 1]) {
    Object.assign(authoritative.tasks[String(urlIndex)], {
      state: 'terminal',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 2000
    });
    authoritative.results.push({
      originalIndex: urlIndex,
      attempt: 1,
      result: 'success',
      aiContent: null,
      errorCode: null,
      errorMessage: null,
      timestamp: 2000
    });
  }
  authoritative.updatedAt = 2000;
  blockTerminal = true;
  void runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.calls.some(([kind]) => kind === 'runtime-blocked'),
    true
  );

  const recovered = await Promise.race([
    runtime.recoverCapacity(authoritative),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);

  assert.equal(recovered, true);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1, 2, 3]
  );
});

test('authoritative recovery bypasses a stuck final terminal operation and completes the batch', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const baseRuntimeRequest = harness.dependencies.runtimeRequest;
  let blockTerminal = false;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (blockTerminal && type === 'BATCH_TASK_TERMINAL') {
      harness.calls.push(['runtime-blocked', type, payload.urlIndex]);
      return new Promise(() => {});
    }
    return baseRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const authoritative = structuredClone(harness.checkpoint);
  Object.assign(authoritative.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 2000
  });
  authoritative.results.push({
    originalIndex: 0,
    attempt: 1,
    result: 'success',
    aiContent: null,
    errorCode: null,
    errorMessage: null,
    timestamp: 2000
  });
  authoritative.updatedAt = 2000;
  blockTerminal = true;
  void runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.calls.some(([kind]) => kind === 'runtime-blocked'),
    true
  );

  const recovered = await Promise.race([
    runtime.recoverCapacity(authoritative),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);

  assert.equal(recovered, true);
  assert.equal(harness.checkpoint.status, 'completed');
  assert.equal(
    harness.calls.some(([, type]) => type === 'BATCH_SESSION_COMPLETE'),
    true
  );
});

test('timeout bounds submit-context sealing before closing a task whose page phase is stale', async () => {
  let now = 1000;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    timeoutSeconds: 1,
    clock: () => now,
    sealTimeoutMs: 5
  });
  harness.dependencies.sealSubmitContext = (activity, reason) => {
    harness.calls.push(['seal', activity.urlIndex, activity.attempt, reason]);
    return new Promise(() => {});
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;
  now = 2100;

  const outcome = await Promise.race([
    harness.intervalCallbacks[0]().then(() => 'finalized'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);

  assert.equal(outcome, 'finalized');
  assert.deepEqual(harness.calls, [
    ['seal', 0, 1, 'timeout'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1],
    ['close', 100],
    ['runtime', 'BATCH_TASK_ACTIVE', 1, 1],
    ['handle', 1, 1]
  ]);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'submission_uncertain'
  );
});

test('a timeout closes and replaces its tab while another finalizer is blocked', async () => {
  const armed = [];
  let expire;
  let releaseBlockedTerminal;
  const harness = createWorkerHarness({
    concurrency: 2,
    taskCount: 3,
    timeoutSeconds: 45,
    taskDeadlineFactory({ onExpire }) {
      expire = onExpire;
      return {
        arm(identity) {
          armed.push(structuredClone(identity));
        },
        clear() {
          return true;
        },
        clearAll() {}
      };
    }
  });
  const runtimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (
      type === 'BATCH_TASK_TERMINAL' &&
      payload.urlIndex === 0
    ) {
      await new Promise((resolve) => {
        releaseBlockedTerminal = resolve;
      });
    }
    return runtimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const blockedConfirmation = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(
    () => typeof releaseBlockedTerminal === 'function',
    'blocked terminal transition'
  );

  await expire(armed.find(({ urlIndex }) => urlIndex === 1));

  assert.equal(
    harness.tabsApi.removeCalls.includes(101),
    true,
    'the expired tab must close without waiting for the blocked finalizer'
  );
  assert.equal(
    harness.terminalPayloads.some(
      ({ urlIndex, result }) => (
        urlIndex === 1 &&
        result.errorCode === 'task_timeout'
      )
    ),
    true
  );
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1, 2],
    'the freed slot must be replenished immediately'
  );

  releaseBlockedTerminal();
  await blockedConfirmation;
});

test('an authoritative background deadline refills behind a blocked page finalizer', async () => {
  let releaseBlockedTerminal;
  const harness = createWorkerHarness({
    concurrency: 2,
    taskCount: 3
  });
  const runtimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (
      type === 'BATCH_TASK_TERMINAL' &&
      payload.urlIndex === 0
    ) {
      await new Promise((resolve) => {
        releaseBlockedTerminal = resolve;
      });
    }
    return runtimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  const blockedConfirmation = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(
    () => typeof releaseBlockedTerminal === 'function',
    'blocked page finalizer'
  );

  harness.tabsApi.emitRemoved(101);
  const terminalCheckpoint = structuredClone(harness.checkpoint);
  terminalCheckpoint.updatedAt += 1;
  Object.assign(terminalCheckpoint.tasks['1'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: terminalCheckpoint.updatedAt
  });
  terminalCheckpoint.results.push({
    originalIndex: 1,
    attempt: 1,
    result: 'fail',
    errorCode: 'task_timeout',
    errorMessage: 'Task deadline exceeded'
  });

  const outcome = await Promise.race([
    runtime.acceptRemovedTabCheckpoint({
      batchId: 'batch-1',
      urlIndex: 1,
      attempt: 1,
      tabId: 101,
      deadlineExpired: true,
      checkpoint: terminalCheckpoint
    }).then((accepted) => accepted ? 'accepted' : 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100))
  ]);

  assert.equal(outcome, 'accepted');
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1, 2]
  );

  Object.assign(
    harness.checkpoint.tasks['1'],
    structuredClone(terminalCheckpoint.tasks['1'])
  );
  harness.checkpoint.results.push(
    structuredClone(terminalCheckpoint.results.at(-1))
  );
  releaseBlockedTerminal();
  await blockedConfirmation;
});

test('adopts an already-terminal checkpoint when background closes a confirmed tab first', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (type !== 'BATCH_TASK_TERMINAL') {
      return originalRequest(type, payload);
    }
    const terminalCheckpoint = structuredClone(harness.checkpoint);
    terminalCheckpoint.updatedAt += 1;
    const task = terminalCheckpoint.tasks[String(payload.urlIndex)];
    Object.assign(task, {
      state: 'terminal',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: terminalCheckpoint.updatedAt
    });
    terminalCheckpoint.results.push({
      originalIndex: payload.urlIndex,
      attempt: payload.attempt,
      result: 'success',
      timestamp: terminalCheckpoint.updatedAt
    });
    return {
      ok: false,
      error: 'task_already_terminal',
      checkpoint: terminalCheckpoint
    };
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;
  harness.tabsApi.emitRemoved(100);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
  assert.deepEqual(harness.tabsApi.removeCalls, []);
});

test('an attempt deadline expires and closes a task without the scan interval', async () => {
  const armed = [];
  let expire;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    timeoutSeconds: 45,
    taskDeadlineFactory({ onExpire }) {
      expire = onExpire;
      return {
        arm(identity, startedAt, timeoutMs) {
          armed.push({
            identity: structuredClone(identity),
            startedAt,
            timeoutMs
          });
        },
        clear() {
          return true;
        },
        clearAll() {}
      };
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  assert.equal(harness.terminalPayloads.length, 0);
  assert.deepEqual(armed, [{
    identity: {
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1
    },
    startedAt: 1000,
    timeoutMs: 45_000
  }]);

  await expire(armed[0].identity);

  assert.equal(harness.terminalPayloads.length, 1);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'task_timeout'
  );
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
});

test('timeout finalizes and replenishes when submit-context sealing never settles', async () => {
  const armed = [];
  let expire;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    timeoutSeconds: 45,
    sealTimeoutMs: 5,
    taskDeadlineFactory({ onExpire }) {
      expire = onExpire;
      return {
        arm(identity) {
          armed.push(structuredClone(identity));
        },
        clear() {
          return true;
        },
        clearAll() {}
      };
    }
  });
  harness.dependencies.sealSubmitContext = () => new Promise(() => {});
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  Object.assign(harness.checkpoint.tasks['0'], {
    state: 'submitting',
    phase: 'confirming'
  });

  const outcome = await Promise.race([
    expire(armed[0]).then(() => 'finalized'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);

  assert.equal(outcome, 'finalized');
  assert.equal(harness.terminalPayloads.length, 1);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'submission_uncertain'
  );
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1]
  );
});

test('stop seals active work and never replenishes it', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  await runtime.stop();

  assert.deepEqual(harness.calls, [
    ['seal', 0, 1, 'stop'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1],
    ['close', 100]
  ]);
  assert.equal(harness.tabsApi.createCalls.length, 1);
});

test('stop reports cleanup failure and retains tab ownership for recovery', async () => {
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      async remove() {
        throw new Error('tab close unavailable');
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const stopped = await runtime.stop();

  assert.equal(stopped, false);
  assert.equal(harness.tabsApi.removedListenerCount(), 1);
  assert.equal(harness.tabsApi.removeCalls.length, 1);
});

test('resume rebuilds scheduling from current task core state', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  await runtime.pause('user');
  harness.calls.length = 0;

  await runtime.resume(harness.checkpoint);

  assert.deepEqual(harness.calls, [
    ['runtime', 'BATCH_TASK_ACTIVE', 1, 1],
    ['handle', 1, 1]
  ]);
});

test('focus activates the worker tab and dispose detaches owned resources', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  await runtime.focus(0);
  await runtime.dispose();

  assert.deepEqual(harness.tabsApi.updateCalls, [[100, { active: true }]]);
  assert.equal(harness.clearedIntervals.length, 1);
  assert.equal(harness.tabsApi.removedListenerCount(), 0);
});

test('an opening timeout releases capacity before a late tab is cleaned up', async () => {
  let now = 0;
  let resolveFirstCreate;
  let createCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    timeoutSeconds: 1,
    clock: () => now,
    tabsOptions: {
      create(details) {
        createCount += 1;
        if (createCount === 1) {
          return new Promise((resolve) => {
            resolveFirstCreate = resolve;
          });
        }
        return {
          id: 101,
          windowId: details.windowId,
          url: details.url,
          status: 'complete',
          discarded: false
        };
      }
    }
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await waitFor(() => createCount === 1, 'first tab create');
  now = 1100;
  await harness.intervalCallbacks[0]();
  await waitFor(() => createCount === 2, 'replacement tab create');
  await waitFor(() => harness.sentHandles.length === 1, 'replacement handle');
  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [1]
  );
  assert.deepEqual(
    harness.terminalPayloads.map(({ urlIndex }) => urlIndex),
    [0]
  );
  assert.equal(
    await Promise.race([
      starting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
    ]),
    'resolved'
  );

  resolveFirstCreate({
    id: 100,
    windowId: 42,
    url: 'https://target.test/0',
    status: 'complete',
    discarded: false
  });
  await waitFor(() => harness.tabsApi.removeCalls.length === 1, 'late cleanup');
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
});

test('a deferred finalizer cleans only its old tab after a replacement lifecycle starts', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const replacementCheckpoint = structuredClone(harness.checkpoint);
  replacementCheckpoint.batchId = 'batch-2';
  let releaseTerminal;
  const originalRuntimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacementCheckpoint.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return Promise.resolve({ ok: true, checkpoint: replacementCheckpoint });
    }
    if (type !== 'BATCH_TASK_TERMINAL') {
      return originalRuntimeRequest(type, payload);
    }
    return new Promise((resolve) => {
      releaseTerminal = async () => resolve(
        await originalRuntimeRequest(type, payload)
      );
    });
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const confirming = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(() => typeof releaseTerminal === 'function', 'terminal write');
  const replacing = runtime.start(replacementCheckpoint);
  await Promise.resolve();
  await releaseTerminal();
  await Promise.all([confirming, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.deepEqual(
    harness.sentHandles.map(({ batchId }) => batchId),
    ['batch-1', 'batch-2']
  );
});

test('a deferred completion cannot stop or clear its replacement lifecycle', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const replacement = structuredClone(harness.checkpoint);
  replacement.batchId = 'batch-2';
  let releaseCompletion;
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (payload.batchId === 'batch-1' && type === 'BATCH_SESSION_COMPLETE') {
      return new Promise((resolve) => {
        releaseCompletion = async () => resolve(
          await originalRequest(type, payload)
        );
      });
    }
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacement.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return { ok: true, checkpoint: replacement };
    }
    return originalRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const confirming = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(
    () => typeof releaseCompletion === 'function',
    'deferred old completion'
  );
  const replacing = runtime.start(replacement);
  await waitFor(
    () => harness.sentHandles.some(({ batchId }) => batchId === 'batch-2'),
    'replacement worker'
  );
  await releaseCompletion();
  await Promise.all([confirming, replacing]);

  assert.deepEqual(
    harness.sentHandles.map(({ batchId }) => batchId),
    ['batch-1', 'batch-2']
  );
  assert.equal(harness.tabsApi.removedListenerCount(), 1);
  assert.equal(
    harness.calls.some(
      ([name, type]) => name === 'runtime' &&
        ['BATCH_SESSION_STOP', 'BATCH_SESSION_CLEAR'].includes(type)
    ),
    false
  );
});

test('a stale BATCH_HANDLE rejection cannot finalize or close the replacement tab', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const replacementCheckpoint = structuredClone(harness.checkpoint);
  replacementCheckpoint.batchId = 'batch-2';
  let rejectOldHandle;
  harness.dependencies.sendHandle = (activity) => {
    harness.sentHandles.push(activity);
    if (activity.batchId === 'batch-1') {
      return new Promise((_resolve, reject) => {
        rejectOldHandle = reject;
      });
    }
    return Promise.resolve({ ok: true });
  };
  const originalRuntimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacementCheckpoint.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return Promise.resolve({ ok: true, checkpoint: replacementCheckpoint });
    }
    return originalRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const oldStart = runtime.start(harness.checkpoint);
  await waitFor(() => typeof rejectOldHandle === 'function', 'old handle');
  const replacing = runtime.start(replacementCheckpoint);
  await waitFor(
    () => harness.sentHandles.some(({ batchId }) => batchId === 'batch-2'),
    'replacement handle'
  );
  rejectOldHandle(new Error('old handle rejected'));
  await Promise.all([oldStart, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.terminalPayloads.length, 1);
  assert.deepEqual(
    harness.sentHandles.map(({ batchId }) => batchId),
    ['batch-1', 'batch-2']
  );
});

test('an unexpected worker-tab close terminalizes only that activity and refills', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 2 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  harness.tabsApi.emitRemoved(100);
  await waitFor(
    () => harness.sentHandles.some(({ urlIndex }) => urlIndex === 1),
    'replacement after unexpected close'
  );

  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'task_failed'
  );
  assert.match(
    harness.terminalPayloads[0].result.errorMessage,
    /用户关闭/
  );
  assert.deepEqual(harness.tabsApi.removeCalls, []);
});

test('adopts background terminal winners when three submitted tabs close together and refills', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 6 });
  const originalRuntimeRequest = harness.dependencies.runtimeRequest;
  let authoritativeCheckpoint = null;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (type === 'BATCH_TASK_TERMINAL' && payload.urlIndex < 3) {
      harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
      authoritativeCheckpoint = structuredClone(harness.checkpoint);
      authoritativeCheckpoint.updatedAt = 2000;
      for (const urlIndex of [0, 1, 2]) {
        Object.assign(authoritativeCheckpoint.tasks[String(urlIndex)], {
          state: 'terminal',
          phase: null,
          tabId: null,
          windowId: null,
          startedAt: null,
          updatedAt: 2000
        });
        authoritativeCheckpoint.results.push({
          originalIndex: urlIndex,
          attempt: 1,
          result: 'success',
          aiContent: `saved-${urlIndex}`,
          errorCode: null,
          errorMessage: null,
          timestamp: 2000
        });
      }
      return {
        ok: false,
        error: 'task_already_terminal',
        checkpoint: authoritativeCheckpoint
      };
    }
    if (!authoritativeCheckpoint) {
      return originalRuntimeRequest(type, payload);
    }
    harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
    if (type === 'BATCH_TASK_ACTIVE') {
      Object.assign(
        authoritativeCheckpoint.tasks[String(payload.urlIndex)],
        {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        }
      );
    }
    if (type === 'BATCH_SESSION_COMPLETE') {
      authoritativeCheckpoint.status = 'completed';
    }
    return { ok: true, checkpoint: authoritativeCheckpoint };
  };
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);
  for (const urlIndex of [0, 1, 2]) {
    Object.assign(harness.checkpoint.tasks[String(urlIndex)], {
      state: 'submitting',
      phase: 'confirming'
    });
  }

  for (const tabId of [100, 101, 102]) {
    harness.tabsApi.emitRemoved(tabId);
  }
  await waitFor(
    () => harness.sentHandles.length === 6,
    'three replacement workers after terminal race'
  );

  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [0, 1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    [0, 1, 2].map(
      (urlIndex) => authoritativeCheckpoint.tasks[String(urlIndex)].state
    ),
    ['terminal', 'terminal', 'terminal']
  );
  assert.equal(
    events.some(({ type }) => type === 'runtime-error'),
    false
  );
});

test('an unexpected close recovers submit context even when the page checkpoint phase is stale', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  harness.dependencies.sealSubmitContext = async (activity, reason) => {
    harness.calls.push(['seal', activity.urlIndex, activity.attempt, reason]);
    return { sealed: true, recovered: true };
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  harness.tabsApi.emitRemoved(100);
  await waitFor(
    () => harness.terminalPayloads.length === 1,
    'recovered unexpected close result'
  );

  assert.deepEqual(harness.calls.slice(0, 2), [
    ['seal', 0, 1, 'unexpected_close'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1]
  ]);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'submission_uncertain'
  );
});

test('ignores a late readiness failure from a worker that was already replaced', async () => {
  let rejectFirstPing;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    tabsOptions: {
      sendMessage(tabId, message) {
        if (message.type === 'PING' && tabId === 100) {
          return new Promise((_resolve, reject) => {
            rejectFirstPing = reject;
          });
        }
        return { ok: true };
      }
    }
  });
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));

  const starting = runtime.start(harness.checkpoint);
  await waitFor(
    () => typeof rejectFirstPing === 'function',
    'first worker readiness probe'
  );

  harness.tabsApi.emitRemoved(100);
  await waitFor(
    () => harness.tabsApi.createCalls.length === 2,
    'replacement worker'
  );
  rejectFirstPing(new Error('No tab with id: 100.'));
  await starting;
  await waitFor(
    () => harness.sentHandles.some(({ urlIndex }) => urlIndex === 1),
    'replacement handle'
  );

  assert.equal(
    events.some((event) => (
      event.type === 'runtime-error' &&
      event.error?.code === 'content_script_unavailable'
    )),
    false
  );
  assert.deepEqual(
    harness.terminalPayloads.map(({ urlIndex }) => urlIndex),
    [0]
  );
});

test('ignores a late readiness failure after the task deadline claimed finalization', async () => {
  let rejectFirstPing;
  let expire;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    tabsOptions: {
      sendMessage(tabId, message) {
        if (message.type === 'PING' && tabId === 100) {
          return new Promise((_resolve, reject) => {
            rejectFirstPing = reject;
          });
        }
        return { ok: true };
      }
    },
    taskDeadlineFactory({ onExpire }) {
      expire = onExpire;
      return {
        arm() {},
        clear() { return true; },
        clearAll() {}
      };
    }
  });
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));

  const starting = runtime.start(harness.checkpoint);
  await waitFor(
    () => typeof rejectFirstPing === 'function',
    'deadline worker readiness probe'
  );
  await expire({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  });
  rejectFirstPing(new Error('No tab with id: 100.'));
  await starting;
  await waitFor(
    () => harness.sentHandles.some(({ urlIndex }) => urlIndex === 1),
    'deadline replacement handle'
  );

  assert.equal(
    events.some((event) => (
      event.type === 'runtime-error' &&
      event.error?.code === 'content_script_unavailable'
    )),
    false
  );
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'task_timeout'
  );
});

test('last confirmation closes its tab before completion and emits final state', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });

  assert.deepEqual(harness.calls, [
    ['seal', 0, 1, 'confirmation'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1],
    ['close', 100],
    ['runtime', 'BATCH_SESSION_COMPLETE', undefined, undefined]
  ]);
  assert.equal(events.some(({ type }) => type === 'confirmed'), true);
  assert.equal(events.at(-1).type, 'changed');
});

test('a deferred stop cleans only its old tab after a replacement lifecycle starts', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const replacementCheckpoint = structuredClone(harness.checkpoint);
  replacementCheckpoint.batchId = 'batch-2';
  let releaseSeal;
  harness.dependencies.sealSubmitContext = () => new Promise((resolve) => {
    releaseSeal = () => resolve({ sealed: true, recovered: false });
  });
  const originalRuntimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacementCheckpoint.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return Promise.resolve({ ok: true, checkpoint: replacementCheckpoint });
    }
    return originalRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const stopping = runtime.stop();
  await waitFor(() => typeof releaseSeal === 'function', 'stop seal');
  const replacing = runtime.start(replacementCheckpoint);
  await Promise.resolve();
  releaseSeal();
  await Promise.all([stopping, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.terminalPayloads.length, 1);
});

test('a deferred timeout scan cleans only its old tab after lifecycle replacement', async () => {
  let now = 1000;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    timeoutSeconds: 1,
    clock: () => now
  });
  const replacementCheckpoint = structuredClone(harness.checkpoint);
  replacementCheckpoint.batchId = 'batch-2';
  let releaseSeal;
  harness.dependencies.sealSubmitContext = () => new Promise((resolve) => {
    releaseSeal = () => resolve({ sealed: true, recovered: false });
  });
  const originalRuntimeRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = (type, payload) => {
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacementCheckpoint.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return Promise.resolve({ ok: true, checkpoint: replacementCheckpoint });
    }
    return originalRuntimeRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  Object.assign(harness.checkpoint.tasks['0'], {
    state: 'submitting',
    phase: 'confirming'
  });
  now = 2100;

  const scanning = harness.intervalCallbacks[0]();
  await waitFor(() => typeof releaseSeal === 'function', 'timeout seal');
  const replacing = runtime.start(replacementCheckpoint);
  await Promise.resolve();
  releaseSeal();
  await Promise.all([scanning, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.terminalPayloads.length, 1);
});

test('rejects a success confirmation that is not durably recorded', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;

  const accepted = await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'failed'
  });

  assert.equal(accepted, false);
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.terminalPayloads.length, 0);
});

test('confirmation and pause share one attempt-aware finalizer claim', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  let releaseFirstSeal;
  let sealCount = 0;
  harness.dependencies.sealSubmitContext = async () => {
    sealCount += 1;
    if (sealCount === 1) {
      await new Promise((resolve) => {
        releaseFirstSeal = resolve;
      });
    }
    return { sealed: true, recovered: false };
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const confirming = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(() => typeof releaseFirstSeal === 'function', 'claimed finalizer');
  const pausing = runtime.pause('user');
  releaseFirstSeal();
  await Promise.all([confirming, pausing]);

  assert.equal(sealCount, 1);
  assert.equal(harness.terminalPayloads.length, 1);
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
});

test('a queued retry cannot be completed or settled by its old attempt finalizer', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  let requestImpl = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = (...args) => requestImpl(...args);
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const retryCheckpoint = structuredClone(harness.checkpoint);
  Object.assign(retryCheckpoint.tasks['0'], {
    attempt: 2,
    state: 'queued',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null
  });
  retryCheckpoint.results = [];
  let releaseAttemptOne;
  requestImpl = async (type, payload) => {
    harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
    if (type === 'BATCH_TASK_TERMINAL' && payload.attempt === 1) {
      return new Promise((resolve) => {
        releaseAttemptOne = () => {
          const oldCheckpoint = structuredClone(harness.checkpoint);
          Object.assign(oldCheckpoint.tasks['0'], {
            state: 'terminal',
            phase: null,
            tabId: null,
            windowId: null,
            startedAt: null
          });
          oldCheckpoint.results = [{
            originalIndex: 0,
            attempt: 1,
            ...payload.result
          }];
          resolve({ ok: true, checkpoint: oldCheckpoint });
        };
      });
    }
    if (type === 'BATCH_TASK_ACTIVE' && payload.attempt === 2) {
      Object.assign(retryCheckpoint.tasks['0'], {
        state: 'active',
        tabId: payload.tabId,
        windowId: payload.windowId,
        startedAt: payload.startedAt
      });
      return { ok: true, checkpoint: retryCheckpoint };
    }
    if (type === 'BATCH_SESSION_COMPLETE') {
      throw new Error('old attempt incorrectly completed the retried batch');
    }
    return { ok: true, checkpoint: retryCheckpoint };
  };

  const confirming = runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await waitFor(() => typeof releaseAttemptOne === 'function', 'attempt one terminal');
  const refilling = runtime.refill(retryCheckpoint);
  releaseAttemptOne();
  await Promise.all([confirming, refilling]);

  assert.deepEqual(
    harness.sentHandles.map(({ attempt }) => attempt),
    [1, 2]
  );
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(retryCheckpoint.tasks['0'].state, 'active');
});

test('unexpected close during submission becomes manual-required', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  Object.assign(harness.checkpoint.tasks['0'], {
    state: 'submitting',
    phase: 'confirming'
  });

  harness.tabsApi.emitRemoved(100);
  await waitFor(() => harness.terminalPayloads.length === 1, 'unexpected close result');

  assert.equal(harness.terminalPayloads[0].result.result, 'manual_required');
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'submission_uncertain'
  );
});

test('readiness deadline terminates even when tabs.get never settles', async () => {
  const tabsApi = createFakeTabsApi({
    get() {
      return new Promise(() => {});
    }
  });
  const activity = {
    tabId: 100,
    startTime: Date.now()
  };

  const outcome = await Promise.race([
    waitForContentScriptReady(activity, {
      tabsApi,
      timeoutMs: 15,
      pollIntervalMs: 5
    }).then(
      () => 'resolved',
      (error) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 200))
  ]);

  assert.notEqual(outcome, 'hung');
  assert.equal(outcome.code, 'content_script_unavailable');
  assert.equal(outcome.reason, 'timeout');
});

test('readiness deadline terminates even when PING delivery never settles', async () => {
  const tabsApi = createFakeTabsApi({
    sendMessage() {
      return new Promise(() => {});
    }
  });
  const tab = await tabsApi.create({
    windowId: 42,
    url: 'https://target.test/final?view=full',
    active: false
  });

  const outcome = await Promise.race([
    waitForContentScriptReady(
      { tabId: tab.id, startTime: Date.now() },
      { tabsApi, timeoutMs: 15, pollIntervalMs: 5 }
    ).then(
      () => 'resolved',
      (error) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 200))
  ]);

  assert.notEqual(outcome, 'hung');
  assert.equal(outcome.code, 'content_script_unavailable');
  assert.equal(outcome.reason, 'timeout');
  assert.match(outcome.message, /view=full/);
});

test('readiness reports content runtime initialization failure after bootstrap responds', async () => {
  const tabsApi = createFakeTabsApi({
    sendMessage() {
      return {
        ok: false,
        bootstrapReady: true,
        runtimeReady: false,
        error: 'content_runtime_initializing'
      };
    }
  });
  const tab = await tabsApi.create({
    windowId: 42,
    url: 'https://target.test/runtime-failed',
    active: false
  });

  const outcome = await waitForContentScriptReady(
    { tabId: tab.id, startTime: Date.now() },
    { tabsApi, timeoutMs: 15, pollIntervalMs: 5 }
  ).then(
    () => 'resolved',
    (error) => error
  );

  assert.equal(outcome.code, 'content_script_unavailable');
  assert.equal(outcome.reason, 'runtime_initialization_failed');
  assert.match(outcome.message, /content_runtime_initializing/);
});

test('deadline claim cannot be flipped by a late successful PING', async () => {
  let resolvePing;
  let resolveDeadlineSnapshot;
  let getCount = 0;
  const tabsApi = createFakeTabsApi({
    get() {
      getCount += 1;
      if (getCount === 1) {
        return {
          id: 100,
          windowId: 42,
          url: 'https://target.test/initial',
          status: 'complete',
          discarded: false
        };
      }
      return new Promise((resolve) => {
        resolveDeadlineSnapshot = resolve;
      });
    },
    sendMessage() {
      return new Promise((resolve) => {
        resolvePing = resolve;
      });
    }
  });

  const readiness = waitForContentScriptReady(
    { tabId: 100, startTime: Date.now() },
    { tabsApi, timeoutMs: 10, pollIntervalMs: 5 }
  ).then(
    (value) => ({ kind: 'ready', value }),
    (error) => ({ kind: 'failed', error })
  );
  await waitFor(() => typeof resolvePing === 'function', 'pending PING');
  await new Promise((resolve) => setTimeout(resolve, 15));
  await waitFor(
    () => typeof resolveDeadlineSnapshot === 'function',
    'deadline snapshot'
  );
  resolvePing({ ok: true });
  await Promise.resolve();
  resolveDeadlineSnapshot({
    id: 100,
    windowId: 42,
    url: 'https://target.test/final?view=full',
    status: 'complete',
    discarded: false
  });
  const outcome = await readiness;

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.error.reason, 'timeout');
  assert.match(outcome.error.message, /final\?view=full/);
});

test('BATCH_HANDLE has its own deadline and ignores late delivery completion', async () => {
  let resolveHandle;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    handleDeliveryTimeoutMs: 15
  });
  harness.dependencies.sendHandle = (activity) => {
    harness.sentHandles.push(activity);
    harness.calls.push(['handle', activity.urlIndex, activity.attempt]);
    return new Promise((resolve) => {
      resolveHandle = resolve;
    });
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const starting = runtime.start(harness.checkpoint);
  await waitFor(() => typeof resolveHandle === 'function', 'pending handle');
  const outcome = await Promise.race([
    starting.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 200))
  ]);

  assert.equal(outcome, 'finished');
  assert.equal(harness.terminalPayloads.length, 1);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'content_script_unavailable'
  );
  assert.match(
    harness.terminalPayloads[0].result.errorMessage,
    /reason=handle_delivery_timeout/
  );
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);

  const callsAfterTimeout = structuredClone(harness.calls);
  resolveHandle({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls, callsAfterTimeout);
  assert.equal(harness.terminalPayloads.length, 1);
});

test('sanitizes BATCH_HANDLE URLs and diagnostic Chrome errors', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const secret = 'super-secret-token';
  const safeUrl = `https://target.test/0?view=full&token=${secret}`;
  harness.checkpoint.source.parsedUrls[0].url = safeUrl;
  harness.checkpoint.source.parsedUrls[0].originalRow = [safeUrl];
  harness.checkpoint.source.rows[0] = [safeUrl];
  delete harness.dependencies.sendHandle;
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  const serializedHandle = JSON.stringify(
    harness.tabsApi.sendMessageCalls.find(([, message]) => (
      message.type === 'BATCH_HANDLE'
    ))
  );
  assert.doesNotMatch(serializedHandle, new RegExp(secret));
  assert.match(serializedHandle, /view=full/);
  assert.match(serializedHandle, /token=REDACTED/);

  const diagnosticTabs = createFakeTabsApi({
    createdTab: {
      url: `https://user:password@target.test/final?view=full&api_key=${secret}`,
      status: 'complete'
    },
    async sendMessage() {
      throw new Error(
        `navigation failed at https://user:password@target.test/final?view=full&token=${secret}`
      );
    }
  });
  const tab = await diagnosticTabs.create({
    windowId: 42,
    url: 'https://target.test',
    active: false
  });
  const error = await waitForContentScriptReady(
    { tabId: tab.id, startTime: Date.now() },
    { tabsApi: diagnosticTabs, timeoutMs: 20, pollIntervalMs: 5 }
  ).catch((caught) => caught);
  const serializedError = JSON.stringify(error.diagnostic) + error.message;
  assert.doesNotMatch(serializedError, new RegExp(secret));
  assert.doesNotMatch(serializedError, /user:password/);
  assert.match(serializedError, /view=full/);
});

test('BATCH_HANDLE carries only the frozen non-sensitive task assignment', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  harness.checkpoint.settings.autoGenerate = true;
  harness.checkpoint.settings.autoSubmit = false;
  Object.assign(harness.checkpoint, {
    version: 3,
    configRevision: 7,
    profiles: {
      'profile-a': {
        id: 'profile-a',
        displayName: '作者 A',
        name: 'Alice',
        email: 'alice@example.test'
      }
    },
    promotionSites: {
      'site-a': {
        id: 'site-a',
        name: '站点 A',
        url: 'https://promo-a.test/',
        content: 'Promotion A'
      }
    }
  });
  Object.assign(harness.checkpoint.tasks['0'], {
    taskId: 'batch-1:1',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted'
  });
  delete harness.dependencies.sendHandle;
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  await runtime.start(harness.checkpoint);

  const [, message] = harness.tabsApi.sendMessageCalls.find(
    ([, candidate]) => candidate.type === 'BATCH_HANDLE'
  );
  assert.deepEqual(message, {
    type: 'BATCH_HANDLE',
    batchId: 'batch-1',
    taskId: 'batch-1:1',
    urlIndex: 0,
    attempt: 1,
    url: 'https://target.test/0',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted',
    configRevision: 7,
    automation: {
      autoGenerate: true,
      autoSubmit: false
    },
    profile: harness.checkpoint.profiles['profile-a'],
    promotionSite: harness.checkpoint.promotionSites['site-a']
  });
  assert.doesNotMatch(JSON.stringify(message), /password|secret/i);
});

test('ACTIVE persistence failure emits runtime-error, closes the tab, and pauses recovery', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const events = [];
  harness.dependencies.runtimeRequest = async (type) => (
    type === 'BATCH_TASK_ACTIVE'
      ? { ok: false, error: 'active write failed token=secret' }
      : { ok: true, checkpoint: harness.checkpoint }
  );
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));

  await assert.doesNotReject(runtime.start(harness.checkpoint));

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.sentHandles.length, 0);
  assert.equal(events.some(({ type }) => type === 'runtime-error'), true);
  assert.doesNotMatch(
    JSON.stringify(events.map(({ error }) => error?.message)),
    /token=secret/
  );
});

test('terminal persistence failure retains the exact tab in paused recovery', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => (
    type === 'BATCH_TASK_TERMINAL'
      ? { ok: false, error: 'terminal write failed authorization=private' }
      : originalRequest(type, payload)
  );
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);

  const accepted = await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });

  assert.equal(accepted, false);
  assert.deepEqual(harness.tabsApi.removeCalls, []);
  assert.equal(events.some(({ type }) => type === 'runtime-error'), true);
  assert.doesNotMatch(
    JSON.stringify(events.map(({ error }) => error?.message)),
    /private/
  );
});

test('seal failure pauses without persisting or closing uncertain work', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  harness.dependencies.sealSubmitContext = async () => {
    throw new Error('seal adapter failed');
  };
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);

  const accepted = await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });

  assert.equal(accepted, false);
  assert.equal(harness.terminalPayloads.length, 0);
  assert.deepEqual(harness.tabsApi.removeCalls, []);
  assert.equal(events.some(({ type }) => type === 'runtime-error'), true);
});

test('close failure retains ownership and dispose can retry cleanup', async () => {
  let removeAttempt = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      async remove() {
        removeAttempt += 1;
        if (removeAttempt === 1) throw new Error('temporary close failure');
      }
    }
  });
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);

  const accepted = await runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });

  assert.equal(accepted, false);
  assert.equal(harness.tabsApi.createCalls.length, 1);
  assert.equal(events.some(({ type }) => type === 'runtime-error'), true);
  await runtime.dispose();
  assert.deepEqual(harness.tabsApi.removeCalls, [100, 100]);
  assert.equal(harness.tabsApi.removedListenerCount(), 0);
});

test('completion adapter failure is recoverable and does not reopen work', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => (
    type === 'BATCH_SESSION_COMPLETE'
      ? { ok: false, error: 'completion persistence failed' }
      : originalRequest(type, payload)
  );
  const events = [];
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  runtime.subscribe((event) => events.push(event));
  await runtime.start(harness.checkpoint);

  await assert.doesNotReject(runtime.handleConfirmation({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  }));

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.tabsApi.createCalls.length, 1);
  assert.equal(events.some(({ type }) => type === 'runtime-error'), true);
});

test('replacement waits for a pending create to terminalize and close', async () => {
  let resolveOldCreate;
  let createCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      create(details) {
        createCount += 1;
        if (createCount === 1) {
          return new Promise((resolve) => {
            resolveOldCreate = resolve;
          });
        }
        return {
          id: 101,
          windowId: details.windowId,
          url: details.url,
          status: 'complete',
          discarded: false
        };
      }
    }
  });
  const replacement = structuredClone(harness.checkpoint);
  replacement.batchId = 'batch-2';
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacement.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return { ok: true, checkpoint: replacement };
    }
    return originalRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const oldStart = runtime.start(harness.checkpoint);
  await waitFor(() => createCount === 1, 'old pending create');
  const replacing = runtime.start(replacement);
  await Promise.resolve();
  assert.equal(createCount, 1);
  resolveOldCreate({
    id: 100,
    windowId: 42,
    url: 'https://target.test/0',
    status: 'complete',
    discarded: false
  });
  await Promise.all([oldStart, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(createCount, 2);
});

test('a cancelled late create waits for its own terminal persistence before close', async () => {
  let resolveOldCreate;
  let createCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      create(details) {
        createCount += 1;
        if (createCount === 1) {
          return new Promise((resolve) => {
            resolveOldCreate = resolve;
          });
        }
        return {
          id: 101,
          windowId: details.windowId,
          url: details.url,
          status: 'complete',
          discarded: false
        };
      }
    }
  });
  const replacement = structuredClone(harness.checkpoint);
  replacement.batchId = 'batch-2';
  const originalRequest = harness.dependencies.runtimeRequest;
  let releaseTerminal;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (payload.batchId === 'batch-1' && type === 'BATCH_TASK_TERMINAL') {
      return new Promise((resolve) => {
        releaseTerminal = async () => resolve(
          await originalRequest(type, payload)
        );
      });
    }
    if (payload.batchId === 'batch-2') {
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(replacement.tasks['0'], {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      return { ok: true, checkpoint: replacement };
    }
    return originalRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const oldStart = runtime.start(harness.checkpoint);
  await waitFor(() => createCount === 1, 'old pending create');
  const replacing = runtime.start(replacement);
  await waitFor(() => typeof releaseTerminal === 'function', 'deferred terminal');
  resolveOldCreate({
    id: 100,
    windowId: 42,
    url: 'https://target.test/0',
    status: 'complete',
    discarded: false
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.tabsApi.removeCalls,
    [],
    'terminal persistence owns the late-created tab until it settles'
  );
  await releaseTerminal();
  await Promise.all([oldStart, replacing]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(createCount, 2);
});

test('failed pending-create terminal persistence blocks replacement and close', async () => {
  let resolveOldCreate;
  let createCount = 0;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 1,
    tabsOptions: {
      create(details) {
        createCount += 1;
        if (createCount === 1) {
          return new Promise((resolve) => {
            resolveOldCreate = resolve;
          });
        }
        return {
          id: 101,
          windowId: details.windowId,
          url: details.url,
          status: 'complete',
          discarded: false
        };
      }
    }
  });
  const replacement = structuredClone(harness.checkpoint);
  replacement.batchId = 'batch-2';
  const originalRequest = harness.dependencies.runtimeRequest;
  harness.dependencies.runtimeRequest = async (type, payload) => {
    if (payload.batchId === 'batch-1' && type === 'BATCH_TASK_TERMINAL') {
      return { ok: false, error: 'terminal persistence unavailable' };
    }
    if (payload.batchId === 'batch-2') {
      return { ok: true, checkpoint: replacement };
    }
    return originalRequest(type, payload);
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);

  const oldStart = runtime.start(harness.checkpoint);
  await waitFor(() => createCount === 1, 'old pending create');
  const replacing = runtime.start(replacement);
  resolveOldCreate({
    id: 100,
    windowId: 42,
    url: 'https://target.test/0',
    status: 'complete',
    discarded: false
  });
  await Promise.all([oldStart, replacing]);

  assert.equal(createCount, 1);
  assert.deepEqual(harness.tabsApi.removeCalls, []);
  assert.equal(harness.tabsApi.removedListenerCount(), 1);
});

test('concurrent starts dispose every intermediate manager before the last owner wins', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  const batch2 = structuredClone(harness.checkpoint);
  batch2.batchId = 'batch-2';
  const batch3 = structuredClone(harness.checkpoint);
  batch3.batchId = 'batch-3';
  const checkpoints = new Map([
    ['batch-1', harness.checkpoint],
    ['batch-2', batch2],
    ['batch-3', batch3]
  ]);
  harness.dependencies.runtimeRequest = async (type, payload) => {
    const checkpoint = checkpoints.get(payload.batchId);
    const task = checkpoint?.tasks[String(payload.urlIndex)];
    harness.calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
    if (type === 'BATCH_TASK_ACTIVE') {
      Object.assign(task, {
        state: 'active',
        tabId: payload.tabId,
        windowId: payload.windowId,
        startedAt: payload.startedAt
      });
    }
    if (type === 'BATCH_TASK_TERMINAL') {
      Object.assign(task, {
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null
      });
      checkpoint.results.push({
        originalIndex: payload.urlIndex,
        attempt: payload.attempt,
        ...payload.result
      });
    }
    if (type === 'BATCH_SESSION_COMPLETE') checkpoint.status = 'completed';
    return { ok: true, checkpoint };
  };
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  await Promise.all([
    runtime.start(batch2),
    runtime.start(batch3)
  ]);

  assert.deepEqual(harness.tabsApi.removeCalls, [100, 101]);
  assert.equal(harness.tabsApi.removedListenerCount(), 1);
  assert.deepEqual(
    harness.sentHandles.map(({ batchId }) => batchId),
    ['batch-1', 'batch-3']
  );
});

test('stop waits for an in-progress pause cleanup before disposing ownership', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  let releaseSeal;
  harness.dependencies.sealSubmitContext = () => new Promise((resolve) => {
    releaseSeal = () => resolve({ sealed: true, recovered: false });
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  const pausing = runtime.pause('user');
  await waitFor(() => typeof releaseSeal === 'function', 'pause seal');
  let stopResolved = false;
  const stopping = runtime.stop().then((checkpoint) => {
    stopResolved = true;
    return checkpoint;
  });
  await Promise.resolve();

  assert.equal(stopResolved, false);
  assert.equal(harness.terminalPayloads.length, 0);
  releaseSeal();
  await Promise.all([pausing, stopping]);

  assert.equal(harness.terminalPayloads.length, 1);
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.equal(harness.tabsApi.removedListenerCount(), 0);
});

test('pause waits for an already-claimed removed-tab finalizer', async () => {
  const harness = createWorkerHarness({ concurrency: 1, taskCount: 1 });
  let releaseSeal;
  harness.dependencies.sealSubmitContext = () => new Promise((resolve) => {
    releaseSeal = () => resolve({ sealed: true, recovered: false });
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);

  harness.tabsApi.emitRemoved(100);
  await waitFor(
    () => typeof releaseSeal === 'function',
    'removed-tab submit-context seal'
  );
  let pauseResolved = false;
  const pausing = runtime.pause('user').then((checkpoint) => {
    pauseResolved = true;
    return checkpoint;
  });
  await Promise.resolve();

  assert.equal(pauseResolved, false);
  releaseSeal();
  const checkpoint = await pausing;

  assert.notEqual(checkpoint, false);
  assert.equal(checkpoint.tasks['0'].state, 'terminal');
  assert.equal(harness.terminalPayloads.length, 1);
});

function createWorkerHarness({
  concurrency,
  taskCount,
  clock = () => 1000,
  readinessTimeoutMs,
  handleDeliveryTimeoutMs,
  sealTimeoutMs,
  timeoutSeconds = 60,
  taskDeadlineFactory,
  tabsOptions = {}
}) {
  const tabsApi = createFakeTabsApi(tabsOptions);
  const sentHandles = [];
  const calls = [];
  const terminalPayloads = [];
  const intervalCallbacks = [];
  const clearedIntervals = [];
  tabsApi.calls = calls;
  const parsedUrls = Array.from({ length: taskCount }, (_, urlIndex) => ({
    originalIndex: urlIndex,
    url: `https://target.test/${urlIndex}`,
    sourceDomain: 'target.test',
    originalRow: [`https://target.test/${urlIndex}`]
  }));
  const tasks = Object.fromEntries(parsedUrls.map((item) => [
    String(item.originalIndex),
    {
      urlIndex: item.originalIndex,
      attempt: 1,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 1000,
      manualResolution: { status: 'idle', updatedAt: null }
    }
  ]));
  const checkpoint = {
    version: 2,
    batchId: 'batch-1',
    status: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: { concurrency, timeoutSeconds },
    cursor: { nextIndex: 0 },
    tasks,
    results: []
  };
  const dependencies = {
    tabsApi,
    windowId: 42,
    runtimeRequest: async (type, payload) => {
      calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
      const task = checkpoint.tasks[String(payload.urlIndex)];
      if (type === 'BATCH_TASK_ACTIVE') {
        Object.assign(task, {
          state: 'active',
          tabId: payload.tabId,
          windowId: payload.windowId,
          startedAt: payload.startedAt
        });
      }
      if (type === 'BATCH_TASK_TERMINAL') {
        terminalPayloads.push(structuredClone(payload));
        Object.assign(task, {
          state: 'terminal',
          phase: null,
          tabId: null,
          windowId: null,
          startedAt: null
        });
        checkpoint.results.push({
          originalIndex: payload.urlIndex,
          attempt: payload.attempt,
          ...payload.result
        });
      }
      if (type === 'BATCH_SESSION_COMPLETE') {
        checkpoint.status = 'completed';
      }
      return { ok: true, checkpoint };
    },
    sendHandle: async (activity) => {
      sentHandles.push(activity);
      calls.push(['handle', activity.urlIndex, activity.attempt]);
      return { ok: true };
    },
    sealSubmitContext: async (activity, reason) => {
      calls.push(['seal', activity.urlIndex, activity.attempt, reason]);
      return { sealed: true, recovered: false };
    },
    clock,
    ...(taskDeadlineFactory ? { taskDeadlineFactory } : {}),
    ...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs }),
    ...(handleDeliveryTimeoutMs === undefined
      ? {}
      : { handleDeliveryTimeoutMs }),
    ...(sealTimeoutMs === undefined ? {} : { sealTimeoutMs }),
    timers: {
      setTimeout,
      clearTimeout,
      setInterval(callback) {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      },
      clearInterval(id) {
        clearedIntervals.push(id);
      }
    }
  };
  return {
    checkpoint,
    calls,
    clearedIntervals,
    dependencies,
    sentHandles,
    terminalPayloads,
    intervalCallbacks,
    tabsApi
  };
}

function createFakeTabsApi(options = {}) {
  const removedListeners = new Set();
  const updatedListeners = new Set();
  const createCalls = [];
  const removeCalls = [];
  const sendMessageCalls = [];
  const updateCalls = [];
  const tabs = new Map();
  let nextTabId = 100;
  const api = {
    createCalls,
    removeCalls,
    sendMessageCalls,
    updateCalls,
    onRemoved: {
      addListener(listener) { removedListeners.add(listener); },
      removeListener(listener) { removedListeners.delete(listener); }
    },
    onUpdated: {
      addListener(listener) { updatedListeners.add(listener); },
      removeListener(listener) { updatedListeners.delete(listener); }
    },
    async create(details) {
      createCalls.push(details);
      if (options.create) {
        const created = await options.create(details);
        if (created?.id) tabs.set(created.id, { ...created });
        return created;
      }
      const tab = {
        id: nextTabId++,
        windowId: details.windowId,
        url: details.url,
        pendingUrl: null,
        status: 'complete',
        discarded: false,
        ...(options.createdTab || {})
      };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    async get(tabId) {
      if (options.get) return options.get(tabId);
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      return { ...tab };
    },
    async sendMessage(tabId, message) {
      sendMessageCalls.push([tabId, structuredClone(message)]);
      if (options.sendMessage) {
        return options.sendMessage(tabId, message);
      }
      return { ok: true };
    },
    async remove(tabId) {
      removeCalls.push(tabId);
      this.calls?.push(['close', tabId]);
      if (options.remove) await options.remove(tabId);
      tabs.delete(tabId);
      for (const listener of [...removedListeners]) {
        listener(tabId, { windowId: 42, isWindowClosing: false });
      }
    },
    async update(tabId, changes) {
      updateCalls.push([tabId, structuredClone(changes)]);
      const tab = tabs.get(tabId);
      Object.assign(tab, changes);
      return { ...tab };
    }
  };
  api.removedListenerCount = () => removedListeners.size;
  api.emitRemoved = (tabId) => {
    tabs.delete(tabId);
    for (const listener of [...removedListeners]) {
      listener(tabId, { windowId: 42, isWindowClosing: false });
    }
  };
  api.emitUpdated = (tabId, changeInfo) => {
    const tab = tabs.get(tabId);
    if (tab) Object.assign(tab, changeInfo);
    for (const listener of [...updatedListeners]) {
      listener(tabId, { ...changeInfo }, tab ? { ...tab } : undefined);
    }
  };
  return api;
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}
