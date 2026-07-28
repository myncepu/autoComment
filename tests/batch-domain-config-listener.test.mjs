import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installBatchDomainConfigListener
} from '../lib/batch-domain-config-listener.mjs';

test('returns only non-sensitive domain config to an internal content sender', async () => {
  let listener;
  const config = {
    version: 2,
    revision: 1,
    profiles: [{
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice',
      email: 'alice@example.test',
      createdAt: 100,
      updatedAt: 100
    }],
    promotionSites: [],
    assignmentPolicy: {
      defaultPairId: null,
      pairs: [],
      quotas: {}
    }
  };
  installBatchDomainConfigListener({
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(value) {
          listener = value;
        }
      }
    }
  }, {
    async load() {
      return structuredClone(config);
    }
  });

  let response;
  const handled = listener({
    type: 'BATCH_GET_MANUAL_DEFAULT_CONFIG'
  }, {
    id: 'extension-id',
    tab: { id: 42 }
  }, (value) => { response = value; });
  await new Promise(setImmediate);

  assert.equal(handled, true);
  assert.deepEqual(response, { ok: true, config });
  assert.doesNotMatch(JSON.stringify(response), /password|secret|token/i);
});

test('rejects external, tabless, and unrelated messages', () => {
  let listener;
  installBatchDomainConfigListener({
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(value) {
          listener = value;
        }
      }
    }
  }, { load: async () => ({}) });

  let external;
  assert.equal(listener({
    type: 'BATCH_GET_MANUAL_DEFAULT_CONFIG'
  }, {
    id: 'other-extension',
    tab: { id: 42 }
  }, (value) => { external = value; }), false);
  assert.deepEqual(external, { ok: false, error: 'forbidden_sender' });
  assert.equal(listener({ type: 'UNRELATED' }, {}, () => {}), undefined);
});

test('waits for retryable initialization and returns a structured failure', async () => {
  let listener;
  let attempts = 0;
  installBatchDomainConfigListener({
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(value) { listener = value; }
      }
    }
  }, {
    async load() {
      return {
        version: 2,
        revision: 0,
        profiles: [],
        promotionSites: [],
        assignmentPolicy: {
          defaultPairId: null,
          pairs: [],
          quotas: {}
        }
      };
    }
  }, {
    ready: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('private migration failure');
        error.code = 'domain_config_migration_deferred';
        throw error;
      }
    }
  });
  const sender = { id: 'extension-id', tab: { id: 42 } };
  const dispatch = (message) => new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });

  assert.deepEqual(await dispatch({
    type: 'BATCH_GET_MANUAL_DEFAULT_CONFIG'
  }), {
    ok: false,
    error: 'domain_config_migration_deferred'
  });
  assert.equal((await dispatch({
    type: 'BATCH_GET_MANUAL_DEFAULT_CONFIG'
  })).ok, true);
  assert.equal(attempts, 2);
});
