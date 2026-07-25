import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';

import {
  authHeaders,
  seedVault,
  VALID_VAULT_ID
} from './fixtures';

const DAY_MS = 24 * 60 * 60 * 1_000;

interface BootstrapResponse {
  ok: boolean;
  comments: Array<{
    comment: { id: string; submittedAt: number };
    anchors: Array<{ id: string; commentId: string }>;
  }>;
  settings: Array<{ key: string; value: unknown }>;
  tombstones: Array<{ recordId: string; deletedAt: number }>;
  nextCursor: string | null;
  hasMore: boolean;
  serverCursor: number;
  serverNow: number;
  requestId: string;
}

async function bootstrap(
  query: string,
  headers: Record<string, string> = authHeaders()
): Promise<{ response: Response; body: BootstrapResponse }> {
  const response = await SELF.fetch(
    `https://worker.test/v1/sync/bootstrap?${query}`,
    { headers }
  );
  const body = await response.json<BootstrapResponse>();
  return { response, body };
}

async function pushSetting(
  mutationId: string,
  settingKey: string,
  value: unknown
): Promise<Response> {
  return SELF.fetch('https://worker.test/v1/sync/push', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      deviceId: 'device-b',
      mutations: [
        {
          mutationId,
          entityType: 'setting',
          entityId: settingKey,
          operation: 'upsert',
          payload: { value },
          createdAt: Date.now()
        }
      ]
    })
  });
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

async function seedComment(
  recordId: string,
  submittedAt: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO comment_records (
       vault_id, record_id, batch_id, url_index, submitted_at, archive_month,
       target_page_url, target_domain, promoted_website_url, promoted_domain,
       comment_html, comment_text, submit_status, source, created_at,
       updated_at, revision_source_rank, revision_captured_at,
       revision_recorded_at, revision_sequence, revision_id,
       accepted_mutation_id, cloud_created_at, cloud_updated_at
     ) VALUES (
       ?, ?, ?, 0, ?, '2026-07',
       'https://target.test/post', 'target.test',
       'https://promoted.test/', 'promoted.test',
       '<p>body</p>', 'body', 'submitted', 'live', ?, ?, 1, ?, ?, 0, ?,
       ?, ?, ?
     )`
  )
    .bind(
      VALID_VAULT_ID,
      recordId,
      recordId,
      submittedAt,
      submittedAt,
      submittedAt,
      submittedAt,
      submittedAt,
      `revision:${recordId}`,
      `mutation:${recordId}`,
      submittedAt,
      submittedAt
    )
    .run();
}

beforeEach(resetDatabase);

test('bootstraps the recent snapshot and leaves later changes for pull', async () => {
  const beforeRequest = Date.now();
  await seedComment('recent:1', beforeRequest - 89 * DAY_MS);
  await seedComment('old:1', beforeRequest - 91 * DAY_MS);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO synced_settings (
         vault_id, setting_key, value_json, accepted_mutation_id,
         server_updated_at, server_seq
       ) VALUES (?, 'batch_concurrency', '3', 'setting:1', ?, 1)`
    ).bind(VALID_VAULT_ID, beforeRequest),
    env.DB.prepare(
      `INSERT INTO synced_settings (
         vault_id, setting_key, value_json, accepted_mutation_id,
         server_updated_at, server_seq
       ) VALUES (
         ?, 'auto_fill_user_password', '"must-not-leave"',
         'legacy-password-setting', ?, NULL
       )`
    ).bind(VALID_VAULT_ID, beforeRequest),
    env.DB.prepare(
      `INSERT INTO comment_tombstones (
         vault_id, record_id, mutation_id, deleted_at, server_seq
       ) VALUES (?, 'deleted:1', 'delete:1', ?, 2)`
    ).bind(VALID_VAULT_ID, beforeRequest),
    env.DB.prepare(
      `INSERT INTO comment_tombstones (
         vault_id, record_id, mutation_id, deleted_at, server_seq
       ) VALUES (?, 'deleted:old', 'delete:old', 1, NULL)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, mutation_id, entity_type, entity_id, operation, created_at
       ) VALUES
         (?, 'setting:1', 'setting', 'batch_concurrency', 'upsert', ?),
         (?, 'delete:1', 'comment_delete', 'deleted:1', 'delete', ?)`
    ).bind(
      VALID_VAULT_ID,
      beforeRequest,
      VALID_VAULT_ID,
      beforeRequest
    )
  ]);

  const { response, body: page } = await bootstrap(
    'limit=50&deviceId=device-b'
  );
  expect(response.status).toBe(200);
  expect(page.comments.map(({ comment }) => comment.id)).toEqual([
    'recent:1'
  ]);
  expect(page.settings).toEqual([
    { key: 'batch_concurrency', value: 3 }
  ]);
  expect(page.tombstones).toEqual([
    { recordId: 'deleted:1', deletedAt: beforeRequest },
    { recordId: 'deleted:old', deletedAt: 1 }
  ]);
  expect(JSON.stringify(page)).not.toContain('must-not-leave');
  expect(page.serverCursor).toBe(2);
  expect(page.serverNow).toBeGreaterThanOrEqual(beforeRequest);

  const pushResponse = await pushSetting(
    'after-snapshot',
    'batch_timeout_seconds',
    90
  );
  expect(pushResponse.status).toBe(200);

  const deltaResponse = await SELF.fetch(
    `https://worker.test/v1/sync/pull?cursor=${page.serverCursor}&limit=100&deviceId=device-b`,
    { headers: authHeaders() }
  );
  expect(deltaResponse.status).toBe(200);
  const delta = await deltaResponse.json<{
    changes: Array<{ entityId: string }>;
  }>();
  expect(delta.changes.map(({ entityId }) => entityId)).toContain(
    'batch_timeout_seconds'
  );
});

