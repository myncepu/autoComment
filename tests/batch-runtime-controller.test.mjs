import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchRuntimeController,
  installBatchRuntimeController
} from '../lib/batch-runtime-controller.mjs';
import {
  createChromeBatchDependencies
} from '../lib/batch-chrome-adapter.mjs';

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

function createHarness({ failPower = false, existingTabs = [] } = {}) {
  const data = {};
  const setCalls = [];
  const powerCalls = [];
  const removedTabs = [];
  const removedWindows = [];
  const createdTabs = [];
  const broadcasts = [];
  const operationLog = [];
  const listeners = {
    messages: [],
    startup: []
  };
  let clock = 1000;
  const storageArea = {
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, structuredClone(data[key])])
      );
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      if (storageArea.setFailure) throw storageArea.setFailure;
      setCalls.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
      operationLog.push([
        'persist',
        values.batchRuntimeCheckpoint?.status,
        structuredClone(
          values.batchRuntimeCheckpoint?.recoveryCleanup?.orphanTabIds || []
        )
      ]);
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      requested.forEach((key) => delete data[key]);
    }
  };
  const power = {
    requestKeepAwake(level) {
      powerCalls.push(['request', level]);
      if (failPower) throw new Error('power unavailable');
    },
    releaseKeepAwake() {
      powerCalls.push(['release']);
      operationLog.push(['power-release']);
    }
  };
  const tabs = {
    async query() {
      return structuredClone(existingTabs);
    },
    async create(details) {
      createdTabs.push(structuredClone(details));
      return { id: 91, ...details };
    },
    async remove(tabIds) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      removedTabs.push(...ids);
      operationLog.push(['tabs-remove', ...ids]);
      if (tabs.removeFailure) throw tabs.removeFailure;
    }
  };
  const windows = {
    async remove(windowId) {
      removedWindows.push(windowId);
    }
  };
  const runtime = {
    id: 'extension-id',
    getURL(path) {
      return `chrome-extension://extension-id/${path}`;
    },
    async sendMessage(message) {
      broadcasts.push(structuredClone(message));
    },
    onMessage: {
      addListener(listener) {
        listeners.messages.push(listener);
      },
      removeListener(listener) {
        const index = listeners.messages.indexOf(listener);
        if (index >= 0) listeners.messages.splice(index, 1);
      }
    },
    onStartup: {
      addListener(listener) {
        listeners.startup.push(listener);
      }
    }
  };
  const controller = createBatchRuntimeController({
    storageArea,
    power,
    tabs,
    windows,
    runtime,
    now: () => {
      clock += 100;
      return clock;
    }
  });
  return {
    controller,
    chrome: { storage: { local: storageArea }, power, tabs, windows, runtime },
    data,
    setCalls,
    powerCalls,
    removedTabs,
    removedWindows,
    createdTabs,
    listeners,
    operationLog,
    broadcasts
  };
}

function startMessage(count = 2) {
  const items = createItems(count);
  return {
    type: 'BATCH_SESSION_START',
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
      concurrency: 2
    }
  };
}

function createVersion1ControllerFixture() {
  const items = createItems(1);
  return {
    version: 1,
    batchId: 'batch-1',
    status: 'paused_recovery',
    createdAt: 1000,
    updatedAt: 1000,
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
    },
    cursor: { nextIndex: 0 },
    tasks: {
      0: {
        urlIndex: 0,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1000
      }
    },
    results: []
  };
}

test('migrates version 1 exactly once before returning it to the page', async () => {
  const harness = createHarness();
  harness.data.batchRuntimeCheckpoint = createVersion1ControllerFixture();

  const first = await harness.controller.handleMessage({
    type: 'BATCH_SESSION_GET'
  });
  const second = await harness.controller.handleMessage({
    type: 'BATCH_SESSION_GET'
  });

  assert.equal(first.checkpoint.version, 2);
  assert.equal(second.checkpoint.version, 2);
  assert.equal(
    harness.setCalls.filter(
      (call) => call.batchRuntimeCheckpoint?.version === 2
    ).length,
    1
  );
});

