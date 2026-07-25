const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

function createBatchHarness(overrides = {}) {
  const elements = new Map();
  const alerts = [];
  const runtimeListeners = [];
  const makeElement = () => {
    const classes = new Set();
    const attributes = new Map();
    const listeners = new Map();
    return {
      checked: false,
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      hidden: false,
      dataset: {},
      style: {},
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) {
          if (force === undefined ? !classes.has(name) : force) {
            classes.add(name);
            return true;
          }
          classes.delete(name);
          return false;
        },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      removeAttribute(name) { attributes.delete(name); },
      getAttribute(name) { return attributes.get(name) || null; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      click() { listeners.get('click')?.({ target: this }); },
      appendChild() {},
      removeChild() {},
      querySelectorAll() { return []; }
    };
  };
  const intervalCalls = [];
  const sendRuntimeMessage = overrides.runtimeSendMessage || ((message) => Promise.resolve(
    message.type === 'BATCH_RECOVER_SUBMIT_CONTEXT'
      ? { ok: true, sealed: true, recovered: false }
      : message.type === 'BATCH_SESSION_START'
        ? { ok: true, checkpoint: { status: 'running' } }
        : { ok: true, checkpoint: null }
  ));
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const response = Promise.resolve().then(() => sendRuntimeMessage(message));
        if (callback) response.then(callback);
        return response;
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      }
    },
    storage: {
      local: {
        set(_values, callback) { callback?.(); },
        remove(_keys, callback) { callback?.(); }
      },
      sync: {
        get(_keys, callback) {
          const result = {};
          callback?.(result);
          return Promise.resolve(result);
        },
        set(_values, callback) {
          callback?.();
          return Promise.resolve();
        }
      }
    },
    tabs: {
      sendMessage() { return Promise.resolve({ ok: true }); },
      create() { return Promise.resolve({ id: 99 }); }
    },
    windows: {}
  };
  class FakeScheduler {
    constructor({ totalCount, concurrency, processedIndices = [] }) {
      this.totalCount = totalCount;
      this.concurrency = concurrency;
      this.processedIndices = processedIndices;
      this.activeIndices = [];
      FakeScheduler.instances.push(this);
    }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    takeAvailable() { return []; }
    settle() {}
  }
  FakeScheduler.instances = [];
  class FakeWindowManager {
    constructor() {
      FakeWindowManager.instances.push(this);
    }
    dispose() {}
    getByIndex() { return null; }
    async closeAll() {}
  }
  FakeWindowManager.instances = [];
  const context = vm.createContext({
    URL,
    TextDecoder,
    chrome,
    BatchScheduler: overrides.BatchScheduler || FakeScheduler,
    BatchWindowManager: overrides.BatchWindowManager || FakeWindowManager,
    normalizeBatchConcurrency:
      overrides.normalizeBatchConcurrency ||
      ((value, fallback = 3) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10
          ? parsed
          : fallback;
      }),
    isDurableBatchConfirmation: overrides.isDurableBatchConfirmation || ((message) => {
      const result = message?.result ?? 'success';
      return result !== 'success' || ['saved', 'queued', 'not_applicable']
        .includes(message?.historySaveStatus);
    }),
    loadLlmConfig: overrides.loadLlmConfig || (async () => ({ apiKey: 'test' })),
    getBatchStartError: overrides.getBatchStartError || (() => ''),
    window: {
      AutoCommentIllegalSiteFilter: {
        evaluateUrl() { return { blocked: false }; }
      }
    },
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement() { return makeElement(); },
      body: makeElement()
    },
    console: {
      log() {},
      warn() {},
      error() {}
    },
    alert(message) { alerts.push(String(message)); },
    setInterval(callback, delay) {
      intervalCalls.push({ callback, delay });
      return intervalCalls.length;
    },
    clearInterval() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {}
  });
  const script = read('batch.js')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .concat(`
      globalThis.__batchTest = {
        openWorkerWindow,
        sendTaskWhenReady,
        recordTaskResult,
        finalizeTask,
        handleTaskConfirmed,
        onAllCompleted,
        startBatch,
        stopBatch,
        resumeBatch,
        clearBatch,
        init,
        hydrateBatchFromCheckpoint:
          typeof hydrateBatchFromCheckpoint === 'undefined'
            ? undefined
            : hydrateBatchFromCheckpoint,
        checkTimeouts,
        resetFile,
        parseCSV,
        updateUI,
        setState(next) {
          if ('batchId' in next) batchId = next.batchId;
          if ('parsedUrls' in next) {
            parsedUrls = next.parsedUrls;
            if (!('batchItems' in next) && typeof batchItems !== 'undefined') {
              batchItems = next.parsedUrls;
            }
          }
          if ('batchItems' in next && typeof batchItems !== 'undefined') batchItems = next.batchItems;
          if ('status' in next) status = next.status;
          if ('scheduler' in next) scheduler = next.scheduler;
          if ('windowManager' in next) windowManager = next.windowManager;
          if ('openingActivities' in next) openingActivities = next.openingActivities;
          if ('lifecycleToken' in next && typeof lifecycleToken !== 'undefined') {
            lifecycleToken = next.lifecycleToken;
          } else if ('batchId' in next && typeof lifecycleToken !== 'undefined') {
            lifecycleToken = next.batchId === null ? null : {};
          }
          if ('isTerminated' in next) isTerminated = next.isTerminated;
          if ('localResults' in next) localResults = next.localResults;
          if ('totalCount' in next) totalCount = next.totalCount;
          if ('successCount' in next) successCount = next.successCount;
          if ('failCount' in next) failCount = next.failCount;
          if ('skippedCount' in next) skippedCount = next.skippedCount;
          if ('noCommentBoxCount' in next) noCommentBoxCount = next.noCommentBoxCount;
          if ('manualRequiredCount' in next) manualRequiredCount = next.manualRequiredCount;
          if ('blockedIllegalCount' in next) blockedIllegalCount = next.blockedIllegalCount;
          if ('pendingCount' in next) pendingCount = next.pendingCount;
          if ('timeoutSeconds' in next) timeoutSeconds = next.timeoutSeconds;
          if ('timeoutCheckTimer' in next) timeoutCheckTimer = next.timeoutCheckTimer;
          if ('batchSourceFileName' in next && typeof batchSourceFileName !== 'undefined') {
            batchSourceFileName = next.batchSourceFileName;
          }
          if ('batchSourceHeaders' in next && typeof batchSourceHeaders !== 'undefined') {
            batchSourceHeaders = next.batchSourceHeaders;
          }
        },
        getState() {
          return {
            localResults,
            batchId,
            parsedUrls,
            batchItems: typeof batchItems === 'undefined' ? null : batchItems,
            lifecycleToken: typeof lifecycleToken === 'undefined' ? null : lifecycleToken,
            status,
            isTerminated,
            successCount,
            failCount,
            pendingCount,
            batchSourceFileName:
              typeof batchSourceFileName === 'undefined'
                ? ''
                : batchSourceFileName,
            batchSourceHeaders:
              typeof batchSourceHeaders === 'undefined'
                ? []
                : batchSourceHeaders
          };
        }
      };
    `);
  vm.runInContext(script, context);
  return {
    api: context.__batchTest,
    chrome,
    elements,
    alerts,
    runtimeListeners,
    intervalCalls,
    FakeScheduler,
    FakeWindowManager
  };
}

