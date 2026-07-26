import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createCloudHistoryController } from '../lib/cloud-history-controller.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
const csvModuleUrl = pathToFileURL(
  path.join(projectRoot, 'lib/comment-history-csv.mjs')
).href;
const cloudDataSourceModuleUrl = pathToFileURL(
  path.join(projectRoot, 'lib/cloud-history-data-source.mjs')
).href;
const cloudControllerModuleUrl = pathToFileURL(
  path.join(projectRoot, 'lib/cloud-history-controller.mjs')
).href;
const appShellModuleUrl = pathToFileURL(
  path.join(projectRoot, 'lib/app-shell.mjs')
).href;
const historyModuleSource = fs
  .readFileSync(path.join(projectRoot, 'history.js'), 'utf8')
  .replace("'./lib/comment-history-csv.mjs'", `'${csvModuleUrl}'`)
  .replace("'./lib/cloud-history-data-source.mjs'", `'${cloudDataSourceModuleUrl}'`)
  .replace("'./lib/cloud-history-controller.mjs'", `'${cloudControllerModuleUrl}'`)
  .replace("'./lib/app-shell.mjs'", `'${appShellModuleUrl}'`);
const {
  advancePagination,
  buildAnchorsRequest,
  buildConfirmedDeleteRequest,
  buildHistoryFilter,
  buildHistoryListRequest,
  buildNotificationHistoryFilter,
  bootHistoryPage,
  createPaginationState,
  downloadCsvPart,
  localDayEnd,
  localDayStart,
  retreatPagination,
  setStoredText
} = await import(`data:text/javascript;base64,${Buffer.from(historyModuleSource).toString('base64')}`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function historyDocument() {
  const html = fs.readFileSync(path.join(projectRoot, 'history.html'), 'utf8');
  return new JSDOM(html, { url: 'https://extension.test/history.html' }).window.document;
}

function record(id, commentText) {
  return {
    id,
    submittedAt: Date.UTC(2026, 6, 24),
    targetPageUrl: 'https://target.test/post',
    promotedWebsiteUrl: 'https://promo.test/',
    commentText,
    commentHtml: `<p>${commentText}</p>`,
    source: 'live'
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('builds an indexed history filter with local inclusive date bounds', () => {
  assert.deepEqual(buildHistoryFilter({
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    targetDomain: ' EXAMPLE.COM ',
    promotedDomain: 'PROMO.EXAMPLE',
    profileId: ' profile-a ',
    promotionSiteId: ' site-a ',
    anchorTextPrefix: '  Product ',
    hrefDomain: 'LINKS.EXAMPLE',
    pageSize: '50'
  }), {
    from: localDayStart('2026-07-01'),
    to: localDayEnd('2026-07-31'),
    targetDomain: 'example.com',
    promotedDomain: 'promo.example',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    anchorTextPrefix: 'product',
    hrefDomain: 'links.example',
    limit: 50
  });
  assert.equal(localDayEnd('2026-07-31'), localDayStart('2026-08-01') - 1);
});

test('omits invalid and empty filter values and allows only 50 or 100 rows', () => {
  assert.deepEqual(buildHistoryFilter({
    dateFrom: 'not-a-date',
    targetDomain: ' ',
    promotedDomain: null,
    anchorTextPrefix: '',
    hrefDomain: undefined,
    pageSize: 75
  }), { limit: 50 });
  assert.deepEqual(buildHistoryFilter({ pageSize: '100' }), { limit: 100 });
});

test('renders stored HTML as escaped text rather than executable markup', () => {
  const dom = new JSDOM('<div id="value"></div>');
  const element = dom.window.document.getElementById('value');
  setStoredText(element, '<img src=x onerror="globalThis.pwned=true"><b>comment</b>');

  assert.equal(element.textContent, '<img src=x onerror="globalThis.pwned=true"><b>comment</b>');
  assert.equal(element.querySelector('img'), null);
  assert.match(element.innerHTML, /&lt;img/);
});

test('cloud controller renders status and source badges while keeping stored HTML and unsafe URLs inert', () => {
  const document = historyDocument();
  const controller = createCloudHistoryController({
    document,
    dataSource: {
      async deleteEverywhere() {
        throw new Error('delete must not run while rendering');
      }
    },
    confirmDelete: async () => true
  });

  controller.renderStatus({
    enabled: true,
    state: 'idle',
    vaultId: 'vault-a'
  }, false);
  controller.renderRecords([
    {
      comment: {
        ...record('cloud:1', 'Cloud body'),
        targetPageUrl: 'javascript:globalThis.pwned=true',
        commentHtml: '<img src=x onerror="globalThis.pwned=true">'
      },
      anchors: [],
      storageSource: 'cloud'
    },
    {
      comment: record('local:1', 'Local body'),
      anchors: null,
      storageSource: 'local'
    }
  ]);

  assert.match(document.getElementById('cloudHistoryStatus').textContent, /离线/);
  const cloudRow = document.querySelector('[data-record-id="cloud:1"]');
  const localRow = document.querySelector('[data-record-id="local:1"]');
  assert.match(cloudRow.textContent, /云端/);
  assert.match(localRow.textContent, /本机/);
  assert.equal(
    cloudRow.querySelector('[data-action="delete-everywhere"]').textContent,
    '从所有设备永久删除'
  );
  assert.equal(
    localRow.querySelector('[data-action="delete-everywhere"]'),
    null
  );
  assert.equal(cloudRow.querySelector('a[href^="javascript:"]'), null);
  assert.match(cloudRow.textContent, /javascript:globalThis\.pwned=true/);

  cloudRow.querySelector('[data-action="expand"]').click();
  const detail = document.querySelector(
    '[data-detail-for="cloud:1"] .stored-html'
  );
  assert.equal(detail.textContent, '<img src=x onerror="globalThis.pwned=true">');
  assert.equal(detail.querySelector('img'), null);
});

test('permanent delete cancellation makes no call and confirmed delete keeps the row busy until cloud success', async () => {
  const document = historyDocument();
  const deletion = deferred();
  let confirmations = 0;
  let deleteCalls = 0;
  const controller = createCloudHistoryController({
    document,
    dataSource: {
      async deleteEverywhere() {
        deleteCalls += 1;
        return deletion.promise;
      }
    },
    confirmDelete: async () => {
      confirmations += 1;
      return confirmations > 1;
    }
  });
  controller.renderStatus({ enabled: true, state: 'idle' }, true);
  controller.renderRecords([{
    comment: record('cloud:delete', 'Delete me'),
    anchors: [],
    storageSource: 'cloud'
  }]);

  assert.equal(await controller.deleteEverywhere('cloud:delete'), false);
  assert.equal(deleteCalls, 0);
  const pending = controller.deleteEverywhere('cloud:delete');
  await nextTurn();

  const row = document.querySelector('[data-record-id="cloud:delete"]');
  const button = row.querySelector('[data-action="delete-everywhere"]');
  assert.equal(deleteCalls, 1);
  assert.equal(row.isConnected, true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');

  deletion.resolve({ status: 'applied' });
  assert.equal(await pending, true);
  assert.equal(
    document.querySelector('[data-record-id="cloud:delete"]'),
    null
  );
});

test('failed and concurrent permanent deletes keep the newest row and expose only a safe error', async () => {
  const document = historyDocument();
  const deletion = deferred();
  let deleteCalls = 0;
  const controller = createCloudHistoryController({
    document,
    dataSource: {
      async deleteEverywhere() {
        deleteCalls += 1;
        return deletion.promise;
      }
    },
    confirmDelete: async () => true
  });
  controller.renderStatus({ enabled: true, state: 'idle' }, true);
  const bundle = {
    comment: record('cloud:race', 'First render'),
    anchors: [],
    storageSource: 'cloud'
  };
  controller.renderRecords([bundle]);

  const first = controller.deleteEverywhere('cloud:race');
  const second = controller.deleteEverywhere('cloud:race');
  await nextTurn();
  assert.equal(deleteCalls, 1);

  controller.renderRecords([{
    ...bundle,
    comment: record('cloud:race', 'Newer page render')
  }]);
  deletion.reject(new Error('secret backend diagnostics'));
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.match(
    document.querySelector('[data-record-id="cloud:race"]').textContent,
    /Newer page render/
  );
  assert.match(document.getElementById('pageStatus').textContent, /删除失败/);
  assert.doesNotMatch(
    document.getElementById('pageStatus').textContent,
    /secret|backend|diagnostics/
  );
  assert.equal(
    document.querySelector(
      '[data-record-id="cloud:race"] [data-action="delete-everywhere"]'
    ).disabled,
    false
  );
});

test('a successful delete cannot be resurrected by a stale page render', async () => {
  const document = historyDocument();
  const deletion = deferred();
  const controller = createCloudHistoryController({
    document,
    dataSource: {
      async deleteEverywhere() {
        return deletion.promise;
      }
    },
    confirmDelete: async () => true
  });
  controller.renderStatus({ enabled: true, state: 'idle' }, true);
  const bundle = {
    comment: record('cloud:tombstone', 'Before delete'),
    anchors: [],
    storageSource: 'cloud'
  };
  controller.renderRecords([bundle]);
  const pending = controller.deleteEverywhere('cloud:tombstone');
  await nextTurn();
  deletion.resolve({ status: 'applied' });
  assert.equal(await pending, true);

  controller.renderRecords([{
    ...bundle,
    comment: record('cloud:tombstone', 'Stale page')
  }]);
  assert.equal(
    document.querySelector('[data-record-id="cloud:tombstone"]'),
    null
  );
});

test('builds one-cursor list requests and tracks next and previous page cursors', () => {
  const firstCursor = { submittedAt: 200, id: 'batch-a:2' };
  const secondCursor = { submittedAt: 100, id: 'batch-a:1' };
  const initial = createPaginationState();
  const secondPage = advancePagination(initial, firstCursor);
  const thirdPage = advancePagination(secondPage, secondCursor);

  assert.deepEqual(buildHistoryListRequest({ targetDomain: 'EXAMPLE.COM' }, thirdPage.cursor), {
    type: 'HISTORY_LIST',
    targetDomain: 'example.com',
    limit: 50,
    cursor: secondCursor
  });
  assert.deepEqual(retreatPagination(thirdPage), {
    cursors: [null, firstCursor, secondCursor],
    pageIndex: 1,
    cursor: firstCursor
  });
  assert.deepEqual(initial, { cursors: [null], pageIndex: 0, cursor: null });
});

test('maps only the retention notification query to an indexed expiry bound', () => {
  const now = Date.UTC(2026, 6, 24, 12);
  assert.deepEqual(buildNotificationHistoryFilter('?filter=expired&utm_source=notification', now), {
    to: now - 90 * 24 * 60 * 60 * 1000
  });
  assert.deepEqual(buildNotificationHistoryFilter('?filter=due-soon', now), {});
  assert.deepEqual(buildNotificationHistoryFilter('?filter=expired%00', now), {});
});

test('builds lazy anchor and explicitly confirmed deletion request shapes', () => {
  assert.deepEqual(buildAnchorsRequest('batch-a:7'), {
    type: 'HISTORY_ANCHORS',
    commentId: 'batch-a:7'
  });
  assert.deepEqual(buildConfirmedDeleteRequest(' export-session-a '), {
    type: 'HISTORY_DELETE_CONFIRMED',
    confirmed: true,
    exportSessionId: 'export-session-a'
  });
});

test('downloads a CSV Blob and always revokes its completed object URL', () => {
  const document = historyDocument();
  const calls = [];
  class BlobFixture {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      calls.push(['blob', parts, options]);
    }
  }
  const urlApi = {
    createObjectURL(blob) {
      calls.push(['create', blob]);
      return 'blob:csv-part';
    },
    revokeObjectURL(url) {
      calls.push(['revoke', url]);
    }
  };
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = (tagName) => {
    const element = originalCreateElement(tagName);
    if (tagName === 'a') {
      element.click = () => calls.push(['click', element.download, element.href]);
    }
    return element;
  };

  downloadCsvPart(document, ['\ufeffheader\r\n', 'row\r\n'], 'part-001.csv', {
    BlobCtor: BlobFixture,
    urlApi
  });

  assert.deepEqual(calls.map(([name]) => name), ['blob', 'create', 'click', 'revoke']);
  assert.deepEqual(calls[0].slice(1), [
    ['\ufeffheader\r\n', 'row\r\n'],
    { type: 'text/csv;charset=utf-8' }
  ]);
  assert.deepEqual(calls[2], ['click', 'part-001.csv', 'blob:csv-part']);
});

test('history startup retries a live worker queue before loading and displays remaining pending count', async () => {
  const document = historyDocument();
  const requests = [];
  const requestMessage = async (message) => {
    requests.push(message);
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 25, saved: 23, pending: 2 };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();

  assert.equal(requests[0].type, 'HISTORY_RETRY_PENDING');
  assert.ok(
    requests.findIndex(({ type }) => type === 'HISTORY_RETRY_PENDING')
      < requests.findIndex(({ type }) => type === 'HISTORY_LIST')
  );
  assert.equal(document.getElementById('historyPendingBanner').hidden, false);
  assert.match(document.getElementById('historyPendingBanner').textContent, /2/);
});

test('zero post-retry pending count clears an earlier queued-row warning', async () => {
  const document = historyDocument();
  const banner = document.getElementById('historyPendingBanner');
  banner.hidden = false;
  banner.textContent = '旧队列仍有 1 条等待保存';
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 1, saved: 1, pending: 0 };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();

  assert.equal(banner.hidden, true);
  assert.equal(banner.textContent, '');
});

test('history keeps a warning visible when the post-retry count is unknown', async () => {
  const document = historyDocument();
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 1, saved: 1, pending: null };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();

  assert.equal(document.getElementById('historyPendingBanner').hidden, false);
  assert.match(
    document.getElementById('historyPendingBanner').textContent,
    /暂时无法刷新/
  );
});

test('exports session chunks into bounded parts then sends only confirmed session deletion', async () => {
  const document = historyDocument();
  document.getElementById('targetDomain').value = 'archive.test';
  const requests = [];
  const downloads = [];
  let chunkNumber = 0;
  const bundles = [
    { comment: record('batch-a:3', 'Three'), anchors: [] },
    { comment: record('batch-a:2', 'Two'), anchors: [] },
    { comment: record('batch-a:1', 'One'), anchors: [] }
  ];
  const requestMessage = async (message) => {
    requests.push(message);
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    if (message.type === 'HISTORY_EXPORT_START') {
      return {
        exportSessionId: 'export-session-a',
        exportedBefore: Date.UTC(2026, 6, 24),
        expectedCount: 3,
        cleanupEligible: true,
        cleanupEligibleCount: 3,
        snapshotRange: {
          from: null,
          to: Date.UTC(2026, 6, 24)
        },
        criteria: { targetDomain: 'archive.test' }
      };
    }
    if (message.type === 'HISTORY_EXPORT_CHUNK') {
      chunkNumber += 1;
      return chunkNumber === 1
        ? {
            records: bundles.slice(0, 2),
            nextCursor: { submittedAt: 100, id: 'batch-a:2' }
          }
        : { records: bundles.slice(2), nextCursor: null };
    }
    if (message.type === 'HISTORY_EXPORT_FINISH') return {};
    if (message.type === 'HISTORY_DELETE_CONFIRMED') {
      return { deletedCount: 3 };
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0,
    rowsPerPart: 2,
    downloadPart(parts, filename) {
      downloads.push({ csv: parts.join(''), filename });
    }
  });
  await nextTurn();
  document.getElementById('exportHistoryBtn').click();
  await nextTurn();
  await nextTurn();

  const exportRequests = requests.filter(({ type }) => type.startsWith('HISTORY_EXPORT'));
  assert.deepEqual(exportRequests[0], {
    type: 'HISTORY_EXPORT_START',
    targetDomain: 'archive.test',
    limit: 50
  });
  assert.deepEqual(exportRequests[1], {
    type: 'HISTORY_EXPORT_CHUNK',
    exportSessionId: 'export-session-a'
  });
  assert.deepEqual(exportRequests[2], {
    type: 'HISTORY_EXPORT_CHUNK',
    exportSessionId: 'export-session-a',
    cursor: { submittedAt: 100, id: 'batch-a:2' }
  });
  assert.equal(downloads.length, 2);
  assert.match(downloads[0].csv, /^\ufeffid,batchId/);
  assert.match(downloads[0].csv, /batch-a:3/);
  assert.match(downloads[0].csv, /batch-a:2/);
  assert.doesNotMatch(downloads[0].csv, /batch-a:1/);
  assert.match(downloads[1].csv, /^\ufeffid,batchId/);
  assert.match(downloads[1].csv, /batch-a:1/);
  assert.deepEqual(exportRequests[3], {
    type: 'HISTORY_EXPORT_FINISH',
    exportSessionId: 'export-session-a',
    filenames: [
      'comment-history-all-20260724-part-001.csv',
      'comment-history-all-20260724-part-002.csv'
    ]
  });
  assert.equal(document.getElementById('confirmDeleteBtn').hidden, false);
  assert.equal(document.getElementById('confirmDeleteBtn').disabled, false);
  assert.match(
    document.getElementById('exportStatus').textContent,
    /服务器快照 3 条.*2026.*2 个文件/
  );

  document.getElementById('confirmDeleteBtn').click();
  await nextTurn();
  assert.deepEqual(
    requests.find(({ type }) => type === 'HISTORY_DELETE_CONFIRMED'),
    {
      type: 'HISTORY_DELETE_CONFIRMED',
      confirmed: true,
      exportSessionId: 'export-session-a'
    }
  );
});

test('mixed-age export remains archive-only and shows the authoritative snapshot range', async () => {
  const document = historyDocument();
  const requests = [];
  const requestMessage = async (message) => {
    requests.push(message);
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 0, saved: 0, pending: 0 };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    if (message.type === 'HISTORY_EXPORT_START') {
      return {
        exportSessionId: 'archive-only-session',
        exportedBefore: Date.UTC(2026, 6, 24),
        expectedCount: 1,
        cleanupEligible: false,
        cleanupEligibleCount: 0,
        snapshotRange: {
          from: Date.UTC(2026, 5, 1),
          to: Date.UTC(2026, 6, 24)
        },
        criteria: {}
      };
    }
    if (message.type === 'HISTORY_EXPORT_CHUNK') {
      return {
        records: [{ comment: record('batch-a:1', 'Mixed age'), anchors: [] }],
        nextCursor: null
      };
    }
    if (message.type === 'HISTORY_EXPORT_FINISH') return {};
    if (message.type === 'HISTORY_DELETE_CONFIRMED') {
      throw new Error('archive-only export must not request deletion');
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0,
    downloadPart() {}
  });
  await nextTurn();
  await nextTurn();
  document.getElementById('exportHistoryBtn').click();
  await nextTurn();
  await nextTurn();

  assert.equal(document.getElementById('confirmDeleteBtn').hidden, true);
  assert.equal(document.getElementById('confirmDeleteBtn').disabled, true);
  assert.match(
    document.getElementById('exportStatus').textContent,
    /仅归档.*服务器快照 1 条.*2026.*不提供删除确认/
  );
  assert.equal(
    requests.some(({ type }) => type === 'HISTORY_DELETE_CONFIRMED'),
    false
  );
});

