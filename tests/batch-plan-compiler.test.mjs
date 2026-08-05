import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultDomainConfig } from '../lib/domain-config-schema.mjs';
import {
  BATCH_SKIP_REASONS,
  canonicalizeBatchTargetUrl,
  compileBatchPlan,
  summarizeBatchPlan
} from '../lib/batch-plan-compiler.mjs';

function profile(id) {
  return {
    id,
    displayName: `Profile ${id.at(-1).toUpperCase()}`,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    createdAt: 1,
    updatedAt: 1
  };
}

function site(id) {
  return {
    id,
    name: `Site ${id.at(-1).toUpperCase()}`,
    url: `https://${id}.promo.test`,
    content: `Description ${id}`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  };
}

function pair(id, profileId, promotionSiteId, weight) {
  return { id, profileId, promotionSiteId, weight, enabled: true };
}

function configFixture({
  pairs = [
    pair('pair-a', 'profile-a', 'site-a', 3),
    pair('pair-b', 'profile-b', 'site-b', 1)
  ],
  quotas = {}
} = {}) {
  const config = createDefaultDomainConfig();
  config.revision = 7;
  config.profiles = [profile('profile-a'), profile('profile-b')];
  config.promotionSites = [site('site-a'), site('site-b')];
  config.assignmentPolicy = {
    defaultPairId: 'pair-a',
    pairs,
    quotas: {
      batch: 100,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3,
      ...quotas
    }
  };
  return config;
}

function row(index, overrides = {}) {
  return {
    rowNumber: index + 2,
    originalRow: [`https://target-${index}.test/post`],
    targetUrlRaw: `https://target-${index}.test/post`,
    sourceDomainRaw: '',
    profileRefRaw: '',
    promotionSiteRefRaw: '',
    profileId: null,
    promotionSiteId: null,
    assignmentPairId: null,
    assignmentSource: 'weighted',
    ...overrides
  };
}

function input(rows, overrides = {}) {
  return {
    planId: 'plan-1',
    createdAt: 100,
    config: configFixture(),
    rows,
    recentSuccessUrls: [],
    repeatOverrides: [],
    illegalSiteEvaluator: () => ({ blocked: false }),
    ...overrides
  };
}

function projection(task) {
  return {
    targetUrl: task.targetUrl,
    canonicalTargetUrl: task.canonicalTargetUrl,
    profileId: task.profileId,
    promotionSiteId: task.promotionSiteId,
    assignmentPairId: task.assignmentPairId,
    assignmentSource: task.assignmentSource,
    state: task.state,
    blockReason: task.blockReason
  };
}

test('smoothly assigns weighted atomic pairs in CSV order deterministically', () => {
  const source = input(Array.from({ length: 5 }, (_, index) => row(index)));
  const first = compileBatchPlan(source);
  const second = compileBatchPlan(source);

  assert.deepEqual(first.tasks.map((task) => task.assignmentPairId), [
    'pair-a',
    'pair-a',
    'pair-b',
    'pair-a',
    'pair-a'
  ]);
  assert.deepEqual(first.tasks.map(projection), second.tasks.map(projection));
});

test('canonicalizes only HTTP(S), lowercases hosts, removes fragments, and preserves query order', () => {
  assert.equal(
    canonicalizeBatchTargetUrl('HTTPS://Example.COM:443/path?b=2&a=1#section'),
    'https://example.com/path?b=2&a=1'
  );
  assert.equal(
    canonicalizeBatchTargetUrl('http://Example.COM:80'),
    'http://example.com/'
  );
  assert.throws(() => canonicalizeBatchTargetUrl('javascript:alert(1)'),
    (error) => error.code === 'invalid_target_url');
});

test('blocks duplicate and recent-success URLs while allowing only explicit recent overrides', () => {
  const recent = canonicalizeBatchTargetUrl('https://recent.test/post#old');
  const plan = compileBatchPlan(input([
    row(0, { targetUrlRaw: 'HTTPS://DUPLICATE.test:443/post#one' }),
    row(1, { targetUrlRaw: 'https://duplicate.test/post#two' }),
    row(2, { targetUrlRaw: 'https://recent.test/post#new' }),
    row(3, { targetUrlRaw: 'https://allowed-repeat.test/post' })
  ], {
    recentSuccessUrls: [recent, 'https://allowed-repeat.test/post'],
    repeatOverrides: ['https://allowed-repeat.test/post']
  }));

  assert.deepEqual(plan.tasks.map(({ blockReason }) => blockReason), [
    null,
    BATCH_SKIP_REASONS.DUPLICATE_IN_BATCH,
    BATCH_SKIP_REASONS.RECENT_SUCCESS,
    null
  ]);
  assert.equal(plan.tasks[1].assignmentSource, 'default_blocked');
  assert.equal(plan.tasks[2].assignmentSource, 'default_blocked');
  assert.equal(plan.tasks[3].recentSuccessOverride, true);
});