function csvBuffer(url) {
  return new TextEncoder().encode(`URL\n${url}`).buffer;
}

test('batch UI exposes the supported persisted concurrency control', () => {
  const html = read('batch.html');
  const script = read('batch.js');
  assert.match(html, /id="concurrencyInput"/);
  assert.match(html, /min="1"/);
  assert.match(html, /max="10"/);
  assert.match(html, /value="3"/);
  assert.match(script, /batch_concurrency/);
  assert.match(script, /normalizeBatchConcurrency/);
});

test('batch UI exposes paused recovery and wakefulness status', () => {
  const html = read('batch.html');

  assert.match(html, /id="recoveryBanner"/);
  assert.match(html, /id="recoveryMessage"/);
  assert.match(html, /id="wakeStatus"/);
});

test('background confirmations preserve batch identity', () => {
  const background = read('background.js');
  assert.match(
    background,
    /type:\s*'BATCH_CONFIRMED',[\s\S]*?batchId:\s*message\.batchId/
  );
});

test('batch page rejects confirmations that do not match its batch', () => {
  const script = read('batch.js');
  assert.match(script, /isBatchConfirmationFor\(message,\s*\{\s*batchId,\s*totalCount\s*\}\)/);
});

test('batch execution uses the scheduler and isolated Chrome windows', () => {
  const script = read('batch.js');
  assert.match(script, /new BatchScheduler\(/);
  assert.match(script, /new BatchWindowManager\(/);
  assert.match(script, /scheduler\.takeAvailable\(\)/);
  assert.match(script, /activityWindowManager\.create\(/);
  assert.doesNotMatch(script, /activeTabCount\s*>=\s*1/);
  assert.doesNotMatch(script, /chrome\.tabs\.create\(\{\s*url,\s*active:\s*true/);
});

test('running batch rejects preview replacement and removal and records from its start snapshot', async () => {
  const { api, elements, FakeWindowManager } = createBatchHarness();
  const oldItem = {
    originalIndex: 0,
    url: 'https://old.test',
    sourceDomain: 'old.test',
    originalRow: ['https://old.test']
  };
  api.setState({
    parsedUrls: [oldItem],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  await api.startBatch();
  api.parseCSV(csvBuffer('https://replacement.test'), 'replacement.csv');
  api.resetFile();
  api.recordTaskResult(0, 'success', 'saved', null, 0);

  const state = api.getState();
  assert.equal(state.status, 'running');
  assert.equal(state.parsedUrls.length, 1);
  assert.equal(state.parsedUrls[0], oldItem);
  assert.notEqual(state.batchItems[0], oldItem);
  assert.equal(state.localResults[0].url, 'https://old.test');
  assert.equal(elements.get('fileInput').disabled, true);
  assert.equal(elements.get('uploadZone').classList.contains('disabled'), true);
  assert.equal(elements.get('fileRemove').getAttribute('aria-disabled'), 'true');
});

test('terminated batch retains its start snapshot and cannot resume', async () => {
  const { api, elements, FakeWindowManager } = createBatchHarness();
  const oldItem = {
    originalIndex: 0,
    url: 'https://resume.test',
    sourceDomain: 'resume.test',
    originalRow: ['https://resume.test']
  };
  api.setState({
    parsedUrls: [oldItem],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  await api.startBatch();
  await api.stopBatch();
  assert.equal(elements.get('startBtn').disabled, true);
  assert.equal(elements.get('startBtn').textContent, '■ 已终止');
  api.parseCSV(csvBuffer('https://replacement.test'), 'replacement.csv');
  api.resetFile();
  await api.resumeBatch();

  const state = api.getState();
  assert.equal(state.status, 'terminated');
  assert.equal(state.parsedUrls[0], oldItem);
  assert.equal(state.localResults.length, 0);
});

test('Start claims synchronously and ignores a second Start while config is pending', async () => {
  let resolveConfig;
  let loadCount = 0;
  const configPromise = new Promise((resolve) => {
    resolveConfig = resolve;
  });
  const { api, FakeScheduler, FakeWindowManager, elements } = createBatchHarness({
    loadLlmConfig() {
      loadCount += 1;
      return configPromise;
    }
  });
  api.setState({
    parsedUrls: [{ url: 'https://single-flight.test', sourceDomain: '' }],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  const firstStart = api.startBatch();
  const secondStart = api.startBatch();

  assert.equal(api.getState().status, 'starting');
  assert.equal(loadCount, 1);
  assert.equal(elements.get('startBtn').disabled, true);
  resolveConfig({ apiKey: 'test' });
  await Promise.all([firstStart, secondStart]);

  assert.equal(api.getState().status, 'running');
  assert.equal(FakeScheduler.instances.length, 1);
});

test('Start durably creates the complete runtime session before scheduling', async () => {
  const runtimeMessages = [];
  let resolveRuntimeStart;
  const runtimeStart = new Promise((resolve) => {
    resolveRuntimeStart = resolve;
  });
  const { api, FakeScheduler, FakeWindowManager } = createBatchHarness({
    runtimeSendMessage(message) {
      runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      if (message.type === 'BATCH_SESSION_START') return runtimeStart;
      return Promise.resolve({ ok: true });
    }
  });
  const items = [
    {
      originalIndex: 0,
      url: 'https://first.test',
      sourceDomain: 'first.test',
      originalRow: ['1', 'https://first.test']
    },
    {
      originalIndex: 1,
      url: 'https://second.test',
      sourceDomain: 'second.test',
      originalRow: ['2', 'https://second.test']
    }
  ];
  api.setState({
    parsedUrls: items,
    batchSourceFileName: 'source.csv',
    batchSourceHeaders: ['id', 'URL'],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  const starting = api.startBatch();
  for (let attempt = 0; attempt < 10 && runtimeMessages.length === 0; attempt += 1) {
    await Promise.resolve();
  }

  assert.equal(runtimeMessages[0].type, 'BATCH_SESSION_START');
  assert.equal(runtimeMessages[0].source.fileName, 'source.csv');
  assert.deepEqual(runtimeMessages[0].source.headers, ['id', 'URL']);
  assert.deepEqual(runtimeMessages[0].source.rows, [
    ['1', 'https://first.test'],
    ['2', 'https://second.test']
  ]);
  assert.equal(runtimeMessages[0].source.parsedUrls.length, 2);
  assert.equal(runtimeMessages[0].settings.timeoutSeconds, 60);
  assert.equal(runtimeMessages[0].settings.concurrency, 3);
  assert.equal(FakeScheduler.instances.length, 0);

  resolveRuntimeStart({ ok: true, checkpoint: { status: 'running' } });
  await starting;
  assert.equal(FakeScheduler.instances.length, 1);
  assert.equal(api.getState().status, 'running');
});

test('a keep-awake failure preserves the uploaded dataset and stays idle', async () => {
  const { api, alerts, FakeScheduler, FakeWindowManager } = createBatchHarness({
    runtimeSendMessage(message) {
      if (message.type === 'BATCH_SESSION_START') {
        return Promise.resolve({
          ok: false,
          error: 'power_request_failed'
        });
      }
      return Promise.resolve({ ok: true });
    }
  });
  const item = {
    originalIndex: 0,
    url: 'https://power.test',
    sourceDomain: 'power.test',
    originalRow: ['https://power.test']
  };
  api.setState({
    parsedUrls: [item],
    batchSourceFileName: 'power.csv',
    batchSourceHeaders: ['URL'],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  await api.startBatch();

  const state = api.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.parsedUrls[0], item);
  assert.equal(state.batchSourceFileName, 'power.csv');
  assert.equal(FakeScheduler.instances.length, 0);
  assert.match(alerts[0], /无法阻止系统休眠/);
});

test('worker activity is checkpointed before the content task is sent', async () => {
  const order = [];
  let activity;
  const { api, chrome } = createBatchHarness({
    runtimeSendMessage(message) {
      if (message.type === 'BATCH_TASK_ACTIVE') {
        order.push(['runtime', JSON.parse(JSON.stringify(message))]);
      }
      return Promise.resolve({ ok: true });
    }
  });
  chrome.tabs.sendMessage = async (_tabId, message) => {
    order.push(['tab', message.type]);
    return { ok: true };
  };
  const manager = {
    async create({ batchId, urlIndex, url }) {
      activity = {
        batchId,
        urlIndex,
        url,
        tabId: 41,
        windowId: 51,
        startTime: 1000
      };
      return activity;
    },
    getByIndex() {
      return activity;
    },
    async closeByIndex() {}
  };
  api.setState({
    batchId: 'batch-active',
    parsedUrls: [{
      originalIndex: 0,
      url: 'https://active.test',
      sourceDomain: 'active.test',
      originalRow: ['https://active.test']
    }],
    status: 'running',
    scheduler: {
      get activeIndices() { return [0]; },
      takeAvailable() { return []; },
      settle() {}
    },
    windowManager: manager,
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    pendingCount: 2
  });

  await api.openWorkerWindow(0);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(order[0], ['runtime', {
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-active',
    urlIndex: 0,
    tabId: 41,
    windowId: 51,
    startedAt: 1000
  }]);
  assert.deepEqual(order[1], ['tab', 'PING']);
});

test('a paused checkpoint hydrates the complete page and resumes only on click', async () => {
  const runtimeMessages = [];
  const items = [
    {
      originalIndex: 0,
      url: 'https://done.test',
      sourceDomain: 'done.test',
      originalRow: ['1', 'https://done.test']
    },
    {
      originalIndex: 1,
      url: 'https://queued.test',
      sourceDomain: 'queued.test',
      originalRow: ['2', 'https://queued.test']
    }
  ];
  const checkpoint = {
    version: 1,
    batchId: 'batch-recovered',
    status: 'paused_recovery',
    createdAt: 1000,
    updatedAt: 2000,
    source: {
      fileName: 'recovered.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 90,
      concurrency: 2
    },
    cursor: { nextIndex: 1 },
    tasks: {
      0: {
        urlIndex: 0,
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1500
      },
      1: {
        urlIndex: 1,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1500
      }
    },
    results: [{
      originalIndex: 0,
      url: 'https://done.test',
      sourceDomain: 'done.test',
      result: 'success',
      aiContent: 'done',
      errorMessage: null,
      timestamp: 1500,
      elapsed: 1,
      originalRow: ['1', 'https://done.test']
    }]
  };
  const { api, elements, FakeScheduler } = createBatchHarness({
    runtimeSendMessage(message) {
      runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      if (message.type === 'BATCH_SESSION_LOAD_FOR_PAGE') {
        return Promise.resolve({ ok: true, checkpoint });
      }
      if (message.type === 'BATCH_SESSION_RESUME') {
        return Promise.resolve({
          ok: true,
          checkpoint: { ...checkpoint, status: 'running' }
        });
      }
      return Promise.resolve({ ok: true });
    }
  });

  await api.init();

  let state = api.getState();
  assert.equal(state.status, 'paused_recovery');
  assert.equal(state.batchId, 'batch-recovered');
  assert.equal(state.parsedUrls.length, 2);
  assert.equal(state.localResults.length, 1);
  assert.equal(state.successCount, 1);
  assert.equal(state.pendingCount, 1);
  assert.equal(state.batchSourceFileName, 'recovered.csv');
  assert.deepEqual(Array.from(state.batchSourceHeaders), ['id', 'URL']);
  assert.equal(elements.get('statusBadge').textContent, '已暂停');
  assert.equal(elements.get('startBtn').textContent, '▶ 继续处理');
  assert.equal(elements.get('recoveryBanner').hidden, false);
  assert.equal(elements.get('wakeStatus').textContent, '系统保活已暂停');
  assert.equal(FakeScheduler.instances.length, 1);
  assert.equal(FakeScheduler.instances[0].started, undefined);

  await api.resumeBatch();

  state = api.getState();
  assert.equal(state.status, 'running');
  assert.equal(FakeScheduler.instances.at(-1).started, true);
  const resumeIndex = runtimeMessages.findIndex(
    (message) => message.type === 'BATCH_SESSION_RESUME'
  );
  assert.ok(resumeIndex >= 0);
  assert.equal(elements.get('wakeStatus').textContent, '系统保持唤醒中');
});

test('Clear during deferred Start invalidates the old continuation', async () => {
  let resolveConfig;
  const configPromise = new Promise((resolve) => {
    resolveConfig = resolve;
  });
  const { api, FakeScheduler, FakeWindowManager } = createBatchHarness({
    loadLlmConfig() { return configPromise; }
  });
  api.setState({
    parsedUrls: [{ url: 'https://cancelled.test', sourceDomain: '' }],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  const starting = api.startBatch();
  api.clearBatch();
  resolveConfig({ apiKey: 'test' });
  await starting;

  const state = api.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.batchId, null);
  assert.equal(state.batchItems, null);
  assert.equal(state.parsedUrls.length, 0);
  assert.equal(FakeScheduler.instances.length, 0);
});

test('settings persistence failure restores the claimed Start lifecycle to safe idle state', async () => {
  const { api, chrome, FakeScheduler, FakeWindowManager, elements } = createBatchHarness();
  chrome.storage.local.set = () => {
    throw new Error('storage unavailable');
  };
  api.setState({
    parsedUrls: [{ url: 'https://settings-fail.test', sourceDomain: '' }],
    status: 'idle',
    windowManager: new FakeWindowManager()
  });

  await api.startBatch();

  const state = api.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.lifecycleToken, null);
  assert.equal(FakeScheduler.instances.length, 0);
  assert.equal(elements.get('fileInput').disabled, false);
});

test('terminal paths close a worker window before replenishing the queue', () => {
  const script = read('batch.js');
  const start = script.indexOf('async function finalizeTask(');
  const end = script.indexOf('\nfunction getProcessedCount()', start);
  const finalizeTask = script.slice(start, end);
  const closeIndex = finalizeTask.indexOf('await taskWindowManager.closeByIndex(urlIndex)');
  const settleIndex = finalizeTask.indexOf('taskScheduler.settle(urlIndex)');
  const refillIndex = finalizeTask.indexOf('fillAvailableWindows()');
  assert.ok(closeIndex >= 0);
  assert.ok(settleIndex > closeIndex);
  assert.ok(refillIndex > settleIndex);
});

test('late window creation stays bound to the batch and manager that opened it', () => {
  const script = read('batch.js');
  const start = script.indexOf('async function openWorkerWindow(');
  const end = script.indexOf('\nfunction sendTaskWhenReady(', start);
  const openWorkerWindow = script.slice(start, end);
  assert.match(openWorkerWindow, /const activityBatchId = batchId/);
  assert.match(openWorkerWindow, /const activityWindowManager = windowManager/);
  assert.match(openWorkerWindow, /activityWindowManager\.create\(/);
  assert.match(openWorkerWindow, /activityWindowManager\.closeByIndex\(urlIndex\)/);
  assert.match(openWorkerWindow, /batchId !== activityBatchId/);
});

test('opening reservations time out and release capacity before window creation resolves', async () => {
  const { api, intervalCalls } = createBatchHarness();
  let settleCount = 0;
  let refillCount = 0;
  api.setState({
    batchId: 'batch-a',
    parsedUrls: [{ url: 'https://a.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      settle() { settleCount += 1; },
      takeAvailable() {
        refillCount += 1;
        return [];
      },
      get activeIndices() { return [0]; }
    },
    windowManager: {
      create() { return new Promise(() => {}); },
      getByIndex() { return null; },
      async closeByIndex() {}
    },
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2,
    timeoutSeconds: -1,
    timeoutCheckTimer: null
  });

  void api.openWorkerWindow(0);
  assert.equal(intervalCalls.length, 1);

  intervalCalls[0].callback();
  await new Promise(setImmediate);

  const state = api.getState();
  assert.equal(state.localResults.length, 1);
  assert.equal(state.localResults[0].errorMessage, '处理超时');
  assert.equal(settleCount, 1);
  assert.equal(refillCount, 1);
});

test('deferred timeout scan cannot continue into a replacement lifecycle', async () => {
  const { api } = createBatchHarness();
  let resolveFirstClose;
  let oldSettleCount = 0;
  const oldToken = {};
  const oldScheduler = {
    get activeIndices() { return [0, 1]; },
    settle() { oldSettleCount += 1; },
    takeAvailable() { return []; }
  };
  const oldManager = {
    getByIndex(index) {
      return {
        batchId: 'batch-old',
        urlIndex: index,
        startTime: 1
      };
    },
    closeByIndex(index) {
      if (index === 0) {
        return new Promise((resolve) => {
          resolveFirstClose = resolve;
        });
      }
      return Promise.resolve();
    }
  };
  api.setState({
    batchId: 'batch-old',
    lifecycleToken: oldToken,
    parsedUrls: [
      { url: 'https://old-0.test', sourceDomain: '' },
      { url: 'https://old-1.test', sourceDomain: '' }
    ],
    status: 'running',
    scheduler: oldScheduler,
    windowManager: oldManager,
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2,
    timeoutSeconds: -1
  });

  const scanning = api.checkTimeouts();
  await new Promise(setImmediate);

  let replacementCloseCount = 0;
  let replacementSettleCount = 0;
  api.setState({
    batchId: 'batch-new',
    lifecycleToken: {},
    parsedUrls: [{ url: 'https://new.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      get activeIndices() { return [0]; },
      stop() {},
      settle() { replacementSettleCount += 1; },
      takeAvailable() { return []; }
    },
    windowManager: {
      getByIndex() {
        return { batchId: 'batch-new', urlIndex: 0, startTime: 1 };
      },
      async closeByIndex() { replacementCloseCount += 1; },
      async closeAll() {}
    },
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  resolveFirstClose();
  await scanning;

  assert.equal(oldSettleCount, 1);
  assert.equal(replacementCloseCount, 0);
  assert.equal(replacementSettleCount, 0);
  assert.equal(api.getState().localResults.length, 0);
});

test('timeout seals and recovers a worker context before closing its window', async () => {
  let closeCount = 0;
  let settleCount = 0;
  let recoveryMessage;
  const { api } = createBatchHarness({
    runtimeSendMessage(message) {
      if (message.type === 'BATCH_RECOVER_SUBMIT_CONTEXT') {
        recoveryMessage = JSON.parse(JSON.stringify(message));
      }
      return Promise.resolve({ ok: true, sealed: true, recovered: true });
    }
  });
  api.setState({
    batchId: 'batch-ambiguous',
    parsedUrls: [{ url: 'https://ambiguous.test', sourceDomain: '' }],
    batchItems: [{ url: 'https://ambiguous.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      get activeIndices() { return [0]; },
      settle() { settleCount += 1; },
      takeAvailable() { return []; }
    },
    windowManager: {
      getByIndex() {
        return {
          batchId: 'batch-ambiguous',
          urlIndex: 0,
          tabId: 77,
          startTime: Date.now() - 5000
        };
      },
      async closeByIndex() { closeCount += 1; }
    },
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2,
    timeoutSeconds: 1
  });

  await api.checkTimeouts();

  assert.deepEqual(recoveryMessage, {
    type: 'BATCH_RECOVER_SUBMIT_CONTEXT',
    tabId: 77,
    batchId: 'batch-ambiguous',
    urlIndex: 0,
    reason: 'timeout'
  });
  assert.equal(closeCount, 1);
  assert.equal(settleCount, 1);
  assert.equal(api.getState().localResults[0].result, 'manual_required');
  assert.match(api.getState().localResults[0].errorMessage, /已保留/);
});

test('stale BATCH_HANDLE rejection cannot finalize the replacement batch', async () => {
  const { api, chrome } = createBatchHarness();
  let rejectHandle;
  let sendCount = 0;
  chrome.tabs.sendMessage = () => {
    sendCount += 1;
    if (sendCount === 1) return Promise.resolve({ ok: true });
    return new Promise((_resolve, reject) => {
      rejectHandle = reject;
    });
  };

  const activity = {
    batchId: 'batch-old',
    urlIndex: 0,
    url: 'https://old.test',
    tabId: 10
  };
  const oldScheduler = { settle() {} };
  const oldLifecycleToken = {};
  const oldManager = {
    getByIndex() { return activity; },
    closeByIndex() { return Promise.resolve(); }
  };
  const ownership = {
    batchId: 'batch-old',
    lifecycleToken: oldLifecycleToken,
    scheduler: oldScheduler,
    windowManager: oldManager,
    activity
  };
  api.setState({
    batchId: 'batch-old',
    lifecycleToken: oldLifecycleToken,
    parsedUrls: [{ url: 'https://old.test', sourceDomain: '' }],
    status: 'running',
    scheduler: oldScheduler,
    windowManager: oldManager,
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  api.sendTaskWhenReady(activity, ownership);
  await Promise.resolve();
  await Promise.resolve();

  let replacementCloseCount = 0;
  let replacementSettleCount = 0;
  const replacementActivity = { ...activity, batchId: 'batch-new', tabId: 20 };
  api.setState({
    batchId: 'batch-new',
    parsedUrls: [{ url: 'https://new.test', sourceDomain: '' }],
    scheduler: {
      settle() { replacementSettleCount += 1; },
      takeAvailable() { return []; },
      stop() {},
      get activeIndices() { return []; }
    },
    windowManager: {
      getByIndex() { return replacementActivity; },
      async closeByIndex() { replacementCloseCount += 1; },
      async closeAll() {}
    },
    localResults: []
  });

  rejectHandle(new Error('old send rejected'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(api.getState().localResults.length, 0);
  assert.equal(replacementCloseCount, 0);
  assert.equal(replacementSettleCount, 0);
});

test('missing parsed URL records a terminal failure with safe defaults', () => {
  const { api } = createBatchHarness();
  api.setState({
    batchId: 'batch-a',
    parsedUrls: [],
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  api.recordTaskResult(0, 'success', 'ignored', null, 0);

  const state = api.getState();
  assert.equal(state.localResults.length, 1);
  assert.equal(state.localResults[0].url, '');
  assert.equal(state.localResults[0].sourceDomain, '');
  assert.equal(state.localResults[0].result, 'fail');
  assert.equal(state.localResults[0].errorMessage, 'URL 数据不存在');
  assert.equal(state.successCount, 0);
  assert.equal(state.failCount, 1);
  assert.equal(state.pendingCount, 0);
});

test('a zero pending count reconciles earlier queued history rows', async () => {
  const { api } = createBatchHarness();
  const items = [
    { url: 'https://first.test', sourceDomain: '', originalRow: [] },
    { url: 'https://second.test', sourceDomain: '', originalRow: [] },
    { url: 'https://third.test', sourceDomain: '', originalRow: [] }
  ];
  api.setState({
    batchId: 'batch-history',
    parsedUrls: items,
    batchItems: items,
    status: 'running',
    scheduler: {
      settle() {},
      takeAvailable() { return []; },
      get activeIndices() { return [1]; }
    },
    windowManager: {
      getByIndex() {
        return { batchId: 'batch-history', urlIndex: 1, startTime: Date.now() };
      },
      async closeByIndex() {}
    },
    localResults: [{
      originalIndex: 0,
      url: 'https://first.test',
      sourceDomain: '',
      result: 'success',
      aiContent: 'first',
      errorMessage: null,
      historySaveStatus: 'queued',
      timestamp: Date.now(),
      elapsed: 1,
      originalRow: []
    }],
    totalCount: 3,
    successCount: 1,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2
  });

  await api.handleTaskConfirmed(
    1,
    'success',
    'second',
    null,
    'saved',
    0
  );

  assert.deepEqual(
    api.getState().localResults.map((entry) => entry.historySaveStatus),
    ['saved', 'saved']
  );
});

test('a durable confirmation from an old tab cannot close a replacement worker', async () => {
  let closeCount = 0;
  let settleCount = 0;
  const { api } = createBatchHarness();
  api.setState({
    batchId: 'batch-confirm',
    parsedUrls: [{ url: 'https://confirm.test', sourceDomain: '' }],
    batchItems: [{ url: 'https://confirm.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      get activeIndices() { return [0]; },
      settle() { settleCount += 1; },
      takeAvailable() { return []; }
    },
    windowManager: {
      getByIndex() {
        return {
          batchId: 'batch-confirm',
          urlIndex: 0,
          tabId: 77,
          startTime: Date.now()
        };
      },
      async closeByIndex() { closeCount += 1; }
    },
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  await api.handleTaskConfirmed(
    0,
    'success',
    'confirmed',
    null,
    'saved',
    0,
    66
  );

  assert.equal(closeCount, 0);
  assert.equal(settleCount, 0);
  assert.deepEqual(api.getState().localResults, []);
});

test('deferred finalizer cannot mutate a replacement same-index lifecycle', async () => {
  const { api } = createBatchHarness();
  let resolveClose;
  let oldCloseCount = 0;
  let oldSettleCount = 0;
  const oldOpening = { batchId: 'batch-old', startTime: 1 };
  const oldOpenings = new Map([[0, oldOpening]]);
  const oldScheduler = {
    settle() { oldSettleCount += 1; }
  };
  const oldManager = {
    getByIndex() {
      return { batchId: 'batch-old', urlIndex: 0, startTime: 1 };
    },
    closeByIndex() {
      oldCloseCount += 1;
      return new Promise((resolve) => {
        resolveClose = resolve;
      });
    }
  };
  api.setState({
    batchId: 'batch-old',
    parsedUrls: [{ url: 'https://old.test', sourceDomain: '' }],
    status: 'running',
    scheduler: oldScheduler,
    windowManager: oldManager,
    openingActivities: oldOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2
  });

  const finalizing = api.finalizeTask(
    0,
    'fail',
    null,
    'old task failed'
  );
  await new Promise(setImmediate);
  assert.equal(oldCloseCount, 1);

  let replacementSettleCount = 0;
  let replacementRefillCount = 0;
  let replacementCloseCount = 0;
  const replacementOpening = { batchId: 'batch-new', startTime: 2 };
  const replacementOpenings = new Map([[0, replacementOpening]]);
  api.setState({
    batchId: 'batch-new',
    parsedUrls: [{ url: 'https://new.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      settle() { replacementSettleCount += 1; },
      takeAvailable() {
        replacementRefillCount += 1;
        return [];
      },
      get activeIndices() { return [0]; }
    },
    windowManager: {
      getByIndex() {
        return { batchId: 'batch-new', urlIndex: 0, startTime: 2 };
      },
      async closeByIndex() { replacementCloseCount += 1; }
    },
    openingActivities: replacementOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  resolveClose();
  await finalizing;

  assert.equal(replacementSettleCount, 0);
  assert.equal(replacementRefillCount, 0);
  assert.equal(replacementCloseCount, 0);
  assert.equal(replacementOpenings.get(0), replacementOpening);
  assert.equal(api.getState().localResults.length, 0);
  assert.equal(oldSettleCount, 1);
});

test('deferred late-create cleanup cannot mutate resumed same-index work', async () => {
  const { api } = createBatchHarness();
  let resolveCreate;
  let resolveClose;
  let closeCount = 0;
  let oldSettleCount = 0;
  const oldOpening = { batchId: 'batch-a', startTime: 1 };
  const oldOpenings = new Map([[0, oldOpening]]);
  const oldScheduler = {
    settle() { oldSettleCount += 1; }
  };
  const activity = {
    batchId: 'batch-a',
    urlIndex: 0,
    url: 'https://old.test',
    tabId: 10,
    windowId: 20,
    startTime: 2
  };
  const manager = {
    create() {
      return new Promise((resolve) => {
        resolveCreate = resolve;
      });
    },
    closeByIndex() {
      closeCount += 1;
      return new Promise((resolve) => {
        resolveClose = resolve;
      });
    }
  };
  api.setState({
    batchId: 'batch-a',
    parsedUrls: [{ url: 'https://old.test', sourceDomain: '' }],
    status: 'running',
    scheduler: oldScheduler,
    windowManager: manager,
    openingActivities: oldOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 2,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 2,
    timeoutCheckTimer: null
  });

  const openingWindow = api.openWorkerWindow(0);
  api.setState({
    status: 'terminated',
    isTerminated: true
  });
  resolveCreate(activity);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCount, 1);

  let resumedSettleCount = 0;
  let resumedRefillCount = 0;
  const resumedOpening = { batchId: 'batch-a', startTime: 3 };
  const resumedOpenings = new Map([[0, resumedOpening]]);
  api.setState({
    status: 'running',
    scheduler: {
      settle() { resumedSettleCount += 1; },
      takeAvailable() {
        resumedRefillCount += 1;
        return [];
      },
      get activeIndices() { return [0]; }
    },
    windowManager: manager,
    openingActivities: resumedOpenings,
    isTerminated: false,
    localResults: []
  });

  resolveClose();
  await openingWindow;

  assert.equal(resumedSettleCount, 0);
  assert.equal(resumedRefillCount, 0);
  assert.equal(resumedOpenings.get(0), resumedOpening);
  assert.equal(oldSettleCount, 1);
  assert.equal(closeCount, 1);
});

test('deferred Stop cleanup cannot close or erase a replacement lifecycle', async () => {
  const { api } = createBatchHarness();
  let resolveClose;
  let oldStopCount = 0;
  let oldSettleCount = 0;
  let oldCloseCount = 0;
  let oldCloseAllCount = 0;
  const oldToken = {};
  const oldOpening = { batchId: 'batch-old', startTime: 1 };
  const oldOpenings = new Map([[0, oldOpening]]);
  const oldActivity = {
    batchId: 'batch-old',
    urlIndex: 0,
    url: 'https://old.test',
    tabId: 10,
    windowId: 20,
    startTime: 1
  };
  const oldScheduler = {
    stop() { oldStopCount += 1; },
    settle() { oldSettleCount += 1; },
    get activeIndices() { return [0]; }
  };
  const oldManager = {
    getByIndex() { return oldActivity; },
    closeByIndex() {
      oldCloseCount += 1;
      return new Promise((resolve) => {
        resolveClose = resolve;
      });
    },
    async closeAll() { oldCloseAllCount += 1; }
  };
  api.setState({
    batchId: 'batch-old',
    parsedUrls: [{ url: 'https://old.test', sourceDomain: '' }],
    batchItems: [{ url: 'https://old.test', sourceDomain: '' }],
    lifecycleToken: oldToken,
    status: 'running',
    scheduler: oldScheduler,
    windowManager: oldManager,
    openingActivities: oldOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  const stopping = api.stopBatch();
  assert.equal(oldStopCount, 1);
  await new Promise(setImmediate);
  assert.equal(oldCloseCount, 1);

  let replacementStopCount = 0;
  let replacementSettleCount = 0;
  let replacementCloseAllCount = 0;
  const replacementToken = {};
  const replacementOpening = { batchId: 'batch-new', startTime: 2 };
  const replacementOpenings = new Map([[0, replacementOpening]]);
  api.setState({
    batchId: 'batch-new',
    parsedUrls: [{ url: 'https://new.test', sourceDomain: '' }],
    batchItems: [{ url: 'https://new.test', sourceDomain: '' }],
    lifecycleToken: replacementToken,
    status: 'running',
    scheduler: {
      stop() { replacementStopCount += 1; },
      settle() { replacementSettleCount += 1; },
      get activeIndices() { return [0]; }
    },
    windowManager: {
      getByIndex() {
        return { batchId: 'batch-new', urlIndex: 0, startTime: 2 };
      },
      async closeAll() { replacementCloseAllCount += 1; }
    },
    openingActivities: replacementOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });
  api.updateUI();

  resolveClose();
  await stopping;

  assert.equal(oldSettleCount, 1);
  assert.equal(oldCloseAllCount, 0);
  assert.equal(replacementStopCount, 0);
  assert.equal(replacementSettleCount, 0);
  assert.equal(replacementCloseAllCount, 0);
  assert.equal(replacementOpenings.get(0), replacementOpening);
  assert.equal(api.getState().status, 'running');
});

test('Stop recovers an unresolved submit context before closing its worker', async () => {
  let recoveryMessage;
  let closeCount = 0;
  let settleCount = 0;
  const { api } = createBatchHarness({
    runtimeSendMessage(message) {
      if (message.type === 'BATCH_RECOVER_SUBMIT_CONTEXT') {
        recoveryMessage = JSON.parse(JSON.stringify(message));
      }
      return Promise.resolve({ ok: true, sealed: true, recovered: true });
    }
  });
  api.setState({
    batchId: 'batch-stop-recovery',
    parsedUrls: [{ url: 'https://stop.test', sourceDomain: '' }],
    batchItems: [{ url: 'https://stop.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      get activeIndices() { return [0]; },
      stop() {},
      settle() { settleCount += 1; },
      takeAvailable() { return []; }
    },
    windowManager: {
      getByIndex() {
        return {
          batchId: 'batch-stop-recovery',
          urlIndex: 0,
          tabId: 44,
          startTime: Date.now()
        };
      },
      async closeByIndex() { closeCount += 1; }
    },
    openingActivities: new Map(),
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });

  await api.stopBatch();

  assert.deepEqual(recoveryMessage, {
    type: 'BATCH_RECOVER_SUBMIT_CONTEXT',
    tabId: 44,
    batchId: 'batch-stop-recovery',
    urlIndex: 0,
    reason: 'stop'
  });
  assert.equal(closeCount, 1);
  assert.equal(settleCount, 1);
  assert.equal(api.getState().localResults[0].result, 'manual_required');
});

test('deferred completion cannot stop or clear a replacement lifecycle', async () => {
  const { api, elements } = createBatchHarness();
  let resolveCloseAll;
  let oldCloseAllCount = 0;
  let oldStopCount = 0;
  const oldOpening = { batchId: 'batch-old', startTime: 1 };
  const oldOpenings = new Map([[0, oldOpening]]);
  const oldScheduler = {
    stop() { oldStopCount += 1; },
    get activeIndices() { return []; }
  };
  const closeAllPromise = new Promise((resolve) => {
    resolveCloseAll = resolve;
  });
  const oldManager = {
    closeAll() {
      oldCloseAllCount += 1;
      return closeAllPromise;
    }
  };
  api.setState({
    batchId: 'batch-old',
    parsedUrls: [{ url: 'https://old.test', sourceDomain: '' }],
    status: 'running',
    scheduler: oldScheduler,
    windowManager: oldManager,
    openingActivities: oldOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 1,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 0,
    timeoutCheckTimer: null
  });
  api.updateUI();

  const completion = api.onAllCompleted();
  const stopButton = elements.get('stopBtn');
  const completionDisabledStopImmediately = stopButton.disabled;
  const completionHidStopImmediately = stopButton.style.display === 'none';

  const stopping = api.stopBatch();
  const statusAfterStopAttempt = api.getState().status;

  let replacementStopCount = 0;
  let replacementCloseAllCount = 0;
  const replacementOpening = { batchId: 'batch-new', startTime: 2 };
  const replacementOpenings = new Map([[0, replacementOpening]]);
  api.setState({
    batchId: 'batch-new',
    parsedUrls: [{ url: 'https://new.test', sourceDomain: '' }],
    status: 'running',
    scheduler: {
      stop() { replacementStopCount += 1; },
      get activeIndices() { return [0]; }
    },
    windowManager: {
      async closeAll() { replacementCloseAllCount += 1; }
    },
    openingActivities: replacementOpenings,
    isTerminated: false,
    localResults: [],
    totalCount: 1,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    noCommentBoxCount: 0,
    manualRequiredCount: 0,
    blockedIllegalCount: 0,
    pendingCount: 1
  });
  api.updateUI();

  resolveCloseAll();
  await Promise.all([completion, stopping]);

  assert.equal(replacementOpenings.get(0), replacementOpening);
  assert.equal(replacementStopCount, 0);
  assert.equal(replacementCloseAllCount, 0);
  assert.equal(api.getState().status, 'running');
  assert.equal(stopButton.disabled, false);
  assert.equal(stopButton.style.display, 'inline-flex');
  assert.equal(completionDisabledStopImmediately, true);
  assert.equal(completionHidStopImmediately, true);
  assert.equal(statusAfterStopAttempt, 'completing');
  assert.equal(oldStopCount, 1);
  assert.equal(oldCloseAllCount, 1);
});
