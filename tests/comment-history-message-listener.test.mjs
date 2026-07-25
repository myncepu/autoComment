import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  HISTORY_MESSAGE_TYPES,
  installCommentHistoryMessageListener
} from '../lib/comment-history-message-listener.mjs';

function createFixture(service = {}) {
  const listeners = [];
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
  installCommentHistoryMessageListener(chromeApi, service);

  async function dispatch(message, sender = { id: 'extension-id' }) {
    const responses = [];
    const handled = listeners[0](message, sender, (response) => responses.push(response));
    if (handled) await new Promise(setImmediate);
    return { handled, response: responses[0], responseCount: responses.length };
  }

  return { dispatch };
}

test('exports and routes each exact history message type', async () => {
  const calls = [];
  const service = {
    async getSummary() { calls.push(['getSummary']); return 'summary'; },
    async listRecords(payload) { calls.push(['listRecords', payload]); return 'list'; },
    async getAnchors(commentId) { calls.push(['getAnchors', commentId]); return 'anchors'; },
    async startExport(payload) { calls.push(['startExport', payload]); return 'started'; },
    async getExportChunk(payload) { calls.push(['getExportChunk', payload]); return 'chunk'; },
    async finishExport(payload) { calls.push(['finishExport', payload]); return 'finished'; },
    async getRetentionStatus() { calls.push(['getRetentionStatus']); return 'retention'; },
    async deleteConfirmed(payload) { calls.push(['deleteConfirmed', payload]); return 'deleted'; },
    async listArchiveEvents() { calls.push(['listArchiveEvents']); return 'events'; },
    async retryPendingWrites() { calls.push(['retryPendingWrites']); return 'retried'; }
  };
  const { dispatch } = createFixture(service);
  const requests = [
    [{ type: HISTORY_MESSAGE_TYPES.SUMMARY }, 'summary'],
    [{ type: HISTORY_MESSAGE_TYPES.LIST }, 'list'],
    [{ type: HISTORY_MESSAGE_TYPES.ANCHORS, commentId: 'batch-a:7' }, 'anchors'],
    [{ type: HISTORY_MESSAGE_TYPES.EXPORT_START }, 'started'],
    [{ type: HISTORY_MESSAGE_TYPES.EXPORT_CHUNK, exportSessionId: 'session-a' }, 'chunk'],
    [{
      type: HISTORY_MESSAGE_TYPES.EXPORT_FINISH,
      exportSessionId: 'session-a',
      filenames: ['part.csv']
    }, 'finished'],
    [{ type: HISTORY_MESSAGE_TYPES.RETENTION_STATUS }, 'retention'],
    [{
      type: HISTORY_MESSAGE_TYPES.DELETE_CONFIRMED,
      confirmed: true,
      exportSessionId: 'session-a'
    }, 'deleted'],
    [{ type: HISTORY_MESSAGE_TYPES.ARCHIVE_EVENTS }, 'events'],
    [{ type: HISTORY_MESSAGE_TYPES.RETRY_PENDING }, 'retried']
  ];

  for (const [message, expected] of requests) {
    assert.deepEqual((await dispatch(message)).response, {
      ok: true,
      data: expected
    });
  }
  assert.deepEqual(calls.map(([method]) => method), [
    'getSummary',
    'listRecords',
    'getAnchors',
    'startExport',
    'getExportChunk',
    'finishExport',
    'getRetentionStatus',
    'deleteConfirmed',
    'listArchiveEvents',
    'retryPendingWrites'
  ]);
});

test('allows only internal extension senders for recognized history messages', async () => {
  let callCount = 0;
  const { dispatch } = createFixture({
    async getSummary() {
      callCount += 1;
    }
  });

  for (const sender of [{}, { id: 'another-extension' }]) {
    const result = await dispatch({ type: 'HISTORY_SUMMARY' }, sender);
    assert.equal(result.handled, false);
    assert.deepEqual(result.response, {
      ok: false,
      error: {
        code: 'FORBIDDEN_SENDER',
        message: '拒绝外部评论历史请求。'
      }
    });
  }
  assert.equal(callCount, 0);
});

