import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import { DEFAULT_QUOTAS } from '../lib/domain-config-schema.mjs';
import {
  createPlanConfirmation,
  finalizeBatchPlan,
  fingerprintBatchPlan,
  getPlanConfirmationRequirements,
  validatePlanConfirmation
} from '../lib/batch-plan-confirmation.mjs';

function task(index, overrides = {}) {
  return {
    taskId: `plan-1:${index + 2}`,
    urlIndex: index,
    rowNumber: index + 2,
    targetUrl: `https://target-${index}.test/`,
    canonicalTargetUrl: `https://target-${index}.test/`,
    targetDomain: `target-${index}.test`,
    sourceDomain: `target-${index}.test`,
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted',
    state: 'eligible',
    blockReason: null,
    recentSuccessOverride: false,
    ...overrides
  };
}

function plan(overrides = {}) {
  return {
    version: 2,
    planId: 'plan-1',
    planFingerprint: null,
    configRevision: 3,
    createdAt: 100,
    illegalSiteRulesVersion: 'rules-v1',
    quotas: { ...DEFAULT_QUOTAS },
    repeatOverrides: [],
    profiles: {
      'profile-a': {
        id: 'profile-a',
        displayName: 'Profile A',
        name: 'Alice',
        email: 'alice@example.test'
      }
    },
    promotionSites: {
      'site-a': {
        id: 'site-a',
        name: 'Site A',
        url: 'https://site-a.test/',
        content: 'Description A'
      }
    },
    tasks: [task(0)],
    warnings: [],
    confirmationRequirements: [],
    ...overrides
  };
}

test('fingerprint is canonical across object-key order and excludes UI-only messages', async () => {
  const first = plan();
  const reordered = {
    ...first,
    quotas: {
      perTargetDomain: 3,
      perPromotionSite: 50,
      perProfile: 50,
      batch: 100
    },
    warnings: ['translated UI warning'],
    confirmationRequirements: ['ui-derived-value']
  };

  assert.equal(
    await fingerprintBatchPlan(first, webcrypto),
    await fingerprintBatchPlan(reordered, webcrypto)
  );
});

test('changes fingerprint when rows, config revision, quotas, or override changes', async () => {
  const base = await fingerprintBatchPlan(plan(), webcrypto);
  const variants = [
    plan({ configRevision: 4 }),
    plan({ quotas: { ...DEFAULT_QUOTAS, batch: 101 } }),
    plan({ repeatOverrides: ['https://target-0.test/'] }),
    plan({ tasks: [task(0, { profileId: 'profile-b' })] }),
    plan({ tasks: [task(0), task(1)] })
  ];

  for (const variant of variants) {
    assert.notEqual(base, await fingerprintBatchPlan(variant, webcrypto));
  }
});

test('requires high-risk confirmation for multiple entities, raised quota, or recent override', () => {
  const risky = plan({
    quotas: { ...DEFAULT_QUOTAS, batch: 101 },
    repeatOverrides: ['https://target-1.test/'],
    tasks: [
      task(0),
      task(1, {
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        assignmentPairId: 'pair-b',
        recentSuccessOverride: true
      })
    ]
  });

  assert.deepEqual(getPlanConfirmationRequirements(risky), [
    'multiple_assignments',
    'raised_quota',
    'recent_success_override'
  ]);
});

test('ignores blocked-only alternate assignments when classifying multiple assignment risk', () => {
  const draft = plan({
    tasks: [
      task(0),
      task(1, {
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        assignmentPairId: 'pair-b',
        assignmentSource: 'default_blocked',
        state: 'blocked',
        blockReason: 'blocked_illegal'
      })
    ]
  });

  assert.deepEqual(getPlanConfirmationRequirements(draft), []);
});

