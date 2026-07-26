import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultBatchAssignment } from '../lib/batch-profile-contract.mjs';

test('creates stable default identity and promotion-site snapshots', () => {
  assert.deepEqual(createDefaultBatchAssignment({
    userName: ' CloudHu ',
    userEmail: ' you@test.com ',
    websiteUrl: ' https://promo.test/ ',
    websiteContent: ' A useful promotion site. '
  }), {
    identityId: 'default-identity',
    promotionSiteId: 'default-promotion-site',
    identitySnapshot: {
      displayName: 'CloudHu',
      email: 'you@test.com'
    },
    promotionSiteSnapshot: {
      label: 'promo.test',
      url: 'https://promo.test/',
      contentSummary: 'A useful promotion site.'
    }
  });
});