test('returns false without responding for unknown message types', async () => {
  const { dispatch } = createFixture({});
  assert.deepEqual(await dispatch({ type: 'NOT_HISTORY' }), {
    handled: false,
    response: undefined,
    responseCount: 0
  });
});

test('normalizes list filters, cursor, and limit before calling the service', async () => {
  let received;
  const { dispatch } = createFixture({
    async listRecords(payload) {
      received = payload;
      return { records: [] };
    }
  });

  const result = await dispatch({
    type: 'HISTORY_LIST',
    filter: {
      dateFrom: 100,
      dateTo: 200,
      targetDomain: ' Target.Test ',
      promotedDomain: 'PROMO.TEST',
      anchorTextPrefix: '  Alpha ',
      hrefDomain: ' LINKS.TEST ',
      ignored: 'do not forward'
    },
    cursor: { submittedAt: 123, id: 'batch-a:7', injected: true },
    limit: 10_000,
    ignored: 'do not forward'
  });

  assert.deepEqual(result.response, { ok: true, data: { records: [] } });
  assert.deepEqual(received, {
    from: 100,
    to: 200,
    targetDomain: 'target.test',
    promotedDomain: 'promo.test',
    anchorTextPrefix: 'alpha',
    hrefDomain: 'links.test',
    cursor: { submittedAt: 123, id: 'batch-a:7' },
    limit: 100
  });
});

test('accepts the history page filter fields at the message top level', async () => {
  let received;
  const { dispatch } = createFixture({
    async listRecords(payload) {
      received = payload;
      return { records: [] };
    }
  });

  await dispatch({
    type: 'HISTORY_LIST',
    from: 100,
    to: 200,
    targetDomain: 'TARGET.TEST',
    limit: 25
  });

  assert.deepEqual(received, {
    from: 100,
    to: 200,
    targetDomain: 'target.test',
    limit: 25
  });
});

test('accepts only normalized filters at export start and only session cursor at 500-row chunks', async () => {
  const calls = [];
  const { dispatch } = createFixture({
    async startExport(payload) {
      calls.push(['startExport', payload]);
      return {};
    },
    async getExportChunk(payload) {
      calls.push(['getExportChunk', payload]);
      return {};
    }
  });

  await dispatch({
    type: 'HISTORY_EXPORT_START',
    targetDomain: ' ARCHIVE.TEST ',
    to: 123,
    exportedBefore: 1,
    limit: 100,
    injected: true
  });
  await dispatch({
    type: 'HISTORY_EXPORT_CHUNK',
    exportSessionId: 'session-a',
    cursor: { submittedAt: 50, id: 'batch-a:1', injected: true },
    targetDomain: 'injected.test',
    limit: 50_000
  });

  assert.deepEqual(calls, [
    ['startExport', {
      to: 123,
      targetDomain: 'archive.test'
    }],
    ['getExportChunk', {
      exportSessionId: 'session-a',
      cursor: { submittedAt: 50, id: 'batch-a:1' },
      limit: 500
    }]
  ]);
});