test('requires an available illegal-site filter and blocks flagged targets before assignment', () => {
  assert.throws(() => compileBatchPlan(input([row(0)], {
    illegalSiteEvaluator: undefined
  })), (error) => error.code === 'illegal_filter_unavailable');
  assert.throws(() => compileBatchPlan(input([row(0)], {
    illegalSiteEvaluator() {
      throw new Error('private diagnostic');
    }
  })), (error) => error.code === 'illegal_filter_unavailable'
    && !error.message.includes('private diagnostic'));

  const plan = compileBatchPlan(input([row(0)], {
    illegalSiteEvaluator: () => ({ blocked: true })
  }));
  assert.equal(plan.tasks[0].blockReason, BATCH_SKIP_REASONS.BLOCKED_ILLEGAL);
  assert.equal(plan.tasks[0].assignmentPairId, 'pair-a');
  assert.equal(plan.tasks[0].assignmentSource, 'default_blocked');
});

test('applies target-domain and batch quotas in CSV order without consuming slots for blocked rows', () => {
  const rows = [
    row(0, { targetUrlRaw: 'https://same.test/one' }),
    row(1, { targetUrlRaw: 'https://same.test/two' }),
    row(2, { targetUrlRaw: 'https://same.test/three' }),
    row(3, { targetUrlRaw: 'https://other.test/four' }),
    row(4, { targetUrlRaw: 'https://third.test/five' })
  ];
  const plan = compileBatchPlan(input(rows, {
    config: configFixture({
      quotas: { batch: 3, perTargetDomain: 2 }
    })
  }));

  assert.deepEqual(plan.tasks.map(({ blockReason }) => blockReason), [
    null,
    null,
    BATCH_SKIP_REASONS.QUOTA_TARGET_DOMAIN,
    null,
    BATCH_SKIP_REASONS.QUOTA_BATCH
  ]);
  assert.equal(plan.tasks[2].assignmentSource, 'default_blocked');
  assert.equal(plan.tasks[4].assignmentSource, 'default_blocked');
});

test('does not reassign an explicit pair when its Profile quota is exhausted', () => {
  const explicit = (index) => row(index, {
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'explicit',
    profileRefRaw: 'profile-a',
    promotionSiteRefRaw: 'site-a'
  });
  const plan = compileBatchPlan(input([explicit(0), explicit(1)], {
    config: configFixture({
      quotas: { perProfile: 1, perPromotionSite: 5 }
    })
  }));

  assert.equal(plan.tasks[1].assignmentPairId, 'pair-a');
  assert.equal(plan.tasks[1].assignmentSource, 'explicit');
  assert.equal(plan.tasks[1].blockReason, BATCH_SKIP_REASONS.QUOTA_PROFILE);
});

test('skips exhausted weighted candidates and reports the intended pair when all are exhausted', () => {
  const plan = compileBatchPlan(input(
    Array.from({ length: 4 }, (_, index) => row(index)),
    {
      config: configFixture({
        pairs: [
          pair('pair-a', 'profile-a', 'site-a', 3),
          pair('pair-b', 'profile-b', 'site-b', 1)
        ],
        quotas: { perProfile: 1, perPromotionSite: 5 }
      })
    }
  ));

  assert.deepEqual(plan.tasks.map(({ assignmentPairId, blockReason }) => [
    assignmentPairId,
    blockReason
  ]), [
    ['pair-a', null],
    ['pair-b', null],
    ['pair-a', BATCH_SKIP_REASONS.QUOTA_PROFILE],
    ['pair-a', BATCH_SKIP_REASONS.QUOTA_PROFILE]
  ]);
});

test('reports Promotion Site quota separately', () => {
  const plan = compileBatchPlan(input([row(0), row(1)], {
    config: configFixture({
      pairs: [pair('pair-a', 'profile-a', 'site-a', 1)],
      quotas: { perProfile: 5, perPromotionSite: 1 }
    })
  }));

  assert.equal(plan.tasks[1].blockReason, BATCH_SKIP_REASONS.QUOTA_PROMOTION_SITE);
});

