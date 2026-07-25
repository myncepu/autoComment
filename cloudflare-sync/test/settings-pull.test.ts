import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';

import {
  authHeaders,
  seedVault,
  VALID_VAULT_ID
} from './fixtures';

interface PushResult {
  mutationId: string;
  status: 'applied' | 'duplicate' | 'stale' | 'rejected';
  serverSeq?: number | null;
  errorCode?: string;
}

interface PushResponse {
  ok: boolean;
  results: PushResult[];
  requestId: string;
}

interface PullChange {
  serverSeq: number;
  entityType: 'comment' | 'comment_delete' | 'setting';
  entityId: string;
  operation: 'upsert' | 'delete';
  value?: unknown;
  record?: {
    comment: { id: string; commentText: string };
    anchors: Array<{ id: string; commentId: string }>;
  };
  recordId?: string;
  deletedAt?: number;
}

interface PullResponse {
  ok: boolean;
  changes: PullChange[];
  nextCursor: number;
  hasMore: boolean;
  highWatermark: number;
  requestId: string;
}

function settingMutation(
  mutationId: string,
  settingKey: string,
  value: unknown
) {
  return {
    mutationId,
    entityType: 'setting',
    entityId: settingKey,
    operation: 'upsert',
    payload: { value },
    createdAt: 1_721_000_000_000
  };
}

async function push(mutations: unknown[]): Promise<PushResponse> {
  const response = await SELF.fetch(
    'https://worker.test/v1/sync/push',
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        deviceId: 'device-settings-push',
        mutations
      })
    }
  );
  expect(response.status).toBe(200);
  return response.json<PushResponse>();
}

async function pull(
  query: string,
  headers: Record<string, string> = authHeaders()
): Promise<{ response: Response; body: PullResponse }> {
  const response = await SELF.fetch(
    `https://worker.test/v1/sync/pull?${query}`,
    { headers }
  );
  const body = await response.json<PullResponse>();
  return { response, body };
}

async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM comment_anchors'),
    env.DB.prepare('DELETE FROM comment_records'),
    env.DB.prepare('DELETE FROM synced_settings'),
    env.DB.prepare('DELETE FROM comment_tombstones'),
    env.DB.prepare('DELETE FROM sync_devices'),
    env.DB.prepare('DELETE FROM sync_changes'),
    env.DB.prepare('DELETE FROM sync_mutations'),
    env.DB.prepare('DELETE FROM sync_vaults'),
    env.DB.prepare(
      "DELETE FROM sqlite_sequence WHERE name = 'sync_changes'"
    )
  ]);
  await seedVault();
}

beforeEach(resetDatabase);

