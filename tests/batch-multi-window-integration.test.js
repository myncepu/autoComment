const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..');
const clone = (value) => structuredClone(value);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
      if (this.setFailure) throw this.setFailure;
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
        openerTabId: details.openerTabId,
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
      if (this.removeFailure) throw this.removeFailure;
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
    button: 0,
    cancelable: true
  }));
}

async function prepareWizardForStart(harness) {
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
}

async function createProductionHarness(options = {}) {
  const {
    createBatchRuntimeController,
    installBatchRuntimeController
  } = await import('../lib/batch-runtime-controller.mjs');
  const {
    createBatchSessionJournal
  } = await import('../lib/batch-session-journal.mjs');
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
  const storageSession = createStorageArea();
  const tabsApi = createTabsApi();
  for (const tab of options.existingTabs || []) {
    if (Number.isInteger(tab?.id)) {
      tabsApi.tabs.set(tab.id, clone(tab));
    }
  }
  const runtimeMessages = [];
  const runtimePageListeners = new Set();
  let localControlListener = null;
  const backgroundBroadcasts = [];
  const manualCreateCalls = [];
  const manualCloseCalls = [];
  const exportCalls = [];
  const draftWrites = [];
  const powerCalls = [];
  const navigateCalls = [];
  let nextManualWindowId = 700;
  let nextOwnershipEpoch = 0;
  let currentTime = 3000;
  const runtimeNow = () => ++currentTime;
  const backgroundRuntime = {
    id: 'extension-id',
    getURL(file) {
      return `chrome-extension://extension-id/${file}`;
    },
    async sendMessage(message) {
      backgroundBroadcasts.push(clone(message));
      for (const listener of [...runtimePageListeners]) {
        listener(clone(message));
      }
    },
    onMessage: new FakeChromeEvent(),
    onStartup: new FakeChromeEvent()
  };
  const runtimeController = createBatchRuntimeController({
    storageArea: storageLocal,
    sessionJournal: createBatchSessionJournal(storageSession),
    power: {
      requestKeepAwake(level) {
        powerCalls.push(['request', level]);
      },
      releaseKeepAwake() {
        powerCalls.push(['release']);
      }
    },
    tabs: tabsApi,
    runtime: backgroundRuntime,
    now: runtimeNow,
    generateOwnershipEpoch: () => `test-epoch-${++nextOwnershipEpoch}`,
    loadDomainConfig: async () => (
      options.domainConfig || { revision: 0 }
    ),
    loadRecentSuccessUrls: async () => [],
    logger: { warn() {} }
  });
  if (options.installBackgroundRuntime === true) {
    const backgroundTabs = options.delayBackgroundRemoval === true
      ? {
          ...tabsApi,
          onRemoved: {
            addListener(listener) {
              tabsApi.onRemoved.addListener((...args) => {
                setImmediate(() => listener(...args));
              });
            },
            removeListener() {}
          }
        }
      : tabsApi;
    installBatchRuntimeController({
      tabs: backgroundTabs,
      runtime: backgroundRuntime
    }, runtimeController);
  }
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
  const pageSender = {
    id: 'extension-id',
    tab: { id: 50, windowId: 42 },
    url: 'chrome-extension://extension-id/batch.html'
  };
  async function runtimeRequest(type, payload = {}) {
    runtimeMessages.push({ type, ...clone(payload) });
    if (options.runtimeGates?.[type]) {
      await options.runtimeGates[type].promise;
    }
    return runtimeController.handleMessage(
      { type, ...clone(payload) },
      pageSender
    );
  }
  const workerTabsApi = {
    onRemoved: tabsApi.onRemoved,
    onUpdated: tabsApi.onUpdated,
    async create(_details, identity) {
      const response = await runtimeRequest('BATCH_CREATE_WORKER_TAB', {
        batchId: identity.batchId,
        urlIndex: identity.urlIndex,
        attempt: identity.attempt,
        requestId: identity.requestId ||
          `${identity.batchId}:${identity.urlIndex}:${identity.attempt}`
      });
      if (!response?.ok) {
        const error = new Error(response?.error || 'tab_create_failed');
        error.code = response?.error || 'tab_create_failed';
        if (response?.recoveryRequired === true) {
          error.recoveryRequired = true;
          error.runtimeCheckpoint = response.checkpoint || null;
        }
        throw error;
      }
      return {
        ...response.tab,
        backgroundCheckpointed: true,
        runtimeCheckpoint: response.checkpoint
      };
    },
    get: (...args) => tabsApi.get(...args),
    query: (...args) => tabsApi.query(...args),
    sendMessage: (...args) => tabsApi.sendMessage(...args),
    remove: (...args) => tabsApi.remove(...args),
    update: (...args) => tabsApi.update(...args)
  };
  const dependencies = {
    runtimeRequest,
    tabsApi: workerTabsApi,
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
    subscribeLocalDebugCommands(listener) {
      localControlListener = listener;
      return () => {
        if (localControlListener === listener) localControlListener = null;
      };
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
    ...(options.requestTargetPermissions
      ? {
          requestTargetPermissions: options.requestTargetPermissions
        }
      : {}),
    ...(options.domainConfig
      ? {
          async loadDomainConfig() {
            return clone(options.domainConfig);
          },
          async loadRecentSuccessUrls() {
            return clone(options.recentSuccessUrls || []);
          }
        }
      : {}),
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
    clock: runtimeNow,
    onlineTarget: dom.window,
    isOnline: () => options.online !== false,
    navigate(href) {
      navigateCalls.push({
        href,
        checkpointStatus: storageLocal.data.batchRuntimeCheckpoint?.status,
        openTabs: tabsApi.tabs.size
      });
    }
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
    storageSession,
    storageSync,
    runtimeMessages,
    runtimePageListeners,
    backgroundBroadcasts,
    backgroundRuntime,
    manualCreateCalls,
    manualCloseCalls,
    exportCalls,
    draftWrites,
    powerCalls,
    navigateCalls,
    runtimeController,
    bootPage: () => bootBatchPage(dom.window.document, dependencies),
    emitRuntime(message) {
      for (const listener of [...runtimePageListeners]) {
        listener(clone(message));
      }
    },
    runLocalControl(message) {
      assert.equal(typeof localControlListener, 'function');
      return localControlListener(clone(message));
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

test('worker pending page is a local inert document with no script or handle path', () => {
  const html = fs.readFileSync(
    path.join(projectRoot, 'worker-pending.html'),
    'utf8'
  );
  const dom = new JSDOM(html);

  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  assert.equal(dom.window.document.querySelectorAll('[onload],[onclick]').length, 0);
  assert.equal(dom.window.document.body.textContent.trim(), '');
  assert.doesNotMatch(html, /BATCH_HANDLE|chrome\./);
  assert.match(html, /Content-Security-Policy/);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'manifest.json'),
    'utf8'
  ));
  assert.match(
    manifest.content_security_policy.extension_pages,
    /default-src 'self'/
  );
  assert.equal(
    manifest.web_accessible_resources.some(
      ({ resources }) => resources.includes('worker-pending.html')
    ),
    true
  );
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

test('pagehide hands teardown directly to background without awaiting page boot', async () => {
  const imported = await import('../lib/batch-entry-lifecycle.mjs');
  assert.equal(typeof imported.installBatchPageLifecycle, 'function');
  const dom = new JSDOM('<!doctype html><p>batch</p>');
  const bootGate = deferred();
  const backgroundGate = deferred();
  const pageDestroyCalls = [];
  const backgroundCalls = [];
  let backgroundFinished = false;
  const lifecycle = imported.installBatchPageLifecycle({
    document: dom.window.document,
    pageTarget: dom.window,
    boot: () => bootGate.promise,
    requestPageTeardown(options) {
      backgroundCalls.push(clone(options));
      return backgroundGate.promise.then(() => {
        backgroundFinished = true;
      });
    }
  });

  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  assert.deepEqual(backgroundCalls, [{ reason: 'pagehide' }]);
  assert.deepEqual(pageDestroyCalls, []);

  dom.window.close();
  backgroundGate.resolve();
  await waitFor(() => backgroundFinished, 'background teardown completion');
  assert.equal(backgroundFinished, true);

  bootGate.resolve({
      async destroy(options) {
        pageDestroyCalls.push(clone(options));
      }
    });
  await lifecycle.ready;
  await lifecycle.destroy();
  assert.deepEqual(pageDestroyCalls, [{ reason: 'page_teardown' }]);
});

test('pagehide background handoff is idempotent', async () => {
  const imported = await import('../lib/batch-entry-lifecycle.mjs');
  const dom = new JSDOM('<!doctype html><p>batch</p>');
  const calls = [];
  const lifecycle = imported.installBatchPageLifecycle({
    document: dom.window.document,
    pageTarget: dom.window,
    boot: async () => ({ async destroy() {} }),
    async requestPageTeardown(options) {
      calls.push(clone(options));
    }
  });
  await lifecycle.ready;

  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await waitFor(() => calls.length === 1, 'pagehide background handoff');
  assert.deepEqual(calls, [{ reason: 'pagehide' }]);
  assert.equal(calls.length, 1);
});

test('production page lifecycle keeps the page mounted across hidden and visible changes', async () => {
  const imported = await import('../lib/batch-entry-lifecycle.mjs');
  const dom = new JSDOM('<!doctype html><p>batch</p>');
  const calls = [];
  const lifecycle = imported.installBatchPageLifecycle({
    document: dom.window.document,
    pageTarget: dom.window,
    boot: async () => ({
      async destroy(options) {
        calls.push(clone(options));
      }
    })
  });
  await lifecycle.ready;
  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    value: 'hidden'
  });

  dom.window.document.dispatchEvent(
    new dom.window.Event('visibilitychange')
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, []);

  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  });
  dom.window.document.dispatchEvent(
    new dom.window.Event('visibilitychange')
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, []);
  await lifecycle.destroy();
  assert.deepEqual(calls, [{ reason: 'page_teardown' }]);
});

