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
  const permissionChecks = [];
  const permissionRequests = [];
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
        if (message.type === 'BATCH_CREATE_WORKER_TAB') {
          return {
            ok: true,
            checkpoint: {
              version: 2,
              batchId: message.batchId,
              status: 'running'
            },
            tab: {
              id: 501,
              windowId: 42,
              url: 'https://checkpoint.test/worker',
              active: false
            }
          };
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
    },
    permissions: {
      async contains(details) {
        permissionChecks.push(structuredClone(details));
        return false;
      },
      async request(details) {
        permissionRequests.push(structuredClone(details));
        return true;
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
    windowRemoves,
    permissionChecks,
    permissionRequests
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
  harness.runtimeOnMessage.emit(
    {
      type: 'BATCH_TASK_PHASE_UPDATED',
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 2,
      phase: 'generating',
      sourceTabId: 503
    },
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/background.js'
    }
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
      type: 'BATCH_TASK_PHASE_UPDATED',
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 2,
      phase: 'generating',
      sourceTabId: 503
    }
  ]);
  unsubscribe();
  assert.equal(harness.runtimeOnMessage.listeners.size, 0);
});

test('accepts local debug page commands only from the extension background', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);
  const received = [];
  const unsubscribe = dependencies.subscribeLocalDebugCommands(
    async (message) => {
      received.push(message);
      return {
        ok: true,
        page: { status: 'paused' },
        token: 'must-not-leak'
      };
    }
  );
  const listener = [...harness.runtimeOnMessage.listeners][0];
  let forgedResponse = null;
  assert.equal(listener(
    {
      type: 'LOCAL_DEBUG_PAGE_COMMAND',
      command: 'pause',
      requestId: 'forged'
    },
    {
      id: 'extension-id',
      tab: { id: 501 },
      url: 'https://target.test/post'
    },
    (response) => { forgedResponse = response; }
  ), false);
  assert.equal(forgedResponse, null);

  let response = null;
  assert.equal(listener(
    {
      type: 'LOCAL_DEBUG_PAGE_COMMAND',
      command: 'pause',
      requestId: 'request-1'
    },
    {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/background.js'
    },
    (value) => { response = value; }
  ), true);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(received, [{
    command: 'pause',
    requestId: 'request-1'
  }]);
  assert.deepEqual(response, {
    ok: true,
    page: { status: 'paused' }
  });
  unsubscribe();
});

test('accepts removed worker checkpoint from MV3 background with or without sender URL and scrubs secrets', () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);
  const received = [];
  dependencies.subscribeRuntimeMessages(
    (message) => received.push(structuredClone(message))
  );
  const message = {
    type: 'BATCH_WORKER_TAB_REMOVED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 501,
    checkpoint: {
      version: 3,
      batchId: 'batch-1',
      status: 'running',
      tasks: {
        0: {
          urlIndex: 0,
          attempt: 1,
          state: 'terminal',
          profileId: 'profile-a',
          apiKey: 'must-not-reach-page'
        }
      }
    }
  };

  harness.runtimeOnMessage.emit(message, {
    id: 'extension-id',
    tab: { id: 501 },
    url: 'https://target.test/post'
  });
  harness.runtimeOnMessage.emit(message, {
    id: 'extension-id'
  });
  harness.runtimeOnMessage.emit(message, {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/background.js'
  });

  const expectedMessage = {
    type: 'BATCH_WORKER_TAB_REMOVED',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 501,
    checkpoint: {
      version: 3,
      batchId: 'batch-1',
      status: 'running',
      tasks: {
        0: {
          urlIndex: 0,
          attempt: 1,
          state: 'terminal',
          profileId: 'profile-a'
        }
      }
    }
  };
  assert.deepEqual(received, [expectedMessage, expectedMessage]);
});

test('worker tab adapter requests an already-checkpointed background tab without trusting page details', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  const created = await dependencies.tabsApi.create({
    windowId: 999,
    url: 'https://attacker.test/ignored',
    active: true
  }, {
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 2
  });

  assert.deepEqual(harness.runtimeMessages, [{
    type: 'BATCH_CREATE_WORKER_TAB',
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 2,
    requestId: 'batch-1:3:2'
  }]);
  assert.deepEqual(created, {
    id: 501,
    windowId: 42,
    url: 'https://checkpoint.test/worker',
    active: false,
    backgroundCheckpointed: true,
    runtimeCheckpoint: {
      version: 2,
      batchId: 'batch-1',
      status: 'running'
    }
  });
});

test('worker tab adapter retries a lost response once with the same request identity', async () => {
  const harness = createChromeHarness();
  let calls = 0;
  harness.chromeApi.runtime.sendMessage = async (message) => {
    harness.runtimeMessages.push(structuredClone(message));
    calls += 1;
    if (calls === 1) {
      throw new Error('The message port closed before a response was received.');
    }
    return {
      ok: true,
      checkpoint: {
        version: 2,
        batchId: message.batchId,
        status: 'running'
      },
      tab: {
        id: 501,
        windowId: 42,
        url: 'https://checkpoint.test/worker',
        active: false
      }
    };
  };
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  const created = await dependencies.tabsApi.create({
    windowId: 999,
    url: 'https://attacker.test/ignored',
    active: true
  }, {
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 2,
    requestId: 'batch-1:3:2'
  });

  assert.equal(created.id, 501);
  assert.deepEqual(harness.runtimeMessages, [
    {
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 2,
      requestId: 'batch-1:3:2'
    },
    {
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 2,
      requestId: 'batch-1:3:2'
    }
  ]);
});

