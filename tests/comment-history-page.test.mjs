import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
const historyModuleSource = fs.readFileSync(path.join(projectRoot, 'history.js'), 'utf8');
const {
  advancePagination,
  buildAnchorsRequest,
  buildConfirmedDeleteRequest,
  buildHistoryFilter,
  buildHistoryListRequest,
  buildNotificationHistoryFilter,
  createPaginationState,
  localDayEnd,
  localDayStart,
  retreatPagination,
  setStoredText
} = await import(`data:text/javascript;base64,${Buffer.from(historyModuleSource).toString('base64')}`);

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
    'confirmDeleteBtn'
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
