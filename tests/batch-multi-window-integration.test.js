const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..');
const clone = (value) => structuredClone(value);

class FakeChromeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

function pausedCheckpoint({
  batchId = 'batch-1',
  taskCount = 5,
  concurrency = 3,
  manualFirst = false
} = {}) {
  const parsedUrls = Array.from({ length: taskCount }, (_, urlIndex) => ({
    originalIndex: urlIndex,
    url: `https://target.test/${urlIndex}`,
    sourceDomain: 'target.test',
    originalRow: [String(urlIndex + 1), `https://target.test/${urlIndex}`]
  }));
  const tasks = Object.fromEntries(parsedUrls.map((item, urlIndex) => [
    String(urlIndex),
    {
      urlIndex,
      attempt: 1,
      state: manualFirst && urlIndex === 0 ? 'terminal' : 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 2000,
      manualResolution: { status: 'idle', updatedAt: null }
    }
  ]));
  const results = manualFirst
    ? [{
        originalIndex: 0,
        attempt: 1,
        url: parsedUrls[0].url,
        sourceDomain: parsedUrls[0].sourceDomain,
        result: 'manual_required',
        aiContent: null,
        errorCode: 'submission_uncertain',
        errorMessage: '提交确认前中断，评论可能已提交',
        timestamp: 2000,
        elapsed: 2,
        originalRow: parsedUrls[0].originalRow
      }]
    : [];

  return {
    version: 2,
    batchId,
    status: 'paused_recovery',
    createdAt: 1000,
    updatedAt: 2000,
    source: {
      fileName: 'targets.csv',
      headers: ['页面AS', '原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site'
      }
    },
    cursor: { nextIndex: 0 },
    tasks,
    results
  };
}