test('changing a filter invalidates and hides an eligible export confirmation', async () => {
  const document = historyDocument();
  const requests = [];
  const requestMessage = async (message) => {
    requests.push(message);
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 0, saved: 0, pending: 0 };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    if (message.type === 'HISTORY_EXPORT_START') {
      return {
        exportSessionId: 'eligible-session',
        exportedBefore: Date.UTC(2026, 6, 24),
        expectedCount: 1,
        cleanupEligible: true,
        cleanupEligibleCount: 1,
        snapshotRange: {
          from: null,
          to: Date.UTC(2026, 3, 25)
        },
        criteria: { to: Date.UTC(2026, 3, 25) }
      };
    }
    if (message.type === 'HISTORY_EXPORT_CHUNK') {
      return {
        records: [{ comment: record('batch-a:1', 'Expired'), anchors: [] }],
        nextCursor: null
      };
    }
    if (message.type === 'HISTORY_EXPORT_FINISH') return {};
    if (message.type === 'HISTORY_DELETE_CONFIRMED') return { deletedCount: 1 };
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0,
    downloadPart() {}
  });
  await nextTurn();
  await nextTurn();
  document.getElementById('exportHistoryBtn').click();
  await nextTurn();
  await nextTurn();
  assert.equal(document.getElementById('confirmDeleteBtn').hidden, false);

  const targetDomain = document.getElementById('targetDomain');
  targetDomain.value = 'changed.test';
  targetDomain.dispatchEvent(
    new document.defaultView.Event('input', { bubbles: true })
  );
  assert.equal(document.getElementById('confirmDeleteBtn').hidden, true);
  assert.equal(document.getElementById('confirmDeleteBtn').disabled, true);
  document.getElementById('confirmDeleteBtn').click();
  await nextTurn();
  assert.equal(
    requests.some(({ type }) => type === 'HISTORY_DELETE_CONFIRMED'),
    false
  );
});

