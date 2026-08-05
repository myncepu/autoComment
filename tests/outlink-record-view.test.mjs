import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeOutlinkPageSize,
  OUTLINK_PAGE_SIZES,
  sourcePageLinkLabel
} from '../lib/outlink-record-view.mjs';

test('accepts only the supported page sizes up to two thousand rows', () => {
  assert.deepEqual(OUTLINK_PAGE_SIZES, [50, 100, 200, 500, 1000, 2000]);
  assert.equal(normalizeOutlinkPageSize('1000'), 1000);
  assert.equal(normalizeOutlinkPageSize('5000'), 50);
  assert.equal(normalizeOutlinkPageSize('invalid'), 50);
});

test('uses the source domain instead of the full source URL', () => {
  assert.equal(sourcePageLinkLabel({
    sourceHost: 'app.ahrefs.com',
    sourceUrl: 'https://app.ahrefs.com/site-explorer/backlinks?target=example.test'
  }), 'app.ahrefs.com');
});

test('derives a domain for legacy records without a stored source host', () => {
  assert.equal(sourcePageLinkLabel({
    sourceUrl: 'https://blog.example.test/a/very/long/path?with=query'
  }), 'blog.example.test');
  assert.equal(sourcePageLinkLabel({}), '—');
});