test('stores only allowlisted settings in canonical JSON and replays without overwriting', async () => {
  const first = await push([
    settingMutation('setting-1', 'batch_concurrency', 2),
    settingMutation('setting-2', 'batch_concurrency', 5),
    settingMutation(
      'setting-canonical',
      'batch_checkbox_settings',
      { z: 1, a: { y: 2, x: 3 } }
    ),
    settingMutation(
      'setting-password',
      'auto_fill_user_password',
      'must-not-leave'
    )
  ]);

  expect(first.results.map(({ status }) => status)).toEqual([
    'applied',
    'applied',
    'applied',
    'rejected'
  ]);
  expect(first.results[3]).toEqual({
    mutationId: 'setting-password',
    status: 'rejected',
    errorCode: 'SETTING_NOT_SYNCABLE'
  });
  expect(
    await env.DB.prepare(
      `SELECT setting_key, value_json, accepted_mutation_id
       FROM synced_settings
       WHERE vault_id = ?
       ORDER BY setting_key`
    )
      .bind(VALID_VAULT_ID)
      .all()
  ).toMatchObject({
    results: [
      {
        setting_key: 'batch_checkbox_settings',
        value_json: '{"a":{"x":3,"y":2},"z":1}',
        accepted_mutation_id: 'setting-canonical'
      },
      {
        setting_key: 'batch_concurrency',
        value_json: '5',
        accepted_mutation_id: 'setting-2'
      }
    ]
  });

  const replay = await push([
    settingMutation('setting-2', 'batch_concurrency', 99)
  ]);
  expect(replay.results).toEqual([
    {
      mutationId: 'setting-2',
      status: 'duplicate',
      serverSeq: 2
    }
  ]);
  expect(
    await env.DB.prepare(
      `SELECT value_json FROM synced_settings
       WHERE vault_id = ? AND setting_key = ?`
    )
      .bind(VALID_VAULT_ID, 'batch_concurrency')
      .first<{ value_json: string }>()
  ).toEqual({ value_json: '5' });
  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ? AND mutation_id = 'setting-2') AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ? AND mutation_id = 'setting-2') AS receipts,
         (SELECT COUNT(*) FROM synced_settings
          WHERE vault_id = ? AND setting_key = 'auto_fill_user_password')
           AS leaked_password_rows`
    )
      .bind(VALID_VAULT_ID, VALID_VAULT_ID, VALID_VAULT_ID)
      .first()
  ).toEqual({
    changes: 1,
    receipts: 1,
    leaked_password_rows: 0
  });
});

test('pull paginates only the authenticated vault and materializes current setting rows', async () => {
  await push([
    settingMutation('setting-1', 'batch_concurrency', 2),
    settingMutation('setting-2', 'batch_concurrency', 5),
    settingMutation('setting-3', 'batch_timeout_seconds', 60)
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_vaults
       (vault_id, secret_hash, created_at, deleted_at)
       VALUES ('BBBBBBBBBBBBBBBBBBBBBB', ?, 1000, NULL)`
    ).bind('0'.repeat(64)),
    env.DB.prepare(
      `INSERT INTO sync_changes
       (vault_id, mutation_id, entity_type, entity_id, operation, created_at)
       VALUES
       ('BBBBBBBBBBBBBBBBBBBBBB', 'other-change', 'setting',
        'batch_concurrency', 'upsert', 1000)`
    )
  ]);

  const first = await pull('cursor=0&limit=2&deviceId=device-a');
  expect(first.response.status).toBe(200);
  expect(first.body).toMatchObject({
    ok: true,
    nextCursor: 2,
    hasMore: true,
    highWatermark: 3
  });
  expect(first.body.changes).toEqual([
    {
      serverSeq: 1,
      entityType: 'setting',
      entityId: 'batch_concurrency',
      operation: 'upsert',
      value: 5
    },
    {
      serverSeq: 2,
      entityType: 'setting',
      entityId: 'batch_concurrency',
      operation: 'upsert',
      value: 5
    }
  ]);
  expect(JSON.stringify(first.body)).not.toMatch(
    /secret|password|authorization|cookie/iu
  );

  const second = await pull(
    `cursor=${first.body.nextCursor}&limit=2&deviceId=device-a`
  );
  expect(second.response.status).toBe(200);
  expect(second.body).toMatchObject({
    nextCursor: 3,
    hasMore: false,
    highWatermark: 3
  });
  expect(second.body.changes).toEqual([
    {
      serverSeq: 3,
      entityType: 'setting',
      entityId: 'batch_timeout_seconds',
      operation: 'upsert',
      value: 60
    }
  ]);
  expect(
    await env.DB.prepare(
      `SELECT last_cursor FROM sync_devices
       WHERE vault_id = ? AND device_id = ?`
    )
      .bind(VALID_VAULT_ID, 'device-a')
      .first<{ last_cursor: number }>()
  ).toEqual({ last_cursor: 3 });
});

