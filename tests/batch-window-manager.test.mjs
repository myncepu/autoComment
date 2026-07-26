import assert from 'node:assert/strict';
import test from 'node:test';

import { BatchTabManager } from '../lib/batch-window-manager.mjs';

function createFakeTabsApi() {
  const listeners = new Set();
  const createCalls = [];
  const removeCalls = [];
  const updateCalls = [];
  let nextId = 110;
  return {
    createCalls,
    removeCalls,
    updateCalls,
    onRemoved: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      emit(tabId, removeInfo = {
        windowId: 10,
        isWindowClosing: false
      }) {
        for (const listener of [...listeners]) listener(tabId, removeInfo);
      }
    },
    async create(details) {
      createCalls.push(details);
      return {
        id: nextId++,
        windowId: details.windowId,
        url: details.url,
        status: 'loading',
        discarded: false
      };
    },
    async remove(tabId) {
      removeCalls.push(tabId);
      this.onRemoved.emit(tabId);
    },
    async update(tabId, changes) {
      updateCalls.push([tabId, changes]);
      return { id: tabId, windowId: 10, active: changes.active };
    }
  };
}

test('creates background tabs in one configured window and indexes each by tab identity', async () => {
  const tabsApi = createFakeTabsApi();
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    now: () => 1234
  });

  const first = await manager.create({
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 1,
    url: 'https://example.test/comments'
  });
  const second = await manager.create({
    batchId: 'batch-a',
    urlIndex: 3,
    attempt: 1,
    url: 'https://second.test/comments'
  });

  assert.deepEqual(tabsApi.createCalls, [{
    windowId: 10,
    url: 'https://example.test/comments',
    active: false
  }, {
    windowId: 10,
    url: 'https://second.test/comments',
    active: false
  }]);
  assert.deepEqual(first, {
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 1,
    url: 'https://example.test/comments',
    tabId: 110,
    windowId: 10,
    startTime: 1234
  });
  assert.equal(second.tabId, 111);
  assert.equal(manager.getByTabId(110), first);
  assert.equal(manager.getByTabId(111), second);
  assert.equal(manager.getByIndex(2), first);
  assert.equal(manager.getByIndex(3), second);
});

test('propagates background checkpoint ownership with the task identity', async () => {
  const tabsApi = createFakeTabsApi();
  const runtimeCheckpoint = {
    version: 2,
    batchId: 'batch-a',
    status: 'running'
  };
  let receivedIdentity = null;
  tabsApi.create = async (details, identity) => {
    tabsApi.createCalls.push(details);
    receivedIdentity = identity;
    return {
      id: 210,
      windowId: details.windowId,
      url: 'https://checkpoint.test/comments',
      backgroundCheckpointed: true,
      runtimeCheckpoint
    };
  };
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    now: () => 1234
  });

  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 3,
    url: 'https://untrusted-page-value.test/comments'
  });

  assert.deepEqual(receivedIdentity, {
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 3
  });
  assert.equal(activity.backgroundCheckpointed, true);
  assert.equal(activity.runtimeCheckpoint, runtimeCheckpoint);
  assert.equal(activity.url, 'https://checkpoint.test/comments');
});

