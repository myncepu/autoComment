import { fail } from './http';

const VAULT_ID_BYTES = 16;
const SECRET_BYTES = 32;
const SHA_256_BYTES = 32;

export const ACTIVE_VAULT_WRITE_SOURCE =
  `FROM sync_vaults AS active_vault
   WHERE active_vault.vault_id = ?
     AND active_vault.deleted_at IS NULL`;

export interface SyncCredentials {
  vaultId: string;
  secret: string;
}

export interface AuthenticatedVault {
  vaultId: string;
  secretHash: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail('INVALID_SYNC_KEY', 401);
  const paddingLength = (4 - (value.length % 4)) % 4;
  if (paddingLength === 3) fail('INVALID_SYNC_KEY', 401);

  try {
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') +
        '='.repeat(paddingLength)
    );
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );
    if (encodeBase64Url(bytes) !== value) fail('INVALID_SYNC_KEY', 401);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    fail('INVALID_SYNC_KEY', 401);
  }
}

export function parseBearerSyncKey(
  authorization: string | null
): SyncCredentials {
  if (!authorization?.startsWith('Bearer ')) {
    fail('INVALID_SYNC_KEY', 401);
  }
  const syncKey = authorization.slice('Bearer '.length);
  if (
    !syncKey.startsWith('acsync_') ||
    /\s/u.test(syncKey)
  ) {
    fail('INVALID_SYNC_KEY', 401);
  }

  const parts = syncKey.slice('acsync_'.length).split('.');
  if (parts.length !== 2) fail('INVALID_SYNC_KEY', 401);
  const vaultId = parts[0] ?? '';
  const secret = parts[1] ?? '';
  if (
    decodeBase64Url(vaultId).byteLength !== VAULT_ID_BYTES ||
    decodeBase64Url(secret).byteLength !== SECRET_BYTES
  ) {
    fail('INVALID_SYNC_KEY', 401);
  }
  return { vaultId, secret };
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

function hexToFixedHash(value: string): {
  bytes: Uint8Array;
  valid: boolean;
} {
  const bytes = new Uint8Array(SHA_256_BYTES);
  const valid = /^[0-9a-f]{64}$/u.test(value);
  if (valid) {
    for (let index = 0; index < SHA_256_BYTES; index += 1) {
      bytes[index] = Number.parseInt(
        value.slice(index * 2, index * 2 + 2),
        16
      );
    }
  }
  return { bytes, valid };
}

export async function hashSyncSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret)
  );
  return bytesToHex(new Uint8Array(digest));
}

export function secretHashesEqual(
  storedHash: string,
  candidateHash: string
): boolean {
  const stored = hexToFixedHash(storedHash);
  const candidate = hexToFixedHash(candidateHash);
  const equal = crypto.subtle.timingSafeEqual(
    stored.bytes,
    candidate.bytes
  );
  return stored.valid && candidate.valid && equal;
}

export async function executeActiveVaultWrite(
  statement: D1PreparedStatement
): Promise<D1Result> {
  const result = await statement.run();
  if (result.meta.changes === 0) fail('VAULT_DELETED', 403);
  return result;
}

export async function requireVault(
  request: Request,
  env: Env
): Promise<AuthenticatedVault> {
  const credentials = parseBearerSyncKey(
    request.headers.get('Authorization')
  );
  const secretHash = await hashSyncSecret(credentials.secret);
  const vault = await env.DB.prepare(
    `SELECT secret_hash, deleted_at
     FROM sync_vaults
     WHERE vault_id = ?`
  )
    .bind(credentials.vaultId)
    .first<{ secret_hash: string; deleted_at: number | null }>();

  if (!vault) fail('INVALID_SYNC_KEY', 401);
  if (!secretHashesEqual(vault.secret_hash, secretHash)) {
    fail('INVALID_SYNC_KEY', 403);
  }
  if (vault.deleted_at !== null) fail('VAULT_DELETED', 403);
  return { vaultId: credentials.vaultId, secretHash };
}