test('changing a filter during export cannot resurrect the stale session delete confirmation', async () => {
  const document = historyDocument();
  const finishRequest = deferred();
  const requests = [];
  const requestMessage = async (message) => {
    requests.push(message);
    if (message.type === 'HISTORY_RETRY_PENDING') {
      return { retried: 0, saved: 0, pending: 0 };
    }
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') return { records: [], nextCursor: null };
    if (message.type === 'HISTORY_EXPORT_START') {
      return {
        exportSessionId: 'stale-eligible-session',
        exportedBefore: Date.UTC(2026, 6, 24),
        expectedCount: 1,
        cleanupEligible: true,
        cleanupEligibleCount: 1,
        snapshotRange: {
          from: null,
          to: Date.UTC(2026, 3, 25)
        },
        criteria: { to: Date.UTC(2026, 3, 25) }
      };
    }
    if (message.type === 'HISTORY_EXPORT_CHUNK') {
      return {
        records: [{ comment: record('batch-a:1', 'Expired'), anchors: [] }],
        nextCursor: null
      };
    }
    if (message.type === 'HISTORY_EXPORT_FINISH') return finishRequest.promise;
    if (message.type === 'HISTORY_DELETE_CONFIRMED') {
      throw new Error('stale export must not request deletion');
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0,
    downloadPart() {}
  });
  await nextTurn();
  await nextTurn();
  document.getElementById('exportHistoryBtn').click();
  await nextTurn();

  const targetDomain = document.getElementById('targetDomain');
  targetDomain.value = 'new-filter.test';
  targetDomain.dispatchEvent(
    new document.defaultView.Event('input', { bubbles: true })
  );
  finishRequest.resolve({});
  await nextTurn();
  await nextTurn();

  assert.equal(document.getElementById('confirmDeleteBtn').hidden, true);
  assert.equal(document.getElementById('confirmDeleteBtn').disabled, true);
  assert.match(document.getElementById('exportStatus').textContent, /筛选条件已更改/);
  document.getElementById('confirmDeleteBtn').click();
  await nextTurn();
  assert.equal(
    requests.some(({ type }) => type === 'HISTORY_DELETE_CONFIRMED'),
    false
  );
});