test('returns the checkpoint updated by a task phase command', async () => {
  const { controller } = createHarness();
  await controller.handleMessage(startMessage(1));
  await controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });

  const response = await controller.handleMessage(
    {
      type: 'BATCH_TASK_PHASE',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      phase: 'generating'
    },
    { id: 'extension-id', tab: { id: 11 } }
  );

  assert.equal(response.ok, true);
  assert.equal(response.checkpoint.tasks['0'].phase, 'generating');
});

test('content task phase persists before a background-owned page broadcast', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  harness.operationLog.length = 0;

  const response = await new Promise((resolve) => {
    harness.listeners.messages[0](
      {
        type: 'BATCH_TASK_PHASE',
        batchId: 'batch-1',
        urlIndex: 0,
        attempt: 1,
        phase: 'generating'
      },
      {
        id: 'extension-id',
        tab: { id: 11 },
        url: 'https://target.test/post'
      },
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.equal(
    harness.data.batchRuntimeCheckpoint.tasks['0'].phase,
    'generating'
  );
  assert.deepEqual(harness.broadcasts, [{
    type: 'BATCH_TASK_PHASE_UPDATED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    phase: 'generating',
    sourceTabId: 11
  }]);
});

test('task phase rejects page senders and mismatched content tabs', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  const phaseMessage = {
    type: 'BATCH_TASK_PHASE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    phase: 'generating'
  };

  const pageResponse = await new Promise((resolve) => {
    harness.listeners.messages[0](
      phaseMessage,
      {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/batch.html'
      },
      resolve
    );
  });
  const wrongTabResponse = await new Promise((resolve) => {
    harness.listeners.messages[0](
      phaseMessage,
      {
        id: 'extension-id',
        tab: { id: 12 },
        url: 'https://target.test/forged'
      },
      resolve
    );
  });

  assert.equal(pageResponse.error, 'forbidden_sender');
  assert.equal(wrongTabResponse.error, 'stale_worker_tab');
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].phase, null);
  assert.deepEqual(harness.broadcasts, []);
});

test('content phase flows through background persistence into the trusted page adapter', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  const event = {
    addListener() {},
    removeListener() {}
  };
  const adapterChrome = {
    ...harness.chrome,
    storage: {
      local: harness.chrome.storage.local,
      sync: { async get() { return {}; } }
    },
    tabs: {
      ...harness.chrome.tabs,
      onRemoved: event,
      onUpdated: event,
      async getCurrent() { return { id: 90, windowId: 21 }; },
      async get() {},
      async sendMessage() {},
      async update() {}
    },
    windows: {
      async create() { return { id: 30, tabs: [{ id: 31 }] }; },
      async remove() {}
    }
  };
  harness.chrome.runtime.sendMessage = async (message) => {
    harness.broadcasts.push(structuredClone(message));
    for (const listener of [...harness.listeners.messages]) {
      listener(
        message,
        {
          id: 'extension-id',
          url: 'chrome-extension://extension-id/background.js'
        },
        () => {}
      );
    }
  };
  const dependencies = createChromeBatchDependencies(adapterChrome);
  const pageEvents = [];
  const unsubscribe = dependencies.subscribeRuntimeMessages(
    (message) => pageEvents.push(structuredClone(message))
  );
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });

  const response = await new Promise((resolve) => {
    harness.listeners.messages[0](
      {
        type: 'BATCH_TASK_PHASE',
        batchId: 'batch-1',
        urlIndex: 0,
        attempt: 1,
        phase: 'filling'
      },
      {
        id: 'extension-id',
        tab: { id: 11 },
        url: 'https://target.test/post'
      },
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].phase, 'filling');
  assert.deepEqual(pageEvents, [{
    type: 'BATCH_TASK_PHASE_UPDATED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    phase: 'filling',
    sourceTabId: 11
  }]);
  unsubscribe();
});

test('installed teardown listener accepts only the extension batch page', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const message = {
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  };

  const contentResponse = await new Promise((resolve) => {
    harness.listeners.messages[0](
      message,
      {
        id: 'extension-id',
        tab: { id: 11 },
        url: 'https://target.test/post'
      },
      resolve
    );
  });
  assert.equal(contentResponse.error, 'forbidden_sender');
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'running');

  const pageResponse = await new Promise((resolve) => {
    harness.listeners.messages[0](
      message,
      {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/batch.html'
      },
      resolve
    );
  });
  assert.equal(pageResponse.ok, true);
  assert.equal(pageResponse.cleanupComplete, true);
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'paused_recovery');
});

