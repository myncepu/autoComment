import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import {
  authHeaders,
  seedVault,
  VALID_VAULT_ID
} from './fixtures';

function profileMutation(
  mutationId: string,
  operation: 'upsert' | 'delete' = 'upsert',
  entityId = 'profile-a'
): Record<string, unknown> {
  return {
    mutationId,
    entityType: 'profile',
    entityId,
    operation,
    payload: operation === 'delete'
      ? { deletedAt: 2_000 }
      : {
          profile: {
            id: entityId,
            displayName: 'Profile A',
            name: 'Alice',
            email: 'alice@example.test',
            createdAt: 1_000,
            updatedAt: 1_500
          }
        },
    createdAt: operation === 'delete' ? 2_000 : 1_500
  };
}

function siteMutation(): Record<string, unknown> {
  return {
    mutationId: 'site:upsert',
    entityType: 'promotion_site',
    entityId: 'site-a',
    operation: 'upsert',
    payload: {
      promotionSite: {
        id: 'site-a',
        name: 'Site A',
        url: 'https://site-a.example.test/',
        content: 'About Site A',
        enabled: true,
        createdAt: 1_000,
        updatedAt: 1_500
      }
    },
    createdAt: 1_500
  };
}

function pairMutation(
  mutationId = 'pair:upsert',
  profileId = 'profile-a'
): Record<string, unknown> {
  return {
    mutationId,
    entityType: 'assignment_pair',
    entityId: 'pair-a',
    operation: 'upsert',
    payload: {
      assignmentPair: {
        id: 'pair-a',
        profileId,
        promotionSiteId: 'site-a',
        weight: 2,
        enabled: true
      }
    },
    createdAt: 1_500
  };
}

function policyMutation(
  mutationId = 'policy:upsert',
  defaultPairId: string | null = 'pair-a'
): Record<string, unknown> {
  return {
    mutationId,
    entityType: 'assignment_policy',
    entityId: 'default-assignment-policy',
    operation: 'upsert',
    payload: {
      assignmentPolicy: {
        id: 'default-assignment-policy',
        defaultPairId,
        quotas: {
          batch: 100,
          perProfile: 50,
          perPromotionSite: 50,
          perTargetDomain: 3
        }
      }
    },
    createdAt: 1_500
  };
}

async function push(mutations: Record<string, unknown>[]) {
  const response = await SELF.fetch(
    'https://worker.test/v1/sync/push',
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        deviceId: 'device-domain',
        mutations
      })
    }
  );
  expect(response.status).toBe(200);
  return response.json<{
    results: Array<{
      mutationId: string;
      status: string;
      serverSeq: number | null;
    }>;
  }>();
}

async function pull(query: string) {
  const response = await SELF.fetch(
    `https://worker.test/v1/sync/pull?${query}`,
    { headers: authHeaders() }
  );
  expect(response.status).toBe(200);
  return response.json<{
    changes: Array<Record<string, unknown>>;
    nextCursor: number;
    highWatermark: number;
    hasMore: boolean;
  }>();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM domain_entity_tombstones'),
    env.DB.prepare('DELETE FROM sync_assignment_policy'),
    env.DB.prepare('DELETE FROM sync_assignment_pairs'),
    env.DB.prepare('DELETE FROM sync_promotion_sites'),
    env.DB.prepare('DELETE FROM sync_profiles'),
    env.DB.prepare('DELETE FROM sync_changes'),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'sync_changes'"),
    env.DB.prepare('DELETE FROM sync_mutations'),
    env.DB.prepare('DELETE FROM sync_devices'),
    env.DB.prepare('DELETE FROM sync_vaults')
  ]);
  await seedVault();
});

test('advertises the v2 domain and assignment capabilities', async () => {
  const response = await SELF.fetch(
    'https://worker.test/v1/status?deviceId=device-domain&protocolVersion=2',
    { headers: authHeaders() }
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    protocolVersion: 2,
    capabilities: [
      'domain_config_entities_v2',
      'comment_assignment_fields_v2'
    ]
  });
});