test('keeps confirmed deletion success when the best-effort page refresh fails', async () => {
  const document = historyDocument();
  let deletionSucceeded = false;
  const refreshFailure = {};
  Object.defineProperty(refreshFailure, 'message', {
    get() {
      throw new Error('refresh status rendering failed');
    }
  });
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_LIST') {
      if (deletionSucceeded) throw refreshFailure;
      return { records: [], nextCursor: null };
    }
    if (message.type === 'HISTORY_EXPORT_START') {
      return {
        exportSessionId: 'export-session-a',
        exportedBefore: Date.UTC(2026, 6, 24),
        expectedCount: 0,
        cleanupEligible: true,
        cleanupEligibleCount: 0,
        snapshotRange: {
          from: null,
          to: Date.UTC(2026, 6, 24)
        },
        criteria: {}
      };
    }
    if (message.type === 'HISTORY_EXPORT_CHUNK') {
      return { records: [], nextCursor: null };
    }
    if (message.type === 'HISTORY_EXPORT_FINISH') return {};
    if (message.type === 'HISTORY_DELETE_CONFIRMED') {
      deletionSucceeded = true;
      return { deletedCount: 0 };
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0,
    downloadPart() {}
  });
  await nextTurn();
  document.getElementById('exportHistoryBtn').click();
  await nextTurn();
  await nextTurn();
  document.getElementById('confirmDeleteBtn').click();
  await nextTurn();
  await nextTurn();

  const status = document.getElementById('exportStatus').textContent;
  assert.match(status, /已删除 0 条已归档记录/);
  assert.match(status, /刷新失败/);
  assert.doesNotMatch(status, /删除失败/);
  assert.equal(document.getElementById('confirmDeleteBtn').hidden, true);
  assert.equal(document.getElementById('confirmDeleteBtn').disabled, true);
  assert.equal(document.getElementById('exportHistoryBtn').disabled, false);
});

