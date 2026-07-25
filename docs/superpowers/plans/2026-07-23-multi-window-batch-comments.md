# Multi-Window Batch Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one CSV batch to process multiple websites concurrently in isolated, non-focused Chrome windows with correct result routing and refresh recovery.

**Architecture:** Add a pure queue scheduler and a Chrome-window lifecycle adapter, then wire both into `batch.js`. Move submit-refresh context from one global storage key to a background-owned, tab-indexed store accessed by a small content-script client; route every confirmation with `batchId`.

**Tech Stack:** Chrome Extension Manifest V3, browser JavaScript/ES modules, `chrome.windows`, `chrome.tabs`, `chrome.runtime`, `chrome.storage`, Node.js built-in test runner.

## Global Constraints

- One batch may run concurrently; simultaneous independent CSV batches are out of scope.
- Each active website uses one normal browser window.
- Concurrency is configurable from 1 through 10, defaults to 3, and persists in `chrome.storage.sync`.
- Worker windows use `focused: false` and are closed on terminal result, timeout, stop, or completion.
- Existing comment detection, AI generation, submission, status values, statistics, and CSV export behavior remain unchanged.
- Every result route is isolated by the exact pair `batchId` and `urlIndex`.
- Submit-refresh context expires after exactly 10 minutes.
- No new runtime dependencies.
- All production behavior changes follow red-green-refactor TDD.

## File Structure

- Create `lib/batch-scheduler.mjs`: pure concurrency normalization, result-identity validation, and URL-index queue state.
- Create `tests/batch-scheduler.test.mjs`: scheduler, resume, stop, completion, and routing tests.
- Create `lib/batch-window-manager.mjs`: isolate `chrome.windows` creation/removal and window/tab/index mappings.
- Create `tests/batch-window-manager.test.mjs`: fake-Chrome tests for window lifecycle and unexpected closure.
- Create `lib/batch-result-store.mjs`: serialize concurrent result persistence in the background.
- Create `tests/batch-result-store.test.mjs`: simultaneous result-write and deduplication tests.
- Create `lib/batch-submit-context-store.mjs`: serialized, tab-indexed storage plus background message listener.
- Create `tests/batch-submit-context-store.test.mjs`: concurrent save/get/clear/expiry tests.
- Create `lib/batch-submit-context-client.js`: content-script API for save/get/clear messages.
- Create `tests/batch-submit-context-client.test.js`: VM tests for the classic content-script bridge.
- Modify `background.js`: install the submit-context listener and preserve `batchId` in confirmations.
- Modify `content.js`: replace direct `batchSubmitCtx` access with the content bridge.
- Modify `manifest.json`: inject the content bridge before `content.js` and increment the extension patch version.
- Modify `batch.html`: add the concurrency input.
- Modify `batch.js`: load/save concurrency, run the scheduler, create isolated windows, route confirmations, stop/resume, and time out by activity.
- Create `tests/batch-multi-window-integration.test.js`: source-level integration guards for the page wiring that cannot run in Node without a full extension host.

---

### Task 1: Pure Batch Scheduler and Result Routing

**Files:**
- Create: `lib/batch-scheduler.mjs`
- Create: `tests/batch-scheduler.test.mjs`

**Interfaces:**
- Produces: `normalizeBatchConcurrency(value, fallback?) -> number`
- Produces: `isBatchConfirmationFor(message, { batchId, totalCount }) -> boolean`
- Produces: `new BatchScheduler({ totalCount, concurrency, processedIndices? })`
- Produces: `scheduler.start()`, `scheduler.stop()`, `scheduler.resume(processedIndices)`, `scheduler.takeAvailable()`, `scheduler.settle(index)`, `scheduler.activeIndices`, `scheduler.isComplete`

- [ ] **Step 1: Write failing scheduler tests**

Create `tests/batch-scheduler.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BatchScheduler,
  isBatchConfirmationFor,
  normalizeBatchConcurrency
} from '../lib/batch-scheduler.mjs';

test('normalizes batch concurrency to the supported 1 through 10 range', () => {
  assert.equal(normalizeBatchConcurrency(undefined), 3);
  assert.equal(normalizeBatchConcurrency('4'), 4);
  assert.equal(normalizeBatchConcurrency(0), 3);
  assert.equal(normalizeBatchConcurrency(11), 3);
  assert.equal(normalizeBatchConcurrency('not-a-number', 6), 6);
});

test('takes only the available concurrency slots and replenishes settled work', () => {
  const scheduler = new BatchScheduler({ totalCount: 5, concurrency: 3 });
  scheduler.start();

  assert.deepEqual(scheduler.takeAvailable(), [0, 1, 2]);
  assert.deepEqual(scheduler.takeAvailable(), []);
  assert.equal(scheduler.settle(1), true);
  assert.deepEqual(scheduler.takeAvailable(), [3]);
  assert.deepEqual(scheduler.activeIndices, [0, 2, 3]);
});

test('does not take work while stopped and resumes only unfinished indices', () => {
  const scheduler = new BatchScheduler({ totalCount: 5, concurrency: 2 });
  scheduler.start();
  assert.deepEqual(scheduler.takeAvailable(), [0, 1]);
  scheduler.stop();
  assert.deepEqual(scheduler.takeAvailable(), []);

  scheduler.resume([0, 2, 4]);
  assert.deepEqual(scheduler.takeAvailable(), [1, 3]);
});

test('settling the same index twice is idempotent', () => {
  const scheduler = new BatchScheduler({ totalCount: 1, concurrency: 1 });
  scheduler.start();
  scheduler.takeAvailable();

  assert.equal(scheduler.settle(0), true);
  assert.equal(scheduler.settle(0), false);
  assert.equal(scheduler.isComplete, true);
});

test('accepts confirmations only for the current batch and valid URL index', () => {
  const current = { batchId: 'batch-a', totalCount: 2 };

  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-a',
    urlIndex: 1
  }, current), true);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-b',
    urlIndex: 1
  }, current), false);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    batchId: 'batch-a',
    urlIndex: 2
  }, current), false);
  assert.equal(isBatchConfirmationFor({
    type: 'BATCH_CONFIRMED',
    urlIndex: 0
  }, current), false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/batch-scheduler.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/batch-scheduler.mjs`.

