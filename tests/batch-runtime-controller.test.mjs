import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchRuntimeController,
  installBatchRuntimeController
} from '../lib/batch-runtime-controller.mjs';
import {
  createChromeBatchDependencies
} from '../lib/batch-chrome-adapter.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

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
  const updatedTabs = [];
  const fetchedTabs = [];
  const broadcasts = [];
  const operationLog = [];
  const tabStore = new Map(
    existingTabs
      .filter((tab) => Number.isInteger(tab?.id))
      .map((tab) => [tab.id, structuredClone(tab)])
  );
  const listeners = {
    messages: [],
    startup: []
  };
  let nextCreatedTabId = 91;
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
      if (storageArea.setFailures?.length > 0) {
        const failure = storageArea.setFailures.shift();
        if (failure) throw failure;
      }
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
      return [...tabStore.values()].map((tab) => structuredClone(tab));
    },
    async create(details) {
      createdTabs.push(structuredClone(details));
      operationLog.push([
        'tabs-create',
        details.windowId ?? null,
        details.url,
        details.active ?? null
      ]);
      if (tabs.createGate) await tabs.createGate.promise;
      if (tabs.createFailure) throw tabs.createFailure;
      const created = { id: nextCreatedTabId++, ...details };
      tabStore.set(created.id, structuredClone(created));
      return created;
    },
    async get(tabId) {
      fetchedTabs.push(tabId);
      if (tabs.getFailure) throw tabs.getFailure;
      const tab = tabStore.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      return structuredClone(tab);
    },
    async update(tabId, changes) {
      updatedTabs.push([tabId, structuredClone(changes)]);
      operationLog.push(['tabs-update', tabId, structuredClone(changes)]);
      if (tabs.updateAppliedFailure) {
        const tab = tabStore.get(tabId);
        tabStore.set(tabId, { ...tab, ...structuredClone(changes) });
        throw tabs.updateAppliedFailure;
      }
      if (tabs.updateFailure) throw tabs.updateFailure;
      const tab = tabStore.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      const updated = { ...tab, ...structuredClone(changes) };
      tabStore.set(tabId, updated);
      return structuredClone(updated);
    },
    async remove(tabIds) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      removedTabs.push(...ids);
      operationLog.push(['tabs-remove', ...ids]);
      if (tabs.removeFailure) throw tabs.removeFailure;
      ids.forEach((tabId) => tabStore.delete(tabId));
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
  const handleMessage = controller.handleMessage;
  controller.handleMessage = (message, sender) => {
    if (
      message?.type === 'BATCH_TASK_ACTIVE' &&
      Number.isInteger(message.urlIndex) &&
      Number.isInteger(message.attempt) &&
      message.attempt > 0 &&
      Number.isInteger(message.tabId) &&
      Number.isInteger(message.windowId) &&
      !tabStore.has(message.tabId)
    ) {
      const item =
        data.batchRuntimeCheckpoint?.source?.parsedUrls?.[message.urlIndex];
      if (typeof item?.url === 'string') {
        tabStore.set(message.tabId, {
          id: message.tabId,
          windowId: message.windowId,
          url: item.url
        });
      }
    }
    return handleMessage(message, sender);
  };
  return {
    controller,
    chrome: { storage: { local: storageArea }, power, tabs, windows, runtime },
    data,
    setCalls,
    powerCalls,
    removedTabs,
    removedWindows,
    createdTabs,
    updatedTabs,
    fetchedTabs,
    tabStore,
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

function batchPageSender(overrides = {}) {
  return {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/batch.html',
    origin: 'chrome-extension://extension-id',
    frameId: 0,
    documentId: 'batch-document-id',
    documentLifecycle: 'active',
    tab: {
      id: 70,
      index: 0,
      windowId: 42,
      highlighted: true,
      active: true,
      pinned: false,
      incognito: false,
      url: 'chrome-extension://extension-id/batch.html',
      title: '批量评论'
    },
    ...overrides
  };
}

function sendInstalledMessage(listener, message, sender) {
  return new Promise((resolve) => {
    const accepted = listener(message, sender, resolve);
    if (accepted !== true) {
      resolve({ ok: false, error: 'listener_rejected_message' });
    }
  });
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

test('installed teardown listener accepts only a real own-extension batch-page sender', async () => {
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

  for (const sender of [
    batchPageSender({
      id: 'other-extension',
      url: 'chrome-extension://other-extension/batch.html'
    }),
    batchPageSender({
      url: 'chrome-extension://extension-id/options.html',
      tab: {
        ...batchPageSender().tab,
        url: 'chrome-extension://extension-id/options.html'
      }
    }),
    batchPageSender({
      url: 'https://attacker.test/batch.html',
      origin: 'https://attacker.test',
      tab: {
        ...batchPageSender().tab,
        url: 'https://attacker.test/batch.html'
      }
    }),
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/batch.html',
      origin: 'chrome-extension://extension-id',
      frameId: 0
    }
  ]) {
    const forgedResponse = await new Promise((resolve) => {
      harness.listeners.messages[0](message, sender, resolve);
    });
    assert.equal(forgedResponse.error, 'forbidden_sender');
    assert.equal(harness.data.batchRuntimeCheckpoint.status, 'running');
  }

  const pageResponse = await new Promise((resolve) => {
    harness.listeners.messages[0](
      message,
      batchPageSender(),
      resolve
    );
  });
  assert.equal(pageResponse.ok, true);
  assert.equal(pageResponse.cleanupComplete, true);
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'paused_recovery');
});