test('expected close removes one tab without disturbing another worker in the shared window', async () => {
  const tabsApi = createFakeTabsApi();
  const unexpected = [];
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  const first = await manager.create({
    batchId: 'a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });
  const second = await manager.create({
    batchId: 'a',
    urlIndex: 1,
    attempt: 1,
    url: 'https://b.test'
  });

  await manager.closeByIndex(0);

  assert.deepEqual(tabsApi.removeCalls, [first.tabId]);
  assert.equal(manager.getByIndex(0), null);
  assert.equal(manager.getByIndex(1), second);
  assert.equal(manager.getByTabId(second.tabId), second);
  assert.deepEqual(unexpected, []);
});

test('user tab closure reports exactly the matching activity', async () => {
  const tabsApi = createFakeTabsApi();
  const unexpected = [];
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  const activity = await manager.create({
    batchId: 'a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  tabsApi.onRemoved.emit(activity.tabId);

  assert.deepEqual(unexpected, [activity]);
  assert.equal(manager.getByIndex(0), null);
});

test('rejects another batch and duplicate attempt without creating tabs', async () => {
  const tabsApi = createFakeTabsApi();
  const manager = new BatchTabManager({ tabsApi, windowId: 10 });
  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  await assert.rejects(
    manager.create({
      batchId: 'batch-b',
      urlIndex: 1,
      attempt: 1,
      url: 'https://b.test'
    }),
    /批次/
  );
  await assert.rejects(
    manager.create({
      batchId: 'batch-a',
      urlIndex: 0,
      attempt: 1,
      url: 'https://b.test'
    }),
    /URL 索引/
  );

  assert.equal(tabsApi.createCalls.length, 1);
  assert.equal(manager.getByIndex(0), activity);
});

test('a newer same-index attempt supersedes a pending create without overwriting its tab', async () => {
  const tabsApi = createFakeTabsApi();
  const pendingCreates = [];
  tabsApi.create = (details) => {
    tabsApi.createCalls.push(details);
    return new Promise((resolve) => pendingCreates.push(resolve));
  };
  const manager = new BatchTabManager({ tabsApi, windowId: 10 });

  const oldCreate = manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://old.test'
  });
  const newCreate = manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 2,
    url: 'https://new.test'
  });
  pendingCreates[1]({ id: 111, windowId: 10 });
  const replacement = await newCreate;
  pendingCreates[0]({ id: 110, windowId: 10 });

  await assert.rejects(oldCreate, /已被更新尝试替代/);
  assert.deepEqual(tabsApi.removeCalls, [110]);
  assert.equal(manager.getByIndex(0), replacement);
  assert.equal(manager.getByTabId(111), replacement);
  assert.equal(manager.getByTabId(110), null);
});

test('removes a returned tab when Chrome creates it outside the configured window', async () => {
  const tabsApi = createFakeTabsApi();
  tabsApi.create = async (details) => {
    tabsApi.createCalls.push(details);
    return { id: 110, windowId: 99 };
  };
  const manager = new BatchTabManager({ tabsApi, windowId: 10 });

  await assert.rejects(
    manager.create({
      batchId: 'batch-a',
      urlIndex: 0,
      attempt: 1,
      url: 'https://a.test'
    }),
    /目标浏览器窗口/
  );

  assert.deepEqual(tabsApi.removeCalls, [110]);
  assert.equal(manager.getByIndex(0), null);
});

test('already-absent tab removal clears the activity without routing an unexpected close', async () => {
  const tabsApi = createFakeTabsApi();
  tabsApi.remove = async (tabId) => {
    tabsApi.removeCalls.push(tabId);
    throw new Error(`No tab with id: ${tabId}.`);
  };
  const unexpected = [];
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  await manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  await manager.closeByIndex(0);

  assert.deepEqual(tabsApi.removeCalls, [110]);
  assert.equal(manager.getByIndex(0), null);
  assert.equal(manager.getByTabId(110), null);
  assert.deepEqual(unexpected, []);
});

test('transient tab removal failure retains mappings and a later close remains unexpected', async () => {
  const tabsApi = createFakeTabsApi();
  tabsApi.remove = async (tabId) => {
    tabsApi.removeCalls.push(tabId);
    throw new Error('Permission denied while removing tab');
  };
  const unexpected = [];
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  await assert.rejects(manager.closeByIndex(0), /Permission denied/);

  assert.equal(manager.getByIndex(0), activity);
  assert.equal(manager.getByTabId(110), activity);
  tabsApi.onRemoved.emit(activity.tabId);
  assert.deepEqual(unexpected, [activity]);
});

test('focus activates only the requested worker tab', async () => {
  const tabsApi = createFakeTabsApi();
  const manager = new BatchTabManager({ tabsApi, windowId: 10 });
  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  await manager.focusByIndex(0);

  assert.deepEqual(tabsApi.updateCalls, [[activity.tabId, { active: true }]]);
});

test('dispose detaches the tab-removed listener', async () => {
  const tabsApi = createFakeTabsApi();
  const unexpected = [];
  const manager = new BatchTabManager({
    tabsApi,
    windowId: 10,
    onUnexpectedClose: (activity) => unexpected.push(activity)
  });
  const activity = await manager.create({
    batchId: 'batch-a',
    urlIndex: 0,
    attempt: 1,
    url: 'https://a.test'
  });

  manager.dispose();
  tabsApi.onRemoved.emit(activity.tabId);

  assert.deepEqual(unexpected, []);
  assert.equal(manager.getByIndex(0), activity);
});
