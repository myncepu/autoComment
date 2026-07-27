function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidSyncKey();
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  if (paddingLength === 3) throw invalidSyncKey();
  try {
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength)
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) throw invalidSyncKey();
    return bytes;
  } catch (error) {
    if (error?.code === 'INVALID_SYNC_KEY') throw error;
    throw invalidSyncKey();
  }
}

function invalidSyncKey() {
  const error = new Error('INVALID_SYNC_KEY');
  error.code = 'INVALID_SYNC_KEY';
  return error;
}

export function createSyncCredentials({
  getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
} = {}) {
  const vaultBytes = getRandomValues(new Uint8Array(16));
  const secretBytes = getRandomValues(new Uint8Array(32));
  const vaultId = bytesToBase64Url(vaultBytes);
  const secret = bytesToBase64Url(secretBytes);
  return { vaultId, secret, syncKey: `acsync_${vaultId}.${secret}` };
}

export function parseSyncKey(value) {
  if (typeof value !== 'string' || /\s/u.test(value) || !value.startsWith('acsync_')) {
    throw invalidSyncKey();
  }
  const parts = value.slice('acsync_'.length).split('.');
  if (parts.length !== 2) throw invalidSyncKey();
  const [vaultId, secret] = parts;
  if (base64UrlToBytes(vaultId).byteLength !== 16 || base64UrlToBytes(secret).byteLength !== 32) {
    throw invalidSyncKey();
  }
  return { vaultId, secret };
}

export async function hashSyncSecret(secret, subtle = globalThis.crypto.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