- [ ] **Step 3: Implement the pure scheduler**

Create `lib/batch-scheduler.mjs`:

```js
export const DEFAULT_BATCH_CONCURRENCY = 3;
export const MIN_BATCH_CONCURRENCY = 1;
export const MAX_BATCH_CONCURRENCY = 10;

export function normalizeBatchConcurrency(
  value,
  fallback = DEFAULT_BATCH_CONCURRENCY
) {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_BATCH_CONCURRENCY ||
    parsed > MAX_BATCH_CONCURRENCY
  ) {
    return fallback;
  }
  return parsed;
}

export function isBatchConfirmationFor(message, { batchId, totalCount }) {
  return Boolean(
    message &&
    message.type === 'BATCH_CONFIRMED' &&
    typeof batchId === 'string' &&
    batchId.length > 0 &&
    message.batchId === batchId &&
    Number.isInteger(message.urlIndex) &&
    message.urlIndex >= 0 &&
    message.urlIndex < totalCount
  );
}

export class BatchScheduler {
  constructor({ totalCount, concurrency, processedIndices = [] }) {
    this.totalCount = totalCount;
    this.concurrency = normalizeBatchConcurrency(concurrency);
    this.state = 'idle';
    this.active = new Set();
    this.settled = new Set(processedIndices);
    this.rebuildPending();
  }

  rebuildPending() {
    this.pending = [];
    for (let index = 0; index < this.totalCount; index += 1) {
      if (!this.settled.has(index)) this.pending.push(index);
    }
  }

  start() {
    this.state = 'running';
  }

  stop() {
    this.state = 'stopped';
  }

  resume(processedIndices = []) {
    this.active.clear();
    this.settled = new Set(processedIndices);
    this.rebuildPending();
    this.state = 'running';
  }

  takeAvailable() {
    if (this.state !== 'running') return [];
    const claimed = [];
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const index = this.pending.shift();
      if (this.active.has(index) || this.settled.has(index)) continue;
      this.active.add(index);
      claimed.push(index);
    }
    return claimed;
  }

  settle(index) {
    if (this.settled.has(index)) return false;
    this.active.delete(index);
    this.settled.add(index);
    return true;
  }

  get activeIndices() {
    return [...this.active];
  }

  get isComplete() {
    return this.totalCount > 0 && this.settled.size >= this.totalCount;
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/batch-scheduler.test.mjs
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/batch-scheduler.mjs tests/batch-scheduler.test.mjs
git commit -m "feat: add concurrent batch scheduler"
```

---

### Task 2: Isolated Chrome Window Lifecycle

**Files:**
- Create: `lib/batch-window-manager.mjs`
- Create: `tests/batch-window-manager.test.mjs`

**Interfaces:**
- Consumes: Chrome-like `windowsApi` with `create`, `remove`, and `onRemoved`.
- Produces: `new BatchWindowManager({ windowsApi, now?, onUnexpectedClose? })`
- Produces: `create(task) -> Promise<Activity>`
- Produces: `getByIndex(index)`, `getByTabId(tabId)`, `closeByIndex(index)`, `closeAll()`, `dispose()`
- Activity shape: `{ batchId, urlIndex, url, tabId, windowId, startTime }`

- [ ] **Step 1: Write failing window-manager tests**

Create `tests/batch-window-manager.test.mjs` with a fake event and fake API:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { BatchWindowManager } from '../lib/batch-window-manager.mjs';

function createFakeWindowsApi() {
  const listeners = new Set();
  const createCalls = [];
  const removeCalls = [];
  let nextId = 10;
  return {
    createCalls,
    removeCalls,
    onRemoved: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      emit(windowId) {
        for (const listener of [...listeners]) listener(windowId);
      }
    },
    async create(details) {
      createCalls.push(details);
      const windowId = nextId++;
      return { id: windowId, tabs: [{ id: windowId + 100 }] };
    },
    async remove(windowId) {
      removeCalls.push(windowId);
      this.onRemoved.emit(windowId);
    }
  };
}

