const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

function configFixture() {
  const profiles = ['a', 'b'].map((suffix) => ({
    id: `profile-${suffix}`,
    displayName: `作者 ${suffix.toUpperCase()}`,
    name: `Name ${suffix}`,
    email: `${suffix}@example.test`,
    createdAt: 1,
    updatedAt: 1
  }));
  const promotionSites = ['a', 'b'].map((suffix) => ({
    id: `site-${suffix}`,
    name: `产品 ${suffix.toUpperCase()}`,
    url: `https://promo-${suffix}.test/`,
    content: `Promotion ${suffix}`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  }));
  return {
    version: 2,
    revision: 9,
    profiles,
    promotionSites,
    assignmentPolicy: {
      defaultPairId: 'pair-a',
      pairs: ['a', 'b'].map((suffix) => ({
        id: `pair-${suffix}`,
        profileId: `profile-${suffix}`,
        promotionSiteId: `site-${suffix}`,
        weight: 1,
        enabled: true
      })),
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
}

test('freezes five explicit/weighted assignments into a v3 checkpoint without secrets', async () => {
  const [
    { createBatchPlanDraftController },
    { createBatchRuntimeCheckpoint }
  ] = await Promise.all([
    import('../lib/batch-plan-draft-controller.mjs'),
    import('../lib/batch-runtime-checkpoint.mjs')
  ]);
  const controller = createBatchPlanDraftController({
    config: configFixture(),
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 1_000,
    createPlanId: () => 'five-target-plan'
  });
  await controller.setParsedCsv({
    headers: ['URL', 'profileId', 'promotionSiteId'],
    rows: [
      {
        rowNumber: 2,
        originalRow: ['https://one.test/', 'profile-b', 'site-b']
      },
      { rowNumber: 3, originalRow: ['https://two.test/', '', ''] },
      { rowNumber: 4, originalRow: ['https://three.test/', '', ''] },
      {
        rowNumber: 5,
        originalRow: ['https://four.test/', 'profile-a', 'site-a']
      },
      { rowNumber: 6, originalRow: ['https://five.test/', '', ''] }
    ]
  });
  await controller.setMapping({
    targetUrl: 0,
    sourceDomain: null,
    profileRef: 1,
    promotionSiteRef: 2
  });
  const confirmed = controller.confirm({
    normalConfirmed: true,
    highRiskConfirmed: true
  });
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: confirmed.plan.planId,
    plan: confirmed.plan,
    confirmation: confirmed.confirmation,
    settings: {
      concurrency: 3,
      timeoutSeconds: 60,
      autoGenerate: true,
      autoSubmit: true
    }
  }, () => 1_001);

  assert.equal(checkpoint.version, 3);
  assert.equal(checkpoint.cursor.nextIndex, 0);
  assert.deepEqual(
    Object.values(checkpoint.tasks).map((task) => [
      task.profileId,
      task.promotionSiteId,
      task.assignmentSource,
      task.state
    ]),
    [
      ['profile-b', 'site-b', 'explicit', 'queued'],
      ['profile-a', 'site-a', 'weighted', 'queued'],
      ['profile-b', 'site-b', 'weighted', 'queued'],
      ['profile-a', 'site-a', 'explicit', 'queued'],
      ['profile-a', 'site-a', 'weighted', 'queued']
    ]
  );
  assert.doesNotMatch(JSON.stringify(checkpoint), /password|secret/i);
});
