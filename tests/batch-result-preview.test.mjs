import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBatchResultPreview
} from '../lib/batch-result-preview.mjs';

test('normalizes the safe display fields for a batch result', () => {
  assert.deepEqual(normalizeBatchResultPreview({
    commentText: '  A useful\n\ncomment  ',
    anchors: [
      { text: ' Product A ' },
      { anchorText: 'Product B' },
      { text: 'Product A' },
      { href: 'https://ignored.test/' },
      ''
    ],
    promotedWebsiteUrl:
      'https://promo.test/page?campaign=spring&token=private#section'
  }), {
    commentText: 'A useful comment',
    anchorTexts: ['Product A', 'Product B'],
    promotedWebsiteUrl:
      'https://promo.test/page?campaign=spring&token=REDACTED#section'
  });
});

test('uses stable empty values for absent preview fields', () => {
  assert.deepEqual(normalizeBatchResultPreview(), {
    commentText: null,
    anchorTexts: [],
    promotedWebsiteUrl: null
  });
  assert.deepEqual(normalizeBatchResultPreview({
    commentText: '   ',
    anchors: null,
    promotedWebsiteUrl: 'ftp://promo.test/'
  }), {
    commentText: null,
    anchorTexts: [],
    promotedWebsiteUrl: null
  });
});

test('caps comments, anchors, anchor count, and promoted URLs', () => {
  const preview = normalizeBatchResultPreview({
    commentText: 'c'.repeat(20_010),
    anchors: Array.from({ length: 105 }, (_, index) => ({
      text: `${index}-${'a'.repeat(1_100)}`
    })),
    promotedWebsiteUrl: `https://promo.test/${'u'.repeat(2_100)}`
  });

  assert.equal(preview.commentText.length, 20_000);
  assert.equal(preview.anchorTexts.length, 100);
  assert.ok(preview.anchorTexts.every((text) => text.length <= 1_000));
  assert.equal(preview.promotedWebsiteUrl.length, 2_048);
});

test('rejects URL credentials and recursively sensitive fields', () => {
  assert.throws(
    () => normalizeBatchResultPreview({
      promotedWebsiteUrl: 'https://alice:hunter2@promo.test/'
    }),
    /batch_result_preview_url_credentials_forbidden/
  );
  assert.throws(
    () => normalizeBatchResultPreview({
      commentText: 'safe',
      metadata: {
        nested: {
          accessToken: 'do-not-store'
        }
      }
    }),
    /sensitive_field_forbidden/
  );
});