test('rejects deletion without explicit confirmation before calling the service', async () => {
  let deleteCount = 0;
  const { dispatch } = createFixture({
    async deleteConfirmed() {
      deleteCount += 1;
    }
  });

  for (const confirmed of [false, undefined, 1]) {
    const { response } = await dispatch({
      type: 'HISTORY_DELETE_CONFIRMED',
      confirmed,
      exportSessionId: 'export-session-a'
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal(deleteCount, 0);
});

test('returns a safe structured error without exposing stack or raw failure details', async () => {
  const { dispatch } = createFixture({
    async getSummary() {
      const error = new Error('db failed at chrome-extension://secret/?password=hunter2');
      error.stack = 'raw stack with private details';
      throw error;
    }
  });

  assert.deepEqual((await dispatch({ type: 'HISTORY_SUMMARY' })).response, {
    ok: false,
    error: {
      code: 'HISTORY_REQUEST_FAILED',
      message: '评论历史请求失败。'
    }
  });
});

test('does not trust an uppercase error code as permission to expose its raw message', async () => {
  const secret = 'chrome-extension://private/?token=history-secret';
  const { dispatch } = createFixture({
    async getSummary() {
      const error = new Error(`database failed while reading ${secret}`);
      error.code = 'DB_FAILED';
      throw error;
    }
  });

  const { response } = await dispatch({ type: 'HISTORY_SUMMARY' });
  assert.deepEqual(response, {
    ok: false,
    error: {
      code: 'DB_FAILED',
      message: '评论历史请求失败。'
    }
  });
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test('background migrates an old record before its startup retention check and confirms saved history', async (t) => {
  const previousChrome = globalThis.chrome;
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousEmitWarning = process.emitWarning;
  const previousConsoleLog = console.log;
  const previousDateNow = Date.now;
  const fixedNow = Date.UTC(2026, 6, 24, 12, 0, 0);
  const runtimeListeners = [];
  const runtimeMessages = [];
  const startupNotifications = [];
  const alarmListeners = [];
  const notificationClickListeners = [];
  const storageData = {
    batchResults: [{
      batchId: 'legacy-batch',
      urlIndex: 1,
      result: 'success',
      url: 'https://legacy.test/post',
      aiContent: 'Migrated legacy comment',
      timestamp: fixedNow - 80 * 24 * 60 * 60 * 1000
    }]
  };
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL(path) {
        return `chrome-extension://extension-id/${path}`;
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      async sendMessage(message) {
        runtimeMessages.push(message);
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return structuredClone(storageData);
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => Object.hasOwn(storageData, key))
              .map((key) => [key, structuredClone(storageData[key])])
          );
        },
        async set(values) {
          Object.assign(storageData, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
        }
      }
    },
    action: {
      onClicked: { addListener() {} }
    },
    alarms: {
      create() {},
      onAlarm: {
        addListener(listener) {
          alarmListeners.push(listener);
        }
      }
    },
    notifications: {
      async create(id, options) {
        startupNotifications.push({ id, options });
      },
      onClicked: {
        addListener(listener) {
          notificationClickListeners.push(listener);
        }
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      async sendMessage() {},
      async create() {}
    }
  };
  globalThis.chrome = chromeApi;
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  Date.now = () => fixedNow;
  process.emitWarning = () => {};
  console.log = () => {};
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    Date.now = previousDateNow;
    process.emitWarning = previousEmitWarning;
    console.log = previousConsoleLog;
  });

  await import(`../background.js?history-integration=${Date.now()}`);
  assert.equal(alarmListeners.length, 1);
  assert.equal(notificationClickListeners.length, 1);
  for (let attempt = 0; attempt < 100 && startupNotifications.length === 0; attempt += 1) {
    await new Promise(setImmediate);
  }
  assert.equal(startupNotifications.length, 1);
  assert.match(startupNotifications[0].options.message, /2026-05-05/);
  const message = {
    type: 'BATCH_HANDLE_CONFIRM',
    batchId: 'batch-integration',
    urlIndex: 9,
    result: 'success',
    url: 'https://target.test/post',
    aiContent: 'Generated fallback',
    history: {
      submittedAt: 1721000000000,
      targetPageUrl: 'https://target.test/post',
      promotedWebsiteUrl: 'https://promo.test/',
      commentHtml: 'Actual submitted comment',
      commentText: 'Actual submitted comment',
      anchors: []
    }
  };

  async function dispatchConfirm(confirmMessage) {
    const responses = [];
    const handled = runtimeListeners.map((listener) => listener(
      confirmMessage,
      { id: 'extension-id', tab: { id: 42 } },
      (response) => responses.push(response)
    ));
    assert.ok(handled.includes(true));
    for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) {
      await new Promise(setImmediate);
    }
    return responses;
  }

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      result: 'success',
      history: message.history
    }
  }), [{ ok: true }]);
  assert.ok(storageData.batchSubmitContextsByTab['42']);

  const responses = await dispatchConfirm(message);
  assert.deepEqual(responses, [{
    ok: true,
    historySaveStatus: 'saved',
    historyPendingCount: 0
  }]);
  assert.equal(runtimeMessages.length, 1);
  assert.equal(runtimeMessages[0].type, 'BATCH_CONFIRMED');
  assert.equal(runtimeMessages[0].sourceTabId, 42);
  assert.equal(runtimeMessages[0].historySaveStatus, 'saved');
  assert.equal(runtimeMessages[0].historyPendingCount, 0);
  assert.equal(storageData.batchSubmitContextsByTab['42'], undefined);

  const oldRevision = {
    capturedAt: fixedNow,
    recordedAt: fixedNow + 1,
    sequence: 1,
    id: 'revision-old-ack'
  };
  const replacementRevision = {
    capturedAt: fixedNow + 10,
    recordedAt: fixedNow + 11,
    sequence: 2,
    id: 'revision-replacement'
  };
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: 'batch-cas',
      urlIndex: 13,
      result: 'success',
      history: {
        ...message.history,
        historyRevision: replacementRevision
      }
    }
  }), [{ ok: true }]);
  const messagesBeforeOldAck = runtimeMessages.length;
  assert.deepEqual(await dispatchConfirm({
    ...message,
    batchId: 'batch-cas',
    urlIndex: 13,
    history: {
      ...message.history,
      historyRevision: oldRevision
    }
  }), [{
    ok: false,
    error: 'submit_context_not_released',
    historySaveStatus: 'saved',
    historyPendingCount: 0
  }]);
  assert.equal(runtimeMessages.length, messagesBeforeOldAck);
  assert.deepEqual(
    storageData.batchSubmitContextsByTab['42'].history.historyRevision,
    replacementRevision
  );
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT'
  }), [{ ok: true }]);

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: 'batch-fallback',
      urlIndex: 8,
      result: 'success',
      history: message.history
    }
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HISTORY_FALLBACK_DURABLE',
    batchId: 'batch-fallback',
    urlIndex: 8,
    url: 'https://target.test/post',
    result: 'success',
    aiContent: 'Generated fallback',
    errorMessage: null
  }), [{ ok: true }]);
  assert.equal(runtimeMessages.at(-1).historySaveStatus, 'queued');
  assert.equal(runtimeMessages.at(-1).historyPendingCount, null);
  assert.equal(storageData.batchSubmitContextsByTab['42'], undefined);

  for (const [offset, result] of ['', false, 0].entries()) {
    const explicitResultResponses = await dispatchConfirm({
      ...message,
      urlIndex: 10 + offset,
      result
    });
    assert.deepEqual(explicitResultResponses, [{
      ok: true,
      historySaveStatus: 'not_applicable'
    }]);
    assert.equal(runtimeMessages.at(-1).result, result);
  }

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: 'batch-ambiguous',
      urlIndex: 12,
      result: 'success',
      history: message.history
    }
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: 'batch-ambiguous',
    urlIndex: 12
  }), [{ ok: true, unresolved: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: 'stale-batch',
    urlIndex: 12
  }), [{ ok: true, unresolved: false }]);
  const messagesBeforeAmbiguousFailure = runtimeMessages.length;
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_REPORT_RESULT',
    batchId: 'batch-ambiguous',
    urlIndex: 12,
    result: 'fail',
    url: 'https://target.test/post',
    errorMessage: '提交结果不明确'
  }), [{ ok: true, deferred: true }]);
  assert.equal(
    runtimeMessages.length,
    messagesBeforeAmbiguousFailure,
    'an unresolved post-click context must prevent a terminal close broadcast'
  );

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT'
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: 'batch-ambiguous',
    urlIndex: 12
  }), [{ ok: true, unresolved: false }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_REPORT_RESULT',
    batchId: 'batch-ambiguous',
    urlIndex: 12,
    result: 'fail',
    url: 'https://target.test/post',
    errorMessage: '确定失败'
  }), [{ ok: true }]);
  assert.equal(runtimeMessages.at(-1).type, 'BATCH_CONFIRMED');
  assert.equal(runtimeMessages.at(-1).result, 'fail');
});