test('bootBatchPage is a per-document singleton with idempotent teardown', async (t) => {
  const harness = await createProductionHarness();
  let secondPage = null;
  t.after(async () => {
    await Promise.all([
      harness.page.destroy(),
      secondPage?.destroy()
    ]);
  });

  secondPage = await harness.bootPage();
  assert.equal(secondPage, harness.page);
  assert.equal(harness.runtimePageListeners.size, 1);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 0);

  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.tabsApi.createCalls.length === 3,
    'three singleton worker tabs'
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.tabsApi.createCalls.length, 3);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 1);

  const firstDestroy = harness.page.destroy();
  const secondDestroy = harness.page.destroy();
  assert.equal(secondDestroy, firstDestroy);
  await firstDestroy;
  assert.equal(harness.runtimePageListeners.size, 0);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 0);
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
  const createIndex = harness.runtimeMessages.findIndex(
    (message) => message.type === 'BATCH_CREATE_WORKER_TAB'
  );
  assert.ok(resumeIndex >= 0 && createIndex > resumeIndex);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_TASK_ACTIVE'
    ),
    false
  );
  assert.deepEqual(harness.tabsApi.createCalls, [
    {
      windowId: 42,
      openerTabId: 50,
      url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A0%3A1',
      active: false
    },
    {
      windowId: 42,
      openerTabId: 50,
      url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A1%3A1',
      active: false
    },
    {
      windowId: 42,
      openerTabId: 50,
      url: 'chrome-extension://extension-id/worker-pending.html#batch-1%3A2%3A1',
      active: false
    }
  ]);
  assert.equal(harness.document.querySelectorAll('[data-task-row]').length, 5);
  assert.match(harness.document.querySelector('[data-task-row="0"]').textContent, /运行|加载|worker/);
  assert.match(harness.document.querySelector('[data-task-row="4"]').textContent, /排队/);
});

