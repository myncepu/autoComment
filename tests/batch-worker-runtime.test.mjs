import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchWorkerRuntime,
  waitForContentScriptReady
} from '../lib/batch-worker-runtime.mjs';

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

test('timeout seals and closes the expired tab before replenishing capacity', async () => {
  let now = 1000;
  const harness = createWorkerHarness({
    concurrency: 1,
    taskCount: 2,
    timeoutSeconds: 1,
    clock: () => now
  });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  harness.calls.length = 0;
  now = 2100;

  await harness.intervalCallbacks[0]();

  assert.deepEqual(harness.calls, [
    ['seal', 0, 1, 'timeout'],
    ['runtime', 'BATCH_TASK_TERMINAL', 0, 1],
    ['close', 100],
    ['runtime', 'BATCH_TASK_ACTIVE', 1, 1],
    ['handle', 1, 1]
  ]);
  assert.equal(
    harness.terminalPayloads[0].result.errorCode,
    'task_timeout'
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

test('an opening timeout replenishes capacity and a late tab is only cleaned up', async () => {
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
  assert.equal(harness.sentHandles.length, 0);
  assert.equal(createCount, 1, 'the timed-out pending create still owns the slot');
  resolveFirstCreate({
    id: 100,
    windowId: 42,
    url: 'https://target.test/0',
    status: 'complete',
    discarded: false
  });
  await starting;
  await waitFor(() => harness.sentHandles.length === 1, 'replacement handle');

  assert.deepEqual(
    harness.sentHandles.map(({ urlIndex }) => urlIndex),
    [1]
  );
  assert.deepEqual(harness.tabsApi.removeCalls, [100]);
  assert.deepEqual(
    harness.terminalPayloads.map(({ urlIndex }) => urlIndex),
    [0]
  );
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

function createWorkerHarness({
  concurrency,
  taskCount,
  clock = () => 1000,
  readinessTimeoutMs,
  timeoutSeconds = 60,
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
    ...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs }),
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