test('returns the checkpoint advanced by a task retry command', async () => {
  const { controller } = createHarness();
  await controller.handleMessage(startMessage(1));
  const terminal = await controller.handleMessage({
    type: 'BATCH_TASK_TERMINAL',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'fail',
      errorCode: 'task_timeout',
      errorMessage: 'timed out'
    }
  });
  assert.equal(terminal.ok, true);

  const response = await controller.handleMessage({
    type: 'BATCH_TASK_RETRY',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  });

  assert.equal(response.ok, true);
  assert.equal(response.checkpoint.tasks['0'].attempt, 2);
  assert.equal(response.checkpoint.tasks['0'].state, 'queued');
});

test('returns the checkpoint updated by a task manual status command', async () => {
  const { controller } = createHarness();
  await controller.handleMessage(startMessage(1));
  const terminal = await controller.handleMessage({
    type: 'BATCH_TASK_TERMINAL',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'no_comment_box',
      errorCode: 'no_comment_box',
      errorMessage: 'not found'
    }
  });
  assert.equal(terminal.ok, true);

  const response = await controller.handleMessage({
    type: 'BATCH_TASK_MANUAL_UPDATE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    status: 'in_progress'
  });

  assert.equal(response.ok, true);
  assert.equal(
    response.checkpoint.tasks['0'].manualResolution.status,
    'in_progress'
  );
});

test('rejects a missing attempt before every untracked terminal return', async () => {
  const message = {
    batchId: 'batch-1',
    urlIndex: 0,
    result: 'success'
  };
  const noCheckpointHarness = createHarness();
  const noCheckpoint = await noCheckpointHarness.controller.markTerminal(
    message
  );

  const staleBatchHarness = createHarness();
  await staleBatchHarness.controller.handleMessage(startMessage(1));
  const staleBatch = await staleBatchHarness.controller.markTerminal({
    ...message,
    batchId: 'old-batch'
  });

  const missingTaskHarness = createHarness();
  await missingTaskHarness.controller.handleMessage(startMessage(1));
  const missingTask = await missingTaskHarness.controller.markTerminal({
    ...message,
    urlIndex: 9
  });

  for (const response of [noCheckpoint, staleBatch, missingTask]) {
    assert.deepEqual(
      { ok: response.ok, error: response.error },
      { ok: false, error: 'stale_attempt' }
    );
  }
});

test('markTerminal preserves the stable error code from content reports', async () => {
  const { controller } = createHarness();
  await controller.handleMessage(startMessage(1));
  await controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });

  const response = await controller.markTerminal({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: 'fail',
    errorCode: 'task_failed',
    errorMessage: 'profile missing'
  });

  assert.equal(response.ok, true);
  assert.equal(response.checkpoint.results[0].errorCode, 'task_failed');
});

test('serializes simultaneous task updates without losing either activity', async () => {
  const { controller, data } = createHarness();
  const started = await controller.handleMessage(startMessage());

  assert.equal(started.ok, true);
  await Promise.all([
    controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 1,
      windowId: 11
    }),
    controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 1,
      attempt: 1,
      tabId: 2,
      windowId: 12
    })
  ]);

  assert.equal(data.batchRuntimeCheckpoint.tasks['0'].state, 'active');
  assert.equal(data.batchRuntimeCheckpoint.tasks['0'].windowId, 11);
  assert.equal(data.batchRuntimeCheckpoint.tasks['1'].state, 'active');
  assert.equal(data.batchRuntimeCheckpoint.tasks['1'].windowId, 12);
});

test('requests system wakefulness only while a batch is running', async () => {
  const { controller, powerCalls } = createHarness();

  await controller.handleMessage(startMessage());
  await controller.handleMessage({
    type: 'BATCH_SESSION_RESUME',
    batchId: 'batch-1'
  });
  await controller.handleMessage({
    type: 'BATCH_SESSION_PAUSE',
    batchId: 'batch-1'
  });
  await controller.handleMessage({
    type: 'BATCH_SESSION_RESUME',
    batchId: 'batch-1'
  });
  await controller.handleMessage({
    type: 'BATCH_SESSION_COMPLETE',
    batchId: 'batch-1'
  });

  assert.deepEqual(powerCalls, [
    ['request', 'system'],
    ['release'],
    ['request', 'system'],
    ['release']
  ]);
});