test('background creates and checkpoints a worker tab from trusted sender identity', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  const start = startMessage(1);
  start.settings.concurrency = 1;
  await harness.controller.handleMessage(start);

  const response = await sendInstalledMessage(
    harness.listeners.messages[0],
      {
        type: 'BATCH_CREATE_WORKER_TAB',
        batchId: 'batch-1',
        urlIndex: 0,
        attempt: 1,
        requestId: 'batch-1:0:1',
        url: 'https://attacker.test/ignored',
        windowId: 999
      },
      batchPageSender()
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.tab, {
    id: 91,
    windowId: 42,
    url: 'https://example.test/0',
    active: false
  });
  assert.equal(response.checkpoint.tasks['0'].state, 'active');
  assert.equal(response.checkpoint.tasks['0'].tabId, 91);
  assert.equal(response.checkpoint.tasks['0'].windowId, 42);
  assert.equal(response.checkpoint.tasks['0'].requestId, 'batch-1:0:1');
  assert.deepEqual(harness.createdTabs, [{
    windowId: 42,
    url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1',
    active: false
  }]);
  assert.deepEqual(harness.updatedTabs, [[
    91,
    { url: 'https://example.test/0' }
  ]]);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'active');
  assert.deepEqual(
    harness.data.batchRuntimeCheckpoint.openingReservations,
    {}
  );
});

test('worker-tab creation rejects non-batch page senders before creating a tab', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const message = {
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  };

  for (const sender of [
    {
      id: 'extension-id',
      url: 'https://target.test/post',
      origin: 'https://target.test',
      frameId: 0,
      tab: {
        ...batchPageSender().tab,
        url: 'https://target.test/post'
      }
    },
    batchPageSender({
      url: 'chrome-extension://extension-id/options.html'
    }),
    batchPageSender({ id: 'other-extension' }),
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/batch.html',
      origin: 'chrome-extension://extension-id',
      frameId: 0
    }
  ]) {
    const response = await sendInstalledMessage(
      harness.listeners.messages[0],
      message,
      sender
    );
    assert.equal(response.error, 'forbidden_sender');
  }
  assert.deepEqual(harness.createdTabs, []);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'queued');
});

test('a create already in background finishes checkpointing before pagehide cleanup', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const createGate = deferred();
  harness.chrome.tabs.createGate = createGate;
  const sender = batchPageSender();

  const creating = sendInstalledMessage(
    harness.listeners.messages[0],
      {
        type: 'BATCH_CREATE_WORKER_TAB',
        batchId: 'batch-1',
        urlIndex: 0,
        attempt: 1,
        requestId: 'batch-1:0:1'
      },
      sender
  );
  await waitFor(
    () => harness.createdTabs.length === 1,
    'background tab creation'
  );
  assert.deepEqual(harness.createdTabs, [{
    windowId: 42,
    url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1',
    active: false
  }]);

  const tearingDown = sendInstalledMessage(
    harness.listeners.messages[0],
      {
        type: 'BATCH_PAGE_TEARDOWN',
        batchId: 'batch-1',
        reason: 'pagehide'
      },
      sender
  );
  createGate.resolve();
  const [created, teardown] = await Promise.all([creating, tearingDown]);

  assert.equal(created.ok, true);
  assert.equal(created.checkpoint.tasks['0'].state, 'active');
  assert.equal(teardown.ok, true);
  assert.equal(teardown.checkpoint.status, 'paused_recovery');
  assert.deepEqual(teardown.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [91]);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'queued');
});

