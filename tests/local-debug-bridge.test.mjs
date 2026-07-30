import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalDebugBridge,
  LOCAL_DEBUG_BRIDGE_ORIGIN,
  LOCAL_DEBUG_BRIDGE_REQUEST,
  LOCAL_DEBUG_BRIDGE_STORAGE_KEY
} from '../lib/local-debug-bridge.mjs';

const TOKEN = '1234567890abcdefghijklmnopqrstuvwxyz123456';

function createHarness({ enabled = true } = {}) {
  const sent = [];
  const createdTabs = [];
  const checkpoint = {
    batchId: 'batch-1',
    status: 'running',
    updatedAt: 1234,
    source: { parsedUrls: [{}, {}] },
    settings: { timeoutSeconds: 90, concurrency: 2 },
    tasks: {
      0: { state: 'terminal' },
      1: { state: 'active' }
    },
    results: [{ result: 'success' }]
  };
  const bridge = createLocalDebugBridge({
    runtime: {
      getURL(pathname) {
        return `chrome-extension://extension-id/${pathname}`;
      },
      async sendMessage(message) {
        sent.push(structuredClone(message));
        return {
          ok: true,
          page: {
            batchId: 'batch-1',
            status: message.command === 'pause' ? 'paused' : 'running'
          }
        };
      }
    },
    tabs: {
      async query() {
        return [{
          id: 41,
          url: 'chrome-extension://extension-id/batch.html'
        }];
      },
      async create(details) {
        createdTabs.push(structuredClone(details));
        return { id: 42, ...details };
      }
    },
    storageArea: {
      async get() {
        return enabled
          ? {
              [LOCAL_DEBUG_BRIDGE_STORAGE_KEY]: {
                enabled: true,
                origin: LOCAL_DEBUG_BRIDGE_ORIGIN,
                token: TOKEN
              }
            }
          : {};
      }
    },
    batchRuntimeController: {
      async handleMessage() {
        return { ok: true, checkpoint };
      }
    },
    now: () => 2000
  });
  return { bridge, sent, createdTabs };
}

function request(command, token = TOKEN) {
  return {
    type: LOCAL_DEBUG_BRIDGE_REQUEST,
    command,
    requestId: 'request-1',
    token
  };
}

const trustedSender = {
  url: `${LOCAL_DEBUG_BRIDGE_ORIGIN}/`
};

test('local debug bridge returns bounded status and relays page state', async () => {
  const { bridge, sent } = createHarness();
  const response = await bridge.handle(request('status'), trustedSender);

  assert.equal(response.ok, true);
  assert.deepEqual(response.background, {
    batchId: 'batch-1',
    status: 'running',
    updatedAt: 1234,
    total: 2,
    taskCounts: { terminal: 1, active: 1 },
    resultCounts: { success: 1 },
    timeoutSeconds: 90,
    concurrency: 2
  });
  assert.equal(response.page.status, 'running');
  assert.deepEqual(sent, [{
    type: 'LOCAL_DEBUG_PAGE_COMMAND',
    command: 'status',
    requestId: 'request-1'
  }]);
});

test('local debug bridge rejects non-local origins, bad tokens, and disabled settings', async () => {
  const { bridge } = createHarness();
  assert.deepEqual(
    await bridge.handle(request('status'), { url: 'https://evil.test/' }),
    { ok: false, error: 'local_debug_origin_forbidden' }
  );
  assert.deepEqual(
    await bridge.handle(request('status', `${TOKEN}x`), trustedSender),
    { ok: false, error: 'local_debug_unauthorized' }
  );
  const disabled = createHarness({ enabled: false }).bridge;
  assert.deepEqual(
    await disabled.handle(request('status'), trustedSender),
    { ok: false, error: 'local_debug_unauthorized' }
  );
});

test('local control bridge exposes start and requires exact permanent stop confirmation', async () => {
  const { bridge, sent } = createHarness();
  const unconfirmed = await bridge.handle(request('stop'), trustedSender);
  assert.deepEqual(unconfirmed, {
    ok: false,
    requestId: 'request-1',
    error: 'stop_confirmation_required',
    background: {
      batchId: 'batch-1',
      status: 'running',
      updatedAt: 1234,
      total: 2,
      taskCounts: { terminal: 1, active: 1 },
      resultCounts: { success: 1 },
      timeoutSeconds: 90,
      concurrency: 2
    }
  });
  assert.deepEqual(sent, []);

  const started = await bridge.handle(request('start'), trustedSender);
  assert.equal(started.ok, true);
  assert.equal(started.command, 'start');

  const paused = await bridge.handle(request('pause'), trustedSender);
  assert.equal(paused.ok, true);
  assert.equal(paused.command, 'pause');
  assert.equal(paused.page.status, 'paused');

  const stopped = await bridge.handle({
    ...request('stop'),
    batchId: 'batch-1',
    confirmPermanent: true
  }, trustedSender);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.command, 'stop');
  assert.deepEqual(sent.at(-1), {
    type: 'LOCAL_DEBUG_PAGE_COMMAND',
    command: 'stop',
    requestId: 'request-1',
    batchId: 'batch-1',
    confirmPermanent: true
  });
});