function createStorageArea(initial = {}) {
  const data = clone(initial);
  const requestedKeys = [];
  return {
    data,
    requestedKeys,
    async get(keys) {
      requestedKeys.push(clone(keys));
      const names = Array.isArray(keys)
        ? keys
        : typeof keys === 'string'
          ? [keys]
          : Object.keys(keys || {});
      return Object.fromEntries(names.flatMap((name) => (
        Object.hasOwn(data, name) ? [[name, clone(data[name])]] : []
      )));
    },
    async set(values) {
      Object.assign(data, clone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function createTabsApi() {
  const onRemoved = new FakeChromeEvent();
  const onUpdated = new FakeChromeEvent();
  const tabs = new Map();
  const createCalls = [];
  const removeCalls = [];
  const sendCalls = [];
  const updateCalls = [];
  let nextTabId = 100;

  return {
    onRemoved,
    onUpdated,
    tabs,
    createCalls,
    removeCalls,
    sendCalls,
    updateCalls,
    async create(details) {
      createCalls.push(clone(details));
      const tab = {
        id: nextTabId++,
        windowId: details.windowId,
        url: details.url,
        status: 'complete',
        discarded: false,
        active: details.active
      };
      tabs.set(tab.id, tab);
      return clone(tab);
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      return clone(tab);
    },
    async query() {
      return [...tabs.values()].map(clone);
    },
    async sendMessage(tabId, message) {
      sendCalls.push([tabId, clone(message)]);
      return { ok: true };
    },
    async remove(tabId) {
      removeCalls.push(tabId);
      if (!tabs.delete(tabId)) throw new Error(`No tab with id: ${tabId}`);
      onRemoved.emit(tabId, { windowId: 42, isWindowClosing: false });
    },
    async update(tabId, details) {
      updateCalls.push([tabId, clone(details)]);
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      Object.assign(tab, details);
      return clone(tab);
    }
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `missing element: ${selector}`);
  element.dispatchEvent(new document.defaultView.MouseEvent('click', {
    bubbles: true,
    button: 0
  }));
}

async function createProductionHarness(options = {}) {
  const {
    createBatchRuntimeController
  } = await import('../lib/batch-runtime-controller.mjs');
  const {
    bootBatchPage
  } = await import('../lib/batch-page-composition.mjs');
  const checkpoint = Object.hasOwn(options, 'checkpoint')
    ? options.checkpoint
    : pausedCheckpoint();
  const storageLocal = createStorageArea({
    ...(checkpoint ? { batchRuntimeCheckpoint: checkpoint } : {}),
    batchLocalResults: {
      batchId: checkpoint?.batchId || 'legacy',
      results: [{ originalIndex: 999, result: 'legacy-truncated' }]
    }
  });
  const storageSync = createStorageArea();
  const tabsApi = createTabsApi();
  const runtimeMessages = [];
  const runtimePageListeners = new Set();
  const manualCreateCalls = [];
  const manualCloseCalls = [];
  const exportCalls = [];
  const draftWrites = [];
  const powerCalls = [];
  let nextManualWindowId = 700;
  const runtimeController = createBatchRuntimeController({
    storageArea: storageLocal,
    power: {
      requestKeepAwake(level) {
        powerCalls.push(['request', level]);
      },
      releaseKeepAwake() {
        powerCalls.push(['release']);
      }
    },
    tabs: tabsApi,
    runtime: {
      id: 'extension-id',
      getURL(file) {
        return `chrome-extension://extension-id/${file}`;
      }
    },
    now: (() => {
      let now = 3000;
      return () => ++now;
    })(),
    logger: { warn() {} }
  });
  const dom = new JSDOM(`<!doctype html>
    <html lang="zh-CN">
      <body class="batch-console-page">
        <header data-app-shell></header>
        <main data-batch-console></main>
        <dialog data-batch-wizard></dialog>
      </body>
    </html>`, {
    url: 'chrome-extension://extension-id/batch.html',
    pretendToBeVisual: true
  });
  const dependencies = {
    async runtimeRequest(type, payload = {}) {
      runtimeMessages.push({ type, ...clone(payload) });
      return runtimeController.handleMessage({ type, ...clone(payload) });
    },
    tabsApi,
    async getConsoleWindowId() {
      return 42;
    },
    manualWindows: {
      async open(url) {
        const handle = {
          windowId: nextManualWindowId++,
          tabId: null,
          url,
          automation: false
        };
        manualCreateCalls.push(clone(handle));
        return handle;
      },
      async close(handle) {
        manualCloseCalls.push(clone(handle));
      }
    },
    subscribeRuntimeMessages(listener) {
      runtimePageListeners.add(listener);
      return () => runtimePageListeners.delete(listener);
    },
    async loadBatchSettings() {
      return {
        userName: 'Alice',
        userEmail: 'alice@example.test',
        websiteUrl: 'https://promo.test/',
        websiteContent: 'A safe promotion profile.',
        autoOpenPanel: false,
        autoGenerate: true,
        autoSubmit: true,
        concurrency: 3,
        timeoutSeconds: 60
      };
    },
    async loadLlmConfig() {
      return {
        apiBaseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        apiKey: 'test-only-key'
      };
    },
    draftStorage: {
      async get() {
        return null;
      },
      async set(draft) {
        draftWrites.push(clone(draft));
      },
      async remove() {}
    },
    async loadLegacyResults() {
      return clone(storageLocal.data.batchLocalResults);
    },
    exportResults(fullCheckpoint, legacyResults) {
      exportCalls.push({
        checkpoint: clone(fullCheckpoint),
        legacyResults: clone(legacyResults)
      });
    },
    parseCsv(text) {
      return {
        data: String(text).trim().split(/\r?\n/).map((line) => line.split(',')),
        errors: []
      };
    },
    evaluateUrl() {
      return { blocked: false };
    },
    onlineTarget: dom.window,
    isOnline: () => true
  };
  if (options.history) {
    dependencies.retryPendingHistoryWrites = async () => (
      clone(options.history.retry)
    );
    dependencies.loadHistoryRetentionStatus = async () => (
      clone(options.history.retention)
    );
  }
  if (options.createBatchId) dependencies.createBatchId = options.createBatchId;
  const page = await bootBatchPage(dom.window.document, dependencies);

  return {
    checkpoint,
    dependencies,
    document: dom.window.document,
    dom,
    page,
    tabsApi,
    storageLocal,
    storageSync,
    runtimeMessages,
    runtimePageListeners,
    manualCreateCalls,
    manualCloseCalls,
    exportCalls,
    draftWrites,
    powerCalls,
    emitRuntime(message) {
      for (const listener of [...runtimePageListeners]) {
        listener(clone(message));
      }
    }
  };
}

test('batch page is a local semantic module shell with no inline handlers', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'batch.html'), 'utf8');

  assert.match(html, /<header[^>]*data-app-shell/);
  assert.match(html, /<main[^>]*data-batch-console/);
  assert.match(html, /<dialog[^>]*data-batch-wizard/);
  assert.match(html, /styles\/tokens\.css/);
  assert.match(html, /styles\/app-shell\.css/);
  assert.match(html, /styles\/batch-console\.css/);
  assert.match(html, /<script type="module" src="batch\.js"><\/script>/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i);
});

test('production batch module imports without document or chrome globals', async () => {
  assert.equal('document' in globalThis, false);
  assert.equal('chrome' in globalThis, false);
  const moduleUrl = pathToFileURL(path.join(projectRoot, 'batch.js'));
  const output = execFileSync(process.execPath, [
    '--no-warnings',
    '--input-type=module',
    '--eval',
    `const imported = await import(${JSON.stringify(moduleUrl.href)});`
      + 'process.stdout.write(typeof imported.bootBatchPage);'
  ], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.equal(output, 'function');
});

test('paused production boot creates no tabs and explicit resume creates three same-window slots', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());

  assert.match(
    harness.document.querySelector('[data-batch-status]').textContent,
    /已暂停/
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);

  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.tabsApi.createCalls.length === 3,
    'three automatic worker tabs'
  );
  await waitFor(
    () => harness.document.querySelectorAll('[data-worker-slot][data-slot-state="active"]').length === 3,
    'three active visible slots'
  );

  const resumeIndex = harness.runtimeMessages.findIndex(
    (message) => message.type === 'BATCH_SESSION_RESUME'
  );
  const activeIndex = harness.runtimeMessages.findIndex(
    (message) => message.type === 'BATCH_TASK_ACTIVE'
  );
  assert.ok(resumeIndex >= 0 && activeIndex > resumeIndex);
  assert.deepEqual(harness.tabsApi.createCalls, [
    { windowId: 42, url: 'https://target.test/0', active: false },
    { windowId: 42, url: 'https://target.test/1', active: false },
    { windowId: 42, url: 'https://target.test/2', active: false }
  ]);
  assert.equal(harness.document.querySelectorAll('[data-task-row]').length, 5);
  assert.match(harness.document.querySelector('[data-task-row="0"]').textContent, /运行|加载|worker/);
  assert.match(harness.document.querySelector('[data-task-row="4"]').textContent, /排队/);
});