test('pagehide serialized before create rejects the create with zero orphan tabs', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const sender = batchPageSender();

  const tearingDown = sendInstalledMessage(
    harness.listeners.messages[0],
      {
        type: 'BATCH_PAGE_TEARDOWN',
        batchId: 'batch-1',
        reason: 'pagehide'
      },
      sender
  );
  const creating = sendInstalledMessage(
    harness.listeners.messages[0],
      {
        type: 'BATCH_CREATE_WORKER_TAB',
        batchId: 'batch-1',
        urlIndex: 0,
        attempt: 1
      },
      sender
  );
  const [teardown, created] = await Promise.all([tearingDown, creating]);

  assert.equal(teardown.ok, true);
  assert.equal(created.ok, false);
  assert.equal(created.error, 'batch_teardown_cancelled');
  assert.deepEqual(harness.createdTabs, []);
  assert.deepEqual(
    harness.data.batchRuntimeCheckpoint.recoveryCleanup.orphanTabIds,
    []
  );
});

test('three background-owned workers use the console sender window', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  const start = startMessage(3);
  start.settings.concurrency = 3;
  await harness.controller.handleMessage(start);
  const sender = batchPageSender();

  const responses = await Promise.all([0, 1, 2].map((urlIndex) => (
    sendInstalledMessage(
      harness.listeners.messages[0],
        {
          type: 'BATCH_CREATE_WORKER_TAB',
          batchId: 'batch-1',
          urlIndex,
          attempt: 1,
          requestId: `batch-1:${urlIndex}:1`,
          windowId: 999,
          url: `https://attacker.test/${urlIndex}`
        },
        sender
    )
  )));

  assert.equal(responses.every((response) => response.ok), true);
  assert.deepEqual(harness.createdTabs, [0, 1, 2].map((urlIndex) => ({
    windowId: 42,
    url: `chrome-extension://extension-id/worker-pending.html#batch-1%3A${urlIndex}%3A1`,
    active: false
  })));
  assert.deepEqual(harness.updatedTabs, [0, 1, 2].map((urlIndex) => ([
    91 + urlIndex,
    { url: `https://example.test/${urlIndex}` }
  ])));
  assert.deepEqual(
    Object.values(harness.data.batchRuntimeCheckpoint.tasks).map((task) => ({
      state: task.state,
      windowId: task.windowId,
      tabId: task.tabId
    })),
    [
      { state: 'active', windowId: 42, tabId: 91 },
      { state: 'active', windowId: 42, tabId: 92 },
      { state: 'active', windowId: 42, tabId: 93 }
    ]
  );
});

test('permanent reservation persistence failure never creates or reports a queued tab as successful', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.storage.local.setFailure = new Error('storage unavailable');

  const response = await sendInstalledMessage(
    harness.listeners.messages[0],
    {
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      requestId: 'batch-1:0:1'
    },
    batchPageSender()
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, 'checkpoint_write_failed');
  assert.deepEqual(harness.createdTabs, []);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'queued');
});

