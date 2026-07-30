import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalControlPoller,
  LOCAL_CONTROL_RESULTS_KEY
} from '../lib/local-control-poller.mjs';
import {
  LOCAL_DEBUG_BRIDGE_ORIGIN,
  LOCAL_DEBUG_BRIDGE_STORAGE_KEY
} from '../lib/local-debug-bridge.mjs';

const TOKEN = '1234567890abcdefghijklmnopqrstuvwxyz123456';

function response(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (body === null) throw new Error('empty');
      return structuredClone(body);
    }
  };
}

test('local control poller pairs, executes, caches, and reports one command', async () => {
  const requests = [];
  const storage = {
    values: {
      [LOCAL_DEBUG_BRIDGE_STORAGE_KEY]: {
        enabled: true,
        origin: LOCAL_DEBUG_BRIDGE_ORIGIN,
        token: TOKEN
      }
    },
    async get(keys) {
      return Object.fromEntries(keys.flatMap((key) => (
        Object.hasOwn(this.values, key) ? [[key, this.values[key]]] : []
      )));
    },
    async set(patch) {
      Object.assign(this.values, structuredClone(patch));
    }
  };
  let executionCount = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options: structuredClone(options) });
    if (url.endsWith('/pair')) return response(200, { ok: true });
    if (url.endsWith('/commands/next')) {
      return response(200, {
        command: {
          id: 'command-1',
          command: 'pause',
          payload: {}
        }
      });
    }
    if (url.endsWith('/command-1/result')) {
      return response(200, { ok: true });
    }
    throw new Error('unexpected_request');
  };
  const poller = createLocalControlPoller({
    fetchImpl,
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
    storageArea: storage,
    bridge: {
      async executeTrusted(message) {
        executionCount += 1;
        return { ok: true, requestId: message.requestId };
      }
    },
    now: () => 2000
  });

  const result = await poller.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(result.command, 'pause');
  assert.equal(executionCount, 1);
  assert.deepEqual(
    storage.values[LOCAL_CONTROL_RESULTS_KEY]['command-1'].result,
    { ok: true, requestId: 'command-1' }
  );
  assert.equal(requests.length, 3);
  assert.match(
    requests[0].options.headers.Authorization,
    /^Bearer /
  );
});

test('local control poller replays a cached result without executing twice', async () => {
  const storage = {
    values: {
      [LOCAL_DEBUG_BRIDGE_STORAGE_KEY]: {
        enabled: true,
        origin: LOCAL_DEBUG_BRIDGE_ORIGIN,
        token: TOKEN
      },
      [LOCAL_CONTROL_RESULTS_KEY]: {
        'command-1': {
          completedAt: 1000,
          result: { ok: true, cached: true }
        }
      }
    },
    async get(keys) {
      return Object.fromEntries(keys.flatMap((key) => (
        Object.hasOwn(this.values, key) ? [[key, this.values[key]]] : []
      )));
    },
    async set(patch) {
      Object.assign(this.values, structuredClone(patch));
    }
  };
  let call = 0;
  const poller = createLocalControlPoller({
    fetchImpl: async (url) => {
      call += 1;
      if (url.endsWith('/pair')) return response(200, { ok: true });
      if (url.endsWith('/commands/next')) {
        return response(200, {
          command: {
            id: 'command-1',
            command: 'pause',
            payload: {}
          }
        });
      }
      return response(200, { ok: true });
    },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
    storageArea: storage,
    bridge: {
      async executeTrusted() {
        throw new Error('must_not_execute');
      }
    }
  });

  const result = await poller.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(result.replayed, true);
  assert.equal(call, 3);
});
