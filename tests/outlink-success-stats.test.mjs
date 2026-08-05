import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annotateOutlinkRecords,
  canonicalSuccessHost,
  compareOutlinksBySuccess,
  promotionAlreadySucceeded,
  summarizeSuccessfulComments
} from '../lib/outlink-success-stats.mjs';

test('canonicalizes target hosts and aggregates confirmed success by blog and promotion site', () => {
  assert.equal(canonicalSuccessHost('https://WWW.Blog.test/post'), 'blog.test');
  assert.equal(canonicalSuccessHost('www.blog.test'), 'blog.test');
  assert.equal(canonicalSuccessHost('javascript:alert(1)'), '');

  const stats = summarizeSuccessfulComments([
    {
      targetDomain: 'www.blog.test',
      targetPageUrl: 'https://www.blog.test/post-a',
      promotionSiteId: 'site-a',
      promotedDomain: 'promo.test',
      promotedWebsiteUrl: 'https://promo.test/page-a',
      submittedAt: 100
    },
    {
      targetPageUrl: 'https://blog.test/other',
      promotionSiteId: 'site-a',
      promotedWebsiteUrl: 'https://promo.test/',
      submittedAt: 200
    },
    {
      targetDomain: 'other.test',
      promotionSiteId: 'site-b',
      promotedDomain: 'second.test',
      submittedAt: 150
    }
  ]);

  assert.equal(stats[0].targetHost, 'blog.test');
  assert.equal(stats[0].successCount, 2);
  assert.equal(stats[0].lastSuccessAt, 200);
  assert.deepEqual(stats[0].promotions, [{
    promotionSiteId: 'site-a',
    promotedDomain: 'promo.test',
    successCount: 2,
    lastSuccessAt: 200
  }]);
  assert.deepEqual(stats[0].pairs, [{
    targetPageUrl: 'https://www.blog.test/post-a',
    promotedWebsiteUrl: 'https://promo.test/page-a'
  }, {
    targetPageUrl: 'https://blog.test/other',
    promotedWebsiteUrl: 'https://promo.test/'
  }]);
});

test('matches prior promotion success by stable id or promoted domain', () => {
  const stat = {
    targetHost: 'blog.test',
    successCount: 1,
    promotions: [{
      promotionSiteId: 'site-old',
      promotedDomain: 'promo.test',
      successCount: 1
    }]
  };

  assert.equal(promotionAlreadySucceeded(stat, {
    id: 'site-old',
    url: 'https://changed.test/'
  }), true);
  assert.equal(promotionAlreadySucceeded(stat, {
    id: 'site-new',
    url: 'https://www.promo.test/'
  }), true);
  assert.equal(promotionAlreadySucceeded(stat, {
    id: 'site-new',
    url: 'https://unused.test/'
  }), false);
});

test('annotates outlinks and sorts proven blogs ahead of untested blogs', () => {
  const records = annotateOutlinkRecords([
    { id: 'new', url: 'https://new.test/post', host: 'new.test' },
    { id: 'proven', url: 'https://www.proven.test/post', host: 'www.proven.test' }
  ], [{
    targetHost: 'proven.test',
    successCount: 3,
    lastSuccessAt: 300,
    promotions: [{
      promotionSiteId: 'site-a',
      promotedDomain: 'promo.test',
      successCount: 3,
      lastSuccessAt: 300
    }]
  }]).sort(compareOutlinksBySuccess);

  assert.equal(records[0].id, 'proven');
  assert.equal(records[0].successCount, 3);
  assert.deepEqual(records[0].successfulPromotionSiteIds, ['site-a']);
  assert.deepEqual(records[0].successfulPromotedDomains, ['promo.test']);
  assert.equal(records[1].successCount, 0);
});