test('resume requests checkpoint target permissions before reopening worker tabs', async (t) => {
  const permissionGate = deferred();
  const requestedUrls = [];
  const harness = await createProductionHarness({
    requestTargetPermissions(urls) {
      requestedUrls.push(clone(urls));
      return permissionGate.promise;
    }
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="resume"]');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedUrls, [[
    'https://target.test/0',
    'https://target.test/1',
    'https://target.test/2',
    'https://target.test/3',
    'https://target.test/4'
  ]]);
  assert.equal(
    harness.runtimeMessages.some(
      ({ type }) => type === 'BATCH_SESSION_RESUME'
    ),
    false
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);

  permissionGate.resolve(true);
  await waitFor(
    () => harness.tabsApi.createCalls.length === 3,
    'worker tabs after resume target permissions'
  );
});

test('boot renders ownership recovery instead of rejecting when worker proof is missing', async (t) => {
  const checkpoint = pausedCheckpoint({
    taskCount: 2,
    concurrency: 1
  });
  checkpoint.status = 'running';
  Object.assign(checkpoint.tasks['0'], {
    state: 'active',
    phase: 'generating',
    requestId: 'batch-1:0:1',
    tabId: 777,
    windowId: 42,
    ownerPageTabId: 50,
    ownershipEpoch: 'lost-session-epoch',
    startedAt: 1500,
    updatedAt: 2000
  });

  const harness = await createProductionHarness({
    checkpoint,
    existingTabs: [{
      id: 777,
      windowId: 42,
      openerTabId: 50,
      url: 'https://target.test/0',
      status: 'complete',
      discarded: false,
      active: false
    }]
  });
  t.after(async () => {
    harness.storageLocal.data.batchRuntimeCheckpoint = pausedCheckpoint({
      taskCount: 2,
      concurrency: 1
    });
    await harness.page.destroy();
    harness.dom.window.close();
  });

  const persisted = harness.storageLocal.data.batchRuntimeCheckpoint;
  assert.equal(persisted.status, 'paused_recovery');
  assert.equal(persisted.recoveryCleanup.reason, 'ownership_unverified');
  assert.equal(persisted.tasks['0'].state, 'active');
  assert.equal(persisted.tasks['0'].tabId, 777);
  assert.deepEqual(harness.tabsApi.removeCalls, []);
  assert.match(
    harness.document.querySelector('[data-batch-status]').textContent,
    /已暂停/
  );

  const recoveryAlert = harness.document.querySelector(
    '[data-runtime-error]'
  );
  assert.ok(recoveryAlert);
  assert.match(
    recoveryAlert.textContent,
    /无法安全验证旧 worker 标签页/
  );
  assert.doesNotMatch(
    recoveryAlert.textContent,
    /batch_ownership_unverified/
  );
  assert.equal(
    harness.document.querySelector('[data-action="resume"]').disabled,
    false
  );
  assert.equal(
    harness.document.querySelector('[data-action="stop"]').disabled,
    false
  );
  assert.equal(
    harness.document.querySelector('[data-action="new-batch"]').disabled,
    true
  );
});

test('restart requeues a missing worker and opens a replacement without a stale-tab error', async (t) => {
  const checkpoint = pausedCheckpoint({
    taskCount: 2,
    concurrency: 1
  });
  Object.assign(checkpoint, {
    status: 'paused_recovery',
    recoveryCleanup: {
      reason: 'ownership_unverified',
      diagnostic: 'ownership_proof_mismatch',
      updatedAt: 2000
    }
  });
  Object.assign(checkpoint.tasks['0'], {
    state: 'active',
    phase: 'generating',
    requestId: 'batch-1:0:1',
    tabId: 777,
    windowId: 42,
    ownerPageTabId: 49,
    ownershipEpoch: 'lost-session-epoch',
    startedAt: 1500,
    updatedAt: 2000
  });

  const harness = await createProductionHarness({ checkpoint });
  t.after(async () => {
    await harness.page.destroy();
    harness.dom.window.close();
  });

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].state,
    'queued'
  );
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].tabId,
    null
  );
  assert.equal(
    harness.document.querySelector('[data-runtime-error]'),
    null
  );

  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
      .state === 'active',
    'replacement worker activity'
  );

  const replacement =
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'];
  assert.notEqual(replacement.tabId, 777);
  assert.match(
    harness.document.querySelector('[data-command-result]').textContent,
    /resume_complete/
  );
  assert.equal(
    harness.document.querySelector('[data-runtime-error]'),
    null
  );
  assert.equal(
    harness.document.body.textContent.includes('stale_worker_tab'),
    false
  );

  click(harness.document, '[data-action="stop"]');
  click(harness.document, '[data-action="confirm-layer"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.status === 'terminated',
    'stale recovery terminated'
  );

  assert.doesNotMatch(
    harness.document.body.textContent,
    /worker_stop_rejected/
  );
  assert.equal(
    harness.document.querySelector('[data-action="new-batch"]').disabled,
    false
  );
});

