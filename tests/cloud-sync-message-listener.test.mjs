import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installCloudSyncMessageListener
} from '../lib/cloud-sync-message-listener.mjs';

function createChromeMessageFixture() {
  const listeners = [];
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL(path = '') {
        return `chrome-extension://extension-id/${path}`;
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };

  return {
    chromeApi,
    listeners,
    dispatch(message, sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/options.html'
    }) {
      let responseCount = 0;
      let asyncResult;
      const response = new Promise((resolve) => {
        asyncResult = listeners[0](message, sender, (value) => {
          responseCount += 1;
          resolve(value);
        });
      });
      if (asyncResult === false) {
        return {
          asyncResult,
          responseCount,
          response: responseCount ? response : Promise.resolve(undefined)
        };
      }
      return {
        asyncResult,
        get responseCount() {
          return responseCount;
        },
        response
      };
    }
  };
}

function createService(overrides = {}) {
  return {
    async getStatus() {
      return { state: 'idle', pendingCount: 0 };
    },
    async createVault() {
      return { connected: true, syncKey: 'acsync_created' };
    },
    async importKey(syncKey) {
      return { connected: true, imported: syncKey };
    },
    async runOnce(reason) {
      return { reason };
    },
    async getCredentialsForDisplay() {
      return { syncKey: 'acsync_visible' };
    },
    async disconnect() {
      return { disconnected: true };
    },
    async deleteVault(confirmation) {
      return { confirmation };
    },
    async listCloudHistory(query) {
      return { query };
    },
    async deleteCloudHistory(recordId) {
      return { recordId };
    },
    ...overrides
  };
}

test('routes every fixed cloud sync and cloud history message once', async () => {
  const fixture = createChromeMessageFixture();
  const service = createService();
  installCloudSyncMessageListener(fixture.chromeApi, service);

  const cases = [
    [{ type: 'CLOUD_SYNC_STATUS' }, { state: 'idle', pendingCount: 0 }],
    [{ type: 'CLOUD_SYNC_CREATE' }, { connected: true, syncKey: 'acsync_created' }],
    [{ type: 'CLOUD_SYNC_IMPORT', syncKey: 'acsync_imported' }, {
      connected: true,
      imported: 'acsync_imported'
    }],
    [{ type: 'CLOUD_SYNC_RUN' }, { reason: 'manual' }],
    [{ type: 'CLOUD_SYNC_SHOW_KEY' }, { syncKey: 'acsync_visible' }],
    [{ type: 'CLOUD_SYNC_DISCONNECT' }, { disconnected: true }],
    [{ type: 'CLOUD_SYNC_DELETE_VAULT', confirmation: 'vault-a' }, {
      confirmation: 'vault-a'
    }],
    [{ type: 'CLOUD_HISTORY_LIST', query: { cursor: 'next' } }, {
      query: { cursor: 'next' }
    }],
    [{ type: 'CLOUD_HISTORY_DELETE', recordId: 'record-a' }, {
      recordId: 'record-a'
    }]
  ];

  for (const [message, expected] of cases) {
    const dispatched = fixture.dispatch(message);
    assert.equal(dispatched.asyncResult, true);
    assert.deepEqual(await dispatched.response, { ok: true, data: expected });
    assert.equal(dispatched.responseCount, 1);
  }
});

test('ignores unknown messages without responding', () => {
  const fixture = createChromeMessageFixture();
  installCloudSyncMessageListener(fixture.chromeApi, createService());

  const dispatched = fixture.dispatch({ type: 'CLOUD_SYNC_UNKNOWN' });

  assert.equal(dispatched.asyncResult, false);
  assert.equal(dispatched.responseCount, 0);
});

test('rejects every known message from content, external, and forged extension senders', async () => {
  const fixture = createChromeMessageFixture();
  installCloudSyncMessageListener(fixture.chromeApi, createService());
  const messages = [
    { type: 'CLOUD_SYNC_STATUS' },
    { type: 'CLOUD_SYNC_CREATE' },
    { type: 'CLOUD_SYNC_IMPORT', syncKey: 'acsync_imported' },
    { type: 'CLOUD_SYNC_RUN' },
    { type: 'CLOUD_SYNC_SHOW_KEY' },
    { type: 'CLOUD_SYNC_DISCONNECT' },
    { type: 'CLOUD_SYNC_DELETE_VAULT', confirmation: 'vault-a' },
    { type: 'CLOUD_HISTORY_LIST', query: {} },
    { type: 'CLOUD_HISTORY_DELETE', recordId: 'record-a' }
  ];
  const senders = [
    { id: 'extension-id', url: 'https://target.test/post' },
    { id: 'other-extension', url: 'chrome-extension://extension-id/options.html' },
    { id: 'extension-id', url: 'chrome-extension://extension-id.evil/options.html' },
    { id: 'extension-id', url: 'chrome-extension://extension-id@evil/options.html' },
    { id: 'extension-id', url: 'not a url' }
  ];

  for (const message of messages) {
    for (const sender of senders) {
      const dispatched = fixture.dispatch(message, sender);
      assert.equal(dispatched.asyncResult, false);
      assert.deepEqual(await dispatched.response, {
        ok: false,
        error: {
          code: 'PRIVILEGED_SENDER_REQUIRED',
          message: '该操作只能从扩展页面发起。',
          retryable: false
        }
      });
      assert.equal(dispatched.responseCount, 1);
    }
  }
});

test('returns a stable safe error without secret, stack, or raw diagnostics', async () => {
  const fixture = createChromeMessageFixture();
  installCloudSyncMessageListener(fixture.chromeApi, createService({
    async importKey() {
      const error = new Error('server rejected acsync_super-secret');
      error.code = 'INVALID_SYNC_KEY';
      error.retryable = false;
      error.raw = { authorization: 'Bearer acsync_super-secret' };
      throw error;
    }
  }));

  const dispatched = fixture.dispatch({
    type: 'CLOUD_SYNC_IMPORT',
    syncKey: 'acsync_super-secret'
  });
  const response = await dispatched.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: 'INVALID_SYNC_KEY',
      message: '同步密钥无效。',
      retryable: false
    }
  });
  assert.equal(JSON.stringify(response).includes('super-secret'), false);
  assert.equal(Object.hasOwn(response.error, 'stack'), false);
  assert.equal(Object.hasOwn(response.error, 'raw'), false);
  assert.equal(dispatched.responseCount, 1);
});
