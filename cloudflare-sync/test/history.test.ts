import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';

import { requireVault } from '../src/auth';
import { deleteHistory as deleteHistoryHandler } from '../src/history';
import {
  authHeaders,
  seedVault,
  VALID_VAULT_ID
} from './fixtures';

const ALLOWED_ORIGIN = 'chrome-extension://allowed-extension';
const OTHER_VAULT_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const OTHER_SYNC_KEY =
  `acsync_${OTHER_VAULT_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const VALID_SECRET_HASH =
  '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';

interface AnchorSeed {
  text: string;
  hrefDomain: string;
}

interface CommentOptions {
  recordId?: string;
  mutationId?: string;
  submittedAt?: number;
  targetDomain?: string;
  promotedDomain?: string;
  anchors?: AnchorSeed[];
  profileId?: string;
  promotionSiteId?: string;
  withAssignment?: boolean;
}

function commentMutation({
  recordId = 'batch-a:1',
  mutationId = `upsert-${recordId}`,
  submittedAt = 1_721_000_000_000,
  targetDomain = 'target.test',
  promotedDomain = 'promoted.test',
  anchors = [{ text: 'Product', hrefDomain: 'docs.test' }],
  profileId = 'profile-a',
  promotionSiteId = 'site-a',
  withAssignment = false
}: CommentOptions = {}) {
  return {
    mutationId,
    entityType: 'comment',
    entityId: recordId,
    operation: 'upsert',
    payload: {
      comment: {
        id: recordId,
        batchId: `batch-${recordId}`,
        urlIndex: 0,
        submittedAt,
        archiveMonth: '2024-07',
        targetPageUrl: `https://${targetDomain}/post`,
        targetDomain,
        promotedWebsiteUrl: `https://${promotedDomain}/`,
        promotedDomain,
        commentHtml: '<p>Product link</p>',
        commentText: 'Product link',
        submitStatus: 'submitted',
        source: 'live',
        ...(withAssignment
          ? {
              profileId,
              profileDisplayName: `Display ${profileId}`,
              promotionSiteId,
              promotionSiteName: `Name ${promotionSiteId}`,
              promotionSiteUrl: `https://${promotionSiteId}.example.test/`,
              assignmentPairId: `pair-${profileId}-${promotionSiteId}`,
              assignmentSource: 'explicit',
              configRevision: 2,
              attemptCount: 1,
              errorCode: null,
              skipReason: null
            }
          : {}),
        createdAt: 1_721_000_000_001,
        updatedAt: 1_721_000_000_002,
        historyRevision: {
          capturedAt: 100,
          recordedAt: 100,
          sequence: 0,
          id: 'revision-1'
        }
      },
      anchors: anchors.map((anchor, position) => ({
          id: `${recordId}:${position}`,
          commentId: recordId,
          position,
          anchorText: anchor.text,
          anchorTextNormalized: anchor.text.toLowerCase(),
          hrefRaw: `https://${anchor.hrefDomain}/product`,
          hrefResolved: `https://${anchor.hrefDomain}/product`,
          hrefDomain: anchor.hrefDomain
        }))
    },
    createdAt: 1_721_000_000_003
  };
}

async function pushComment(
  options: CommentOptions = {},
  syncKey?: string
): Promise<{
  status: 'applied' | 'duplicate' | 'stale' | 'rejected';
  serverSeq?: number | null;
}> {
  const response = await SELF.fetch('https://worker.test/v1/sync/push', {
    method: 'POST',
    headers: authHeaders(syncKey),
    body: JSON.stringify({
      deviceId: 'history-test-device',
      mutations: [commentMutation(options)]
    })
  });
  expect(response.status).toBe(200);
  const body = await response.json<{
    results: Array<{
      status: 'applied' | 'duplicate' | 'stale' | 'rejected';
      serverSeq?: number | null;
    }>;
  }>();
  return body.results[0]!;
}

