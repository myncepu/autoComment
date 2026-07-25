import {
  CLOUD_SYNC_COMMENT_ASSIGNMENT_CAPABILITY,
  CLOUD_SYNC_DOMAIN_CAPABILITY,
  CLOUD_SYNC_PROTOCOL_VERSION
} from '../../lib/cloud-sync-protocol.mjs';
import {
  ACTIVE_VAULT_WRITE_SOURCE,
  executeActiveVaultWrite,
  hashSyncSecret,
  parseBearerSyncKey,
  requireVault,
  secretHashesEqual
} from './auth';
import { fail, json } from './http';
import {
  boundedQueryString,
  boundedString,
  protocolVersionFromQuery,
  readBoundedJson,
  rejectUnknownQuery,
  requireJsonObject
} from './validation';

const MAX_VAULT_BODY_BYTES = 4_096;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_VAULT_ID_LENGTH = 128;

export async function touchActiveVaultDevice(
  env: Env,
  vaultId: string,
  deviceId: string,
  now: number
): Promise<void> {
  await executeActiveVaultWrite(
    env.DB.prepare(
      `INSERT INTO sync_devices
       (vault_id, device_id, display_name, created_at, last_seen_at,
          last_successful_sync_at, last_cursor)
       SELECT active_vault.vault_id, ?, NULL, ?, ?, NULL, 0
       ${ACTIVE_VAULT_WRITE_SOURCE}
       ON CONFLICT(vault_id, device_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at`
    ).bind(deviceId, now, now, vaultId)
  );
}

async function highWatermark(env: Env, vaultId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(server_seq), 0) AS high_watermark
     FROM sync_changes
     WHERE vault_id = ?`
  )
    .bind(vaultId)
    .first<{ high_watermark: number }>();
  return row?.high_watermark ?? 0;
}

export async function putVault(
  request: Request,
  env: Env,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const credentials = parseBearerSyncKey(
    request.headers.get('Authorization')
  );
  const body = requireJsonObject(
    await readBoundedJson(request, MAX_VAULT_BODY_BYTES),
    ['deviceId']
  );
  const deviceId = boundedString(
    body.deviceId,
    1,
    MAX_DEVICE_ID_LENGTH,
    'INVALID_DEVICE_ID'
  );
  const secretHash = await hashSyncSecret(credentials.secret);
  const now = Date.now();

  const insertion = await env.DB.prepare(
    `INSERT INTO sync_vaults (vault_id, secret_hash, created_at, deleted_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(vault_id) DO NOTHING`
  )
    .bind(credentials.vaultId, secretHash, now)
    .run();

  const vault = await env.DB.prepare(
    `SELECT secret_hash, deleted_at
     FROM sync_vaults
     WHERE vault_id = ?`
  )
    .bind(credentials.vaultId)
    .first<{ secret_hash: string; deleted_at: number | null }>();
  if (
    !vault ||
    !secretHashesEqual(vault.secret_hash, secretHash)
  ) {
    fail('INVALID_SYNC_KEY', 403);
  }
  if (vault.deleted_at !== null) fail('VAULT_DELETED', 403);

  await touchActiveVaultDevice(env, credentials.vaultId, deviceId, now);
  return json(
    {
      ok: true,
      vaultId: credentials.vaultId,
      requestId
    },
    { status: insertion.meta.changes === 1 ? 201 : 200 }
  );
}

export async function getStatus(
  request: Request,
  env: Env,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const vault = await requireVault(request, env);
  const url = new URL(request.url);
  rejectUnknownQuery(url, ['deviceId', 'protocolVersion']);
  protocolVersionFromQuery(url);
  const deviceId = boundedQueryString(
    url,
    'deviceId',
    1,
    MAX_DEVICE_ID_LENGTH,
    'INVALID_DEVICE_ID'
  );
  const now = Date.now();
  await touchActiveVaultDevice(env, vault.vaultId, deviceId, now);

  return json({
    ok: true,
    vaultId: vault.vaultId,
    serverTime: now,
    highWatermark: await highWatermark(env, vault.vaultId),
    protocolVersion: CLOUD_SYNC_PROTOCOL_VERSION,
    capabilities: [
      CLOUD_SYNC_DOMAIN_CAPABILITY,
      CLOUD_SYNC_COMMENT_ASSIGNMENT_CAPABILITY
    ],
    requestId
  });
}

export async function deleteVault(
  request: Request,
  env: Env,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const vault = await requireVault(request, env);
  const body = requireJsonObject(
    await readBoundedJson(request, MAX_VAULT_BODY_BYTES),
    ['confirmation']
  );
  const confirmation = boundedString(
    body.confirmation,
    1,
    MAX_VAULT_ID_LENGTH
  );
  if (confirmation !== vault.vaultId) {
    fail('VAULT_CONFIRMATION_MISMATCH', 400);
  }

  const deletedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM comment_anchors WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM comment_records WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM synced_settings WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM comment_tombstones WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_assignment_policy WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_assignment_pairs WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_promotion_sites WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_profiles WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM domain_entity_tombstones WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_devices WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_changes WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'DELETE FROM sync_mutations WHERE vault_id = ?'
    ).bind(vault.vaultId),
    env.DB.prepare(
      'UPDATE sync_vaults SET deleted_at = ? WHERE vault_id = ?'
    ).bind(deletedAt, vault.vaultId)
  ]);

  return json({
    ok: true,
    vaultId: vault.vaultId,
    deleted: true,
    requestId
  });
}