test('pre-assignment blocks do not advance smooth weights', () => {
  const withBlocked = compileBatchPlan(input([
    row(0),
    row(1, { targetUrlRaw: 'https://illegal.test/post' }),
    row(2)
  ], {
    illegalSiteEvaluator: (url) => ({ blocked: url.includes('illegal.test') })
  }));
  const withoutBlocked = compileBatchPlan(input([row(0), row(2)]));

  assert.deepEqual(
    [withBlocked.tasks[0], withBlocked.tasks[2]].map(({ assignmentPairId }) => assignmentPairId),
    withoutBlocked.tasks.map(({ assignmentPairId }) => assignmentPairId)
  );
});

test('prioritizes proven blogs and avoids promotion sites already successful there', () => {
  const plan = compileBatchPlan(input([
    row(0, { targetUrlRaw: 'https://untested.test/post' }),
    row(1, { targetUrlRaw: 'https://www.proven.test/post' })
  ], {
    successfulTargetStats: [{
      targetHost: 'proven.test',
      successCount: 5,
      lastSuccessAt: 500,
      promotions: [{
        promotionSiteId: 'site-a',
        promotedDomain: 'site-a.promo.test',
        successCount: 2,
        lastSuccessAt: 500
      }]
    }]
  }));

  assert.equal(plan.tasks[0].targetDomain, 'www.proven.test');
  assert.equal(plan.tasks[0].promotionSiteId, 'site-b');
  assert.equal(plan.tasks[0].blockReason, null);
  assert.equal(plan.tasks[1].targetDomain, 'untested.test');
});

test('blocks explicit and fully exhausted promotion history on a target blog', () => {
  const explicit = row(0, {
    targetUrlRaw: 'https://proven.test/explicit',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'explicit',
    profileRefRaw: 'profile-a',
    promotionSiteRefRaw: 'site-a'
  });
  const successfulTargetStats = [{
    targetHost: 'proven.test',
    successCount: 2,
    promotions: [
      { promotionSiteId: 'site-a', successCount: 1 },
      { promotedDomain: 'site-b.promo.test', successCount: 1 }
    ]
  }];
  const explicitPlan = compileBatchPlan(input([explicit], {
    successfulTargetStats
  }));
  assert.equal(
    explicitPlan.tasks[0].blockReason,
    BATCH_SKIP_REASONS.PROMOTION_ALREADY_SUCCEEDED
  );

  const weightedPlan = compileBatchPlan(input([
    row(1, { targetUrlRaw: 'https://proven.test/weighted' })
  ], { successfulTargetStats }));
  assert.equal(
    weightedPlan.tasks[0].blockReason,
    BATCH_SKIP_REASONS.ALL_PROMOTIONS_ALREADY_SUCCEEDED
  );
});

test('history-blocked targets do not consume batch quota from later runnable targets', () => {
  const plan = compileBatchPlan(input([
    row(0, { targetUrlRaw: 'https://untested.test/post' }),
    row(1, { targetUrlRaw: 'https://proven.test/post' })
  ], {
    config: configFixture({ quotas: { batch: 1 } }),
    successfulTargetStats: [{
      targetHost: 'proven.test',
      successCount: 2,
      promotions: [
        { promotionSiteId: 'site-a', successCount: 1 },
        { promotionSiteId: 'site-b', successCount: 1 }
      ]
    }]
  }));

  assert.equal(
    plan.tasks[0].blockReason,
    BATCH_SKIP_REASONS.ALL_PROMOTIONS_ALREADY_SUCCEEDED
  );
  assert.equal(plan.tasks[1].targetDomain, 'untested.test');
  assert.equal(plan.tasks[1].blockReason, null);
});

test('freezes only referenced non-sensitive Profile and Promotion Site snapshots', () => {
  const plan = compileBatchPlan(input([row(0), row(1), row(2)]));
  const serialized = JSON.stringify(plan);

  assert.deepEqual(plan.profiles['profile-a'], {
    id: 'profile-a',
    displayName: 'Profile A',
    name: 'Name profile-a',
    email: 'profile-a@example.test'
  });
  assert.deepEqual(plan.promotionSites['site-a'], {
    id: 'site-a',
    name: 'Site A',
    url: 'https://site-a.promo.test/',
    content: 'Description site-a'
  });
  assert.doesNotMatch(serialized, /password|secret|apiKey|checkpoint|submitContext/i);
  assert.equal(plan.configRevision, 7);
  assert.deepEqual(plan.quotas, configFixture().assignmentPolicy.quotas);
});

