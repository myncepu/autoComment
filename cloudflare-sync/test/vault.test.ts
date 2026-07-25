import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';

import {
  authHeaders,
  seedVault,
  VALID_SYNC_KEY,
  VALID_VAULT_ID
} from './fixtures';

const ALLOWED_ORIGIN = 'chrome-extension://allowed-extension';
const VALID_SECRET =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_SECRET_HASH =
  '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';
const WRONG_SECRET_KEY =
  `acsync_${VALID_VAULT_ID}.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE`;

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
});

function vaultRequest(
  method: 'PUT' | 'DELETE',
  body: Record<string, string>,
  syncKey = VALID_SYNC_KEY
): Promise<Response> {
  return SELF.fetch('https://worker.test/v1/vault', {
    method,
    headers: {
      ...authHeaders(syncKey),
      Origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify(body)
  });
}

async function tableCount(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function seedVaultContents(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_devices
         (vault_id, device_id, display_name, created_at, last_seen_at,
          last_successful_sync_at, last_cursor)
       VALUES (?, 'device-delete', NULL, 1, 2, NULL, 0)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO comment_records
         (vault_id, record_id, batch_id, url_index, submitted_at, archive_month,
          target_page_url, target_domain, promoted_website_url, promoted_domain,
          comment_html, comment_text, submit_status, source, created_at, updated_at,
          revision_source_rank, revision_captured_at, revision_recorded_at,
          revision_sequence, revision_id, accepted_mutation_id, cloud_created_at,
          cloud_updated_at)
       VALUES
         (?, 'record-delete', 'batch-delete', 0, 1, '2026-07',
          'https://target.test/post', 'target.test', 'https://promoted.test',
          'promoted.test', '<p>body</p>', 'body', 'success', 'live', 1, 1,
          1, 1, 1, 1, 'revision-delete', 'mutation-comment', 1, 1)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO comment_anchors
         (vault_id, anchor_id, comment_id, position, anchor_text,
          anchor_text_normalized, href_raw, href_resolved, href_domain)
       VALUES
         (?, 'anchor-delete', 'record-delete', 0, 'Anchor', 'anchor',
          'https://anchor.test', 'https://anchor.test/', 'anchor.test')`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO synced_settings
         (vault_id, setting_key, value_json, accepted_mutation_id,
          server_updated_at, server_seq)
       VALUES (?, 'batch_concurrency', '2', 'mutation-setting', 1, NULL)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO comment_tombstones
         (vault_id, record_id, mutation_id, deleted_at, server_seq)
       VALUES (?, 'record-tombstone', 'mutation-delete', 1, NULL)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO sync_changes
         (vault_id, mutation_id, entity_type, entity_id, operation, created_at)
       VALUES (?, 'mutation-change', 'setting', 'batch_concurrency', 'upsert', 1)`
    ).bind(VALID_VAULT_ID),
    env.DB.prepare(
      `INSERT INTO sync_mutations
         (vault_id, mutation_id, entity_type, entity_id, result_status,
          server_seq, processed_at)
       VALUES (?, 'mutation-receipt', 'setting', 'batch_concurrency',
         'applied', NULL, 1)`
    ).bind(VALID_VAULT_ID)
  ]);
}

test('creates a vault through the real Worker and stores only the secret hash', async () => {
  const response = await vaultRequest('PUT', { deviceId: 'device-a' });

  expect(response.status).toBe(201);
  expect(response.headers.get('Content-Type')).toBe(
    'application/json; charset=utf-8'
  );
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Vary')).toContain('Origin');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
    ALLOWED_ORIGIN
  );
  expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
  expect(await response.json()).toMatchObject({
    ok: true,
    vaultId: VALID_VAULT_ID,
    requestId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
  });

  const vault = await env.DB.prepare(
    `SELECT vault_id, secret_hash
     FROM sync_vaults
     WHERE vault_id = ?`
  )
    .bind(VALID_VAULT_ID)
    .first<{ vault_id: string; secret_hash: string }>();
  expect(vault).toEqual({
    vault_id: VALID_VAULT_ID,
    secret_hash: VALID_SECRET_HASH
  });
  expect(vault?.secret_hash).not.toContain(VALID_SECRET);

  const device = await env.DB.prepare(
    `SELECT device_id
     FROM sync_devices
     WHERE vault_id = ?`
  )
    .bind(VALID_VAULT_ID)
    .first<{ device_id: string }>();
  expect(device?.device_id).toBe('device-a');
});

test('makes same-key creation idempotent and rejects a different secret', async () => {
  expect((await vaultRequest('PUT', { deviceId: 'device-a' })).status).toBe(201);
  expect((await vaultRequest('PUT', { deviceId: 'device-b' })).status).toBe(200);

  expect(await tableCount('sync_vaults')).toBe(1);
  expect(await tableCount('sync_devices')).toBe(2);

  const wrong = await SELF.fetch(
    'https://worker.test/v1/status?deviceId=device-c',
    { headers: authHeaders(WRONG_SECRET_KEY) }
  );
  expect(wrong.status).toBe(403);
  expect(await wrong.json()).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_SYNC_KEY',
      retryable: false
    }
  });
});