test('a reloaded service worker reasserts wakefulness on the next running task update', async () => {
  const { controller, chrome, powerCalls } = createHarness();
  await controller.handleMessage(startMessage());

  const reloadedController = createBatchRuntimeController({
    storageArea: chrome.storage.local,
    power: chrome.power,
    tabs: chrome.tabs,
    windows: chrome.windows,
    runtime: chrome.runtime,
    now: () => 5000
  });
  const response = await reloadedController.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 1,
    windowId: 11,
    startedAt: 4900
  });

  assert.equal(response.ok, true);
  assert.deepEqual(powerCalls, [
    ['request', 'system'],
    ['request', 'system']
  ]);
});

test('a power acquisition failure leaves a new checkpoint safely paused', async () => {
  const { controller, data, powerCalls } = createHarness({
    failPower: true
  });

  const response = await controller.handleMessage(startMessage());

  assert.deepEqual(
    { ok: response.ok, error: response.error },
    { ok: false, error: 'power_request_failed' }
  );
  assert.equal(data.batchRuntimeCheckpoint.status, 'paused_recovery');
  assert.deepEqual(powerCalls, [
    ['request', 'system'],
    ['release']
  ]);
});

test('loading a stale running batch closes only worker tabs in their shared window', async () => {
  const {
    controller,
    data,
    powerCalls,
    removedTabs,
    removedWindows
  } = createHarness();
  await controller.handleMessage(startMessage());
  await Promise.all([
    controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 1,
      windowId: 11
    }),
    controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 1,
      attempt: 1,
      tabId: 2,
      windowId: 11
    })
  ]);
  await controller.handleMessage({
    type: 'BATCH_TASK_SUBMITTING',
    batchId: 'batch-1',
    urlIndex: 1,
    attempt: 1
  });

  const response = await controller.loadForPage();

  assert.equal(response.ok, true);
  assert.equal(response.checkpoint.status, 'paused_recovery');
  assert.equal(response.checkpoint.tasks['0'].state, 'queued');
  assert.equal(response.checkpoint.tasks['1'].state, 'terminal');
  assert.equal(response.checkpoint.results[0].result, 'manual_required');
  assert.deepEqual(removedTabs.sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(removedWindows, []);
  assert.equal(data.batchRuntimeCheckpoint.status, 'paused_recovery');
  assert.deepEqual(powerCalls, [
    ['request', 'system'],
    ['release']
  ]);
});

test('startup recovery retains failed orphan cleanup for the next retry', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  harness.chrome.tabs.removeFailure = new Error('tabs unavailable');

  const failed = await harness.controller.loadForPage();

  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'batch_teardown_cleanup_failed');
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'paused_recovery');
  assert.deepEqual(
    harness.data.batchRuntimeCheckpoint.recoveryCleanup.orphanTabIds,
    [11]
  );

  harness.chrome.tabs.removeFailure = null;
  const retried = await harness.controller.loadForPage();
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [11, 11]);
});

test('page teardown persists recovery ownership before closing tabs and releasing power', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage());
  await Promise.all([
    harness.controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 11,
      windowId: 21
    }),
    harness.controller.handleMessage({
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 1,
      attempt: 1,
      tabId: 12,
      windowId: 21
    })
  ]);
  harness.operationLog.length = 0;

  const response = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });

  assert.equal(response.ok, true);
  assert.equal(response.cleanupComplete, true);
  assert.equal(response.checkpoint.status, 'paused_recovery');
  assert.deepEqual(response.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.operationLog, [
    ['persist', 'paused_recovery', [11, 12]],
    ['tabs-remove', 11],
    ['tabs-remove', 12],
    ['persist', 'paused_recovery', []],
    ['power-release']
  ]);
});