test('pull materializes a current comment with anchors and a delete tombstone', async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comment_records (
         vault_id, record_id, batch_id, url_index, submitted_at, archive_month,
         target_page_url, target_domain, promoted_website_url, promoted_domain,
         comment_html, comment_text, submit_status, source, created_at,
         updated_at, revision_source_rank, revision_captured_at,
         revision_recorded_at, revision_sequence, revision_id,
         accepted_mutation_id, cloud_created_at, cloud_updated_at
       ) VALUES (
         ?, 'comment:1', 'comment', 1, 1721000000000, '2024-07',
         'https://target.test/post', 'target.test',
         'https://promoted.test/', 'promoted.test',
         '<p>current body</p>', 'current body', 'submitted', 'live',
         1721000000001, 1721000000002, 1, 200, 201, 0, 'revision-2',
         'comment-change', 1721000000003, 1721000000004
       )`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO comment_anchors (
         vault_id, anchor_id, comment_id, position, anchor_text,
         anchor_text_normalized, href_raw, href_resolved, href_domain
       ) VALUES (
         ?, 'comment:1:0', 'comment:1', 0, 'Anchor', 'anchor',
         'https://anchor.test/', 'https://anchor.test/', 'anchor.test'
       )`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, mutation_id, entity_type, entity_id, operation, created_at
       ) VALUES (?, 'comment-change', 'comment', 'comment:1', 'upsert', 1000)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, mutation_id, entity_type, entity_id, operation, created_at
       ) VALUES (
         ?, 'delete-change', 'comment_delete', 'deleted:1', 'delete', 1001
       )`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO comment_tombstones
       (vault_id, record_id, mutation_id, deleted_at, server_seq)
       VALUES (?, 'deleted:1', 'delete-change', 1721000000005, 2)`
    ).bind(VALID_VAULT_ID)
  ]);

  const { response, body } = await pull(
    'cursor=0&limit=100&deviceId=device-materialize'
  );
  expect(response.status).toBe(200);
  expect(body.changes[0]).toMatchObject({
    serverSeq: 1,
    entityType: 'comment',
    entityId: 'comment:1',
    operation: 'upsert',
    record: {
      comment: {
        id: 'comment:1',
        commentText: 'current body'
      },
      anchors: [
        {
          id: 'comment:1:0',
          commentId: 'comment:1'
        }
      ]
    }
  });
  expect(body.changes[1]).toEqual({
    serverSeq: 2,
    entityType: 'comment_delete',
    entityId: 'deleted:1',
    operation: 'delete',
    recordId: 'deleted:1',
    deletedAt: 1_721_000_000_005
  });
});

test.each([
  '',
  'limit=1&deviceId=device-a',
  'cursor=-1&limit=1&deviceId=device-a',
  'cursor=01&limit=1&deviceId=device-a',
  'cursor=0&deviceId=device-a',
  'cursor=0&limit=0&deviceId=device-a',
  'cursor=0&limit=101&deviceId=device-a',
  'cursor=0&limit=1',
  'cursor=0&limit=1&deviceId=%20',
  'cursor=0&limit=1&deviceId=a&deviceId=b',
  'cursor=0&limit=1&deviceId=device-a&unknown=1'
])('strictly rejects invalid pull query %j', async (query) => {
  const { response } = await pull(query);
  expect(response.status).toBe(400);
});

test('pull inherits authentication, method, request-id, and CORS invariants', async () => {
  const unauthenticated = await SELF.fetch(
    'https://worker.test/v1/sync/pull?cursor=0&limit=1&deviceId=device-a'
  );
  expect(unauthenticated.status).toBe(401);

  const wrongMethod = await SELF.fetch(
    'https://worker.test/v1/sync/pull?cursor=0&limit=1&deviceId=device-a',
    {
      method: 'POST',
      headers: authHeaders()
    }
  );
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get('Allow')).toBe('GET, OPTIONS');

  const allowedOrigin = 'chrome-extension://allowed-extension';
  const preflight = await SELF.fetch(
    'https://worker.test/v1/sync/pull',
    {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization'
      }
    }
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
    allowedOrigin
  );

  const success = await SELF.fetch(
    'https://worker.test/v1/sync/pull?cursor=0&limit=1&deviceId=device-a',
    {
      headers: {
        ...authHeaders(),
        Origin: allowedOrigin
      }
    }
  );
  expect(success.status).toBe(200);
  const body = await success.json<{ requestId: string }>();
  expect(body.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
});