test('running console disables the new-batch preview entry and cannot open its wizard', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.status === 'running',
    'running checkpoint'
  );

  const createButton = harness.document.querySelector(
    '[data-action="new-batch"]'
  );
  assert.equal(createButton.disabled, true);
  click(harness.document, '[data-action="new-batch"]');
  assert.equal(
    harness.document.querySelector('[data-batch-wizard]').hasAttribute('open'),
    false
  );
});

test('rejected new batch keeps active ownership selected and explains recovery', async (t) => {
  const harness = await createProductionHarness();
  const cleanupCheckpoint = clone(
    harness.storageLocal.data.batchRuntimeCheckpoint
  );
  t.after(async () => {
    harness.storageLocal.data.batchRuntimeCheckpoint = cleanupCheckpoint;
    await harness.page.destroy();
    harness.dom.window.close();
  });
  const activeCheckpoint = clone(cleanupCheckpoint);
  activeCheckpoint.batchId = 'owned-batch';
  activeCheckpoint.source.fileName = 'owned-targets.csv';
  activeCheckpoint.tasks['0'] = {
    ...activeCheckpoint.tasks['0'],
    state: 'active',
    phase: 'generating',
    tabId: 901,
    windowId: 42,
    startedAt: 3_000
  };
  harness.storageLocal.data.batchRuntimeCheckpoint = activeCheckpoint;

  await prepareWizardForStart(harness);
  click(harness.document, '[data-action="wizard-start"]');
  await waitFor(
    () => /当前批次仍有活动任务，请继续处理或停止批次。/.test(
      harness.document.body.textContent
    ),
    'ownership recovery guidance'
  );

  assert.doesNotMatch(
    harness.document.body.textContent,
    /batch_ownership_active/
  );

  assert.equal(
    harness.document.querySelector('[data-batch-name]').textContent,
    'owned-targets.csv'
  );
  assert.equal(
    harness.document.querySelector('[data-batch-status]').textContent,
    '已暂停，可恢复'
  );
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.type === 'BATCH_SESSION_START'
    ).length,
    1
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_CLEAR'
    ),
    false
  );
  const wizard = harness.document.querySelector('[data-batch-wizard]');
  assert.equal(wizard.hasAttribute('open'), false);
  const recoveryAlert = harness.document.querySelector(
    '[data-runtime-error]'
  );
  assert.ok(recoveryAlert);
  assert.equal(recoveryAlert.getAttribute('role'), 'alert');
  assert.equal(harness.document.activeElement, recoveryAlert);
  for (
    let ancestor = recoveryAlert;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    assert.equal(ancestor.hasAttribute('inert'), false);
    assert.notEqual(ancestor.getAttribute('aria-hidden'), 'true');
  }
  assert.equal(
    harness.document.querySelector('[data-action="resume"]').disabled,
    false
  );
  assert.equal(
    harness.document.querySelector('[data-action="stop"]').disabled,
    false
  );
  assert.equal(
    harness.document.querySelector('[data-action="new-batch"]').disabled,
    true
  );
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

test('duplicate background removal cannot regress the active replacement checkpoint', async (t) => {
  const checkpoint = pausedCheckpoint({ taskCount: 2, concurrency: 1 });
  checkpoint.source.parsedUrls[0].url = 'https://target.test/target-0';
  checkpoint.source.parsedUrls[1].url = 'https://target.test/target-1';
  checkpoint.source.rows[0][1] = 'https://target.test/target-0';
  checkpoint.source.rows[1][1] = 'https://target.test/target-1';
  const harness = await createProductionHarness({
    checkpoint,
    installBackgroundRuntime: true
  });
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
      .state === 'active',
    'first worker activity'
  );
  const firstTask = clone(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
  );
  await harness.tabsApi.remove(firstTask.tabId);
  await waitFor(
    () => harness.backgroundBroadcasts.some(
      ({ type }) => type === 'BATCH_WORKER_TAB_REMOVED'
    ),
    'background removal broadcast'
  );
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['1']
      .state === 'active',
    'refilled worker activity'
  );
  const removalMessage = harness.backgroundBroadcasts.find(
    ({ type }) => type === 'BATCH_WORKER_TAB_REMOVED'
  );
  await harness.backgroundRuntime.sendMessage(removalMessage);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].state,
    'terminal'
  );
  assert.ok(harness.tabsApi.updateCalls.some(
    ([, { url }]) => url.endsWith('/target-1')
  ));
  assert.equal(harness.tabsApi.updateCalls.filter(
    ([, { url }]) => url.endsWith('/target-1')
  ).length, 1);
  assert.match(
    harness.document.querySelector('[data-task-row="1"]').textContent,
    /运行|加载|worker/
  );
  assert.doesNotMatch(
    harness.document.querySelector('[data-task-row="1"]').textContent,
    /排队/
  );
  assert.equal(
    harness.document.querySelector('[data-runtime-error]'),
    null
  );
});

