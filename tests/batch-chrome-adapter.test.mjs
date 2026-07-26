import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChromeBatchDependencies
} from '../lib/batch-chrome-adapter.mjs';

class FakeChromeEvent {
  listeners = new Set();

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

function createChromeHarness() {
  const runtimeMessages = [];
  const syncGets = [];
  const localGets = [];
  const localSets = [];
  const localRemoves = [];
  const windowCreates = [];
  const windowRemoves = [];
  const runtimeOnMessage = new FakeChromeEvent();
  const tabsOnRemoved = new FakeChromeEvent();
  const tabsOnUpdated = new FakeChromeEvent();
  const syncData = {
    promotion_website_url: ' https://promo.test/ ',
    promotion_website_content: ' Promotion copy. ',
    auto_fill_user_name: ' Alice ',
    auto_fill_user_email: ' alice@example.test ',
    auto_fill_user_password: 'must-not-be-requested',
    batch_checkbox_settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: false
    },
    batch_concurrency: 4,
    batch_timeout_seconds: 75,
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'openrouter/auto'
  };
  const localData = {
    llm_api_key: 'runtime-only-api-key',
    batchDraftV1: {
      step: 2,
      password: 'draft-password-must-not-leak'
    },
    batchLocalResults: {
      batchId: 'legacy',
      results: [{ result: 'success' }]
    }
  };
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: runtimeOnMessage,
      getURL(file) {
        return `chrome-extension://extension-id/${file}`;
      },
      async sendMessage(message) {
        runtimeMessages.push(structuredClone(message));
        if (message.type === 'BATCH_RECOVER_SUBMIT_CONTEXT') {
          return { ok: true, sealed: true, recovered: false };
        }
        return { ok: true, checkpoint: null };
      }
    },
    storage: {
      sync: {
        async get(keys) {
          syncGets.push(structuredClone(keys));
          return Object.fromEntries(keys.flatMap((key) => (
            Object.hasOwn(syncData, key) ? [[key, structuredClone(syncData[key])]] : []
          )));
        }
      },
      local: {
        async get(keys) {
          localGets.push(structuredClone(keys));
          return Object.fromEntries(keys.flatMap((key) => (
            Object.hasOwn(localData, key) ? [[key, structuredClone(localData[key])]] : []
          )));
        },
        async set(values) {
          localSets.push(structuredClone(values));
          Object.assign(localData, structuredClone(values));
        },
        async remove(keys) {
          localRemoves.push(structuredClone(keys));
          for (const key of keys) delete localData[key];
        }
      }
    },
    tabs: {
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      async getCurrent() {
        return { id: 9, windowId: 42 };
      },
      async create() {
        throw new Error('automatic tabs are owned by BatchTabManager');
      },
      async get() {},
      async query() {},
      async sendMessage() {},
      async remove() {},
      async update() {}
    },
    windows: {
      async create(details) {
        windowCreates.push(structuredClone(details));
        return { id: 70, tabs: [{ id: 700 }] };
      },
      async remove(windowId) {
        windowRemoves.push(windowId);
      }
    }
  };
  return {
    chromeApi,
    runtimeMessages,
    runtimeOnMessage,
    syncGets,
    localGets,
    localSets,
    localRemoves,
    windowCreates,
    windowRemoves
  };
}

