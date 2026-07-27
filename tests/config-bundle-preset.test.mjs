import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseConfigBundle } from '../lib/config-bundle.mjs';

const PRESET_URL = new URL(
  '../examples/autocomment-local-dry-run-config.json',
  import.meta.url
);

function allKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    allKeys(child, output);
  }
  return output;
}

test('local dry-run preset parses as a safe deterministic 3×3 assignment bundle', async () => {
  const raw = await readFile(PRESET_URL, 'utf8');
  const bundle = JSON.parse(raw);
  const parsed = parseConfigBundle(bundle);

  assert.equal(bundle.format, 'autocomment-config-bundle');
  assert.equal(bundle.version, 3);
  assert.equal(bundle.exportedAt, 1785110400000);

  const { domainConfig, batchDefaults } = parsed;
  assert.deepEqual(
    domainConfig.profiles.map(({ id }) => id),
    ['test-profile-a', 'test-profile-b', 'test-profile-c']
  );
  assert.deepEqual(
    domainConfig.promotionSites.map(({ id }) => id),
    ['test-site-a', 'test-site-b', 'test-site-c']
  );
  assert.deepEqual(
    domainConfig.promotionSites.map(({ url }) => url),
    [
      'http://127.0.0.1:4173/promotion/a',
      'http://127.0.0.1:4173/promotion/b',
      'http://127.0.0.1:4173/promotion/c'
    ]
  );
  assert.deepEqual(
    domainConfig.assignmentPolicy.pairs.map(({
      id,
      profileId,
      promotionSiteId,
      weight
    }) => ({ id, profileId, promotionSiteId, weight })),
    [
      {
        id: 'test-pair-a',
        profileId: 'test-profile-a',
        promotionSiteId: 'test-site-a',
        weight: 1
      },
      {
        id: 'test-pair-b',
        profileId: 'test-profile-b',
        promotionSiteId: 'test-site-b',
        weight: 1
      },
      {
        id: 'test-pair-c',
        profileId: 'test-profile-c',
        promotionSiteId: 'test-site-c',
        weight: 1
      }
    ]
  );
  assert.equal(domainConfig.assignmentPolicy.defaultPairId, 'test-pair-a');
  assert.equal(
    domainConfig.profiles.every((profile) => (
      profile.createdAt === 1785110400000
      && profile.updatedAt === 1785110400000
    )),
    true
  );
  assert.equal(
    domainConfig.promotionSites.every((site) => (
      site.createdAt === 1785110400000
      && site.updatedAt === 1785110400000
      && site.enabled
    )),
    true
  );
  assert.equal(
    domainConfig.assignmentPolicy.pairs.every(({ enabled }) => enabled),
    true
  );
  assert.equal(domainConfig.assignmentPolicy.quotas.batch, 80);
  assert.equal(domainConfig.assignmentPolicy.quotas.perProfile, 30);
  assert.equal(domainConfig.assignmentPolicy.quotas.perPromotionSite, 30);
  assert.equal(domainConfig.assignmentPolicy.quotas.perTargetDomain, 1);
  assert.deepEqual(parsed.llm, {
    apiBaseUrl: 'http://127.0.0.1:4173/v1',
    model: 'local-dry-run-model'
  });
  assert.deepEqual(batchDefaults, {
    autoOpenPanel: true,
    autoGenerate: true,
    autoSubmit: false,
    concurrency: 3,
    timeoutSeconds: 120
  });

  for (const key of allKeys(bundle)) {
    assert.doesNotMatch(
      key,
      /api[_-]?key|password|secret|token|authorization|credential/i
    );
  }
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /api[_-]?key|password|secret|token|authorization|credential|history|draft|checkpoint|handle|results?|submitContext/i
  );
});
