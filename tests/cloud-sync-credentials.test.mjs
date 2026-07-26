import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncCredentials,
  hashSyncSecret,
  parseSyncKey
} from '../lib/cloud-sync-credentials.mjs';

test('creates and parses the documented sync-key format', () => {
  const getRandomValues = (bytes) => bytes.fill(0);
  const credentials = createSyncCredentials({ getRandomValues });
  assert.equal(
    credentials.syncKey,
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  );
  assert.deepEqual(parseSyncKey(credentials.syncKey), {
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });
});

test('hashes the secret without returning the cleartext', async () => {
  assert.equal(
    await hashSyncSecret('secret', crypto.subtle),
    '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b'
  );
});

test('rejects malformed sync keys and decoded byte lengths', () => {
  for (const value of [
    ' acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ',
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.extra',
    'wrong_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'acsync_aaaaaaaaaaaaaaaaaaaaa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  ]) {
    assert.throws(() => parseSyncKey(value), /INVALID_SYNC_KEY/);
  }
});