test('ACTIVE persistence and pending-tab close failures retain durable cleanup ownership without navigation', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.storage.local.setFailures = [
    null,
    new Error('ACTIVE storage unavailable')
  ];
  harness.chrome.tabs.removeFailure = new Error('tabs unavailable');

  const response = await sendInstalledMessage(
    harness.listeners.messages[0],
    {
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      requestId: 'batch-1:0:1'
    },
    batchPageSender()
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, 'checkpoint_write_failed');
  assert.deepEqual(harness.createdTabs, [{
    windowId: 42,
    url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1',
    active: false
  }]);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.removedTabs, [91]);
  assert.equal(harness.data.batchRuntimeCheckpoint.status, 'paused_recovery');
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'queued');
  assert.deepEqual(
    harness.data.batchRuntimeCheckpoint.recoveryCleanup.orphanTabIds,
    [91]
  );
  assert.equal(
    harness.data.batchRuntimeCheckpoint
      .openingReservations['batch-1:0:1'].tabId,
    91
  );

  harness.chrome.tabs.removeFailure = null;
  const recovered = await harness.controller.recoverOnStartup();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(recovered.checkpoint.openingReservations, {});
  assert.deepEqual(harness.removedTabs, [91, 91]);
});

test('startup discovers and cleans a pending worker after ownership, close, and recovery writes all fail', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.storage.local.setFailures = [
    null,
    new Error('ACTIVE storage unavailable'),
    new Error('recovery storage unavailable')
  ];
  harness.chrome.tabs.removeFailure = new Error('tabs unavailable');

  const failed = await harness.controller.handleMessage({
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  }, batchPageSender());

  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'checkpoint_write_failed');
  assert.equal(
    harness.data.batchRuntimeCheckpoint
      .openingReservations['batch-1:0:1'].tabId,
    null
  );
  assert.equal(
    harness.tabStore.get(91).url,
    'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1'
  );

  harness.chrome.tabs.removeFailure = null;
  const recovered = await harness.controller.recoverOnStartup();

  assert.equal(recovered.ok, true);
  assert.equal(harness.tabStore.has(91), false);
  assert.deepEqual(harness.removedTabs, [91, 91]);
  assert.deepEqual(recovered.checkpoint.openingReservations, {});
});

test('startup discovers a pending worker left between tab creation and ACTIVE persistence', async () => {
  const pendingUrl =
    'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1';
  const harness = createHarness({
    existingTabs: [{
      id: 600,
      windowId: 42,
      url: pendingUrl,
      active: false
    }]
  });
  await harness.controller.handleMessage(startMessage(1));
  harness.data.batchRuntimeCheckpoint.openingReservations = {
    'batch-1:0:1': {
      requestId: 'batch-1:0:1',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      windowId: 42,
      tabId: null,
      updatedAt: 2000
    }
  };

  const recovered = await harness.controller.recoverOnStartup();

  assert.equal(recovered.ok, true);
  assert.deepEqual(harness.removedTabs, [600]);
  assert.equal(harness.tabStore.has(600), false);
  assert.deepEqual(recovered.checkpoint.openingReservations, {});
});

test('malformed opening reservations fail validation without deleting their claimed tab', async () => {
  const harness = createHarness({
    existingTabs: [{
      id: 777,
      windowId: 42,
      url: 'https://user-owned.test/',
      active: true
    }]
  });
  await harness.controller.handleMessage(startMessage(1));
  harness.data.batchRuntimeCheckpoint.openingReservations = {
    forged: {
      requestId: 'different-key',
      batchId: 'batch-1',
      urlIndex: 99,
      attempt: 7,
      windowId: 42,
      tabId: 777,
      updatedAt: 2000
    }
  };

  const response = await harness.controller.loadForPage();

  assert.equal(response.ok, false);
  assert.equal(response.error, 'invalid_checkpoint');
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(harness.tabStore.has(777), true);
});

test('malformed task ownership never deletes the claimed user tab during page recovery', async () => {
  for (const mutation of [
    (task) => Object.assign(task, {
      state: 'active',
      requestId: 'forged-request',
      tabId: 777,
      windowId: 42,
      startedAt: 2000
    }),
    (task) => Object.assign(task, {
      state: 'active',
      requestId: 'batch-1:0:1',
      tabId: null,
      windowId: 42,
      startedAt: 2000
    }),
    (task) => Object.assign(task, {
      urlIndex: 9,
      attempt: 2,
      state: 'active',
      requestId: 'batch-1:9:2',
      tabId: 777,
      windowId: 42,
      startedAt: 2000
    })
  ]) {
    const harness = createHarness({
      existingTabs: [{
        id: 777,
        windowId: 42,
        url: 'https://user-owned.test/',
        active: true
      }]
    });
    await harness.controller.handleMessage(startMessage(1));
    mutation(harness.data.batchRuntimeCheckpoint.tasks['0']);

    const response = await harness.controller.loadForPage();

    assert.equal(response.ok, false);
    assert.equal(response.error, 'invalid_checkpoint');
    assert.deepEqual(harness.removedTabs, []);
    assert.equal(harness.tabStore.has(777), true);
  }
});

