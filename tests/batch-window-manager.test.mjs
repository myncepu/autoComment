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