test('editing a form field without Apply keeps Next bound to the active filter snapshot', async () => {
  const document = historyDocument();
  document.getElementById('targetDomain').value = 'original.example';
  const firstPage = deferred();
  const secondPage = deferred();
  const listRequests = [];
  const requestMessage = (message) => {
    if (message.type === 'HISTORY_SUMMARY') return Promise.resolve({});
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return Promise.resolve([]);
    if (message.type === 'HISTORY_LIST') {
      listRequests.push(message);
      return listRequests.length === 1 ? firstPage.promise : secondPage.promise;
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0
  });
  firstPage.resolve({
    records: [record('batch-a:1', 'First page')],
    nextCursor: { submittedAt: 100, id: 'batch-a:1' }
  });
  await nextTurn();

  document.getElementById('targetDomain').value = 'edited.example';
  document.getElementById('nextPageBtn').click();
  assert.equal(listRequests.length, 2);
  assert.deepEqual(listRequests[1], {
    type: 'HISTORY_LIST',
    targetDomain: 'original.example',
    limit: 50,
    cursor: { submittedAt: 100, id: 'batch-a:1' }
  });

  secondPage.resolve({ records: [], nextCursor: null });
  await nextTurn();
});

test('a stale page completion cannot render rows or replace the newer cursor', async () => {
  const document = historyDocument();
  document.getElementById('targetDomain').value = 'older.example';
  const olderPage = deferred();
  const newerPage = deferred();
  const nextPage = deferred();
  const listRequests = [];
  const requestMessage = (message) => {
    if (message.type === 'HISTORY_SUMMARY') return Promise.resolve({});
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return Promise.resolve([]);
    if (message.type === 'HISTORY_LIST') {
      listRequests.push(message);
      return [olderPage.promise, newerPage.promise, nextPage.promise][listRequests.length - 1];
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    search: '',
    estimateStorage: async () => 0
  });
  document.getElementById('targetDomain').value = 'newer.example';
  document.getElementById('historyFilterForm').dispatchEvent(
    new document.defaultView.Event('submit', { bubbles: true, cancelable: true })
  );

  const newerCursor = { submittedAt: 200, id: 'batch-new:2' };
  newerPage.resolve({
    records: [record('batch-new:2', 'Newer response')],
    nextCursor: newerCursor
  });
  await nextTurn();
  olderPage.resolve({
    records: [record('batch-old:1', 'Older response')],
    nextCursor: { submittedAt: 100, id: 'batch-old:1' }
  });
  await nextTurn();

  assert.match(document.getElementById('historyTableBody').textContent, /Newer response/);
  assert.doesNotMatch(document.getElementById('historyTableBody').textContent, /Older response/);
  document.getElementById('nextPageBtn').click();
  assert.deepEqual(listRequests.at(-1), {
    type: 'HISTORY_LIST',
    targetDomain: 'newer.example',
    limit: 50,
    cursor: newerCursor
  });

  nextPage.resolve({ records: [], nextCursor: null });
  await nextTurn();
});