test('legacy naked orphan IDs never authorize deletion of a user tab', async () => {
  const harness = createHarness({
    existingTabs: [{
      id: 777,
      windowId: 42,
      url: 'https://user-owned.test/',
      active: true
    }]
  });
  await harness.controller.handleMessage(startMessage(1));
  harness.data.batchRuntimeCheckpoint.status = 'paused_recovery';
  harness.data.batchRuntimeCheckpoint.recoveryCleanup = {
    reason: 'legacy',
    orphanTabIds: [777],
    diagnostic: 'tab_close_failed',
    updatedAt: 2000
  };

  const response = await harness.controller.loadForPage();

  assert.equal(response.ok, true);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(harness.tabStore.has(777), true);
});

test('teardown requires live window and URL proof before deleting an owned task tab', async () => {
  const harness = createHarness({
    existingTabs: [{
      id: 11,
      windowId: 21,
      url: 'https://example.test/0'
    }]
  });
  await harness.controller.handleMessage(startMessage(1));
  await harness.controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  harness.tabStore.set(11, {
    id: 11,
    windowId: 21,
    url: 'https://user.example/private'
  });

  const response = await harness.controller.handleMessage({
    type: 'BATCH_PAGE_TEARDOWN',
    batchId: 'batch-1',
    reason: 'navigation'
  });

  assert.equal(response.ok, true);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(harness.tabStore.has(11), true);
});

test('installed runtime rejects content-forged ACTIVE ownership without persistence or cleanup', async () => {
  const harness = createHarness({
    existingTabs: [{
      id: 777,
      windowId: 42,
      url: 'https://user-owned.test/',
      active: true
    }]
  });
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  harness.setCalls.length = 0;

  const response = await sendInstalledMessage(
    harness.listeners.messages[0],
    {
      type: 'BATCH_TASK_ACTIVE',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      tabId: 777,
      windowId: 42
    },
    {
      id: 'extension-id',
      tab: { id: 777, windowId: 42 },
      url: 'https://attacker.test/'
    }
  );

  assert.equal(response.error, 'listener_rejected_message');
  assert.deepEqual(harness.setCalls, []);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(harness.data.batchRuntimeCheckpoint.tasks['0'].state, 'queued');
});

test('legacy canonical reservation migration still discovers and cleans its exact pending tab', async () => {
  const harness = createHarness({
    existingTabs: [{
      id: 600,
      windowId: 42,
      url:
        'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1',
      active: false
    }]
  });
  await harness.controller.handleMessage(startMessage(1));
  harness.data.batchRuntimeCheckpoint.openingReservations = {
    'batch-1:0:1': {
      requestId: 'batch-1:0:1',
      urlIndex: 0,
      attempt: 1,
      windowId: 42,
      tabId: null,
      updatedAt: 2000
    }
  };

  const response = await harness.controller.recoverOnStartup();

  assert.equal(response.ok, true);
  assert.deepEqual(harness.removedTabs, [600]);
  assert.deepEqual(response.checkpoint.openingReservations, {});
});

test('lost create response replays the same live ACTIVE tab without creating a second target', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const message = {
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  };

  const first = await sendInstalledMessage(
    harness.listeners.messages[0],
    message,
    batchPageSender()
  );
  const replay = await sendInstalledMessage(
    harness.listeners.messages[0],
    message,
    batchPageSender()
  );

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.tab.id, first.tab.id);
  assert.equal(replay.checkpoint.tasks['0'].state, 'active');
  assert.equal(replay.checkpoint.tasks['0'].requestId, message.requestId);
  assert.equal(harness.createdTabs.length, 1);
  assert.deepEqual(harness.fetchedTabs, [first.tab.id]);
  assert.equal(harness.tabStore.get(first.tab.id).url, 'https://example.test/0');
});

