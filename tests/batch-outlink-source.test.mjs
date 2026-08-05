import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_OUTLINK_HEADERS,
  BATCH_OUTLINK_MAPPING,
  buildBatchOutlinkParsedCsv,
  buildLegacyBatchOutlinkDocument,
  normalizeBatchOutlinkRecords
} from '../lib/batch-outlink-source.mjs';

test('normalizes and deduplicates saved outlinks without exposing unsafe URLs', () => {
  const records = normalizeBatchOutlinkRecords([
    {
      id: 'first',
      url: 'https://blog.example.test/post?x=1',
      sourceUrl: 'https://app.ahrefs.com/report',
      isDofollow: true,
      lastCapturedAt: 123
    },
    {
      id: 'duplicate',
      url: 'https://blog.example.test/post?x=1',
      sourceHost: 'ignored.test'
    },
    { id: 'unsafe', url: 'javascript:alert(1)' }
  ]);

  assert.deepEqual(records, [{
    id: 'first',
    url: 'https://blog.example.test/post?x=1',
    host: 'blog.example.test',
    sourceHost: 'app.ahrefs.com',
    isDofollow: true,
    lastCapturedAt: 123,
    successCount: 0,
    lastSuccessAt: null,
    successfulPromotionSiteIds: [],
    successfulPromotedDomains: []
  }]);
});

test('preserves success annotations for the saved-outlink picker', () => {
  const [record] = normalizeBatchOutlinkRecords([{
    id: 'successful',
    url: 'https://blog.example.test/post',
    successCount: 3,
    lastSuccessAt: 456,
    successfulPromotionSiteIds: ['site-a', 'site-a', ''],
    successfulPromotedDomains: ['promo.test', 'promo.test']
  }]);

  assert.equal(record.successCount, 3);
  assert.equal(record.lastSuccessAt, 456);
  assert.deepEqual(record.successfulPromotionSiteIds, ['site-a']);
  assert.deepEqual(record.successfulPromotedDomains, ['promo.test']);
});

test('converts selected outlinks into both supported batch import shapes', () => {
  const records = [{
    id: 'one',
    url: 'https://blog.example.test/post',
    host: 'blog.example.test',
    sourceHost: 'source.example.test'
  }];
  const parsed = buildBatchOutlinkParsedCsv(records);

  assert.deepEqual(BATCH_OUTLINK_HEADERS, ['原URL', '来源域名']);
  assert.deepEqual(BATCH_OUTLINK_MAPPING, {
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  });
  assert.deepEqual(parsed, {
    headers: ['原URL', '来源域名'],
    rows: [{
      rowNumber: 2,
      originalRow: [
        'https://blog.example.test/post',
        'source.example.test'
      ]
    }]
  });
  assert.deepEqual(buildLegacyBatchOutlinkDocument(records), {
    headers: ['原URL', '来源域名'],
    rows: [[
      'https://blog.example.test/post',
      'source.example.test'
    ]]
  });
});