test('history page preserves an opaque source cursor identity across local-to-cloud pagination', async () => {
  const document = historyDocument();
  const opaqueCursor = Object.freeze({
    phase: 'cloud',
    localCursor: null,
    cloudCursor: null,
    cutoff: 123
  });
  const listCalls = [];
  const dataSource = {
    async status() {
      return { enabled: true, state: 'idle', pendingCount: 0 };
    },
    async list(filter, cursor) {
      listCalls.push({ filter, cursor });
      return listCalls.length === 1
        ? {
            records: [{
              comment: record('local:cursor', 'Local first page'),
              anchors: null,
              storageSource: 'local'
            }],
            nextCursor: opaqueCursor
          }
        : { records: [], nextCursor: null };
    },
    async deleteEverywhere() {
      throw new Error('delete not expected');
    }
  };
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_RETRY_PENDING') return { pending: 0 };
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_ANCHORS') return [];
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    dataSource,
    isOnline: () => true,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();
  document.getElementById('nextPageBtn').click();
  await nextTurn();

  assert.equal(listCalls.length, 2);
  assert.strictEqual(listCalls[1].cursor, opaqueCursor);
  assert.equal(listCalls[1].filter.syncEnabled, true);
  assert.equal(listCalls[1].filter.online, true);
});

test('offline cloud-required failure keeps the currently rendered rows and reports availability safely', async () => {
  const document = historyDocument();
  const listCalls = [];
  const dataSource = {
    async status() {
      return { enabled: true, state: 'idle', pendingCount: 0 };
    },
    async list(filter, cursor) {
      listCalls.push({ filter, cursor });
      if (filter.targetDomain) {
        const error = new Error('当前离线，无法读取所需的云端评论历史。');
        error.code = 'CLOUD_HISTORY_UNAVAILABLE_OFFLINE';
        throw error;
      }
      return {
        records: [{
          comment: record('local:preserved', 'Keep this row'),
          anchors: null,
          storageSource: 'local'
        }],
        nextCursor: null
      };
    },
    async deleteEverywhere() {
      throw new Error('delete not expected');
    }
  };
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_RETRY_PENDING') return { pending: 0 };
    if (message.type === 'HISTORY_SUMMARY') return {};
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    if (message.type === 'HISTORY_ANCHORS') return [];
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    dataSource,
    isOnline: () => false,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();
  assert.match(document.getElementById('historyTableBody').textContent, /Keep this row/);

  document.getElementById('targetDomain').value = 'target.test';
  document.getElementById('historyFilterForm').dispatchEvent(
    new document.defaultView.Event('submit', {
      bubbles: true,
      cancelable: true
    })
  );
  await nextTurn();

  assert.match(document.getElementById('historyTableBody').textContent, /Keep this row/);
  assert.match(document.getElementById('pageStatus').textContent, /当前离线/);
  assert.equal(listCalls[1].filter.targetDomain, 'target.test');
  assert.equal(listCalls[1].filter.online, false);
});