test('missing ACTIVE replay tab is durably re-reserved and replaced once', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  const message = {
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  };
  const first = await sendInstalledMessage(
    harness.listeners.messages[0],
    message,
    batchPageSender()
  );
  harness.tabStore.delete(first.tab.id);

  const replay = await sendInstalledMessage(
    harness.listeners.messages[0],
    message,
    batchPageSender()
  );

  assert.equal(replay.ok, true);
  assert.equal(replay.tab.id, 92);
  assert.equal(replay.checkpoint.tasks['0'].state, 'active');
  assert.equal(replay.checkpoint.tasks['0'].tabId, 92);
  assert.equal(harness.createdTabs.length, 2);
  assert.deepEqual(harness.fetchedTabs, [91]);
});

test('navigation failure pauses for recovery and closes the owned pending tab before any handle exists', async () => {
  const harness = createHarness();
  installBatchRuntimeController(harness.chrome, harness.controller);
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.tabs.updateFailure = new Error('navigation unavailable');

  const response = await sendInstalledMessage(
    harness.listeners.messages[0],
    {
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      requestId: 'batch-1:0:1'
    },
    batchPageSender()
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, 'tab_navigation_failed');
  assert.equal(response.checkpoint.status, 'paused_recovery');
  assert.equal(response.checkpoint.tasks['0'].state, 'queued');
  assert.deepEqual(response.checkpoint.recoveryCleanup.orphanTabIds, []);
  assert.deepEqual(harness.removedTabs, [91]);
  assert.equal(harness.tabStore.has(91), false);
});

test('an applied navigation with a lost update response verifies the target and succeeds with one tab', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.tabs.updateAppliedFailure =
    new Error('tabs.update response lost');

  const response = await harness.controller.handleMessage({
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  }, batchPageSender());

  assert.equal(response.ok, true);
  assert.equal(response.tab.id, 91);
  assert.equal(response.checkpoint.tasks['0'].state, 'active');
  assert.equal(harness.createdTabs.length, 1);
  assert.deepEqual(harness.fetchedTabs, [91]);
  assert.deepEqual(harness.removedTabs, []);
});

test('uncertain navigation lookup preserves ACTIVE ownership and requests recovery', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  harness.chrome.tabs.updateFailure = new Error('navigation uncertain');
  harness.chrome.tabs.getFailure = new Error('tabs temporarily unavailable');

  const response = await harness.controller.handleMessage({
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  }, batchPageSender());

  assert.equal(response.ok, false);
  assert.equal(response.recoveryRequired, true);
  assert.equal(response.checkpoint.status, 'running');
  assert.equal(response.checkpoint.tasks['0'].state, 'active');
  assert.equal(response.checkpoint.tasks['0'].tabId, 91);
  assert.deepEqual(harness.removedTabs, []);
});

test('transient ACTIVE replay lookup preserves ownership instead of resetting or terminalizing', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  const message = {
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1'
  };
  const created = await harness.controller.handleMessage(
    message,
    batchPageSender()
  );
  harness.chrome.tabs.getFailure = new Error('tabs temporarily unavailable');

  const replay = await harness.controller.handleMessage(
    message,
    batchPageSender()
  );

  assert.equal(created.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.recoveryRequired, true);
  assert.equal(replay.checkpoint.tasks['0'].state, 'active');
  assert.equal(replay.checkpoint.tasks['0'].tabId, 91);
  assert.equal(harness.createdTabs.length, 1);
  assert.deepEqual(harness.removedTabs, []);
});

test('background create reasserts wakefulness after a service-worker restart', async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(startMessage(1));
  harness.powerCalls.length = 0;
  const reloadedController = createBatchRuntimeController({
    storageArea: harness.chrome.storage.local,
    power: harness.chrome.power,
    tabs: harness.chrome.tabs,
    runtime: harness.chrome.runtime,
    now: () => 9000
  });

  const response = await reloadedController.handleMessage({
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  }, batchPageSender());

  assert.equal(response.ok, true);
  assert.deepEqual(harness.powerCalls, [['request', 'system']]);
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

test('missing-attempt worker activation pauses without deleting an unclaimed tab ID', async () => {
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
  assert.deepEqual(harness.removedTabs, []);
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
