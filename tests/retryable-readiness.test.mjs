import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createInitializationAwareBatchRuntimeController,
  createRetryableReadiness
} from '../lib/retryable-readiness.mjs';
import {
  installBatchRuntimeController
} from '../lib/batch-runtime-controller.mjs';
import {
  isBenignRuntimeDeliveryError
} from '../lib/chrome-runtime-delivery.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('shares concurrent initialization and retries after a failed attempt', async () => {
  const attempts = [];
  const first = deferred();
  const ready = createRetryableReadiness(() => {
    attempts.push(attempts.length + 1);
    if (attempts.length === 1) return first.promise;
    return 'ready';
  });

  const a = ready();
  const b = ready();
  await Promise.resolve();
  assert.equal(attempts.length, 1);
  first.reject(new Error('migration unavailable'));
  await assert.rejects(a, /migration unavailable/);
  await assert.rejects(b, /migration unavailable/);
  assert.equal(await ready(), 'ready');
  assert.equal(await ready(), 'ready');
  assert.deepEqual(attempts, [1, 2]);
});

test('registers batch listeners immediately while event handlers await readiness', async () => {
  const gate = deferred();
  const calls = [];
  const listeners = {};
  const controller = createInitializationAwareBatchRuntimeController({
    async handleMessage(message) {
      calls.push(['message', message.type]);
      return { ok: true };
    },
    async handleWorkerTabRemoved(tabId) {
      calls.push(['removed', tabId]);
      return { ok: true, changed: false };
    },
    async recoverOnStartup() {
      calls.push(['startup']);
      return { ok: true };
    }
  }, () => gate.promise);
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      onMessage: {
        addListener(listener) { listeners.message = listener; }
      },
      onStartup: {
        addListener(listener) { listeners.startup = listener; }
      },
      async sendMessage() {}
    },
    tabs: {
      onRemoved: {
        addListener(listener) { listeners.removed = listener; }
      }
    }
  };

  installBatchRuntimeController(chromeApi, controller);
  assert.equal(typeof listeners.message, 'function');
  assert.equal(typeof listeners.removed, 'function');
  assert.equal(typeof listeners.startup, 'function');

  let response;
  assert.equal(listeners.message({
    type: 'BATCH_GET_TAB_MODE'
  }, {
    id: 'extension-id'
  }, (value) => { response = value; }), true);
  listeners.removed(42);
  listeners.startup();
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);

  gate.resolve();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(calls.sort((left, right) => left[0].localeCompare(right[0])), [
    ['message', 'BATCH_GET_TAB_MODE'],
    ['removed', 42],
    ['startup']
  ]);
  assert.deepEqual(response, { ok: true });
});

test('batch handler returns a structured error and a later event can retry readiness', async () => {
  let attempts = 0;
  const listeners = {};
  const ready = createRetryableReadiness(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('migration failed privately');
  });
  const controller = createInitializationAwareBatchRuntimeController({
    async handleMessage() {
      return { ok: true };
    },
    async handleWorkerTabRemoved() {
      return { ok: true, changed: false };
    },
    async recoverOnStartup() {
      return { ok: true };
    }
  }, ready);
  installBatchRuntimeController({
    runtime: {
      id: 'extension-id',
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      onMessage: {
        addListener(listener) { listeners.message = listener; }
      },
      onStartup: { addListener() {} },
      async sendMessage() {}
    },
    tabs: {
      onRemoved: { addListener() {} }
    }
  }, controller);
  const dispatch = () => new Promise((resolve) => {
    listeners.message({
      type: 'BATCH_GET_TAB_MODE'
    }, {
      id: 'extension-id'
    }, resolve);
  });

  assert.deepEqual(await dispatch(), {
    ok: false,
    error: 'batch_runtime_failed'
  });
  assert.deepEqual(await dispatch(), { ok: true });
  assert.equal(attempts, 2);
});

test('classifies missing runtime receivers as benign delivery failures', () => {
  for (const message of [
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
    'A listener indicated an asynchronous response, but the message channel closed.'
  ]) {
    assert.equal(isBenignRuntimeDeliveryError(new Error(message)), true);
  }
  assert.equal(
    isBenignRuntimeDeliveryError(new Error('permission denied')),
    false
  );
});

test('MV3 background installs event listeners synchronously outside readiness continuations', () => {
  const source = fs.readFileSync(
    new URL('../background.js', import.meta.url),
    'utf8'
  );
  const deferredInstall =
    /ensureDomainConfigReady\s*(?:\(\))?\.then\([\s\S]*install(?:BatchRuntimeController|BatchDomainConfigListener|BatchSecretVaultListener|CloudSyncMessageListener|CloudSyncBackground)/;

  assert.doesNotMatch(source, deferredInstall);
  for (const installation of [
    'installBatchRuntimeController',
    'installBatchDomainConfigListener',
    'installBatchSecretVaultListener',
    'installCloudSyncMessageListener',
    'installCloudSyncBackground'
  ]) {
    assert.match(source, new RegExp(`${installation}\\(`));
  }
});
