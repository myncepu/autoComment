import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  createBatchPlanDraftController
} from '../lib/batch-plan-draft-controller.mjs';

const CONFIG = {
  version: 2,
  revision: 7,
  profiles: [
    {
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice',
      email: 'alice@example.test',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'profile-b',
      displayName: '作者 B',
      name: 'Bob',
      email: 'bob@example.test',
      createdAt: 1,
      updatedAt: 1
    }
  ],
  promotionSites: [
    {
      id: 'site-a',
      name: '产品 A',
      url: 'https://promo-a.test/',
      content: '介绍产品 A',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'site-b',
      name: '产品 B',
      url: 'https://promo-b.test/',
      content: '介绍产品 B',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }
  ],
  assignmentPolicy: {
    defaultPairId: 'pair-a',
    pairs: [
      {
        id: 'pair-a',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        weight: 2,
        enabled: true
      },
      {
        id: 'pair-b',
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        weight: 1,
        enabled: true
      }
    ],
    quotas: {
      batch: 100,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3
    }
  }
};

const PARSED = {
  headers: ['目标', '来源', '身份', '推广网站'],
  rows: [
    {
      rowNumber: 2,
      originalRow: [
        'https://one.test/post',
        'one.test',
        'profile-b',
        'site-b'
      ]
    },
    {
      rowNumber: 3,
      originalRow: ['https://two.test/post', 'two.test', '', '']
    },
    {
      rowNumber: 4,
      originalRow: ['https://three.test/post', 'three.test', '', '']
    }
  ]
};

test('compiles explicit and weighted rows then binds confirmation to the exact plan', async () => {
  const controller = createBatchPlanDraftController({
    config: CONFIG,
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 1_000,
    createPlanId: () => 'plan-a'
  });

  await controller.setParsedCsv(PARSED);
  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: 2,
    promotionSiteRef: 3
  });
  const preview = controller.snapshot();

  assert.deepEqual(
    preview.plan.tasks.map((task) => [
      task.profileId,
      task.promotionSiteId,
      task.assignmentSource
    ]),
    [
      ['profile-b', 'site-b', 'explicit'],
      ['profile-a', 'site-a', 'weighted'],
      ['profile-b', 'site-b', 'weighted']
    ]
  );
  assert.deepEqual(preview.summary.status, { eligible: 3, blocked: 0 });
  assert.deepEqual(preview.plan.confirmationRequirements, ['multiple_assignments']);
  assert.equal(preview.confirmation, null);

  const confirmed = controller.confirm({
    normalConfirmed: true,
    highRiskConfirmed: true
  });
  assert.equal(
    confirmed.confirmation.planFingerprint,
    confirmed.plan.planFingerprint
  );

  await controller.setRecentSuccessUrls(['https://two.test/post']);
  await controller.setRepeatOverride('https://two.test/post', true);
  assert.equal(controller.snapshot().confirmation, null);
  assert.notEqual(
    controller.snapshot().plan.planFingerprint,
    confirmed.plan.planFingerprint
  );
});

test('same-batch duplicate stays blocked while a recent success is individually overridable', async () => {
  const controller = createBatchPlanDraftController({
    config: CONFIG,
    recentSuccessUrls: ['https://two.test/post'],
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 2_000,
    createPlanId: () => 'plan-b'
  });
  await controller.setParsedCsv({
    headers: ['URL'],
    rows: [
      { rowNumber: 2, originalRow: ['https://one.test/post'] },
      { rowNumber: 3, originalRow: ['https://one.test/post'] },
      { rowNumber: 4, originalRow: ['https://two.test/post'] }
    ]
  });
  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: null,
    profileRef: null,
    promotionSiteRef: null
  });

  assert.deepEqual(
    controller.snapshot().plan.tasks.map(({ blockReason }) => blockReason),
    [null, 'duplicate_in_batch', 'recent_success']
  );
  assert.equal(
    await controller.setRepeatOverride('https://one.test/post', true),
    false
  );
  await controller.setRepeatOverride('https://two.test/post', true);
  assert.deepEqual(
    controller.snapshot().plan.tasks.map(({ blockReason }) => blockReason),
    [null, 'duplicate_in_batch', null]
  );
});

test('mapping or config changes invalidate the prior finalized plan and confirmation', async () => {
  const controller = createBatchPlanDraftController({
    config: CONFIG,
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 3_000,
    createPlanId: () => 'plan-c'
  });
  await controller.setParsedCsv(PARSED);
  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: 2,
    promotionSiteRef: 3
  });
  controller.confirm({ normalConfirmed: true, highRiskConfirmed: true });

  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: null,
    profileRef: 2,
    promotionSiteRef: 3
  });
  assert.equal(controller.snapshot().confirmation, null);

  const updated = structuredClone(CONFIG);
  updated.revision = 8;
  await controller.setConfig(updated);
  assert.equal(controller.snapshot().plan.configRevision, 8);
  assert.equal(controller.snapshot().confirmation, null);
});

test('never exposes values from sensitive CSV columns in draft snapshots', async () => {
  const controller = createBatchPlanDraftController({
    config: CONFIG,
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 4_000,
    createPlanId: () => 'plan-sensitive'
  });
  await controller.setParsedCsv({
    headers: ['URL', 'password', 'API Token'],
    rows: [{
      rowNumber: 2,
      originalRow: [
        'https://one.test/',
        'csv-password-sentinel',
        'csv-token-sentinel'
      ]
    }]
  });
  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: null,
    profileRef: null,
    promotionSiteRef: null
  });

  const serialized = JSON.stringify(controller.snapshot());
  assert.doesNotMatch(serialized, /csv-password-sentinel|csv-token-sentinel/);
  assert.match(serialized, /\[REDACTED\]/);
});