test('creates one non-focused normal window and indexes its first tab', async () => {
  const windowsApi = createFakeWindowsApi();
  const manager = new BatchWindowManager({
    windowsApi,
    now: () => 1234
  });

  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 2,
    url: 'https://example.test/comments'
  });

  assert.deepEqual(windowsApi.createCalls, [{
    url: 'https://example.test/comments',
    focused: false,
    type: 'normal'
  }]);
  assert.deepEqual(activity, {
    batchId: 'batch-a',
    urlIndex: 2,
    url: 'https://example.test/comments',
    tabId: 110,
    windowId: 10,
    startTime: 1234
  });
  assert.equal(manager.getByTabId(110), activity);
  assert.equal(manager.getByIndex(2), activity);
});

test('expected close removes mappings without reporting an unexpected close', async () => {
  const windowsApi = createFakeWindowsApi();
  const unexpected = [];
  const manager = new BatchWindowManager({
    windowsApi,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  await manager.create({ batchId: 'a', urlIndex: 0, url: 'https://a.test' });

  await manager.closeByIndex(0);

  assert.deepEqual(windowsApi.removeCalls, [10]);
  assert.equal(manager.getByIndex(0), null);
  assert.deepEqual(unexpected, []);
});

test('user window closure reports exactly the matching activity', async () => {
  const windowsApi = createFakeWindowsApi();
  const unexpected = [];
  const manager = new BatchWindowManager({
    windowsApi,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  const activity = await manager.create({
    batchId: 'a',
    urlIndex: 0,
    url: 'https://a.test'
  });

  windowsApi.onRemoved.emit(activity.windowId);

  assert.deepEqual(unexpected, [activity]);
  assert.equal(manager.getByIndex(0), null);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/batch-window-manager.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the window manager**

Create `lib/batch-window-manager.mjs`:

```js
function requireCreatedWindow(createdWindow) {
  const windowId = createdWindow?.id;
  const tabId = createdWindow?.tabs?.[0]?.id;
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
    throw new Error('浏览器窗口创建成功但未返回可用标签页');
  }
  return { windowId, tabId };
}

export class BatchWindowManager {
  constructor({ windowsApi, now = Date.now, onUnexpectedClose = () => {} }) {
    this.windowsApi = windowsApi;
    this.now = now;
    this.onUnexpectedClose = onUnexpectedClose;
    this.byIndex = new Map();
    this.byTabId = new Map();
    this.byWindowId = new Map();
    this.expectedWindowIds = new Set();
    this.handleRemoved = this.handleRemoved.bind(this);
    this.windowsApi.onRemoved.addListener(this.handleRemoved);
  }

  async create(task) {
    const createdWindow = await this.windowsApi.create({
      url: task.url,
      focused: false,
      type: 'normal'
    });
    const { windowId, tabId } = requireCreatedWindow(createdWindow);
    const activity = {
      ...task,
      tabId,
      windowId,
      startTime: this.now()
    };
    this.byIndex.set(task.urlIndex, activity);
    this.byTabId.set(tabId, activity);
    this.byWindowId.set(windowId, activity);
    return activity;
  }

  getByIndex(index) {
    return this.byIndex.get(index) || null;
  }

  getByTabId(tabId) {
    return this.byTabId.get(tabId) || null;
  }

  removeMappings(activity) {
    this.byIndex.delete(activity.urlIndex);
    this.byTabId.delete(activity.tabId);
    this.byWindowId.delete(activity.windowId);
  }

  handleRemoved(windowId) {
    const activity = this.byWindowId.get(windowId);
    if (!activity) return;
    this.removeMappings(activity);
    if (this.expectedWindowIds.delete(windowId)) return;
    this.onUnexpectedClose(activity);
  }

  async closeByIndex(index) {
    const activity = this.getByIndex(index);
    if (!activity) return null;
    this.expectedWindowIds.add(activity.windowId);
    try {
      await this.windowsApi.remove(activity.windowId);
    } catch {
      this.expectedWindowIds.delete(activity.windowId);
      this.removeMappings(activity);
    }
    return activity;
  }

  async closeAll() {
    const indices = [...this.byIndex.keys()];
    await Promise.all(indices.map((index) => this.closeByIndex(index)));
  }

  dispose() {
    this.windowsApi.onRemoved.removeListener(this.handleRemoved);
  }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/batch-window-manager.test.mjs
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/batch-window-manager.mjs tests/batch-window-manager.test.mjs
git commit -m "feat: manage isolated batch windows"
```

---

### Task 3: Serialized Concurrent Result Persistence

**Files:**
- Create: `lib/batch-result-store.mjs`
- Create: `tests/batch-result-store.test.mjs`
- Modify: `background.js`
- Modify: `content.js`

**Interfaces:**
- Produces: `createBatchResultStore(storageArea) -> { save(message) }`
- Consumes result identity `batchId + urlIndex`.
- Preserves storage keys `batchResults` and `batchReportedUrls`.

- [ ] **Step 1: Write a failing simultaneous-write test**

Create `tests/batch-result-store.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchResultStore } from '../lib/batch-result-store.mjs';

function createDelayedStorage() {
  const data = { batchResults: [], batchReportedUrls: [] };
  return {
    data,
    async get() {
      await new Promise((resolve) => setImmediate(resolve));
      return structuredClone(data);
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(data, structuredClone(values));
    }
  };
}

test('serializes simultaneous result writes without losing either URL', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);

  await Promise.all([
    store.save({ batchId: 'a', urlIndex: 0, result: 'success' }),
    store.save({ batchId: 'a', urlIndex: 1, result: 'fail' })
  ]);

  assert.deepEqual(
    storage.data.batchResults.map(({ batchId, urlIndex, result }) => ({
      batchId,
      urlIndex,
      result
    })),
    [
      { batchId: 'a', urlIndex: 0, result: 'success' },
      { batchId: 'a', urlIndex: 1, result: 'fail' }
    ]
  );
});

test('updates a duplicate task result instead of appending it', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);
  await store.save({ batchId: 'a', urlIndex: 0, result: 'fail' });
  await store.save({ batchId: 'a', urlIndex: 0, result: 'success' });

  assert.equal(storage.data.batchResults.length, 1);
  assert.equal(storage.data.batchResults[0].result, 'success');
  assert.deepEqual(storage.data.batchReportedUrls, ['a:0']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/batch-result-store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the serialized result store**

Create `lib/batch-result-store.mjs`:

```js
export function createBatchResultStore(storageArea) {
  let operation = Promise.resolve();

  return {
    save(message) {
      const saveOperation = operation.then(async () => {
        const data = await storageArea.get([
          'batchResults',
          'batchReportedUrls'
        ]);
        const results = Array.isArray(data.batchResults)
          ? data.batchResults
          : [];
        const entry = {
          batchId: message.batchId,
          urlIndex: message.urlIndex,
          url: message.url || '',
          result: message.result,
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null,
          timestamp: Date.now()
        };
        const existingIndex = results.findIndex((item) =>
          item.batchId === entry.batchId &&
          item.urlIndex === entry.urlIndex
        );
        if (existingIndex >= 0) {
          results[existingIndex] = { ...results[existingIndex], ...entry };
        } else {
          results.push(entry);
        }
        while (results.length > 100) results.shift();

        const reported = Array.isArray(data.batchReportedUrls)
          ? data.batchReportedUrls
          : [];
        const key = `${entry.batchId}:${entry.urlIndex}`;
        if (!reported.includes(key)) reported.push(key);
        while (reported.length > 500) reported.shift();

        await storageArea.set({
          batchResults: results,
          batchReportedUrls: reported
        });
      });
      operation = saveOperation.catch(() => {});
      return saveOperation;
    }
  };
}
```

Import and instantiate the store once in `background.js`, then replace the body of `persistBatchReport` with:

```js
async function persistBatchReport(message) {
  await batchResultStore.save(message);
}
```

Add a `BATCH_PERSIST_PENDING_RESULT` background listener that calls
`batchResultStore.save(message)` and responds only after storage completes. It
must not broadcast a terminal confirmation because successful submissions use
this route before clicking the submit button.

Change `content.js` `writePendingResult` to persist through that awaited
background-only route:

```js
async function writePendingResult(
  batchId,
  urlIndex,
  url,
  result,
  aiContent,
  errorMessage
) {
  const response = await chrome.runtime.sendMessage({
    type: 'BATCH_PERSIST_PENDING_RESULT',
    batchId,
    urlIndex,
    url: url || '',
    result,
    aiContent,
    errorMessage
  });
  if (!response?.ok) {
    throw new Error(response?.error || '批处理待确认结果保存失败');
  }
}
```

This keeps pre-navigation durability while making the background the serialized
primary writer. Retain the existing direct-storage code only as
`reportBatchResult`'s extension-context failure fallback.

After the existing `BATCH_REPORT_RESULT` listener persists a terminal failure,
broadcast `BATCH_CONFIRMED` with `batchId`, `urlIndex`, `result`, `aiContent`,
and `errorMessage`. This lets immediately detected failures release their
window slot instead of waiting for the generic timeout. The
`BATCH_HANDLE_CONFIRM` listener keeps the same broadcast behavior for
successful and classified terminal results.

- [ ] **Step 4: Run focused result tests**

Run:

```bash
node --test tests/batch-result-store.test.mjs tests/batch-submit-order.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js content.js lib/batch-result-store.mjs tests/batch-result-store.test.mjs
git commit -m "fix: serialize concurrent batch results"
```

---

### Task 4: Tab-Indexed Submit Context in the Background

**Files:**
- Create: `lib/batch-submit-context-store.mjs`
- Create: `tests/batch-submit-context-store.test.mjs`
- Modify: `background.js`

**Interfaces:**
- Produces: `createBatchSubmitContextStore(storageArea, options?)`
- Produces: `installBatchSubmitContextListener(chromeApi, store)`
- Message types: `BATCH_SAVE_SUBMIT_CONTEXT`, `BATCH_GET_SUBMIT_CONTEXT`, `BATCH_CLEAR_SUBMIT_CONTEXT`
- Storage key: `batchSubmitContextsByTab`

- [ ] **Step 1: Write failing context-store tests**

Create tests proving simultaneous saves do not overwrite, tabs cannot read each other, expiry is 10 minutes, and invalid senders are rejected:

```js
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
    async get(key) { return { [key]: data[key] }; },
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

test('does not return contexts older than ten minutes', async () => {
  let now = 1000;
  const store = createBatchSubmitContextStore(createStorageArea(), {
    now: () => now
  });
  await store.save(11, { batchId: 'a', urlIndex: 0 });
  now += 10 * 60 * 1000 + 1;

  assert.equal(await store.get(11), null);
});

test('listener uses sender tab id and rejects extension-page senders', async () => {
  let listener;
  let tabRemovedListener;
  const chromeApi = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { onRemoved: { addListener(fn) { tabRemovedListener = fn; } } }
  };
  const saved = [];
  const cleared = [];
  const store = {
    async save(tabId, context) { saved.push({ tabId, context }); },
    async clear(tabId) { cleared.push(tabId); }
  };
  installBatchSubmitContextListener(chromeApi, store);

  const valid = await new Promise((resolve) => {
    listener(
      { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: { batchId: 'a' } },
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

  assert.deepEqual(saved, [{ tabId: 42, context: { batchId: 'a' } }]);
  assert.deepEqual(valid, { ok: true });
  assert.deepEqual(invalid, { ok: false, error: 'missing_sender_tab' });
  tabRemovedListener(42);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleared, [42]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/batch-submit-context-store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement serialized storage and the listener**

Create `lib/batch-submit-context-store.mjs`. Use one internal promise chain for all reads and mutations so two simultaneous saves cannot both read the same stale map:

```js
const STORAGE_KEY = 'batchSubmitContextsByTab';
const MAX_AGE_MS = 10 * 60 * 1000;

export function createBatchSubmitContextStore(
  storageArea,
  { now = Date.now, maxAgeMs = MAX_AGE_MS } = {}
) {
  let operation = Promise.resolve();
  const enqueue = (work) => {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  };
  const readMap = async () => {
    const data = await storageArea.get(STORAGE_KEY);
    const value = data?.[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  };

  return {
    save(tabId, context) {
      return enqueue(async () => {
        const contexts = await readMap();
        contexts[String(tabId)] = { ...context, timestamp: now() };
        await storageArea.set({ [STORAGE_KEY]: contexts });
      });
    },
    get(tabId) {
      return enqueue(async () => {
        const contexts = await readMap();
        const key = String(tabId);
        const context = contexts[key];
        if (!context) return null;
        if (now() - context.timestamp <= maxAgeMs) return context;
        delete contexts[key];
        await storageArea.set({ [STORAGE_KEY]: contexts });
        return null;
      });
    },
    clear(tabId) {
      return enqueue(async () => {
        const contexts = await readMap();
        delete contexts[String(tabId)];
        await storageArea.set({ [STORAGE_KEY]: contexts });
      });
    }
  };
}

export function installBatchSubmitContextListener(chromeApi, store) {
  chromeApi.tabs.onRemoved.addListener((tabId) => {
    void store.clear(tabId).catch(() => {});
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const methods = {
      BATCH_SAVE_SUBMIT_CONTEXT: () => store.save(sender.tab.id, message.context),
      BATCH_GET_SUBMIT_CONTEXT: () => store.get(sender.tab.id),
      BATCH_CLEAR_SUBMIT_CONTEXT: () => store.clear(sender.tab.id)
    };
    const method = methods[message?.type];
    if (!method) return undefined;
    if (!Number.isInteger(sender?.tab?.id)) {
      sendResponse({ ok: false, error: 'missing_sender_tab' });
      return false;
    }
    Promise.resolve(method())
      .then((context) => sendResponse({
        ok: true,
        ...(message.type === 'BATCH_GET_SUBMIT_CONTEXT' ? { context } : {})
      }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });
}
```

Modify `background.js`:

```js
import {
  createBatchSubmitContextStore,
  installBatchSubmitContextListener
} from './lib/batch-submit-context-store.mjs';

const batchSubmitContextStore = createBatchSubmitContextStore(
  chrome.storage.local
);
installBatchSubmitContextListener(chrome, batchSubmitContextStore);
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/batch-submit-context-store.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js lib/batch-submit-context-store.mjs tests/batch-submit-context-store.test.mjs
git commit -m "feat: isolate submit context by tab"
```

---

### Task 5: Content-Script Submit Context Client

**Files:**
- Create: `lib/batch-submit-context-client.js`
- Create: `tests/batch-submit-context-client.test.js`
- Modify: `manifest.json`
- Modify: `content.js`

**Interfaces:**
- Produces global `window.AutoCommentBatchSubmitContext`
- Produces `save(context) -> Promise<void>`, `restore() -> Promise<object|null>`, `clear() -> Promise<void>`
- Consumes Task 4 message types.

- [ ] **Step 1: Write failing client tests**

Run the classic script in a VM and assert exact messages:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadClient(responses = {}) {
  const messages = [];
  const window = {};
  const context = vm.createContext({
    window,
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return responses[message.type] || { ok: true };
        }
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../lib/batch-submit-context-client.js'), 'utf8'),
    context
  );
  return { client: window.AutoCommentBatchSubmitContext, messages };
}

test('saves, restores, and clears through background messages', async () => {
  const restored = { batchId: 'a', urlIndex: 2 };
  const { client, messages } = loadClient({
    BATCH_GET_SUBMIT_CONTEXT: { ok: true, context: restored }
  });

  await client.save(restored);
  assert.deepEqual(await client.restore(), restored);
  await client.clear();

  assert.deepEqual(messages, [
    { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: restored },
    { type: 'BATCH_GET_SUBMIT_CONTEXT' },
    { type: 'BATCH_CLEAR_SUBMIT_CONTEXT' }
  ]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/batch-submit-context-client.test.js
```

Expected: FAIL with `ENOENT` for the client script.

- [ ] **Step 3: Implement and inject the client**

Create `lib/batch-submit-context-client.js`:

```js
(() => {
  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || '批处理提交上下文操作失败');
    }
    return response;
  }

  window.AutoCommentBatchSubmitContext = {
    async save(context) {
      await request({ type: 'BATCH_SAVE_SUBMIT_CONTEXT', context });
    },
    async restore() {
      const response = await request({ type: 'BATCH_GET_SUBMIT_CONTEXT' });
      return response.context || null;
    },
    async clear() {
      await request({ type: 'BATCH_CLEAR_SUBMIT_CONTEXT' });
    }
  };
})();
```

Modify `manifest.json` so `lib/batch-submit-context-client.js` appears immediately before `content.js`, and change version `1.5.2` to `1.5.3`.

Replace the direct `chrome.storage.local` implementations in `content.js`:

```js
async function persistBatchSubmitContext(
  batchId,
  urlIndex,
  url,
  result,
  aiContent,
  errorMessage
) {
  await window.AutoCommentBatchSubmitContext.save({
    batchId,
    urlIndex,
    url,
    result,
    aiContent: aiContent || null,
    errorMessage: errorMessage || null
  });
}

async function clearBatchSubmitContext() {
  try {
    await window.AutoCommentBatchSubmitContext.clear();
  } catch (_) {}
}

async function restoreBatchContext() {
  let context = null;
  try {
    context = await window.AutoCommentBatchSubmitContext.restore();
  } catch (_) {}
  if (context) await confirmRestoredBatchSubmit(context);
}
```

Change every call to `clearBatchSubmitContext()` in async task paths to `await clearBatchSubmitContext()`. Keep `confirmRestoredBatchSubmit` responsible for confirming first and clearing second.

- [ ] **Step 4: Run focused and existing content tests**

Run:

```bash
node --test tests/batch-submit-context-client.test.js tests/batch-submit-order.test.js tests/llm-content-bridge.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js lib/batch-submit-context-client.js tests/batch-submit-context-client.test.js
git commit -m "feat: restore batch submissions per tab"
```

---

### Task 6: Concurrency UI and Strict Confirmation Identity

**Files:**
- Modify: `batch.html`
- Modify: `batch.js`
- Modify: `background.js`
- Create: `tests/batch-multi-window-integration.test.js`

**Interfaces:**
- Consumes: `normalizeBatchConcurrency`, `isBatchConfirmationFor` from Task 1.
- Adds DOM input `#concurrencyInput`.
- Adds sync key `batch_concurrency`.

- [ ] **Step 1: Write failing integration guards**

Create `tests/batch-multi-window-integration.test.js`:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

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
```

- [ ] **Step 2: Run the integration guards and verify RED**

Run:

```bash
node --test tests/batch-multi-window-integration.test.js
```

Expected: FAIL because the concurrency input and strict routing are absent.

- [ ] **Step 3: Add UI persistence and batch identity**

In `batch.html`, add above the timeout section:

```html
<div class="card-title" style="margin-top: 16px;">并发配置</div>
<div style="display:flex;align-items:center;gap:10px;">
  <label for="concurrencyInput" style="font-size:13px;font-weight:500;color:#374151;white-space:nowrap;margin:0;">并发窗口数：</label>
  <input
    type="number"
    id="concurrencyInput"
    min="1"
    max="10"
    value="3"
    style="width:80px;padding:7px 10px;border-radius:8px;border:1px solid #d1d5db;font-size:13px;outline:none;"
  />
  <span style="font-size:12px;color:#9ca3af;">范围 1~10，默认 3</span>
</div>
```

In `batch.js`, import Task 1 helpers, add `BATCH_CONCURRENCY_KEY`, `concurrencyInput`, and `concurrency`, then load before binding:

```js
async function loadConcurrencySetting() {
  const data = await chrome.storage.sync.get(BATCH_CONCURRENCY_KEY);
  concurrency = normalizeBatchConcurrency(data[BATCH_CONCURRENCY_KEY]);
  concurrencyInput.value = String(concurrency);
}

async function saveConcurrencySetting() {
  concurrency = normalizeBatchConcurrency(
    concurrencyInput.value,
    concurrency
  );
  concurrencyInput.value = String(concurrency);
  await chrome.storage.sync.set({ [BATCH_CONCURRENCY_KEY]: concurrency });
}
```

Bind `change` to `saveConcurrencySetting`. Disable the concurrency input while a batch is running so the scheduler limit is immutable for one run.

In `background.js`, add `batchId: message.batchId` immediately after `type: 'BATCH_CONFIRMED'`.

In the `batch.js` runtime listener:

```js
if (!isBatchConfirmationFor(message, { batchId, totalCount })) return;
void handleTaskConfirmed(
  message.urlIndex,
  message.result,
  message.aiContent,
  message.errorMessage
);
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/batch-scheduler.test.mjs tests/batch-multi-window-integration.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add batch.html batch.js background.js tests/batch-multi-window-integration.test.js
git commit -m "feat: configure batch window concurrency"
```

---

### Task 7: Replace Single-Tab Execution with Concurrent Window Scheduling

**Files:**
- Modify: `batch.js`
- Modify: `tests/batch-multi-window-integration.test.js`

**Interfaces:**
- Consumes: `BatchScheduler` from Task 1.
- Consumes: `BatchWindowManager` from Task 2.
- Produces page functions `fillAvailableWindows()`, `openWorkerWindow(urlIndex)`, `finalizeTask(...)`, `handleUnexpectedWindowClose(activity)`.

- [ ] **Step 1: Extend integration guards for real window wiring**

Append:

```js
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
  const end = script.indexOf('\\nfunction getProcessedCount()', start);
  const finalizeTask = script.slice(start, end);
  const closeIndex = finalizeTask.indexOf('await windowManager.closeByIndex(urlIndex)');
  const settleIndex = finalizeTask.indexOf('scheduler.settle(urlIndex)');
  const refillIndex = finalizeTask.indexOf('fillAvailableWindows()');
  assert.ok(closeIndex >= 0);
  assert.ok(settleIndex > closeIndex);
  assert.ok(refillIndex > settleIndex);
});
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
node --test tests/batch-multi-window-integration.test.js
```

Expected: FAIL because `batch.js` still uses `chrome.tabs.create` and the single-tab gate.

- [ ] **Step 3: Introduce scheduler and window-manager state**

At the top of `batch.js`, import both classes and replace `activeTabCount`, `currentIndex`, `activeTabs`, `activeTabsByIndex`, `isOpeningTab`, `tabsPendingConfirm`, and `tabsWaitingClose` with:

```js
let scheduler = null;
let windowManager = null;
let openingActivities = new Map();

function createWindowManager() {
  windowManager?.dispose();
  windowManager = new BatchWindowManager({
    windowsApi: chrome.windows,
    onUnexpectedClose: (activity) => {
      void handleUnexpectedWindowClose(activity);
    }
  });
}
```

Call `createWindowManager()` once during initialization.

- [ ] **Step 4: Start and resume through the scheduler**

In `startBatch`, after initializing counts and `batchId`:

```js
scheduler = new BatchScheduler({
  totalCount,
  concurrency
});
scheduler.start();
isTerminated = false;
fillAvailableWindows();
```

In `resumeBatch`, replace index scanning with:

```js
const processedIndices = localResults.map((result) => result.originalIndex);
scheduler = new BatchScheduler({
  totalCount,
  concurrency,
  processedIndices
});
scheduler.start();
isTerminated = false;
fillAvailableWindows();
```

- [ ] **Step 5: Implement concurrent window claiming and opening**

Replace `openNextTabSync` and `openNextTab` with:

```js
function fillAvailableWindows() {
  if (status !== 'running' || isTerminated || !scheduler) return;
  const indices = scheduler.takeAvailable();
  for (const urlIndex of indices) {
    void openWorkerWindow(urlIndex);
  }
  checkAllCompleted();
}

async function openWorkerWindow(urlIndex) {
  const item = parsedUrls[urlIndex];
  if (!item) {
    await finalizeTask(
      urlIndex,
      'fail',
      null,
      'URL 数据不存在',
      { closeWindow: false }
    );
    return;
  }

  const illegalCheck = item.illegalCheck ||
    evaluateIllegalSiteForBatchItem(item.url, item.sourceDomain);
  if (illegalCheck.blocked) {
    item.illegalCheck = illegalCheck;
    await finalizeTask(
      urlIndex,
      'blocked_illegal',
      null,
      getIllegalSiteBlockMessage(illegalCheck),
      { closeWindow: false, forcedElapsed: 0 }
    );
    return;
  }

  openingActivities.set(urlIndex, { startTime: Date.now() });
  try {
    const activity = await windowManager.create({
      batchId,
      urlIndex,
      url: item.url
    });
    openingActivities.delete(urlIndex);
    if (
      status !== 'running' ||
      isTerminated ||
      localResults.some((entry) => entry.originalIndex === urlIndex)
    ) {
      await windowManager.closeByIndex(urlIndex);
      scheduler.settle(urlIndex);
      return;
    }
    highlightPreviewRow(urlIndex, 'processing');
    startTimeoutChecker();
    updateStatsUI();
    sendTaskWhenReady(activity);
  } catch (error) {
    openingActivities.delete(urlIndex);
    await finalizeTask(
      urlIndex,
      'fail',
      null,
      `窗口创建失败：${error.message || error}`,
      { closeWindow: false }
    );
  }
}
```

Move the existing PING retry into `sendTaskWhenReady(activity)`, use
`activity.tabId`, and include the same `batchId`, `urlIndex`, and URL. If
retries exceed 20 or `BATCH_HANDLE` rejects, call `finalizeTask` immediately
instead of leaving the window until the generic timeout, but first skip that
fallback when `localResults` already contains `activity.urlIndex`; a terminal
background confirmation may close the window while the message promise is
resolving.

- [ ] **Step 6: Centralize terminal result handling**

Split current `handleTabResult` into `recordTaskResult` (existing count/UI/storage behavior only) and:

```js
async function finalizeTask(
  urlIndex,
  result,
  aiContent,
  errorMessage,
  {
    closeWindow = true,
    forcedElapsed,
    suppressCompletion = false
  } = {}
) {
  if (localResults.some((entry) => entry.originalIndex === urlIndex)) return false;

  const activity = windowManager?.getByIndex(urlIndex);
  const opening = openingActivities.get(urlIndex);
  const startTime = activity?.startTime || opening?.startTime;
  const elapsed = forcedElapsed !== undefined
    ? forcedElapsed
    : startTime
      ? Math.round((Date.now() - startTime) / 1000)
      : null;

  recordTaskResult(urlIndex, result, aiContent, errorMessage, elapsed);
  if (closeWindow) {
    await windowManager.closeByIndex(urlIndex);
  }
  openingActivities.delete(urlIndex);
  scheduler?.settle(urlIndex);

  if (!suppressCompletion && status === 'running' && !isTerminated) {
    fillAvailableWindows();
  }
  checkAllCompleted({ suppressCompletion });
  return true;
}

async function handleTaskConfirmed(urlIndex, result, aiContent, errorMessage) {
  await finalizeTask(urlIndex, result, aiContent, errorMessage);
}

async function handleUnexpectedWindowClose(activity) {
  if (activity.batchId !== batchId) return;
  await finalizeTask(
    activity.urlIndex,
    'fail',
    null,
    '用户手动关闭',
    { closeWindow: false }
  );
}
```

`recordTaskResult` must retain all current counter branches, row highlighting, `pendingCount`, statistics rendering, and `saveLocalResults()`, but it must not itself call `checkAllCompleted`.

- [ ] **Step 7: Convert timeout, stop, completion, and clear paths**

Timeout iteration becomes:

```js
for (const urlIndex of scheduler?.activeIndices || []) {
  const activity = windowManager.getByIndex(urlIndex);
  const opening = openingActivities.get(urlIndex);
  const startTime = activity?.startTime || opening?.startTime;
  if (startTime && (Date.now() - startTime) / 1000 > timeoutSeconds) {
    await finalizeTask(urlIndex, 'fail', null, '处理超时');
  }
}
```

Stop must set terminated state before asynchronous cleanup:

```js
isTerminated = true;
scheduler?.stop();
setStatus('terminated');
stopTimeoutChecker();
const activeIndices = scheduler?.activeIndices || [];
for (const urlIndex of activeIndices) {
  await finalizeTask(
    urlIndex,
    'fail',
    null,
    '手动终止',
    { suppressCompletion: true }
  );
}
await windowManager.closeAll();
openingActivities.clear();
updateStatsUI();
updateUI();
```

Completion closes all remaining windows without creating more work. `clearBatch` resets the scheduler, disposes/recreates the window manager, and clears opening state. Remove all remaining references to the old tab maps and single-opening lock.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
node --test \
  tests/batch-scheduler.test.mjs \
  tests/batch-window-manager.test.mjs \
  tests/batch-multi-window-integration.test.js \
  tests/batch-submit-order.test.js
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add batch.js tests/batch-multi-window-integration.test.js
git commit -m "feat: run batch comments in concurrent windows"
```

---

### Task 8: Full Regression and Extension Fixture Verification

**Files:**
- Modify only if a test exposes a defect in an already modified file.

**Interfaces:**
- Verifies all interfaces and acceptance criteria from Tasks 1–7.

- [ ] **Step 1: Run static and syntax checks**

```bash
node --check background.js
node --check content.js
node --check batch.js
git diff --check
```

Expected: every command exits 0 with no output.

- [ ] **Step 2: Run the complete automated suite**

```bash
npm test
```

Expected: all tests PASS, with no unhandled rejections or warnings introduced by the feature.

- [ ] **Step 3: Load the unpacked extension and verify the local fixture**

Start the local fixture:

```bash
npm run test:fixture
```

In Chrome:

1. Load `/Users/moltbot/Code/autoComment` as an unpacked extension.
2. Open the batch page.
3. Set concurrency to 3.
4. Upload a CSV containing at least five local fixture URLs served by the fixture process, using distinct harmless query strings if needed.
5. Start the batch.
6. Confirm that no more than three worker windows exist simultaneously.
7. Confirm that when one finishes, the fourth URL begins in a new window.
8. Confirm every result row remains associated with its original URL.
9. Repeat with concurrency 1 to verify backward-compatible sequential behavior.
10. Start again with concurrency 3, stop during processing, verify all worker windows close, then resume and verify only unfinished URLs run.

Expected: every acceptance criterion passes. Stop the fixture server with Ctrl-C after verification.

- [ ] **Step 4: Inspect final changes**

```bash
git status --short
git diff --stat HEAD~7..HEAD
git log -7 --oneline
```

Expected: only feature files and the pre-existing user-owned `.DS_Store` modification remain; `.DS_Store` is not staged or committed.

- [ ] **Step 5: Commit any verification-only correction**

Only if Step 1–3 required a code correction:

```bash
git add <exact-files-corrected>
git commit -m "fix: complete multi-window batch verification"
```

If no correction was required, do not create an empty commit.