async function seedOtherVault(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_vaults (vault_id, secret_hash, created_at, deleted_at)
     VALUES (?, ?, ?, NULL)`
  )
    .bind(OTHER_VAULT_ID, VALID_SECRET_HASH, 1_000)
    .run();
}

async function deleteHistoryRequest(
  recordId: string,
  mutationId: string,
  syncKey?: string
): Promise<Response> {
  return SELF.fetch(
    `https://worker.test/v1/history/${encodeURIComponent(recordId)}`,
    {
      method: 'DELETE',
      headers: authHeaders(syncKey),
      body: JSON.stringify({ mutationId })
    }
  );
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM comment_anchors'),
    env.DB.prepare('DELETE FROM comment_records'),
    env.DB.prepare('DELETE FROM synced_settings'),
    env.DB.prepare('DELETE FROM comment_tombstones'),
    env.DB.prepare('DELETE FROM sync_devices'),
    env.DB.prepare('DELETE FROM sync_changes'),
    env.DB.prepare('DELETE FROM sync_mutations'),
    env.DB.prepare('DELETE FROM sync_vaults')
  ]);
  await seedVault();
});

test('returns an authenticated bounded cloud history page from real D1 rows', async () => {
  await pushComment();

  const response = await SELF.fetch(
    'https://worker.test/v1/history?targetDomain=target.test&limit=50',
    { headers: authHeaders() }
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    records: [
      {
        comment: { id: 'batch-a:1' },
        anchors: [{ id: 'batch-a:1:0' }]
      }
    ]
  });
});

test('stores and filters non-sensitive Assignment history fields', async () => {
  await pushComment({
    recordId: 'assigned:a',
    mutationId: 'assigned:a',
    submittedAt: 1_721_000_000_003,
    withAssignment: true
  });
  await pushComment({
    recordId: 'assigned:b',
    mutationId: 'assigned:b',
    submittedAt: 1_721_000_000_002,
    profileId: 'profile-b',
    withAssignment: true
  });
  await pushComment({
    recordId: 'legacy:no-assignment',
    mutationId: 'legacy:no-assignment',
    submittedAt: 1_721_000_000_001
  });

  const response = await SELF.fetch(
    'https://worker.test/v1/history?profileId=profile-a&promotionSiteId=site-a&limit=50',
    { headers: authHeaders() }
  );
  expect(response.status).toBe(200);
  const body = await response.json<{
    records: Array<{ comment: Record<string, unknown> }>;
  }>();
  expect(body.records).toHaveLength(1);
  expect(body.records[0]?.comment).toMatchObject({
    id: 'assigned:a',
    profileId: 'profile-a',
    profileDisplayName: 'Display profile-a',
    promotionSiteId: 'site-a',
    promotionSiteName: 'Name site-a',
    promotionSiteUrl: 'https://site-a.example.test/',
    assignmentSource: 'explicit',
    configRevision: 2,
    attemptCount: 1,
    errorCode: null,
    skipReason: null
  });
  expect(JSON.stringify(body)).not.toMatch(/alice@example|About Site|password/iu);

  const v1Pull = await SELF.fetch(
    'https://worker.test/v1/sync/pull?cursor=0&limit=100&deviceId=history-v1',
    { headers: authHeaders() }
  ).then((result) => result.json<{
    changes: Array<{ record?: { comment: Record<string, unknown> } }>;
  }>());
  expect(v1Pull.changes[0]?.record?.comment).not.toHaveProperty('profileId');

  const v2Pull = await SELF.fetch(
    'https://worker.test/v1/sync/pull?cursor=0&limit=100&deviceId=history-v2&protocolVersion=2',
    { headers: authHeaders() }
  ).then((result) => result.json<{
    changes: Array<{ record?: { comment: Record<string, unknown> } }>;
  }>());
  expect(v2Pull.changes[0]?.record?.comment).toHaveProperty('profileId');
});

