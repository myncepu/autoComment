import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDomainChanges,
  createDomainConfigMutations
} from '../lib/cloud-sync-domain-config.mjs';

function profile(id, displayName = id) {
  return {
    id,
    displayName,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    createdAt: 10,
    updatedAt: 20
  };
}

function site(id, name = id) {
  return {
    id,
    name,
    url: `https://${id}.example.test/`,
    content: `About ${id}`,
    enabled: true,
    createdAt: 10,
    updatedAt: 20
  };
}

function config() {
  return {
    version: 2,
    revision: 4,
    profiles: [profile('profile-a')],
    promotionSites: [site('site-a')],
    assignmentPolicy: {
      pairs: [{
        id: 'pair-a',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        weight: 1,
        enabled: true
      }],
      defaultPairId: 'pair-a',
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
}

test('creates exact independent mutations for a local domain config change', () => {
  const before = config();
  const after = structuredClone(before);
  after.profiles.push(profile('profile-b'));
  after.promotionSites[0] = { ...after.promotionSites[0], content: 'Updated' };
  after.assignmentPolicy.pairs.push({
    id: 'pair-b',
    profileId: 'profile-b',
    promotionSiteId: 'site-a',
    weight: 2,
    enabled: true
  });
  after.assignmentPolicy.defaultPairId = 'pair-b';

  let sequence = 0;
  const mutations = createDomainConfigMutations({ oldValue: before, newValue: after }, {
    now: () => 500,
    createMutationId: () => `mutation-${++sequence}`
  });

  assert.deepEqual(mutations.map(({ entityType, entityId, operation }) => ({
    entityType,
    entityId,
    operation
  })), [
    { entityType: 'profile', entityId: 'profile-b', operation: 'upsert' },
    { entityType: 'promotion_site', entityId: 'site-a', operation: 'upsert' },
    { entityType: 'assignment_pair', entityId: 'pair-b', operation: 'upsert' },
    {
      entityType: 'assignment_policy',
      entityId: 'default-assignment-policy',
      operation: 'upsert'
    }
  ]);
  assert.deepEqual(mutations[0].payload, { profile: profile('profile-b') });
  assert.deepEqual(mutations[3].payload.assignmentPolicy, {
    id: 'default-assignment-policy',
    defaultPairId: 'pair-b',
    quotas: after.assignmentPolicy.quotas
  });
  assert.doesNotMatch(JSON.stringify(mutations), /password|secret/iu);
});

test('creates tombstones for removed profiles, sites, and pairs', () => {
  const before = config();
  const after = {
    ...before,
    profiles: [],
    promotionSites: [],
    assignmentPolicy: {
      ...before.assignmentPolicy,
      pairs: [],
      defaultPairId: null
    }
  };

  const mutations = createDomainConfigMutations({ oldValue: before, newValue: after }, {
    now: () => 900,
    createMutationId: () => crypto.randomUUID()
  });

  assert.deepEqual(mutations.map((mutation) => [
    mutation.entityType,
    mutation.entityId,
    mutation.operation,
    mutation.payload
  ]), [
    [
      'assignment_policy',
      'default-assignment-policy',
      'upsert',
      {
        assignmentPolicy: {
          id: 'default-assignment-policy',
          defaultPairId: null,
          quotas: after.assignmentPolicy.quotas
        }
      }
    ],
    ['assignment_pair', 'pair-a', 'delete', { deletedAt: 900 }],
    ['profile', 'profile-a', 'delete', { deletedAt: 900 }],
    ['promotion_site', 'site-a', 'delete', { deletedAt: 900 }]
  ]);
});

test('applies unordered related remote entities as one validated replacement', () => {
  const current = config();
  const changes = [
    {
      entityType: 'assignment_pair',
      entityId: 'pair-b',
      operation: 'upsert',
      payload: {
        assignmentPair: {
          id: 'pair-b',
          profileId: 'profile-b',
          promotionSiteId: 'site-b',
          weight: 3,
          enabled: true
        }
      }
    },
    {
      entityType: 'assignment_policy',
      entityId: 'default-assignment-policy',
      operation: 'upsert',
      payload: {
        assignmentPolicy: {
          id: 'default-assignment-policy',
          defaultPairId: 'pair-b',
          quotas: current.assignmentPolicy.quotas
        }
      }
    },
    {
      entityType: 'profile',
      entityId: 'profile-b',
      operation: 'upsert',
      payload: { profile: profile('profile-b') }
    },
    {
      entityType: 'promotion_site',
      entityId: 'site-b',
      operation: 'upsert',
      payload: { promotionSite: site('site-b') }
    }
  ];

  const { config: next, changed } = applyDomainChanges(current, changes);
  assert.equal(changed, true);
  assert.equal(next.revision, current.revision);
  assert.equal(next.profiles.at(-1).id, 'profile-b');
  assert.equal(next.promotionSites.at(-1).id, 'site-b');
  assert.equal(next.assignmentPolicy.defaultPairId, 'pair-b');
  assert.equal(next.assignmentPolicy.pairs.at(-1).id, 'pair-b');
});

test('rejects a remote page that would leave an orphaned pair', () => {
  assert.throws(() => applyDomainChanges(config(), [{
    entityType: 'profile',
    entityId: 'profile-a',
    operation: 'delete',
    payload: { deletedAt: 50 }
  }]), (error) => error.code === 'invalid_assignment_pair');
});

test('returns the same object identity marker for a semantic replay', () => {
  const current = config();
  const result = applyDomainChanges(current, [{
    entityType: 'profile',
    entityId: 'profile-a',
    operation: 'upsert',
    payload: { profile: structuredClone(current.profiles[0]) }
  }]);

  assert.equal(result.changed, false);
  assert.deepEqual(result.config, current);
});