test('page-first worker removal adopts the delayed background repair and refills once', async (t) => {
  const checkpoint = pausedCheckpoint({ taskCount: 2, concurrency: 1 });
  checkpoint.source.parsedUrls[0].url = 'https://target.test/target-0';
  checkpoint.source.parsedUrls[1].url = 'https://target.test/target-1';
  checkpoint.source.rows[0][1] = 'https://target.test/target-0';
  checkpoint.source.rows[1][1] = 'https://target.test/target-1';
  const harness = await createProductionHarness({
    checkpoint,
    installBackgroundRuntime: true,
    delayBackgroundRemoval: true
  });
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
      .state === 'active',
    'first worker activity'
  );
  const firstTask = clone(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
  );

  await harness.tabsApi.remove(firstTask.tabId);

  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0']
      .state === 'terminal',
    'background terminal repair'
  );
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.tasks['1']
      .state === 'active',
    'one replacement worker'
  );

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'running'
  );
  assert.equal(
    harness.tabsApi.updateCalls.filter(
      ([, { url }]) => url.endsWith('/target-0')
    ).length,
    1
  );
  assert.equal(
    harness.tabsApi.updateCalls.filter(
      ([, { url }]) => url.endsWith('/target-1')
    ).length,
    1
  );
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.results.filter(
      ({ originalIndex, attempt }) => originalIndex === 0 && attempt === 1
    ).length,
    1
  );
  assert.equal(
    harness.document.querySelector('[data-runtime-error]'),
    null
  );
});