test('finalizes a deeply frozen clone with a matching fingerprint and derived risks', async () => {
  const source = plan({
    quotas: { ...DEFAULT_QUOTAS, perTargetDomain: 4 }
  });
  const finalized = await finalizeBatchPlan(source, webcrypto);

  assert.match(finalized.planFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(finalized.planFingerprint, await fingerprintBatchPlan(finalized, webcrypto));
  assert.deepEqual(finalized.confirmationRequirements, ['raised_quota']);
  assert.equal(Object.isFrozen(finalized), true);
  assert.equal(Object.isFrozen(finalized.tasks), true);
  assert.equal(Object.isFrozen(finalized.tasks[0]), true);
  assert.throws(() => { finalized.tasks[0].profileId = 'mutated'; }, TypeError);
  assert.equal(source.planFingerprint, null);
});

test('creates normal and high-risk confirmation bound to the exact finalized plan', async () => {
  const finalized = await finalizeBatchPlan(plan({
    repeatOverrides: ['https://target-0.test/'],
    tasks: [task(0, { recentSuccessOverride: true })]
  }), webcrypto);
  const confirmation = createPlanConfirmation(finalized, {
    normalConfirmed: true,
    highRiskConfirmed: true
  }, () => 1_000);

  assert.deepEqual(confirmation, {
    version: 1,
    planFingerprint: finalized.planFingerprint,
    normalConfirmed: true,
    requiredRisks: ['recent_success_override'],
    highRiskConfirmed: true,
    confirmedAt: 1_000
  });
  assert.deepEqual(validatePlanConfirmation(finalized, confirmation, {
    now: () => 1_500
  }), { ok: true });
});

test('rejects missing normal or required high-risk confirmation', async () => {
  const normalPlan = await finalizeBatchPlan(plan(), webcrypto);
  const normalMissing = createPlanConfirmation(normalPlan, {
    normalConfirmed: false,
    highRiskConfirmed: false
  }, () => 1_000);
  assert.deepEqual(validatePlanConfirmation(normalPlan, normalMissing, {
    now: () => 1_001
  }), { ok: false, error: 'normal_confirmation_required' });

  const riskyPlan = await finalizeBatchPlan(plan({
    quotas: { ...DEFAULT_QUOTAS, batch: 101 }
  }), webcrypto);
  const highMissing = createPlanConfirmation(riskyPlan, {
    normalConfirmed: true,
    highRiskConfirmed: false
  }, () => 1_000);
  assert.deepEqual(validatePlanConfirmation(riskyPlan, highMissing, {
    now: () => 1_001
  }), { ok: false, error: 'high_risk_confirmation_required' });
});

test('rejects a changed fingerprint or exact required-risk set', async () => {
  const finalized = await finalizeBatchPlan(plan(), webcrypto);
  const confirmation = createPlanConfirmation(finalized, {
    normalConfirmed: true,
    highRiskConfirmed: false
  }, () => 1_000);

  assert.deepEqual(validatePlanConfirmation({
    ...finalized,
    planFingerprint: 'f'.repeat(64)
  }, confirmation, { now: () => 1_001 }), {
    ok: false,
    error: 'plan_fingerprint_changed'
  });
  assert.deepEqual(validatePlanConfirmation(finalized, {
    ...confirmation,
    requiredRisks: ['raised_quota']
  }, { now: () => 1_001 }), {
    ok: false,
    error: 'confirmation_risk_set_changed'
  });
});

test('rejects future, expired, malformed, and overly old confirmation timestamps', async () => {
  const finalized = await finalizeBatchPlan(plan(), webcrypto);
  const confirmation = createPlanConfirmation(finalized, {
    normalConfirmed: true,
    highRiskConfirmed: false
  }, () => 1_000);

  assert.deepEqual(validatePlanConfirmation(finalized, confirmation, {
    now: () => 999
  }), { ok: false, error: 'confirmation_from_future' });
  assert.deepEqual(validatePlanConfirmation(finalized, confirmation, {
    now: () => 1_601,
    maxAgeMs: 600
  }), { ok: false, error: 'confirmation_expired' });
  assert.deepEqual(validatePlanConfirmation(finalized, {
    ...confirmation,
    confirmedAt: '1000'
  }, { now: () => 1_001 }), { ok: false, error: 'invalid_plan_confirmation' });
});

test('rejects unfinalized plans and sensitive confirmation payloads', () => {
  assert.throws(() => createPlanConfirmation(plan(), {
    normalConfirmed: true,
    highRiskConfirmed: false
  }), (error) => error.code === 'plan_not_finalized');

  const fakeFinalized = {
    ...plan(),
    planFingerprint: 'a'.repeat(64)
  };
  assert.deepEqual(validatePlanConfirmation(fakeFinalized, {
    version: 1,
    planFingerprint: 'a'.repeat(64),
    normalConfirmed: true,
    requiredRisks: [],
    highRiskConfirmed: false,
    confirmedAt: 1_000,
    password: 'DO_NOT_ECHO'
  }, { now: () => 1_001 }), {
    ok: false,
    error: 'invalid_plan_confirmation'
  });
});
