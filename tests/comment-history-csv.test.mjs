import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMENT_CSV_HEADER,
  CSV_EXPORT_CHUNK_SIZE,
  CSV_ROWS_PER_PART,
  buildCommentCsvRow,
  buildCsvPartName,
  escapeCsvCell
} from '../lib/comment-history-csv.mjs';

test('escapes spreadsheet formulas and standard CSV control characters safely', () => {
  assert.equal(escapeCsvCell('=cmd()'), "'=cmd()");
  assert.equal(escapeCsvCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(escapeCsvCell('-1+2'), "'-1+2");
  assert.equal(escapeCsvCell('@payload'), "'@payload");
  assert.equal(escapeCsvCell('a,"b"'), '"a,""b"""');
  assert.equal(escapeCsvCell('line 1\r\nline 2'), '"line 1\r\nline 2"');
  assert.equal(escapeCsvCell('中文评论'), '中文评论');
});

test('uses a BOM and one fixed stable column order', () => {
  assert.equal(COMMENT_CSV_HEADER.charCodeAt(0), 0xfeff);
  assert.equal(
    COMMENT_CSV_HEADER,
    '\ufeffid,batchId,urlIndex,submittedAt,targetPageUrl,targetDomain,promotedWebsiteUrl,promotedDomain,commentHtml,commentText,anchorTexts,anchorHrefRaws,anchorHrefResolveds,submitStatus,source\r\n'
  );
});

test('builds rows in header order with local timestamp and anchor JSON arrays', () => {
  const record = {
    id: 'batch-a:7',
    batchId: 'batch-a',
    urlIndex: 7,
    submittedAt: new Date(2026, 6, 24, 12, 34, 56).getTime(),
    targetPageUrl: 'https://target.test/post?a=1,b=2',
    targetDomain: 'target.test',
    promotedWebsiteUrl: 'https://promo.test/',
    promotedDomain: 'promo.test',
    commentHtml: '<p>中文, "评论"</p>',
    commentText: '=unsafe',
    submitStatus: 'submitted',
    source: 'live'
  };
  const anchors = [{
    anchorText: '产品 "A"',
    hrefRaw: '/go?a=1,b=2',
    hrefResolved: 'https://target.test/go?a=1,b=2'
  }, {
    anchorText: '@危险',
    hrefRaw: '=HYPERLINK("https://evil.test")',
    hrefResolved: 'https://target.test/safe'
  }];

  const row = buildCommentCsvRow(record, anchors);
  assert.match(row, /^batch-a:7,batch-a,7,2026-07-24T12:34:56[+-]\d{2}:\d{2},/);
  assert.match(row, /,'=unsafe,/);
  assert.ok(row.includes(escapeCsvCell(JSON.stringify(['产品 "A"', '@危险']))));
  assert.ok(row.includes(escapeCsvCell(JSON.stringify([
    '/go?a=1,b=2',
    '=HYPERLINK("https://evil.test")'
  ]))));
  assert.ok(row.endsWith(',submitted,live\r\n'));
});

test('pads part numbers and exposes the background and file row boundaries', () => {
  assert.equal(CSV_EXPORT_CHUNK_SIZE, 500);
  assert.equal(CSV_ROWS_PER_PART, 50_000);
  assert.equal(buildCsvPartName({
    from: Date.UTC(2026, 6, 1),
    to: Date.UTC(2026, 6, 31),
    part: 2
  }), 'comment-history-20260701-20260731-part-002.csv');
  assert.equal(buildCsvPartName({
    exportedBefore: Date.UTC(2026, 6, 24),
    part: 1
  }), 'comment-history-all-20260724-part-001.csv');
});