test('rejected removal cannot replace a live task with a different frozen profile', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: null,
    createBatchId: () => 'frozen-profile-batch'
  });
  t.after(() => harness.page.destroy());
  await prepareWizardForStart(harness);
  click(harness.document, '[data-action="wizard-start"]');
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint?.tasks?.['0']
      ?.state === 'active',
    'active frozen-profile task'
  );
  const current = clone(
    harness.storageLocal.data.batchRuntimeCheckpoint
  );
  const activeTask = current.tasks['0'];
  const rejectedCheckpoint = clone(current);
  rejectedCheckpoint.updatedAt = current.updatedAt + 100;
  Object.assign(rejectedCheckpoint.tasks['0'], {
    state: 'terminal',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    profileId: 'forged-profile'
  });

  harness.emitRuntime({
    type: 'BATCH_WORKER_TAB_REMOVED',
    batchId: current.batchId,
    urlIndex: 0,
    attempt: activeTask.attempt,
    tabId: activeTask.tabId,
    checkpoint: rejectedCheckpoint
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(
    harness.document.querySelector('[data-task-row="0"]').textContent,
    /运行|加载|worker/
  );
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].profileId,
    activeTask.profileId
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

test('local control starts a paused batch and stops only the exact confirmed batch', async (t) => {
  const permissionCalls = [];
  const harness = await createProductionHarness({
    requestTargetPermissions: async (urls) => {
      permissionCalls.push(clone(urls));
      return true;
    }
  });
  t.after(() => harness.page.destroy());

  const started = await harness.runLocalControl({ command: 'start' });
  assert.equal(started.ok, true);
  assert.equal(started.page.status, 'running');
  assert.equal(permissionCalls.length, 1);
  assert.equal(harness.tabsApi.tabs.size, 3);

  const staleStop = await harness.runLocalControl({
    command: 'stop',
    batchId: 'another-batch',
    confirmPermanent: true
  });
  assert.equal(staleStop.ok, false);
  assert.equal(staleStop.error, 'stale_batch');
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'running'
  );

  const stopped = await harness.runLocalControl({
    command: 'stop',
    batchId: 'batch-1',
    confirmPermanent: true
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.page.status, 'terminated');
  assert.equal(harness.tabsApi.tabs.size, 0);
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

test('legacy local results remain exportable when no checkpoint exists', async (t) => {
  const harness = await createProductionHarness({ checkpoint: null });
  t.after(() => harness.page.destroy());

  const exportButton = harness.document.querySelector('[data-action="export"]');
  assert.equal(exportButton.disabled, false);
  click(harness.document, '[data-action="export"]');

  assert.deepEqual(harness.exportCalls, [{
    checkpoint: null,
    legacyResults: {
      batchId: 'legacy',
      results: [{ originalIndex: 999, result: 'legacy-truncated' }]
    }
  }]);
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

test('empty production boot composes profile-ready preflight wizard into a v3 start', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: null,
    createBatchId: () => 'batch-from-wizard'
  });
  t.after(() => harness.page.destroy());

  await prepareWizardForStart(harness);
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
  assert.equal(current.version, 3);
  assert.equal(current.settings.assignment.identityId, 'default-identity');
  assert.equal(
    current.settings.assignment.promotionSiteId,
    'default-promotion-site'
  );
  assert.equal(current.source.parsedUrls.length, 3);
  assert.equal(JSON.stringify(current).includes('test-only-key'), false);
  assert.ok(harness.draftWrites.length > 0);
});

test('wizard requests target permissions before starting worker tabs', async (t) => {
  const permissionGate = deferred();
  const requestedUrls = [];
  const harness = await createProductionHarness({
    checkpoint: null,
    requestTargetPermissions(urls) {
      requestedUrls.push(clone(urls));
      return permissionGate.promise;
    }
  });
  t.after(() => harness.page.destroy());

  await prepareWizardForStart(harness);
  click(harness.document, '[data-action="wizard-start"]');

  assert.equal(
    harness.runtimeMessages.some(
      ({ type }) => type === 'BATCH_SESSION_START'
    ),
    false
  );

  permissionGate.resolve(true);
  assert.deepEqual(requestedUrls, [[
    'https://first.test/post',
    'https://second.test/post',
    'https://third.test/post'
  ]]);
  await waitFor(
    () => harness.runtimeMessages.some(
      ({ type }) => type === 'BATCH_SESSION_START'
    ),
    'batch start after target permissions'
  );
  await waitFor(
    () => harness.tabsApi.createCalls.length === 3,
    'worker tabs after target permissions'
  );
});

test('denied target permissions keep the wizard open and do not claim a batch', async (t) => {
  const permissionError = new Error('batch_target_permission_denied');
  permissionError.code = 'batch_target_permission_denied';
  const harness = await createProductionHarness({
    checkpoint: null,
    async requestTargetPermissions() {
      throw permissionError;
    }
  });
  t.after(() => harness.page.destroy());

  await prepareWizardForStart(harness);
  click(harness.document, '[data-action="wizard-start"]');
  await waitFor(
    () => harness.document.body.textContent.includes(
      '未授予目标网站访问权限'
    ),
    'target permission denial'
  );

  assert.equal(
    harness.runtimeMessages.some(
      ({ type }) => type === 'BATCH_SESSION_START'
    ),
    false
  );
  assert.equal(
    harness.document.querySelector('[data-batch-wizard]').hasAttribute('open'),
    true
  );
});

test('dispatches five rows with frozen two-Profile two-Site combinations across three slots', async (t) => {
  const domainConfig = {
    version: 2,
    revision: 12,
    profiles: [
      {
        id: 'profile-a',
        displayName: '作者 A',
        name: 'Alice',
        email: 'alice@example.test',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'profile-b',
        displayName: '作者 B',
        name: 'Bob',
        email: 'bob@example.test',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    promotionSites: [
      {
        id: 'site-a',
        name: '产品 A',
        url: 'https://promo-a.test/',
        content: '介绍 A',
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'site-b',
        name: '产品 B',
        url: 'https://promo-b.test/',
        content: '介绍 B',
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    assignmentPolicy: {
      defaultPairId: 'pair-a',
      pairs: [
        {
          id: 'pair-a',
          profileId: 'profile-a',
          promotionSiteId: 'site-a',
          weight: 1,
          enabled: true
        },
        {
          id: 'pair-b',
          profileId: 'profile-b',
          promotionSiteId: 'site-b',
          weight: 1,
          enabled: true
        }
      ],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
  const harness = await createProductionHarness({
    checkpoint: null,
    domainConfig,
    createBatchId: () => 'multi-plan'
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="new-batch"]');
  click(harness.document, '[data-action="wizard-next"]');
  const csv = [
    'URL,来源域名,profileId,promotionSiteId',
    'https://one.test/post,one.test,profile-b,site-b',
    'https://two.test/post,two.test,,',
    'https://three.test/post,three.test,,',
    'https://four.test/post,four.test,profile-a,site-a',
    'https://five.test/post,five.test,,'
  ].join('\n');
  const fileInput = harness.document.querySelector('input[type="file"]');
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{
      name: 'five-targets.csv',
      async arrayBuffer() {
        return new TextEncoder().encode(csv).buffer;
      }
    }]
  });
  fileInput.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
  await waitFor(
    () => harness.document.querySelectorAll('[data-plan-row]').length === 5,
    'five assignment preview rows'
  );
  click(harness.document, '[data-action="wizard-next"]');
  click(harness.document, '[data-action="wizard-next"]');

  for (const name of ['normalConfirmed', 'highRiskConfirmed']) {
    const input = harness.document.querySelector(`[name="${name}"]`);
    input.checked = true;
    input.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await waitFor(
      () => harness.document.querySelector(`[name="${name}"]`)?.checked === true,
      `${name} applied`
    );
  }
  await waitFor(
    () => harness.document.querySelector('[data-action="wizard-start"]').disabled === false,
    'assignment plan confirmed'
  );
  click(harness.document, '[data-action="wizard-start"]');

  await waitFor(
    () => harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_START'
    ),
    'assignment start request'
  );
  assert.doesNotMatch(
    harness.document.body.textContent,
    /confirmation_from_future|confirmation_expired|invalid_checkpoint/
  );
  await waitFor(
    () => harness.tabsApi.sendCalls.filter(
      ([, message]) => message.type === 'BATCH_HANDLE'
    ).length === 3,
    'three initial handles'
  );
  const handleCalls = harness.tabsApi.sendCalls.filter(
    ([, message]) => message.type === 'BATCH_HANDLE'
  );
  const checkpoint = harness.storageLocal.data.batchRuntimeCheckpoint;
  assert.equal(checkpoint.version, 3);
  assert.equal(checkpoint.configRevision, 12);
  assert.deepEqual(
    Object.values(checkpoint.tasks).map((task) => [
      task.profileId,
      task.promotionSiteId,
      task.assignmentSource
    ]),
    [
      ['profile-b', 'site-b', 'explicit'],
      ['profile-a', 'site-a', 'weighted'],
      ['profile-b', 'site-b', 'weighted'],
      ['profile-a', 'site-a', 'explicit'],
      ['profile-a', 'site-a', 'weighted']
    ]
  );
  assert.deepEqual(
    handleCalls.map(([, message]) => [
      message.profileId,
      message.promotionSiteId,
      message.profile.displayName,
      message.promotionSite.name
    ]),
    [
      ['profile-b', 'site-b', '作者 B', '产品 B'],
      ['profile-a', 'site-a', '作者 A', '产品 A'],
      ['profile-b', 'site-b', '作者 B', '产品 B']
    ]
  );
  assert.doesNotMatch(
    JSON.stringify({
      checkpoint,
      messages: handleCalls
    }),
    /password|secret/i
  );

  for (const urlIndex of [2, 0, 1, 4, 3]) {
    await waitFor(
      () => Number.isInteger(
        harness.storageLocal.data.batchRuntimeCheckpoint.tasks[String(urlIndex)]
          ?.tabId
      ),
      `task ${urlIndex} active`
    );
    const task = harness.storageLocal.data.batchRuntimeCheckpoint
      .tasks[String(urlIndex)];
    harness.emitRuntime({
      type: 'BATCH_CONFIRMED',
      batchId: 'multi-plan',
      urlIndex,
      attempt: task.attempt,
      sourceTabId: task.tabId,
      result: 'success',
      aiContent: `result-${urlIndex}`,
      historySaveStatus: 'saved',
      historyPendingCount: 0
    });
    await waitFor(
      () => harness.storageLocal.data.batchRuntimeCheckpoint
        .tasks[String(urlIndex)].state === 'terminal',
      `task ${urlIndex} terminal`
    );
  }

  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint.status === 'completed',
    'multi-assignment completion'
  );
  assert.equal(
    harness.tabsApi.sendCalls.filter(
      ([, message]) => message.type === 'BATCH_HANDLE'
    ).length,
    5
  );
  const finished = harness.storageLocal.data.batchRuntimeCheckpoint;
  assert.deepEqual(
    [...finished.results]
      .sort((left, right) => left.originalIndex - right.originalIndex)
      .map((result) => [
        result.profileId,
        result.promotionSiteId,
        result.aiContent
      ]),
    [
      ['profile-b', 'site-b', 'result-0'],
      ['profile-a', 'site-a', 'result-1'],
      ['profile-b', 'site-b', 'result-2'],
      ['profile-a', 'site-a', 'result-3'],
      ['profile-a', 'site-a', 'result-4']
    ]
  );
});

test('an open wizard disables readiness and start when connectivity drops', async (t) => {
  const harness = await createProductionHarness({ checkpoint: null });
  t.after(() => harness.page.destroy());
  await prepareWizardForStart(harness);
  const startButton = harness.document.querySelector(
    '[data-action="wizard-start"]'
  );
  assert.equal(startButton.disabled, false);

  harness.dom.window.dispatchEvent(new harness.dom.window.Event('offline'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.document.querySelector('[data-action="wizard-start"]').disabled,
    true
  );
  assert.match(
    harness.document.querySelector('[data-batch-wizard]').textContent,
    /batch_offline/
  );
  click(harness.document, '[data-action="wizard-start"]');
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_START'
    ),
    false
  );
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

test('empty offline boot cannot open the wizard or start a batch', async (t) => {
  const harness = await createProductionHarness({
    checkpoint: null,
    online: false
  });
  t.after(() => harness.page.destroy());

  const createButton = harness.document.querySelector('[data-action="new-batch"]');
  assert.equal(createButton.disabled, true);
  click(harness.document, '[data-action="new-batch"]');

  assert.equal(
    harness.document.querySelector('[data-batch-wizard]').hasAttribute('open'),
    false
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_START'
    ),
    false
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);
});

test('offline preempts an in-flight resume before any worker tab is created', async (t) => {
  const resumeGate = deferred();
  const harness = await createProductionHarness({
    runtimeGates: { BATCH_SESSION_RESUME: resumeGate }
  });
  t.after(() => harness.page.destroy());

  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_RESUME'
    ),
    'pending resume'
  );
  harness.dom.window.dispatchEvent(new harness.dom.window.Event('offline'));
  resumeGate.resolve();
  await waitFor(
    () => harness.tabsApi.createCalls.length > 0 ||
      harness.runtimeMessages.some(
        (message) => message.type === 'BATCH_SESSION_PAUSE'
      ),
    'resume cancellation outcome'
  );

  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_PAUSE'
    ),
    true
  );
  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'paused_recovery'
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_TASK_ACTIVE'
    ),
    false
  );
});