test('summarizes eligible, blocked, pair, Profile, Site, domain, and reason counts', () => {
  const plan = compileBatchPlan(input([
    row(0, { targetUrlRaw: 'https://same.test/one' }),
    row(1, { targetUrlRaw: 'https://same.test/two' }),
    row(2, { targetUrlRaw: 'https://same.test/three' }),
    row(3, { targetUrlRaw: 'https://same.test/four' })
  ]));
  const summary = summarizeBatchPlan(plan);

  assert.deepEqual(summary.status, { eligible: 3, blocked: 1 });
  assert.equal(summary.byBlockReason.quota_target_domain, 1);
  assert.equal(summary.byTargetDomain['same.test'], 3);
  assert.equal(summary.byAssignmentPair['pair-a'], 2);
  assert.equal(summary.byAssignmentPair['pair-b'], 1);
  assert.equal(summary.byProfile['profile-a'], 2);
  assert.equal(summary.byPromotionSite['site-b'], 1);
});

test('modern configuration rotates identities and promotion pages independently', () => {
  const config = configFixture();
  config.profiles.forEach((item) => { item.email = ''; });
  config.promotionSites = [{
    ...site('site-parent'),
    email: 'support@promo.test',
    pages: [
      {
        id: 'page-a',
        url: 'https://promo.test/a',
        keywords: ['Page A'],
        content: 'Page A promotion instructions',
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'page-b',
        url: 'https://promo.test/b',
        keywords: ['Page B'],
        content: 'Page B promotion instructions',
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'page-c',
        url: 'https://promo.test/c',
        keywords: ['Page C'],
        content: 'Page C promotion instructions',
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }];
  config.assignmentPolicy = {
    defaultPairId: null,
    pairs: [],
    quotas: config.assignmentPolicy.quotas
  };
  const plan = compileBatchPlan(input(
    Array.from({ length: 6 }, (_, index) => row(index)),
    { config }
  ));

  assert.deepEqual(plan.tasks.map(({ profileId, promotionSiteId }) => [
    profileId,
    promotionSiteId
  ]), [
    ['profile-a', 'page-a'],
    ['profile-b', 'page-b'],
    ['profile-a', 'page-c'],
    ['profile-b', 'page-a'],
    ['profile-a', 'page-b'],
    ['profile-b', 'page-c']
  ]);
  assert.equal(plan.promotionSites['page-a'].email, 'support@promo.test');
  assert.equal(plan.tasks[0].assignmentSource, 'round_robin');
});

test('modern configuration respects the identities and promotion pages selected for this batch', () => {
  const config = configFixture();
  config.profiles.forEach((item) => { item.email = ''; });
  config.promotionSites = [{
    ...site('site-parent'),
    email: 'support@promo.test',
    pages: ['a', 'b'].map((suffix) => ({
      id: `page-${suffix}`,
      url: `https://promo.test/${suffix}`,
      keywords: [`Page ${suffix.toUpperCase()}`],
      content: `Page ${suffix.toUpperCase()} promotion instructions`,
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }))
  }];
  config.assignmentPolicy = {
    defaultPairId: null,
    pairs: [],
    quotas: config.assignmentPolicy.quotas
  };
  const plan = compileBatchPlan(input([row(0), row(1)], {
    config,
    selectedProfileIds: ['profile-b'],
    selectedPromotionPageIds: ['page-b']
  }));

  assert.deepEqual(plan.tasks.map(({ profileId, promotionSiteId }) => [
    profileId,
    promotionSiteId
  ]), [
    ['profile-b', 'page-b'],
    ['profile-b', 'page-b']
  ]);
});

test('modern configuration blocks only an exact target-article and promotion-page pair', () => {
  const config = configFixture();
  config.promotionSites = [{
    ...site('site-parent'),
    email: 'support@promo.test',
    pages: [{
      id: 'page-a',
      url: 'https://promo.test/a',
      keywords: ['Page A'],
      content: 'Page A promotion instructions',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }]
  }];
  config.assignmentPolicy = {
    defaultPairId: null,
    pairs: [],
    quotas: config.assignmentPolicy.quotas
  };
  const successfulTargetStats = [{
    targetHost: 'same-blog.test',
    successCount: 1,
    pairs: [{
      targetPageUrl: 'https://same-blog.test/post-a',
      promotedWebsiteUrl: 'https://promo.test/a'
    }]
  }];
  const plan = compileBatchPlan(input([
    row(0, { targetUrlRaw: 'https://same-blog.test/post-a' }),
    row(1, { targetUrlRaw: 'https://same-blog.test/post-b' })
  ], {
    config,
    successfulTargetStats,
    recentSuccessUrls: [
      'https://same-blog.test/post-a',
      'https://same-blog.test/post-b'
    ]
  }));

  assert.equal(
    plan.tasks[0].blockReason,
    BATCH_SKIP_REASONS.ALL_PROMOTIONS_ALREADY_SUCCEEDED
  );
  assert.equal(plan.tasks[1].targetUrl, 'https://same-blog.test/post-b');
  assert.equal(plan.tasks[1].blockReason, null);
});