test('routes runtime requests and accepts only own-extension page events', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);
  const received = [];
  const unsubscribe = dependencies.subscribeRuntimeMessages(
    (message) => received.push(structuredClone(message))
  );

  await dependencies.runtimeRequest('BATCH_SESSION_GET', { batchId: 'batch-1' });
  harness.runtimeOnMessage.emit(
    { type: 'BATCH_CONFIRMED', batchId: 'batch-1' },
    { id: 'external-extension' }
  );
  harness.runtimeOnMessage.emit(
    { type: 'UNRELATED_INTERNAL_MESSAGE', password: 'do-not-forward' },
    { id: 'extension-id' }
  );
  harness.runtimeOnMessage.emit(
    { type: 'BATCH_CONFIRMED', batchId: 'content-forged', attempt: 2 },
    {
      id: 'extension-id',
      tab: { id: 501 },
      url: 'https://target.test/post'
    }
  );
  harness.runtimeOnMessage.emit(
    { type: 'BATCH_CONFIRMED', batchId: 'page-forged', attempt: 2 },
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/batch.html'
    }
  );
  harness.runtimeOnMessage.emit(
    { type: 'BATCH_CONFIRMED', batchId: 'batch-1', attempt: 2 },
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/background.js'
    }
  );
  harness.runtimeOnMessage.emit(
    { type: 'BATCH_TASK_PHASE', batchId: 'batch-1', attempt: 2 },
    { id: 'extension-id' }
  );

  assert.deepEqual(harness.runtimeMessages[0], {
    type: 'BATCH_SESSION_GET',
    batchId: 'batch-1'
  });
  assert.deepEqual(received, [
    {
      type: 'BATCH_CONFIRMED',
      batchId: 'batch-1',
      attempt: 2
    },
    {
      type: 'BATCH_TASK_PHASE',
      batchId: 'batch-1',
      attempt: 2
    }
  ]);
  unsubscribe();
  assert.equal(harness.runtimeOnMessage.listeners.size, 0);
});

test('loads only whitelisted profile and automation settings', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  assert.deepEqual(await dependencies.loadBatchSettings(), {
    userName: 'Alice',
    userEmail: 'alice@example.test',
    websiteUrl: 'https://promo.test/',
    websiteContent: 'Promotion copy.',
    autoOpenPanel: true,
    autoGenerate: true,
    autoSubmit: false,
    concurrency: 4,
    timeoutSeconds: 75
  });
  const requested = harness.syncGets.flat();
  assert.equal(requested.includes('auto_fill_user_password'), false);
  assert.equal(JSON.stringify(await dependencies.loadBatchSettings()).includes(
    'must-not-be-requested'
  ), false);
});

test('keeps the model key out of profile state and supports durable local compatibility stores', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  assert.deepEqual(await dependencies.loadLlmConfig(), {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    apiKey: 'runtime-only-api-key'
  });
  assert.deepEqual(await dependencies.draftStorage.get(), { step: 2 });
  await dependencies.draftStorage.set({ step: 3 });
  await dependencies.draftStorage.remove();
  assert.deepEqual(await dependencies.loadLegacyResults(), {
    batchId: 'legacy',
    results: [{ result: 'success' }]
  });
  assert.deepEqual(harness.localSets.at(-1), {
    batchDraftV1: { step: 3 }
  });
  assert.deepEqual(harness.localRemoves.at(-1), ['batchDraftV1']);
});

test('uses tabs to resolve the console window and windows only for manual work', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  assert.equal(await dependencies.getConsoleWindowId(), 42);
  const handle = await dependencies.manualWindows.open(
    'https://manual.test/review'
  );

  assert.deepEqual(harness.windowCreates, [{
    url: 'https://manual.test/review',
    focused: true,
    type: 'normal'
  }]);
  assert.deepEqual(handle, {
    windowId: 70,
    tabId: 700,
    url: 'https://manual.test/review',
    automation: false
  });
  assert.equal(
    harness.runtimeMessages.some((message) => message.type === 'BATCH_HANDLE'),
    false
  );
  await dependencies.manualWindows.close(handle);
  assert.deepEqual(harness.windowRemoves, [70]);
});

test('seals submit context through the runtime without exposing Chrome to the worker', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  assert.deepEqual(await dependencies.sealSubmitContext({
    tabId: 101,
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3
  }, 'pause'), {
    sealed: true,
    recovered: false
  });
  assert.deepEqual(harness.runtimeMessages.at(-1), {
    type: 'BATCH_RECOVER_SUBMIT_CONTEXT',
    tabId: 101,
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3,
    reason: 'pause'
  });
});

test('keeps local history retry and retention compatibility behind runtime adapters', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await dependencies.retryPendingHistoryWrites();
  await dependencies.loadHistoryRetentionStatus();

  assert.deepEqual(harness.runtimeMessages, [
    { type: 'HISTORY_RETRY_PENDING' },
    { type: 'HISTORY_RETENTION_STATUS' }
  ]);
});