test('destroy delegates durable cleanup to background before local disposal', async () => {
  const harness = await createProductionHarness();
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');

  await harness.page.destroy({ reason: 'page_teardown' });

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'paused_recovery'
  );
  assert.deepEqual(harness.powerCalls.at(-1), ['release']);
  assert.deepEqual(
    harness.runtimeMessages.findLast(
      (message) => message.type === 'BATCH_PAGE_TEARDOWN'
    ),
    {
      type: 'BATCH_PAGE_TEARDOWN',
      batchId: 'batch-1',
      reason: 'page_teardown'
    }
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_PAUSE'
    ),
    false
  );
  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(harness.runtimePageListeners.size, 0);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 0);
  assert.equal(harness.tabsApi.onUpdated.listeners.size, 0);
  assert.equal(harness.document.querySelector('[data-console-layer]'), null);
  assert.equal(harness.document.querySelector('[data-batch-console]').textContent, '');
});

test('page teardown preempts an in-flight resume before worker creation', async () => {
  const resumeGate = deferred();
  const harness = await createProductionHarness({
    runtimeGates: { BATCH_SESSION_RESUME: resumeGate }
  });
  click(harness.document, '[data-action="resume"]');
  await waitFor(
    () => harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_RESUME'
    ),
    'pending resume'
  );

  const destroying = harness.page.destroy({ reason: 'pagehide' });
  resumeGate.resolve();
  await destroying;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'paused_recovery'
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_PAUSE'
    ),
    false
  );
  assert.equal(
    harness.runtimeMessages.findLast(
      (message) => message.type === 'BATCH_PAGE_TEARDOWN'
    )?.reason,
    'pagehide'
  );
});

