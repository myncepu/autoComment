import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUD_SYNC_API_BASE_URL } from '../lib/cloud-sync-config.mjs';

test('ships one fixed HTTPS cloud sync origin', () => {
  const url = new URL(CLOUD_SYNC_API_BASE_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, CLOUD_SYNC_API_BASE_URL);
  assert.equal(url.pathname, '/');
  assert.notEqual(url.hostname, 'example.invalid');
});
