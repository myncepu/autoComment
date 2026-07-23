import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
const csvModuleUrl = pathToFileURL(
  path.join(projectRoot, 'lib/comment-history-csv.mjs')
).href;
const historyModuleSource = fs
  .readFileSync(path.join(projectRoot, 'history.js'), 'utf8')
  .replace("'./lib/comment-history-csv.mjs'", `'${csvModuleUrl}'`);
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
    anchorTextPrefix: '  Product ',
    hrefDomain: 'LINKS.EXAMPLE',
    pageSize: '50'
  }), {
    from: localDayStart('2026-07-01'),
    to: localDayEnd('2026-07-31'),
    targetDomain: 'example.com',
    promotedDomain: 'promo.example',
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
  assert.match(document.getElementById('exportStatus').textContent, /已处理 3 条，共 2 个文件/);

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

test('history layout includes summaries, indexed filters, pagination, archive and lifecycle controls', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'history.html'), 'utf8');
  for (const id of [
    'summaryTotal',
    'summaryLast24Hours',
    'summaryDueSoon',
    'summaryExpired',
    'summaryStorage',
    'retentionBanner',
    'dateFrom',
    'dateTo',
    'targetDomain',
    'promotedDomain',
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

test('entry pages expose comment history links and batch requests retention status', () => {
  const optionsHtml = fs.readFileSync(path.join(projectRoot, 'options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(projectRoot, 'options.js'), 'utf8');
  const batchHtml = fs.readFileSync(path.join(projectRoot, 'batch.html'), 'utf8');
  const batchJs = fs.readFileSync(path.join(projectRoot, 'batch.js'), 'utf8');

  assert.match(optionsHtml, /id="openHistoryBtn"[^>]*>[^<]*评论历史/);
  assert.match(optionsJs, /chrome\.tabs\.create\(\{ url: 'history\.html' \}\)/);
  assert.match(batchHtml, /id="openHistoryBtn"[^>]*>[^<]*评论历史/);
  assert.match(batchHtml, /id="historyRetentionBanner"/);
  assert.match(batchJs, /type:\s*'HISTORY_RETENTION_STATUS'/);
});