test('worker tab adapter preserves recovery ownership metadata on a failed response', async () => {
  const harness = createChromeHarness();
  const checkpoint = {
    version: 2,
    batchId: 'batch-1',
    status: 'running',
    tasks: {
      3: {
        state: 'active',
        attempt: 2,
        tabId: 501,
        windowId: 42
      }
    }
  };
  harness.chromeApi.runtime.sendMessage = async () => ({
    ok: false,
    error: 'tab_navigation_uncertain',
    recoveryRequired: true,
    checkpoint
  });
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await assert.rejects(
    dependencies.tabsApi.create({}, {
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 2,
      requestId: 'batch-1:3:2'
    }),
    (error) => {
      assert.equal(error.code, 'tab_navigation_uncertain');
      assert.equal(error.recoveryRequired, true);
      assert.equal(error.runtimeCheckpoint, checkpoint);
      return true;
    }
  );
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

test('requests one deduplicated permission set for batch target origins', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await dependencies.requestTargetPermissions([
    'https://blog.example.test/post-1',
    'https://blog.example.test/post-2?draft=1',
    'http://legacy.example.test:8080/comment',
    'chrome://settings/'
  ]);

  assert.deepEqual(harness.permissionRequests, [{
    origins: [
      'http://blog.example.test/*',
      'http://legacy.example.test/*',
      'https://blog.example.test/*',
      'https://legacy.example.test/*'
    ]
  }]);
  assert.deepEqual(harness.permissionChecks, harness.permissionRequests);
});

test('requests permissions for common scheme and apex-www redirects', async () => {
  const harness = createChromeHarness();
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await dependencies.requestTargetPermissions([
    'http://example.test/post',
    'https://www.jarman.org.uk/article'
  ]);

  assert.deepEqual(harness.permissionRequests, [{
    origins: [
      'http://example.test/*',
      'http://jarman.org.uk/*',
      'http://www.example.test/*',
      'http://www.jarman.org.uk/*',
      'https://example.test/*',
      'https://jarman.org.uk/*',
      'https://www.example.test/*',
      'https://www.jarman.org.uk/*'
    ]
  }]);
});

test('reports a stable error when batch target permission is denied', async () => {
  const harness = createChromeHarness();
  harness.chromeApi.permissions.request = async () => false;
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await assert.rejects(
    dependencies.requestTargetPermissions([
      'https://blog.example.test/post'
    ]),
    (error) => error?.code === 'batch_target_permission_denied'
  );
});

test('does not request target permissions that Chrome already granted', async () => {
  const harness = createChromeHarness();
  harness.chromeApi.permissions.contains = async () => true;
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await dependencies.requestTargetPermissions([
    'https://blog.example.test/post'
  ]);

  assert.deepEqual(harness.permissionRequests, []);
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
    taskId: 'batch-1:3',
    urlIndex: 2,
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    attempt: 3
  }, 'pause'), {
    sealed: true,
    recovered: false
  });
  assert.deepEqual(harness.runtimeMessages.at(-1), {
    type: 'BATCH_RECOVER_SUBMIT_CONTEXT',
    tabId: 101,
    batchId: 'batch-1',
    taskId: 'batch-1:3',
    urlIndex: 2,
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
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

test('loads all recent successful URLs through the bounded 24-hour history query', async () => {
  const harness = createChromeHarness();
  harness.chromeApi.runtime.sendMessage = async (message) => {
    harness.runtimeMessages.push(structuredClone(message));
    if (message.type === 'HISTORY_RECENT_SUCCESS_URLS') {
      return {
        ok: true,
        data: [
          'https://target.test/one',
          'https://target.test/two',
          'https://target.test/one'
        ]
      };
    }
    return { ok: true };
  };
  const dependencies = createChromeBatchDependencies(
    harness.chromeApi,
    { now: () => 200_000_000 }
  );

  assert.deepEqual(await dependencies.loadRecentSuccessUrls(), [
    'https://target.test/one',
    'https://target.test/two'
  ]);
  assert.deepEqual(harness.runtimeMessages, [{
    type: 'HISTORY_RECENT_SUCCESS_URLS',
    since: 200_000_000 - (24 * 60 * 60 * 1000)
  }]);
});

test('fails closed when recent-success history cannot be read', async () => {
  const harness = createChromeHarness();
  harness.chromeApi.runtime.sendMessage = async () => ({
    ok: false,
    error: { code: 'HISTORY_REQUEST_FAILED' }
  });
  const dependencies = createChromeBatchDependencies(harness.chromeApi);

  await assert.rejects(
    dependencies.loadRecentSuccessUrls(),
    (error) => error.code === 'recent_success_history_unavailable'
  );
});