test('enabled sync explains that only repository-approved old rows are automatic local cache eviction candidates', async () => {
  const document = historyDocument();
  const dataSource = {
    async status() {
      return { enabled: true, state: 'idle', pendingCount: 0 };
    },
    async list() {
      return { records: [], nextCursor: null };
    },
    async deleteEverywhere() {
      throw new Error('delete not expected');
    }
  };
  const requestMessage = async (message) => {
    if (message.type === 'HISTORY_RETRY_PENDING') return { pending: 0 };
    if (message.type === 'HISTORY_SUMMARY') {
      return {
        expiredCount: 2,
        dueSoonCount: 0
      };
    }
    if (message.type === 'HISTORY_ARCHIVE_EVENTS') return [];
    throw new Error(`Unexpected request: ${message.type}`);
  };

  bootHistoryPage(document, {
    requestMessage,
    dataSource,
    isOnline: () => true,
    search: '',
    estimateStorage: async () => 0
  });
  await nextTurn();
  await nextTurn();

  assert.match(
    document.getElementById('retentionBanner').textContent,
    /已确认同步.*本机缓存.*自动清理/
  );
  assert.doesNotMatch(
    document.getElementById('retentionBanner').textContent,
    /直到.*明确确认删除/
  );
});

test('history layout includes summaries, indexed filters, pagination, archive and lifecycle controls', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'history.html'), 'utf8');
  for (const id of [
    'summaryTotal',
    'summaryLast24Hours',
    'summaryDueSoon',
    'summaryExpired',
    'summaryStorage',
    'cloudHistoryStatus',
    'retentionBanner',
    'historyPendingBanner',
    'dateFrom',
    'dateTo',
    'targetDomain',
    'promotedDomain',
    'profileId',
    'promotionSiteId',
    'anchorTextPrefix',
    'hrefDomain',
    'pageSize',
    'historyTableBody',
    'previousPageBtn',
    'nextPageBtn',
    'archiveTableBody',
    'exportHistoryBtn',
    'confirmDeleteBtn',
    'exportStatus'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="50"/);
  assert.match(html, /<option value="100"/);
});

test('entry pages expose comment history through the shared application shell', async () => {
  const optionsHtml = fs.readFileSync(path.join(projectRoot, 'options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(projectRoot, 'options.js'), 'utf8');
  const batchHtml = fs.readFileSync(path.join(projectRoot, 'batch.html'), 'utf8');
  const { bootAppShell } = await import(appShellModuleUrl);
  const document = new JSDOM(batchHtml, {
    url: 'chrome-extension://extension-id/batch.html'
  }).window.document;
  bootAppShell(document, { currentUrl: document.location.href });

  assert.match(optionsHtml, /id="openHistoryBtn"[^>]*>[^<]*评论历史/);
  assert.match(optionsJs, /chrome\.tabs\.create\(\{ url: 'history\.html' \}\)/);
  const historyLink = [...document.querySelectorAll('a')].find(
    (link) => link.textContent === '评论历史'
  );
  assert.ok(historyLink);
  assert.equal(historyLink.getAttribute('href'), 'history.html');
});