test('rejects missing, malformed, and non-canonical bearer credentials', async () => {
  const missing = await SELF.fetch('https://worker.test/v1/status');
  expect(missing.status).toBe(401);

  for (const authorization of [
    'Bearer malformed',
    `bearer ${VALID_SYNC_KEY}`,
    `Bearer  ${VALID_SYNC_KEY}`,
    `Bearer ${VALID_SYNC_KEY},extra`,
    `Basic ${VALID_SYNC_KEY}`,
    `Bearer acsync_${VALID_VAULT_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`
  ]) {
    const response = await SELF.fetch('https://worker.test/v1/status', {
      headers: { Authorization: authorization }
    });
    expect(response.status, authorization).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(authorization);
  }
});

test('allows only an exact configured extension origin', async () => {
  for (const origin of [
    'https://untrusted.example',
    `${ALLOWED_ORIGIN}.evil`,
    'null'
  ]) {
    const response = await SELF.fetch('https://worker.test/v1/vault', {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        Origin: origin
      },
      body: JSON.stringify({ deviceId: 'device-origin' })
    });
    expect(response.status, origin).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  }

  const preflight = await SELF.fetch('https://worker.test/v1/vault', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://untrusted.example',
      'Access-Control-Request-Method': 'PUT'
    }
  });
  expect(preflight.status).toBe(403);
  expect(await tableCount('sync_vaults')).toBe(0);
});

test('answers a valid preflight without credentials or cookies', async () => {
  const response = await SELF.fetch('https://worker.test/v1/vault', {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization, content-type'
    }
  });

  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
  expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
    'Authorization, Content-Type'
  );
  expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
  expect(await response.text()).toBe('');
});

test('returns safe JSON for method and input failures', async () => {
  const method = await SELF.fetch('https://worker.test/v1/vault', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      Origin: ALLOWED_ORIGIN
    },
    body: '{}'
  });
  expect(method.status).toBe(405);
  expect(method.headers.get('Allow')).toBe('PUT, DELETE, OPTIONS');

  const secretMarker = 'body-secret-marker';
  const malformed = await SELF.fetch('https://worker.test/v1/vault', {
    method: 'PUT',
    headers: {
      ...authHeaders(),
      Origin: ALLOWED_ORIGIN
    },
    body: `{"deviceId":"${secretMarker}"`
  });
  expect(malformed.status).toBe(400);
  const errorText = await malformed.text();
  expect(errorText).not.toContain(secretMarker);
  expect(errorText).not.toContain(VALID_SYNC_KEY);
  expect(errorText).not.toMatch(/SELECT|INSERT|UPDATE|DELETE FROM/u);

  const overlongDevice = await vaultRequest('PUT', {
    deviceId: 'd'.repeat(129)
  });
  expect(overlongDevice.status).toBe(400);
});

test('status upserts a device last-seen timestamp and returns the vault watermark', async () => {
  await seedVault();
  await env.DB.prepare(
    `INSERT INTO sync_changes
       (vault_id, mutation_id, entity_type, entity_id, operation, created_at)
     VALUES (?, 'status-change', 'setting', 'batch_concurrency', 'upsert', 1)`
  )
    .bind(VALID_VAULT_ID)
    .run();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await SELF.fetch(
      'https://worker.test/v1/status?deviceId=device-status',
      { headers: authHeaders() }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      vaultId: VALID_VAULT_ID,
      highWatermark: 1,
      serverTime: expect.any(Number),
      requestId: expect.any(String)
    });
  }

  const device = await env.DB.prepare(
    `SELECT COUNT(*) AS count, MIN(created_at) AS created_at,
            MAX(last_seen_at) AS last_seen_at
     FROM sync_devices
     WHERE vault_id = ? AND device_id = ?`
  )
    .bind(VALID_VAULT_ID, 'device-status')
    .first<{ count: number; created_at: number; last_seen_at: number }>();
  expect(device?.count).toBe(1);
  expect(device?.created_at).toBeGreaterThan(0);
  expect(device?.last_seen_at).toBeGreaterThanOrEqual(device?.created_at ?? 0);
});

test('requires exact vault confirmation and permanently clears every vault table', async () => {
  await seedVault();
  await seedVaultContents();

  const mismatch = await vaultRequest('DELETE', {
    confirmation: 'BBBBBBBBBBBBBBBBBBBBBB'
  });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({
    ok: false,
    error: { code: 'VAULT_CONFIRMATION_MISMATCH', retryable: false }
  });
  expect(await tableCount('comment_records')).toBe(1);

  const deleted = await vaultRequest('DELETE', {
    confirmation: VALID_VAULT_ID
  });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({
    ok: true,
    vaultId: VALID_VAULT_ID,
    deleted: true
  });

  for (const table of [
    'comment_anchors',
    'comment_records',
    'synced_settings',
    'comment_tombstones',
    'sync_devices',
    'sync_changes',
    'sync_mutations'
  ]) {
    expect(await tableCount(table), table).toBe(0);
  }
  const vault = await env.DB.prepare(
    'SELECT deleted_at FROM sync_vaults WHERE vault_id = ?'
  )
    .bind(VALID_VAULT_ID)
    .first<{ deleted_at: number | null }>();
  expect(vault?.deleted_at).toBeGreaterThan(0);

  const afterDelete = await SELF.fetch(
    'https://worker.test/v1/status?deviceId=device-after-delete',
    { headers: authHeaders() }
  );
  expect(afterDelete.status).toBe(403);
  expect(await afterDelete.json()).toMatchObject({
    ok: false,
    error: { code: 'VAULT_DELETED', retryable: false }
  });
});
