import { env } from 'cloudflare:workers';

export const VALID_VAULT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const VALID_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_SECRET_HASH =
  '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';

export const VALID_SYNC_KEY = `acsync_${VALID_VAULT_ID}.${VALID_SECRET}`;

export function authHeaders(syncKey = VALID_SYNC_KEY): Record<string, string> {
  return {
    Authorization: `Bearer ${syncKey}`,
    'Content-Type': 'application/json'
  };
}

export async function seedVault(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_vaults (vault_id, secret_hash, created_at, deleted_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(vault_id) DO NOTHING`
  )
    .bind(VALID_VAULT_ID, VALID_SECRET_HASH, 1_000)
    .run();
}