test('pushes, pulls, deletes, and refuses to resurrect a Profile', async () => {
  const inserted = await push([profileMutation('profile:upsert')]);
  expect(inserted.results).toEqual([
    expect.objectContaining({ status: 'applied', serverSeq: 1 })
  ]);

  const v2First = await pull(
    'cursor=0&limit=100&deviceId=device-domain&protocolVersion=2'
  );
  expect(v2First.changes).toEqual([{
    serverSeq: 1,
    entityType: 'profile',
    entityId: 'profile-a',
    operation: 'upsert',
    payload: {
      profile: {
        id: 'profile-a',
        displayName: 'Profile A',
        name: 'Alice',
        email: 'alice@example.test',
        createdAt: 1_000,
        updatedAt: 1_500
      }
    }
  }]);

  const deleted = await push([
    profileMutation('profile:delete', 'delete')
  ]);
  expect(deleted.results).toEqual([
    expect.objectContaining({ status: 'applied', serverSeq: 2 })
  ]);
  const resurrection = await push([
    profileMutation('profile:offline-old')
  ]);
  expect(resurrection.results).toEqual([
    expect.objectContaining({ status: 'stale', serverSeq: 2 })
  ]);

  const v2Delete = await pull(
    'cursor=1&limit=100&deviceId=device-domain&protocolVersion=2'
  );
  expect(v2Delete.changes).toEqual([{
    serverSeq: 2,
    entityType: 'profile',
    entityId: 'profile-a',
    operation: 'delete',
    payload: { deletedAt: 2_000 }
  }]);
  expect(await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM sync_profiles
     WHERE vault_id = ? AND entity_id = ?`
  ).bind(VALID_VAULT_ID, 'profile-a').first<{ count: number }>())
    .toEqual({ count: 0 });

  const v1 = await pull(
    'cursor=0&limit=100&deviceId=device-v1'
  );
  expect(v1.changes).toEqual([]);
  expect(v1.nextCursor).toBe(2);
  expect(v1.highWatermark).toBe(2);
});

test('bootstraps v2 domain entities through a signed phase before history', async () => {
  await push([
    profileMutation('profile:bootstrap', 'upsert', 'profile-bootstrap')
  ]);
  const firstResponse = await SELF.fetch(
    'https://worker.test/v1/sync/bootstrap?limit=1&deviceId=device-bootstrap&protocolVersion=2',
    { headers: authHeaders() }
  );
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json<{
    domainEntities: Array<Record<string, unknown>>;
    comments: unknown[];
    tombstones: unknown[];
    nextCursor: string;
    hasMore: boolean;
    serverCursor: number;
  }>();
  expect(first).toMatchObject({
    domainEntities: [{
      entityType: 'profile',
      entityId: 'profile-bootstrap',
      operation: 'upsert'
    }],
    comments: [],
    tombstones: [],
    hasMore: true,
    serverCursor: expect.any(Number)
  });

  const finalResponse = await SELF.fetch(
    `https://worker.test/v1/sync/bootstrap?limit=1&deviceId=device-bootstrap&protocolVersion=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    { headers: authHeaders() }
  );
  expect(finalResponse.status).toBe(200);
  await expect(finalResponse.json()).resolves.toMatchObject({
    domainEntities: [],
    comments: [],
    tombstones: [],
    nextCursor: null,
    hasMore: false,
    serverCursor: first.serverCursor
  });

  const legacyResponse = await SELF.fetch(
    'https://worker.test/v1/sync/bootstrap?limit=1&deviceId=device-legacy',
    { headers: authHeaders() }
  );
  const legacy = await legacyResponse.json<Record<string, unknown>>();
  expect(legacyResponse.status).toBe(200);
  expect(legacy).not.toHaveProperty('domainEntities');
});

test('persists Site, Pair, and Policy payloads and rejects dangling or sensitive entities', async () => {
  const accepted = await push([
    profileMutation('profile:relations'),
    siteMutation(),
    pairMutation(),
    policyMutation()
  ]);
  expect(accepted.results.map(({ status }) => status)).toEqual([
    'applied',
    'applied',
    'applied',
    'applied'
  ]);
  const page = await pull(
    'cursor=0&limit=100&deviceId=device-relations&protocolVersion=2'
  );
  expect(page.changes.map((change) => [
    change.entityType,
    change.entityId,
    change.operation
  ])).toEqual([
    ['profile', 'profile-a', 'upsert'],
    ['promotion_site', 'site-a', 'upsert'],
    ['assignment_pair', 'pair-a', 'upsert'],
    ['assignment_policy', 'default-assignment-policy', 'upsert']
  ]);
  expect(page.changes[1]).toMatchObject({
    payload: {
      promotionSite: {
        url: 'https://site-a.example.test/',
        enabled: true
      }
    }
  });
  expect(page.changes[3]).toMatchObject({
    payload: {
      assignmentPolicy: {
        defaultPairId: 'pair-a',
        quotas: { perTargetDomain: 3 }
      }
    }
  });

  const dangling = await push([
    pairMutation('pair:dangling', 'missing-profile')
  ]);
  expect(dangling.results).toEqual([
    expect.objectContaining({ status: 'stale' })
  ]);
  const sensitive = structuredClone(profileMutation('profile:sensitive'));
  const payload = sensitive.payload as {
    profile: Record<string, unknown>;
  };
  payload.profile.accessToken = 'must-not-leave';
  const rejected = await push([sensitive]);
  expect(rejected.results).toEqual([{
    mutationId: 'profile:sensitive',
    status: 'rejected',
    errorCode: 'SENSITIVE_FIELD_NOT_SYNCABLE'
  }]);
  expect(JSON.stringify(await env.DB.prepare(
    `SELECT * FROM sync_profiles WHERE vault_id = ?`
  ).bind(VALID_VAULT_ID).all())).not.toContain('must-not-leave');

  const blockedDelete = await push([
    profileMutation('profile:blocked-delete', 'delete')
  ]);
  expect(blockedDelete.results).toEqual([
    expect.objectContaining({ status: 'stale' })
  ]);
  const cleanup = await push([
    policyMutation('policy:clear', null),
    {
      mutationId: 'pair:delete',
      entityType: 'assignment_pair',
      entityId: 'pair-a',
      operation: 'delete',
      payload: { deletedAt: 2_100 },
      createdAt: 2_100
    },
    profileMutation('profile:delete-after-pair', 'delete')
  ]);
  expect(cleanup.results.map(({ status }) => status)).toEqual([
    'applied',
    'applied',
    'applied'
  ]);
});
