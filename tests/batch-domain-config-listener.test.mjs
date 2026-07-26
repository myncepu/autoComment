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