test('page teardown durably cleans a deferred START cancelled by beginTeardown', async () => {
  const startGate = deferred();
  const harness = await createProductionHarness({
    checkpoint: null,
    createBatchId: () => 'deferred-start-batch',
    runtimeGates: { BATCH_SESSION_START: startGate }
  });
  await prepareWizardForStart(harness);
  click(harness.document, '[data-action="wizard-start"]');
  await waitFor(
    () => harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_START'
    ),
    'deferred START'
  );

  const destroying = harness.page.destroy({ reason: 'pagehide' });
  startGate.resolve();
  await destroying;

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'paused_recovery'
  );
  assert.equal(
    Object.hasOwn(
      harness.storageLocal.data.batchRuntimeCheckpoint.recoveryCleanup,
      'orphanTabIds'
    ),
    false
  );
  assert.equal(harness.tabsApi.createCalls.length, 0);
  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_TASK_ACTIVE'
    ),
    false
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_PAUSE'
    ),
    false
  );
  assert.equal(
    harness.runtimeMessages.findLast(
      (message) => message.type === 'BATCH_PAGE_TEARDOWN'
    )?.batchId,
    'deferred-start-batch'
  );
});

test('navigation cleanup failure retains UI, singleton, and retryable ownership', async () => {
  const harness = await createProductionHarness();
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');
  harness.tabsApi.removeFailure = new Error('tab close unavailable');

  const historyLink = [...harness.document.querySelectorAll('a')].find(
    (link) => link.textContent === '评论历史'
  );
  historyLink.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(
    () => harness.storageLocal.data.batchRuntimeCheckpoint
      ?.recoveryCleanup?.diagnostic === 'tab_close_failed',
    'persisted cleanup diagnostic'
  );

  assert.equal(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'paused_recovery'
  );
  assert.notEqual(
    harness.storageLocal.data.batchRuntimeCheckpoint.status,
    'running'
  );
  assert.deepEqual(harness.powerCalls.at(-1), ['release']);
  assert.equal(harness.tabsApi.tabs.size, 3);
  assert.equal(harness.tabsApi.onRemoved.listeners.size, 1);
  assert.equal(harness.navigateCalls.length, 0);
  assert.notEqual(
    harness.document.querySelector('[data-batch-console]').textContent,
    ''
  );
  assert.equal(await harness.bootPage(), harness.page);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === 'BATCH_SESSION_STOP'
    ),
    false
  );

  harness.tabsApi.removeFailure = null;
  historyLink.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(() => harness.navigateCalls.length === 1, 'retry navigation');
  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.equal(harness.runtimePageListeners.size, 0);
});

test('navigation storage failure keeps durable ownership for an explicit-missing retry', async () => {
  const harness = await createProductionHarness();
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');
  harness.storageLocal.setFailure = new Error('storage unavailable');

  const historyLink = [...harness.document.querySelectorAll('a')].find(
    (link) => link.textContent === '评论历史'
  );
  historyLink.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(
    () => /checkpoint_write_failed/.test(harness.document.body.textContent),
    'local persistence failure projection'
  );

  assert.equal(harness.storageLocal.data.batchRuntimeCheckpoint.status, 'running');
  assert.equal(harness.navigateCalls.length, 0);
  assert.equal(harness.tabsApi.tabs.size, 0);
  assert.notEqual(
    harness.document.querySelector('[data-batch-console]').textContent,
    ''
  );
  assert.equal(await harness.bootPage(), harness.page);

  harness.storageLocal.setFailure = null;
  historyLink.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(() => harness.navigateCalls.length === 1, 'storage retry navigation');
  assert.equal(harness.tabsApi.tabs.size, 0);
});

test('shared-shell navigation waits for durable pause and tab cleanup', async () => {
  const harness = await createProductionHarness();
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');

  const historyLink = [...harness.document.querySelectorAll('a')].find(
    (link) => link.textContent === '评论历史'
  );
  historyLink.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(() => harness.navigateCalls.length === 1, 'navigation');

  assert.deepEqual(harness.navigateCalls, [{
    href: 'history.html',
    checkpointStatus: 'paused_recovery',
    openTabs: 0
  }]);
  assert.equal(
    harness.runtimeMessages.findLast(
      (message) => message.type === 'BATCH_PAGE_TEARDOWN'
    )?.reason,
    'navigation'
  );
  assert.equal(harness.runtimePageListeners.size, 0);
});

test('shared-shell brand navigation also waits for durable teardown', async (t) => {
  const harness = await createProductionHarness();
  t.after(() => harness.page.destroy());
  click(harness.document, '[data-action="resume"]');
  await waitFor(() => harness.tabsApi.tabs.size === 3, 'owned tabs');

  const brand = harness.document.querySelector('.app-shell__brand');
  brand.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true
  }));
  await waitFor(() => harness.navigateCalls.length === 1, 'brand navigation');

  assert.deepEqual(harness.navigateCalls, [{
    href: 'batch.html',
    checkpointStatus: 'paused_recovery',
    openTabs: 0
  }]);
});