test('retry advances to attempt 2 and ignores an old attempt confirmation', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: pausedCheckpoint({ manualFirst: true })
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="retry"][data-url-index="0"]');
  click(harness.document, '[data-action="confirm-layer"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].attempt === 2,
    'attempt 2 checkpoint'
  );

  harness.emitRuntime({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success',
    historySaveStatus: 'saved'
  });
  await new Promise((resolve) => setImmediate(resolve));

  const current = harness.storageLocal.data.batchRuntimeCheckpoint;
  assert.equal(current.tasks['0'].attempt, 2);
  assert.equal(current.tasks['0'].state, 'queued');
  assert.equal(current.results.some(
    (result) => result.attempt === 2 && result.result === 'success'
  ), false);
});

test('a success tab closes only after its history confirmation is durable', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'worker tabs');

  const confirmation = {
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    sourceTabId: 100,
    result: 'success'
  };
  harness.emitRuntime({
    ...confirmation,
    historySaveStatus: 'failed'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.tabsApi.tabs.has(100), true);

  harness.emitRuntime({
    ...confirmation,
    historySaveStatus: 'saved',
    historyPendingCount: 0
  });
  await waitFor(
    () => harness.tabsApi.tabs.has(100) === false,
    'durably confirmed tab close'
  );
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.results.some(
      (result) => (
        result.originalIndex === 0 &&
        result.attempt === 1 &&
        result.result === 'success'
      )
    ),
    true
  );
});

test('manual work opens a normal non-automation window and never sends BATCH_HANDLE', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: pausedCheckpoint({ manualFirst: true })
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="manual"][data-url-index="0"]');
  await waitFor(
    () => harness.manualCreateCalls.length === 1,
    'manual window'
  );

  assert.deepEqual(harness.manualCreateCalls[0], {
    windowId: 700,
    tabId: null,
    url: 'https://target.test/0',
    automation: false
  });
  assert.equal(
    harness.tabsApi.sendCalls.some(([, message]) => message.type === 'BATCH_HANDLE'),
    false
  );
  assert.equal(
    harness.runtimeMessages.some((message) => message.type === 'BATCH_TASK_MANUAL_UPDATE'),
    true
  );
});

test('permanent stop closes owned tabs and cannot resume', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.createCalls.length === 3, 'worker tabs');

  click(harness.document, '[data-action="stop"]');
  click(harness.document, '[data-action="confirm-layer"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.status === 'terminated',
    'terminated checkpoint'
  );

  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(harness.document.querySelector('[data-action="resume"]'), null);
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.type === 'BATCH_SESSION_RESUME'
    ).length,
    1
  );
});