test('permanently deletes a real D1 comment through the history route', async () => {
  await pushComment();

  const response = await deleteHistoryRequest('batch-a:1', 'delete-a');

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    mutationId: 'delete-a',
    status: 'applied'
  });
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM comment_records
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'batch-a:1')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('combines every filter on one matching anchor and paginates by the stable descending tuple', async () => {
  await pushComment({
    recordId: 'matching-newer',
    mutationId: 'upsert-newer',
    submittedAt: 300,
    anchors: [{ text: 'Product guide', hrefDomain: 'docs.test' }]
  });
  await pushComment({
    recordId: 'matching-older',
    mutationId: 'upsert-older',
    submittedAt: 200,
    anchors: [{ text: 'Product older', hrefDomain: 'docs.test' }]
  });
  await pushComment({
    recordId: 'split-anchor-match',
    mutationId: 'upsert-split',
    submittedAt: 250,
    anchors: [
      { text: 'Product elsewhere', hrefDomain: 'wrong.test' },
      { text: 'Other link', hrefDomain: 'docs.test' }
    ]
  });
  await seedOtherVault();
  await pushComment(
    {
      recordId: 'other-vault',
      mutationId: 'upsert-other-vault',
      submittedAt: 400,
      anchors: [{ text: 'Product leak', hrefDomain: 'docs.test' }]
    },
    OTHER_SYNC_KEY
  );

  const first = await SELF.fetch(
    'https://worker.test/v1/history?' +
      new URLSearchParams({
        targetDomain: 'target.test',
        promotedDomain: 'promoted.test',
        anchorTextPrefix: 'product',
        hrefDomain: 'docs.test',
        from: '150',
        to: '350',
        limit: '1'
      }),
    { headers: authHeaders() }
  );
  expect(first.status).toBe(200);
  const firstBody = await first.json<{
    records: Array<{ comment: { id: string } }>;
    nextCursor: { submittedAt: number; id: string } | null;
    hasMore: boolean;
  }>();
  expect(firstBody.records.map(({ comment }) => comment.id)).toEqual([
    'matching-newer'
  ]);
  expect(firstBody.nextCursor).toEqual({
    submittedAt: 300,
    id: 'matching-newer'
  });
  expect(firstBody.hasMore).toBe(true);

  const second = await SELF.fetch(
    'https://worker.test/v1/history?' +
      new URLSearchParams({
        targetDomain: 'target.test',
        promotedDomain: 'promoted.test',
        anchorTextPrefix: 'product',
        hrefDomain: 'docs.test',
        from: '150',
        to: '350',
        cursorSubmittedAt: '300',
        cursorId: 'matching-newer',
        limit: '1'
      }),
    { headers: authHeaders() }
  );
  const secondBody = await second.json<{
    records: Array<{ comment: { id: string } }>;
    nextCursor: { submittedAt: number; id: string } | null;
    hasMore: boolean;
  }>();
  expect(second.status).toBe(200);
  expect(secondBody.records.map(({ comment }) => comment.id)).toEqual([
    'matching-older'
  ]);
  expect(secondBody.nextCursor).toBeNull();
  expect(secondBody.hasMore).toBe(false);
});

test('uses record id as the stable tie-breaker for identical timestamps', async () => {
  await pushComment({
    recordId: 'tie-b',
    mutationId: 'upsert-tie-b',
    submittedAt: 500
  });
  await pushComment({
    recordId: 'tie-a',
    mutationId: 'upsert-tie-a',
    submittedAt: 500
  });

  const first = await SELF.fetch(
    'https://worker.test/v1/history?limit=1',
    { headers: authHeaders() }
  );
  const firstBody = await first.json<{
    records: Array<{ comment: { id: string } }>;
    nextCursor: { submittedAt: number; id: string };
  }>();
  expect(firstBody.records[0]?.comment.id).toBe('tie-b');

  const second = await SELF.fetch(
    'https://worker.test/v1/history?' +
      new URLSearchParams({
        cursorSubmittedAt: String(firstBody.nextCursor.submittedAt),
        cursorId: firstBody.nextCursor.id,
        limit: '1'
      }),
    { headers: authHeaders() }
  );
  const secondBody = await second.json<{
    records: Array<{ comment: { id: string } }>;
  }>();
  expect(secondBody.records[0]?.comment.id).toBe('tie-a');
});

test('handles Unicode prefixes including the maximum scalar without prefix spillover', async () => {
  await pushComment({
    recordId: 'unicode-match',
    mutationId: 'upsert-unicode-match',
    anchors: [{
      text: `${String.fromCodePoint(0x10ffff)}产品链接`,
      hrefDomain: 'unicode.test'
    }]
  });
  await pushComment({
    recordId: 'unicode-nonmatch',
    mutationId: 'upsert-unicode-nonmatch',
    anchors: [{ text: '产品链接', hrefDomain: 'unicode.test' }]
  });

  const response = await SELF.fetch(
    'https://worker.test/v1/history?' +
      new URLSearchParams({
        anchorTextPrefix: String.fromCodePoint(0x10ffff),
        limit: '50'
      }),
    { headers: authHeaders() }
  );
  const body = await response.json<{
    records: Array<{ comment: { id: string } }>;
  }>();
  expect(response.status).toBe(200);
  expect(body.records.map(({ comment }) => comment.id)).toEqual([
    'unicode-match'
  ]);
});