test('failed page teardown retains orphan ownership and succeeds on retry', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  harness.chrome.tabs.removeFailure = new Error('tabs unavailable');

  const failed = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'batch_teardown_cleanup_failed');
  assert.equal(failed.cleanupComplete, false);
  assert.deepEqual(
    {
      reason: harness.data.batchRuntimeCheckpoint.recoveryCleanup.reason,
      orphanTabIds:
        harness.data.batchRuntimeCheckpoint.recoveryCleanup.orphanTabIds,
      diagnostic:
        harness.data.batchRuntimeCheckpoint.recoveryCleanup.diagnostic
    },
    {
      reason: 'navigation',
      orphanTabIds: [11],
      diagnostic: 'tab_close_failed'
    }
  );
  assert.equal(
    Number.isFinite(
      harness.data.batchRuntimeCheckpoint.recoveryCleanup.updatedAt
    ),
    true
  );

  harness.chrome.tabs.removeFailure = new Error('No tab with id: 11');
  const retried = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });

  assert.equal(retried.ok, true);
  assert.equal(retried.cleanupComplete, true);
  assert.deepEqual(retried.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [11, 11]);
});

test('page teardown storage failure leaves running ownership untouched', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  harness.operationLog.length = 0;
  harness.chrome.storage.local.setFailure = new Error('storage unavailable');

  const response = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, 'checkpoint_write_failed');
  assert.equal(response.checkpoint.status, 'running');
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'running');
  assert.deepEqual(harness.operationLog, []);
  assert.deepEqual(harness.removedTabs, []);
});

test('missing-attempt worker activation safely pauses and closes the unclaimed tab', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));

  const response = await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    tabId: 11,
    windowId: 21
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, 'stale_attempt');
  assert.equal(response.checkpoint.status, 'paused_recovery');
  assert.deepEqual(response.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [11]);
});

test('late activation after page teardown is cancelled and cleaned without restart', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  const teardown = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });
  assert.equal(teardown.ok, true);

  const late = await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });

  assert.equal(late.ok, false);
  assert.equal(late.error, 'batch_teardown_cancelled');
  assert.equal(late.checkpoint.status, 'paused_recovery');
  assert.deepEqual(late.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [11]);
  assert.equal(
    harness.powerCalls.filter(([name]) => name === 'request').length,
    1
  );
});

test('startup opens one paused recovery page and never reacquires power', async () => {
  const {
    controller,
    powerCalls,
    createdTabs
  } = createHarness();
  await controller.handleMessage(startMessage());
  powerCalls.length = 0;

  const response = await controller.recoverOnStartup();

  assert.equal(response.ok, true);
  assert.equal(response.checkpoint.status, 'paused_recovery');
  assert.deepEqual(powerCalls, [['release']]);
  assert.equal(
    powerCalls.some(([action]) => action === 'request'),
    false
  );
  assert.deepEqual(createdTabs, [{
    url: 'chrome-extension://extension-id/batch.html?recovery=1'
  }]);
});

test('startup does not duplicate an existing recovery page', async () => {
  const {
    controller,
    createdTabs
  } = createHarness({
    existingTabs: [{
      id: 90,
      url: 'chrome-extension://extension-id/batch.html?recovery=1'
    }]
  });
  await controller.handleMessage(startMessage());

  await controller.recoverOnStartup();

  assert.deepEqual(createdTabs, []);
});

test('startup ignores completed and terminated checkpoints', async () => {
  for (const type of ['BATCH_SESSION_COMPLETE', 'BATCH_SESSION_STOP']) {
    const { controller, createdTabs } = createHarness();
    await controller.handleMessage(startMessage());
    await controller.handleMessage({ type, batchId: 'batch-1' });

    const response = await controller.recoverOnStartup();

    assert.equal(response.ok, true);
    assert.deepEqual(createdTabs, []);
  }
});

test('installed listeners reject external senders and route startup safely', async () => {
  const { controller, chrome, listeners, createdTabs } = createHarness();
  installBatchRuntimeController(chrome, controller);

  assert.equal(listeners.messages.length, 1);
  assert.equal(listeners.startup.length, 1);

  const responses = [];
  const externalResult = listeners.messages[0](
    startMessage(),
    { id: 'other-extension' },
    (response) => responses.push(response)
  );
  assert.equal(externalResult, false);
  assert.deepEqual(responses, [{
    ok: false,
    error: 'forbidden_sender'
  }]);

  let internalResult;
  const internalResponse = await new Promise((resolve) => {
    internalResult = listeners.messages[0](
      startMessage(),
      { id: 'extension-id' },
      resolve
    );
  });
  assert.equal(internalResult, true);
  assert.equal(internalResponse.ok, true);

  assert.equal(listeners.startup[0](), undefined);
  for (let attempt = 0; attempt < 10 && createdTabs.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(createdTabs.length, 1);
});