test('keeps the composite comment order and snapshot bounds fixed across pages', async () => {
  const submittedAt = Date.now() - DAY_MS;
  await seedComment('same:z', submittedAt);
  await seedComment('same:m', submittedAt);
  await seedComment('same:a', submittedAt);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO synced_settings (
         vault_id, setting_key, value_json, accepted_mutation_id,
         server_updated_at, server_seq
       ) VALUES (?, 'batch_concurrency', '3', 'setting:first', ?, 1)`
    ).bind(VALID_VAULT_ID, submittedAt),
    env.DB.prepare(
      `INSERT INTO comment_tombstones (
         vault_id, record_id, mutation_id, deleted_at, server_seq
       ) VALUES (?, 'deleted:first', 'delete:first', ?, 2)`
    ).bind(VALID_VAULT_ID, submittedAt),
    env.DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, mutation_id, entity_type, entity_id, operation, created_at
       ) VALUES
         (?, 'setting:first', 'setting', 'batch_concurrency', 'upsert', ?),
         (?, 'delete:first', 'comment_delete', 'deleted:first', 'delete', ?)`
    ).bind(
      VALID_VAULT_ID,
      submittedAt,
      VALID_VAULT_ID,
      submittedAt
    )
  ]);

  const first = await bootstrap('limit=1&deviceId=device-pages');
  expect(first.response.status).toBe(200);
  expect(first.body.comments.map(({ comment }) => comment.id)).toEqual([
    'same:z'
  ]);
  expect(first.body).toMatchObject({
    settings: [{ key: 'batch_concurrency', value: 3 }],
    tombstones: [
      { recordId: 'deleted:first', deletedAt: submittedAt }
    ],
    hasMore: true,
    serverCursor: 2
  });
  expect(first.body.nextCursor).toEqual(expect.any(String));

  const afterSnapshot = await pushSetting(
    'setting:after-page-one',
    'batch_timeout_seconds',
    90
  );
  expect(afterSnapshot.status).toBe(200);

  const second = await bootstrap(
    `limit=1&deviceId=device-pages&cursor=${encodeURIComponent(
      first.body.nextCursor ?? ''
    )}`
  );
  expect(second.response.status).toBe(200);
  expect(second.body.comments.map(({ comment }) => comment.id)).toEqual([
    'same:m'
  ]);
  expect(second.body).toMatchObject({
    settings: [],
    tombstones: [],
    hasMore: true,
    serverCursor: first.body.serverCursor,
    serverNow: first.body.serverNow
  });

  const third = await bootstrap(
    `limit=1&deviceId=device-pages&cursor=${encodeURIComponent(
      second.body.nextCursor ?? ''
    )}`
  );
  expect(third.response.status).toBe(200);
  expect(third.body.comments.map(({ comment }) => comment.id)).toEqual([
    'same:a'
  ]);
  expect(third.body).toMatchObject({
    settings: [],
    tombstones: [],
    hasMore: false,
    nextCursor: null,
    serverCursor: first.body.serverCursor,
    serverNow: first.body.serverNow
  });
  expect(
    await env.DB.prepare(
      `SELECT last_cursor FROM sync_devices
       WHERE vault_id = ? AND device_id = 'device-pages'`
    )
      .bind(VALID_VAULT_ID)
      .first<{ last_cursor: number }>()
  ).toEqual({ last_cursor: first.body.serverCursor });

  const deltaResponse = await SELF.fetch(
    `https://worker.test/v1/sync/pull?cursor=${third.body.serverCursor}&limit=100&deviceId=device-pages`,
    { headers: authHeaders() }
  );
  expect(deltaResponse.status).toBe(200);
  const delta = await deltaResponse.json<{
    changes: Array<{ entityId: string }>;
  }>();
  expect(delta.changes.map(({ entityId }) => entityId)).toContain(
    'batch_timeout_seconds'
  );
});