test('strictly rejects unknown, duplicate, overlong, partial-cursor, and invalid range queries', async () => {
  const invalidQueries = [
    'unknown=value',
    'limit=1&limit=2',
    'limit=0',
    'limit=101',
    'from=-1',
    'from=2&to=1',
    'cursorSubmittedAt=10',
    'cursorId=record-a',
    `targetDomain=${'a'.repeat(254)}`,
    `anchorTextPrefix=${'a'.repeat(10_001)}`
  ];

  for (const query of invalidQueries) {
    const response = await SELF.fetch(
      `https://worker.test/v1/history?${query}`,
      { headers: authHeaders() }
    );
    expect(response.status, query).toBe(400);
    expect(response.headers.get('Cache-Control'), query).toBe('no-store');
  }
});

test('returns at most 100 records and uses limit plus one to signal more pages', async () => {
  for (let index = 0; index < 101; index += 1) {
    await pushComment({
      recordId: `bounded-${String(index).padStart(3, '0')}`,
      mutationId: `upsert-bounded-${index}`,
      submittedAt: index,
      anchors: []
    });
  }

  const response = await SELF.fetch(
    'https://worker.test/v1/history?limit=100',
    { headers: authHeaders() }
  );
  const body = await response.json<{
    records: Array<{ comment: { id: string } }>;
    nextCursor: { submittedAt: number; id: string } | null;
    hasMore: boolean;
  }>();
  expect(response.status).toBe(200);
  expect(body.records).toHaveLength(100);
  expect(body.hasMore).toBe(true);
  expect(body.nextCursor).not.toBeNull();
});

test('returns full public comment bundles without mutation or vault metadata', async () => {
  await pushComment();
  const response = await SELF.fetch(
    'https://worker.test/v1/history?limit=50',
    {
      headers: {
        ...authHeaders(),
        Origin: ALLOWED_ORIGIN
      }
    }
  );
  const body = await response.json<{
    records: Array<{
      comment: Record<string, unknown>;
      anchors: Array<Record<string, unknown>>;
    }>;
    requestId: string;
  }>();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
    ALLOWED_ORIGIN
  );
  expect(body.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect(body.records[0]?.comment).toMatchObject({
    id: 'batch-a:1',
    historyRevision: {
      capturedAt: 100,
      recordedAt: 100,
      sequence: 0,
      id: 'revision-1'
    }
  });
  expect(body.records[0]?.anchors[0]).toMatchObject({
    id: 'batch-a:1:0',
    anchorText: 'Product',
    hrefDomain: 'docs.test'
  });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('secret_hash');
  expect(serialized).not.toContain('accepted_mutation_id');
  expect(serialized).not.toContain('processed_at');
});

test('enforces history authentication, method Allow, and route-specific CORS preflights', async () => {
  const unauthenticated = await SELF.fetch(
    'https://worker.test/v1/history?limit=50'
  );
  expect(unauthenticated.status).toBe(401);

  const wrongMethod = await SELF.fetch(
    'https://worker.test/v1/history',
    { method: 'POST', headers: authHeaders() }
  );
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get('Allow')).toBe('GET, OPTIONS');

  const readPreflight = await SELF.fetch(
    'https://worker.test/v1/history',
    {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization'
      }
    }
  );
  expect(readPreflight.status).toBe(204);
  expect(readPreflight.headers.get('Access-Control-Allow-Methods')).toBe(
    'GET, OPTIONS'
  );

  const deletePreflight = await SELF.fetch(
    'https://worker.test/v1/history/batch-a%3A1',
    {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'Authorization, Content-Type'
      }
    }
  );
  expect(deletePreflight.status).toBe(204);
  expect(deletePreflight.headers.get('Access-Control-Allow-Methods')).toBe(
    'DELETE, OPTIONS'
  );
});

test('same delete raced concurrently is one applied and one stored duplicate', async () => {
  await pushComment();

  const responses = await Promise.all([
    deleteHistoryRequest('batch-a:1', 'delete-race'),
    deleteHistoryRequest('batch-a:1', 'delete-race')
  ]);
  const bodies = await Promise.all(
    responses.map((response) =>
      response.json<{
        status: string;
        serverSeq: number | null;
      }>()
    )
  );

  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  expect(bodies.map(({ status }) => status).sort()).toEqual([
    'applied',
    'duplicate'
  ]);
  expect(new Set(bodies.map(({ serverSeq }) => serverSeq)).size).toBe(1);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM comment_tombstones
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'batch-a:1')
        .first<{ count: number }>()
    )?.count
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sync_changes
         WHERE vault_id = ? AND mutation_id = ?`
      )
        .bind(VALID_VAULT_ID, 'delete-race')
        .first<{ count: number }>()
    )?.count
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?`
      )
        .bind(VALID_VAULT_ID, 'delete-race')
        .first<{ count: number }>()
    )?.count
  ).toBe(1);
});

