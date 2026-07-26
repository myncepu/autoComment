import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  HISTORY_MESSAGE_TYPES,
  installCommentHistoryMessageListener
} from '../lib/comment-history-message-listener.mjs';
import {
  openCommentHistoryDb
} from '../lib/comment-history-db.mjs';

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
  const previousConsoleError = console.error;
  const previousDateNow = Date.now;
  const fixedNow = Date.UTC(2026, 6, 24, 12, 0, 0);
  const runtimeListeners = [];
  const runtimeMessages = [];
  const startupNotifications = [];
  const alarmListeners = [];
  const notificationClickListeners = [];
  const startupListeners = [];
  const powerCalls = [];
  const tabRemoveFailures = [];
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
  const sessionData = {};
  const tabData = new Map();
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
      onStartup: {
        addListener(listener) {
          startupListeners.push(listener);
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
      },
      session: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.flatMap((key) => (
            Object.hasOwn(sessionData, key)
              ? [[key, structuredClone(sessionData[key])]]
              : []
          )));
        },
        async set(values) {
          Object.assign(sessionData, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete sessionData[key];
          }
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
    power: {
      requestKeepAwake(level) {
        powerCalls.push(['request', level]);
      },
      releaseKeepAwake() {
        powerCalls.push(['release']);
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      async sendMessage() {},
      async create(details) {
        const tab = { id: 42, windowId: details.windowId, ...details };
        tabData.set(tab.id, structuredClone(tab));
        return tab;
      },
      async get(tabId) {
        const tab = tabData.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return structuredClone(tab);
      },
      async update(tabId, details) {
        const updated = {
          ...tabData.get(tabId),
          id: tabId,
          windowId: 52,
          ...details
        };
        tabData.set(tabId, structuredClone(updated));
        return updated;
      },
      async remove(tabId) {
        const failure = tabRemoveFailures.shift();
        if (failure) throw failure;
        tabData.delete(tabId);
      },
      async query() {
        return [...tabData.values()].map((tab) => structuredClone(tab));
      }
    },
    windows: {
      async remove() {}
    }
  };
  globalThis.chrome = chromeApi;
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  Date.now = () => fixedNow;
  process.emitWarning = () => {};
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    Date.now = previousDateNow;
    process.emitWarning = previousEmitWarning;
    console.log = previousConsoleLog;
    console.error = previousConsoleError;
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
    attempt: 1,
    result: 'success',
    url: 'https://target.test/post',
    aiContent: 'Generated fallback',
    errorCode: 'confirmed_success',
    history: {
      submittedAt: 1721000000000,
      targetPageUrl: 'https://target.test/post',
      promotedWebsiteUrl: 'https://promo.test/',
      commentHtml: 'Actual submitted comment',
      commentText: 'Actual submitted comment',
      anchors: [],
      historyRevision: {
        capturedAt: 1721000000000,
        recordedAt: 1721000000001,
        sequence: 1,
        id: 'revision-integration-confirm'
      }
    }
  };

  async function dispatchConfirm(
    confirmMessage,
    sender = { id: 'extension-id', tab: { id: 42 } }
  ) {
    const responses = [];
    const handled = runtimeListeners.map((listener) => listener(
      confirmMessage,
      sender,
      (response) => responses.push(response)
    ));
    assert.ok(handled.includes(true));
    for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) {
      await new Promise(setImmediate);
    }
    return responses;
  }

  function createRealContentConfirmationClient() {
    const contentSource = readFileSync(
      new URL('../content.js', import.meta.url),
      'utf8'
    );
    const start = contentSource.indexOf('function createHistoryUniqueId');
    const end = contentSource.indexOf(
      '\n  // 从 storage 恢复提交后上下文',
      start
    );
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    let dispatchCount = 0;
    const context = vm.createContext({
      Date,
      Math,
      crypto: {
        randomUUID: () => 'content-confirmation-revision'
      },
      console: { log() {}, warn() {}, error() {} },
      chrome: {
        runtime: {
          async sendMessage(contentMessage) {
            dispatchCount += 1;
            const responses = await dispatchConfirm(contentMessage);
            return responses[0];
          }
        }
      },
      window: {
        AutoCommentBatchSubmitContext: {
          clear() {
            throw new Error('content must not clear terminal context');
          }
        }
      }
    });
    vm.runInContext(
      `let historyRevisionSequence = 0;
${contentSource.slice(start, end)}
globalThis.confirmBatchHistoryDurably = confirmBatchHistoryDurably;`,
      context
    );
    return {
      confirm: context.confirmBatchHistoryDurably,
      get dispatchCount() {
        return dispatchCount;
      }
    };
  }

  const resultStorageBeforeInvalidMessages = structuredClone({
    batchResults: storageData.batchResults,
    batchReportedUrls: storageData.batchReportedUrls
  });
  for (const type of [
    'BATCH_HANDLE_CONFIRM',
    'BATCH_PERSIST_PENDING_RESULT',
    'BATCH_REPORT_RESULT',
    'BATCH_HISTORY_PENDING_FALLBACK'
  ]) {
    const responses = await dispatchConfirm({
      type,
      batchId: 'batch-incomplete',
      urlIndex: 3,
      result: 'fail',
      errorCode: 'task_failed'
    });
    assert.equal(responses[0]?.ok, false);
    assert.match(
      responses[0]?.error || '',
      /stale_attempt|invalid_batch_result_identity/
    );
  }
  assert.deepEqual({
    batchResults: storageData.batchResults,
    batchReportedUrls: storageData.batchReportedUrls
  }, resultStorageBeforeInvalidMessages);

  const sourceItems = Array.from({ length: 14 }, (_, originalIndex) => {
    const url = originalIndex === 9
      ? message.url
      : `https://target.test/${originalIndex}`;
    return {
      originalIndex,
      url,
      sourceDomain: 'target.test',
      originalRow: [String(originalIndex), url]
    };
  });
  const startResponses = await dispatchConfirm(
    {
      type: 'BATCH_SESSION_START',
      batchId: message.batchId,
      source: {
        fileName: 'integration.csv',
        headers: ['id', 'URL'],
        rows: sourceItems.map((item) => item.originalRow),
        parsedUrls: sourceItems
      },
      settings: {
        autoOpenPanel: true,
        autoGenerate: true,
        autoSubmit: true,
        timeoutSeconds: 60,
        concurrency: 1
      }
    },
    {
      id: 'extension-id',
      tab: { id: 900, windowId: 52 },
      url: 'chrome-extension://extension-id/batch.html'
    }
  );
  assert.equal(startResponses[0]?.ok, true);
  assert.deepEqual(powerCalls, [['request', 'system']]);
  assert.equal(startupListeners.length, 1);

  async function activateTask(urlIndex, { submitting = false } = {}) {
    const attempt = 1;
    const activeResponses = await dispatchConfirm({
      type: 'BATCH_CREATE_WORKER_TAB',
      batchId: message.batchId,
      urlIndex,
      attempt,
      requestId: `${message.batchId}:${urlIndex}:${attempt}`
    }, {
      id: 'extension-id',
      tab: { id: 900, windowId: 52 },
      url: 'chrome-extension://extension-id/batch.html'
    });
    assert.equal(activeResponses[0]?.ok, true);
    if (submitting) {
      const submittingResponses = await dispatchConfirm({
        type: 'BATCH_TASK_SUBMITTING',
        batchId: message.batchId,
        urlIndex,
        attempt
      });
      assert.equal(submittingResponses[0]?.ok, true);
    }
  }

  await activateTask(message.urlIndex, { submitting: true });

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      result: 'success',
      history: message.history
    }
  }), [{ ok: true }]);
  assert.ok(storageData.batchSubmitContextsByTab['42']);

  const historyProbe = await openCommentHistoryDb({
    indexedDBImpl: globalThis.indexedDB,
    IDBKeyRangeImpl: globalThis.IDBKeyRange
  });
  const wrongSenderSnapshot = {
    resultCount: storageData.batchResults.length,
    historyCount: await historyProbe.countRecords(),
    runtimeMessageCount: runtimeMessages.length,
    submitContext: structuredClone(
      storageData.batchSubmitContextsByTab['42']
    ),
    task: structuredClone(
      storageData.batchRuntimeCheckpoint.tasks['9']
    ),
    sessionJournal: structuredClone(sessionData),
    tabCount: tabData.size
  };
  const wrongSender = {
    id: 'extension-id',
    tab: { id: 999, windowId: 52 },
    url: 'https://target.test/post'
  };
  for (const ingress of [
    message,
    {
      ...message,
      type: 'BATCH_REPORT_RESULT',
      result: 'fail',
      history: undefined
    },
    {
      ...message,
      type: 'BATCH_PERSIST_PENDING_RESULT',
      result: 'fail',
      history: undefined
    },
    {
      ...message,
      type: 'BATCH_HISTORY_PENDING_FALLBACK'
    }
  ]) {
    const wrongSenderResponses = await dispatchConfirm(
      ingress,
      wrongSender
    );
    assert.equal(wrongSenderResponses[0]?.ok, false, ingress.type);
    assert.deepEqual({
      resultCount: storageData.batchResults.length,
      historyCount: await historyProbe.countRecords(),
      runtimeMessageCount: runtimeMessages.length,
      submitContext: storageData.batchSubmitContextsByTab['42'],
      task: storageData.batchRuntimeCheckpoint.tasks['9'],
      sessionJournal: sessionData,
      tabCount: tabData.size
    }, wrongSenderSnapshot, ingress.type);
  }
  historyProbe.close();

  tabRemoveFailures.push(new Error('remove unavailable'));
  const contentConfirmation = createRealContentConfirmationClient();
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await contentConfirmation.confirm(message)
    )),
    {
      durable: true,
      acknowledgement: {
        ok: true,
        historySaveStatus: 'saved',
        historyPendingCount: 0
      }
    }
  );
  assert.equal(contentConfirmation.dispatchCount, 2);
  assert.equal(runtimeMessages.length, 1);
  assert.equal(runtimeMessages[0].type, 'BATCH_CONFIRMED');
  assert.equal(runtimeMessages[0].attempt, 1);
  assert.equal(runtimeMessages[0].sourceTabId, 42);
  assert.equal(runtimeMessages[0].historySaveStatus, 'saved');
  assert.equal(runtimeMessages[0].historyPendingCount, 0);
  assert.equal(storageData.batchResults.at(-1).attempt, 1);
  assert.equal(
    storageData.batchResults.at(-1).errorCode,
    'confirmed_success'
  );
  assert.equal(
    storageData.batchResults.filter(
      (entry) =>
        entry.batchId === message.batchId &&
        entry.urlIndex === message.urlIndex &&
        entry.attempt === message.attempt
    ).length,
    1
  );
  const successfulHistoryProbe = await openCommentHistoryDb({
    indexedDBImpl: globalThis.indexedDB,
    IDBKeyRangeImpl: globalThis.IDBKeyRange
  });
  assert.equal(
    await successfulHistoryProbe.countRecords(),
    wrongSenderSnapshot.historyCount + 1
  );
  successfulHistoryProbe.close();
  assert.equal(storageData.batchSubmitContextsByTab['42'], undefined);
  assert.equal(
    storageData.batchRuntimeCheckpoint.tasks['9'].state,
    'terminal'
  );
  assert.equal(
    storageData.batchRuntimeCheckpoint.results[0].result,
    'success'
  );
  assert.equal(tabData.has(42), false);
  assert.equal(
    Object.keys(sessionData).some((key) => key.includes(
      `${message.batchId}:${message.urlIndex}:${message.attempt}`
    )),
    false
  );
  const authoritativeSnapshot = {
    results: structuredClone(storageData.batchResults),
    historyCount: await (async () => {
      const probe = await openCommentHistoryDb({
        indexedDBImpl: globalThis.indexedDB,
        IDBKeyRangeImpl: globalThis.IDBKeyRange
      });
      try {
        return await probe.countRecords();
      } finally {
        probe.close();
      }
    })(),
    submitContexts: structuredClone(
      storageData.batchSubmitContextsByTab || {}
    ),
    runtimeMessageCount: runtimeMessages.length,
    checkpoint: structuredClone(storageData.batchRuntimeCheckpoint),
    sessionJournal: structuredClone(sessionData),
    tabCount: tabData.size
  };
  for (const type of [
    'BATCH_HANDLE_CONFIRM',
    'BATCH_REPORT_RESULT',
    'BATCH_PERSIST_PENDING_RESULT',
    'BATCH_HISTORY_PENDING_FALLBACK'
  ]) {
    const terminalResponse = await dispatchConfirm({
      ...message,
      type,
      result: 'fail',
      errorCode: 'late_overwrite',
      errorMessage: 'must not replace authoritative result'
    });
    assert.deepEqual(terminalResponse, [{
      ok: false,
      error: 'task_already_terminal'
    }], type);
    const probe = await openCommentHistoryDb({
      indexedDBImpl: globalThis.indexedDB,
      IDBKeyRangeImpl: globalThis.IDBKeyRange
    });
    const currentHistoryCount = await probe.countRecords();
    probe.close();
    assert.deepEqual({
      results: storageData.batchResults,
      historyCount: currentHistoryCount,
      submitContexts: storageData.batchSubmitContextsByTab || {},
      runtimeMessageCount: runtimeMessages.length,
      checkpoint: storageData.batchRuntimeCheckpoint,
      sessionJournal: sessionData,
      tabCount: tabData.size
    }, authoritativeSnapshot, type);
  }
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SESSION_RESUME',
    batchId: message.batchId
  }, {
    id: 'extension-id',
    tab: { id: 900, windowId: 52 },
    url: 'chrome-extension://extension-id/batch.html'
  }), [{
    ok: true,
    checkpoint: storageData.batchRuntimeCheckpoint,
    changed: true
  }]);

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
  await activateTask(13);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: message.batchId,
      urlIndex: 13,
      attempt: 1,
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
    batchId: 'stale-batch',
    urlIndex: 13,
    history: {
      ...message.history,
      historyRevision: oldRevision
    }
  }), [{
    ok: false,
    error: 'stale_batch'
  }]);
  assert.equal(runtimeMessages.length, messagesBeforeOldAck);
  assert.deepEqual(
    storageData.batchSubmitContextsByTab['42'].history.historyRevision,
    replacementRevision
  );
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
    match: {
      batchId: message.batchId,
      urlIndex: 13,
      attempt: 1,
      historyRevision: replacementRevision
    }
  }), [{ ok: true }]);

  await dispatchConfirm({
    type: 'BATCH_REPORT_RESULT',
    batchId: message.batchId,
    urlIndex: 13,
    attempt: 1,
    result: 'skipped',
    url: sourceItems[13].url,
    errorMessage: 'cleanup'
  });

  await activateTask(8, { submitting: true });
  const fallbackHistory = {
    ...message.history,
    targetPageUrl: sourceItems[8].url,
    historyRevision: {
      capturedAt: fixedNow + 20,
      recordedAt: fixedNow + 21,
      sequence: 3,
      id: 'revision-fallback'
    }
  };
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: message.batchId,
      urlIndex: 8,
      attempt: 1,
      result: 'success',
      history: fallbackHistory
    }
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HISTORY_PENDING_FALLBACK',
    batchId: message.batchId,
    urlIndex: 8,
    attempt: 1,
    url: 'https://target.test/post',
    result: 'success',
    aiContent: 'Generated fallback',
    errorMessage: null,
    history: fallbackHistory
  }), [{
    ok: true,
    historySaveStatus: 'saved',
    historyPendingCount: 0
  }]);
  assert.equal(runtimeMessages.at(-1).historySaveStatus, 'saved');
  assert.equal(runtimeMessages.at(-1).historyPendingCount, 0);
  assert.equal(runtimeMessages.at(-1).attempt, 1);
  assert.equal(storageData.batchSubmitContextsByTab['42'], undefined);

  await activateTask(7);
  const pendingMessage = {
    type: 'BATCH_PERSIST_PENDING_RESULT',
    batchId: message.batchId,
    urlIndex: 7,
    attempt: 1,
    url: sourceItems[7].url,
    result: 'fail',
    aiContent: null,
    errorCode: 'task_failed',
    errorMessage: 'pending failure'
  };
  assert.deepEqual(await dispatchConfirm(pendingMessage), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm(pendingMessage), [{ ok: true }]);
  assert.equal(
    storageData.batchResults.filter(
      (entry) =>
        entry.batchId === message.batchId &&
        entry.urlIndex === 7 &&
        entry.attempt === 1
    ).length,
    1
  );
  assert.equal(
    storageData.batchRuntimeCheckpoint.tasks['7'].state,
    'active'
  );
  assert.equal(tabData.has(42), true);
  assert.deepEqual(await dispatchConfirm({
    ...pendingMessage,
    type: 'BATCH_REPORT_RESULT',
    errorMessage: 'final failure'
  }), [{ ok: true }]);
  assert.equal(
    storageData.batchRuntimeCheckpoint.tasks['7'].state,
    'terminal'
  );
  assert.equal(tabData.has(42), false);
  assert.equal(
    storageData.batchResults.filter(
      (entry) =>
        entry.batchId === message.batchId &&
        entry.urlIndex === 7 &&
        entry.attempt === 1
    ).length,
    1
  );
  assert.equal(
    storageData.batchResults.find(
      (entry) =>
        entry.batchId === message.batchId &&
        entry.urlIndex === 7 &&
        entry.attempt === 1
    ).errorMessage,
    'final failure'
  );

  for (const [offset, result] of ['', false, 0].entries()) {
    const messagesBeforeInvalidTask = runtimeMessages.length;
    const explicitResultResponses = await dispatchConfirm({
      ...message,
      urlIndex: 20 + offset,
      result
    });
    assert.deepEqual(explicitResultResponses, [{
      ok: false,
      error: 'invalid_url_index'
    }]);
    assert.equal(runtimeMessages.length, messagesBeforeInvalidTask);
  }

  await activateTask(12, { submitting: true });
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_SAVE_SUBMIT_CONTEXT',
    context: {
      batchId: message.batchId,
      urlIndex: 12,
      attempt: 1,
      result: 'success',
      history: message.history
    }
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: message.batchId,
    urlIndex: 12,
    attempt: 1
  }), [{ ok: true, unresolved: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: 'stale-batch',
    urlIndex: 12,
    attempt: 1
  }), [{ ok: true, unresolved: false }]);
  const messagesBeforeAmbiguousFailure = runtimeMessages.length;
  const resultsBeforeAmbiguousFailure =
    structuredClone(storageData.batchResults);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_REPORT_RESULT',
    batchId: message.batchId,
    urlIndex: 12,
    attempt: 1,
    result: 'fail',
    url: 'https://target.test/post',
    errorMessage: '提交结果不明确'
  }), [{ ok: true, deferred: true }]);
  assert.equal(
    runtimeMessages.length,
    messagesBeforeAmbiguousFailure,
    'an unresolved post-click context must prevent a terminal close broadcast'
  );
  assert.deepEqual(
    storageData.batchResults,
    resultsBeforeAmbiguousFailure,
    'an unresolved post-click context must not persist a terminal result'
  );
  assert.equal(
    storageData.batchRuntimeCheckpoint.tasks['12'].state,
    'submitting'
  );
  assert.equal(tabData.has(42), true);

  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
    match: {
      batchId: message.batchId,
      urlIndex: 12,
      attempt: 1
    }
  }), [{ ok: true }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_HAS_SUBMIT_CONTEXT',
    tabId: 42,
    batchId: message.batchId,
    urlIndex: 12,
    attempt: 1
  }), [{ ok: true, unresolved: false }]);
  assert.deepEqual(await dispatchConfirm({
    type: 'BATCH_REPORT_RESULT',
    batchId: message.batchId,
    urlIndex: 12,
    attempt: 1,
    result: 'fail',
    url: 'https://target.test/post',
    errorMessage: '确定失败'
  }), [{ ok: true }]);
  assert.equal(runtimeMessages.at(-1).type, 'BATCH_CONFIRMED');
  assert.equal(runtimeMessages.at(-1).attempt, 1);
  assert.equal(runtimeMessages.at(-1).result, 'fail');
});
