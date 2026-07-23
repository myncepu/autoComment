const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

function createBatchHarness() {
  const makeElement = () => ({
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    addEventListener() {},
    appendChild() {},
    removeChild() {},
    querySelectorAll() { return []; }
  });
  const intervalCalls = [];
  const chrome = {
    storage: {
      local: {
        set() {},
        remove(_keys, callback) { callback?.(); }
      },
      sync: {}
    },
    tabs: {
      sendMessage() { return Promise.resolve({ ok: true }); }
    }
  };
  const context = vm.createContext({
    URL,
    chrome,
    window: {
      AutoCommentIllegalSiteFilter: {
        evaluateUrl() { return { blocked: false }; }
      }
    },
    document: {
      addEventListener() {},
      getElementById() { return makeElement(); },
      createElement() { return makeElement(); },
      body: makeElement()
    },
    console: {
      log() {},
      warn() {},
      error() {}
    },
    alert() {},
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
        setState(next) {
          if ('batchId' in next) batchId = next.batchId;
          if ('parsedUrls' in next) parsedUrls = next.parsedUrls;
          if ('status' in next) status = next.status;
          if ('scheduler' in next) scheduler = next.scheduler;
          if ('windowManager' in next) windowManager = next.windowManager;
          if ('openingActivities' in next) openingActivities = next.openingActivities;
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
        },
        getState() {
          return {
            localResults,
            successCount,
            failCount,
            pendingCount
          };
        }
      };
    `);
  vm.runInContext(script, context);
  return {
    api: context.__batchTest,
    chrome,
    intervalCalls
  };
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
  assert.match(script, /windowManager\.create\(/);
  assert.doesNotMatch(script, /activeTabCount\s*>=\s*1/);
  assert.doesNotMatch(script, /chrome\.tabs\.create\(\{\s*url,\s*active:\s*true/);
});

test('terminal paths close a worker window before replenishing the queue', () => {
  const script = read('batch.js');
  const start = script.indexOf('async function finalizeTask(');
  const end = script.indexOf('\nfunction getProcessedCount()', start);
  const finalizeTask = script.slice(start, end);
  const closeIndex = finalizeTask.indexOf('await windowManager.closeByIndex(urlIndex)');
  const settleIndex = finalizeTask.indexOf('scheduler.settle(urlIndex)');
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
  assert.match(openWorkerWindow, /windowManager\.create\(/);
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const state = api.getState();
  assert.equal(state.localResults.length, 1);
  assert.equal(state.localResults[0].errorMessage, '处理超时');
  assert.equal(settleCount, 1);
  assert.equal(refillCount, 1);
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
  const oldManager = {
    getByIndex() { return activity; },
    closeByIndex() { return Promise.resolve(); }
  };
  const ownership = {
    batchId: 'batch-old',
    scheduler: oldScheduler,
    windowManager: oldManager,
    activity
  };
  api.setState({
    batchId: 'batch-old',
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