test('deleting an unknown record creates a tombstone and makes an offline upsert stale', async () => {
  const deleted = await deleteHistoryRequest(
    'offline-record',
    'delete-offline'
  );
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({
    mutationId: 'delete-offline',
    status: 'applied'
  });

  const oldUpload = await pushComment({
    recordId: 'offline-record',
    mutationId: 'offline-old-upsert',
    submittedAt: 100
  });
  expect(oldUpload.status).toBe('stale');
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM comment_records
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'offline-record')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('rejects mutation id reuse for another entity without creating a second tombstone', async () => {
  const first = await deleteHistoryRequest(
    'record-one',
    'delete-conflict'
  );
  expect(first.status).toBe(200);

  const conflicting = await deleteHistoryRequest(
    'record-two',
    'delete-conflict'
  );
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({
    ok: false,
    error: { code: 'MUTATION_ID_CONFLICT', retryable: false }
  });
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM comment_tombstones
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'record-two')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('permanent deletion is isolated to the authenticated vault', async () => {
  await seedOtherVault();
  await pushComment({
    recordId: 'shared-record',
    mutationId: 'upsert-primary-shared'
  });
  await pushComment(
    {
      recordId: 'shared-record',
      mutationId: 'upsert-other-shared'
    },
    OTHER_SYNC_KEY
  );

  const deleted = await deleteHistoryRequest(
    'shared-record',
    'delete-primary-shared'
  );
  expect(deleted.status).toBe(200);
  const otherCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM comment_records
     WHERE vault_id = ? AND record_id = ?`
  )
    .bind(OTHER_VAULT_ID, 'shared-record')
    .first<{ count: number }>();
  expect(otherCount?.count).toBe(1);
  const otherTombstoneCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM comment_tombstones
     WHERE vault_id = ? AND record_id = ?`
  )
    .bind(OTHER_VAULT_ID, 'shared-record')
    .first<{ count: number }>();
  expect(otherTombstoneCount?.count).toBe(0);
});

test('an authenticated delete cannot write after the vault becomes inactive', async () => {
  const request = new Request(
    'https://worker.test/v1/history/raced-record',
    {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ mutationId: 'delete-after-vault' })
    }
  );
  const vault = await requireVault(request, env);
  await env.DB.prepare(
    'UPDATE sync_vaults SET deleted_at = ? WHERE vault_id = ?'
  )
    .bind(Date.now(), VALID_VAULT_ID)
    .run();

  await expect(
    deleteHistoryHandler(request, env, vault, 'race-request')
  ).rejects.toMatchObject({
    code: 'VAULT_DELETED',
    status: 403
  });
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM comment_tombstones
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'raced-record')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?`
      )
        .bind(VALID_VAULT_ID, 'delete-after-vault')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('strictly validates delete path and bounded mutation-only JSON bodies', async () => {
  const cases: Array<{ url: string; init?: RequestInit; status: number }> = [
    {
      url: 'https://worker.test/v1/history/batch-a%3A1',
      init: {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({
          mutationId: 'delete-a',
          unexpected: true
        })
      },
      status: 400
    },
    {
      url: 'https://worker.test/v1/history/%252F',
      init: {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ mutationId: 'delete-a' })
      },
      status: 400
    },
    {
      url: 'https://worker.test/v1/history/a/b',
      init: {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ mutationId: 'delete-a' })
      },
      status: 404
    },
    {
      url: 'https://worker.test/v1/history/batch-a%3A1',
      init: {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ mutationId: 'x'.repeat(5_000) })
      },
      status: 413
    }
  ];

  for (const entry of cases) {
    const response = await SELF.fetch(entry.url, entry.init);
    expect(response.status, entry.url).toBe(entry.status);
    const text = await response.text();
    expect(text).not.toContain('acsync_');
    expect(text).not.toContain('secret_hash');
  }
});