test('checkpoint results are authoritative for export and history remains navigable', async (t) => {
  const checkpoint = pausedCheckpoint({ manualFirst: true });
  checkpoint.status = 'completed';
  checkpoint.results.push({
    ...checkpoint.results[0],
    originalIndex: 1,
    attempt: 1,
    url: checkpoint.source.parsedUrls[1].url,
    result: 'success',
    errorCode: null,
    errorMessage: null,
    originalRow: checkpoint.source.parsedUrls[1].originalRow
  });
  checkpoint.tasks['1'] = {
    ...checkpoint.tasks['1'],
    state: 'terminal'
  };
  const harness = await createProductionHarness({ checkpoint });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="export"]');

  assert.equal(harness.exportCalls.length, 1);
  assert.equal(harness.exportCalls[0].checkpoint.results.length, 2);
  assert.equal(
    harness.exportCalls[0].checkpoint.results.some(
      (result) => result.result === 'legacy-truncated'
    ),
    false
  );
  assert.ok([...harness.document.querySelectorAll('a')].some(
    (link) => link.textContent === '评论历史' && /history\.html$/.test(link.href)
  ));
});

test('history retry and retention status remain visible in the composed console', async (t) => {
  const harness = await createProductionHarness({
    history: {
      retry: { ok: true, data: { pending: 2 } },
      retention: {
        ok: true,
        data: { dueSoonCount: 1, expiredCount: 0 }
      }
    }
  });
  t.after(() => harness.page.destroy());
  await waitFor(
    () => /2 条评论历史/.test(harness.document.body.textContent),
    'pending history banner'
  );

  assert.match(harness.document.body.textContent, /2 条评论历史/);
  assert.match(harness.document.body.textContent, /1 条评论历史即将达到 90 天/);
  assert.match(
    harness.document.querySelector('[data-batch-status]').textContent,
    /已暂停/
  );
});

test('empty production boot composes profile-ready preflight wizard into a v2 start', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: null,
    createBatchId: () => 'batch-from-wizard'
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="new-batch"]');
  click(harness.document, '[data-action="wizard-next"]');
  const fileInput = harness.document.querySelector('input[type="file"]');
  const csv = [
    '原URL,URL对应域名',
    'https://first.test/post,first.test',
    'https://second.test/post,second.test',
    'https://third.test/post,third.test'
  ].join('\n');
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{
      name: 'wizard-targets.csv',
      async arrayBuffer() {
        return new TextEncoder().encode(csv).buffer;
      }
    }]
  });
  fileInput.dispatchEvent(new harness.dom.window.Event('change', {
    bubbles: true
  }));
  await waitFor(
    () => harness.document.querySelectorAll('[data-preflight-row]').length === 3,
    'three preflight rows'
  );

  click(harness.document, '[data-action="wizard-next"]');
  click(harness.document, '[data-action="wizard-next"]');
  click(harness.document, '[data-action="wizard-start"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint?.batchId === 'batch-from-wizard',
    'wizard checkpoint'
  );
  await waitFor(
    () => harness.tabsApi.createCalls.length === 3,
    'wizard worker tabs'
  );

  const current = harness.storageLocal.data.batchRuntimeCheckpoint;
  assert.equal(current.version, 2);
  assert.equal(current.settings.assignment.identityId, 'default-identity');
  assert.equal(
    current.settings.assignment.promotionSiteId,
    'default-promotion-site'
  );
  assert.equal(current.source.parsedUrls.length, 3);
  assert.equal(JSON.stringify(current).includes('test-only-key'), false);
  assert.ok(harness.draftWrites.length > 0);
});

test('offline pauses owned tabs and returning online never resumes automatically', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'worker tabs');

  harness.dom.window.dispatchEvent(new harness.dom.window.Event('offline'));
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.status === 'paused_recovery',
    'offline recovery checkpoint'
  );
  const resumesBeforeOnline = harness.runtimeMessages.filter(
    (message) => message.type === 'BATCH_SESSION_RESUME'
  ).length;
  harness.dom.window.dispatchEvent(new harness.dom.window.Event('online'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(harness.runtimeMessages.filter(
    (message) => message.type === 'BATCH_SESSION_RESUME'
  ).length, resumesBeforeOnline);
  assert.match(
    harness.document.querySelector('[data-batch-status]').textContent,
    /已暂停/
  );
});

test('destroy removes page/runtime/timer layers and closes automatic tab ownership', async () => {
  const harness = await createProductionHarness();
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');

  await harness.page.destroy();

  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(harness.runtimePageListeners.size, 0);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 0);
  assert.equal(harness.tabsApi.onUpdated.listeners.size, 0);
  assert.equal(harness.document.querySelector('[data-console-layer]'), null);
  assert.equal(harness.document.querySelector('[data-batch-console]').textContent, '');
});