test.each([
  '',
  'deviceId=device-b',
  'limit=0&deviceId=device-b',
  'limit=101&deviceId=device-b',
  'limit=1',
  'limit=1&deviceId=%20',
  'limit=1&deviceId=a&deviceId=b',
  'limit=1&deviceId=device-b&cursor=not-a-cursor',
  'limit=1&deviceId=device-b&unknown=1'
])('strictly rejects invalid bootstrap query %j', async (query) => {
  const { response } = await bootstrap(query);
  expect(response.status).toBe(400);
});

test('bootstrap inherits authentication, method, request-id, CORS, and vault isolation', async () => {
  const now = Date.now();
  await seedComment('own:1', now - DAY_MS);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_vaults
       (vault_id, secret_hash, created_at, deleted_at)
       VALUES ('BBBBBBBBBBBBBBBBBBBBBB', ?, 1000, NULL)`
    ).bind('0'.repeat(64)),
    env.DB.prepare(
      `INSERT INTO comment_records (
         vault_id, record_id, batch_id, url_index, submitted_at, archive_month,
         target_page_url, target_domain, promoted_website_url, promoted_domain,
         comment_html, comment_text, submit_status, source, created_at,
         updated_at, revision_source_rank, revision_captured_at,
         revision_recorded_at, revision_sequence, revision_id,
         accepted_mutation_id, cloud_created_at, cloud_updated_at
       ) VALUES (
         'BBBBBBBBBBBBBBBBBBBBBB', 'other:1', 'other:1', 0, ?, '2026-07',
         'https://other.test/post', 'other.test',
         'https://other-promoted.test/', 'other-promoted.test',
         '<p>other-vault-secret</p>', 'other-vault-secret', 'submitted',
         'live', ?, ?, 1, ?, ?, 0, 'revision:other', 'mutation:other', ?, ?
       )`
    ).bind(now - DAY_MS, now, now, now, now, now, now)
  ]);

  const unauthenticated = await SELF.fetch(
    'https://worker.test/v1/sync/bootstrap?limit=1&deviceId=device-b'
  );
  expect(unauthenticated.status).toBe(401);

  const wrongMethod = await SELF.fetch(
    'https://worker.test/v1/sync/bootstrap?limit=1&deviceId=device-b',
    { method: 'POST', headers: authHeaders() }
  );
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get('Allow')).toBe('GET, OPTIONS');

  const allowedOrigin = 'chrome-extension://allowed-extension';
  const preflight = await SELF.fetch(
    'https://worker.test/v1/sync/bootstrap',
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

  const success = await bootstrap(
    'limit=10&deviceId=device-b',
    { ...authHeaders(), Origin: allowedOrigin }
  );
  expect(success.response.status).toBe(200);
  expect(success.response.headers.get('Access-Control-Allow-Origin')).toBe(
    allowedOrigin
  );
  expect(success.body.comments.map(({ comment }) => comment.id)).toEqual([
    'own:1'
  ]);
  expect(success.body.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect(JSON.stringify(success.body)).not.toMatch(
    /other-vault-secret|authorization|password|cookie/iu
  );
});
