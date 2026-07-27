import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfigBundle,
  isConfigBundle,
  parseConfigBundle
} from '../lib/config-bundle.mjs';

function domainConfigFixture() {
  return {
    version: 2,
    revision: 0,
    profiles: [],
    promotionSites: [],
    assignmentPolicy: {
      defaultPairId: null,
      pairs: [],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
}

function bundleFixture() {
  return {
    format: 'autocomment-config-bundle',
    version: 3,
    exportedAt: 100,
    data: {
      domainConfig: domainConfigFixture(),
      llm: {
        apiBaseUrl: ' https://openrouter.ai/api/v1/ ',
        model: ' qwen/qwen-plus '
      },
      batchDefaults: {
        autoOpenPanel: true,
        autoGenerate: true,
        autoSubmit: false,
        concurrency: 3,
        timeoutSeconds: 120
      },
      preferences: {
        showExportOutlinksFloatingButton: true
      }
    }
  };
}

function portableFixture() {
  return structuredClone(bundleFixture().data);
}

function addPromotionSite(data, url) {
  data.domainConfig.promotionSites.push({
    id: 'promotion-site-a',
    name: 'Promotion site A',
    url,
    content: 'Public promotion content',
    enabled: true,
    createdAt: 100,
    updatedAt: 100
  });
}

function assertCode(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

test('parses one exact v3 portable bundle and freezes a clone', () => {
  const input = bundleFixture();
  const parsed = parseConfigBundle(input);

  assert.equal(parsed.llm.apiBaseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(parsed.batchDefaults, {
    autoOpenPanel: true,
    autoGenerate: true,
    autoSubmit: false,
    concurrency: 3,
    timeoutSeconds: 120
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parsed.domainConfig, input.data.domainConfig);
});

test('identifies only the supported bundle format', () => {
  assert.equal(isConfigBundle(bundleFixture()), true);
  assert.equal(isConfigBundle({ format: 'autocomment-domain-config' }), false);
  assert.equal(isConfigBundle(null), false);
});

test('rejects malformed bundle wrappers and unsupported versions', () => {
  assertCode(() => parseConfigBundle({}), 'invalid_config_bundle_format');
  assertCode(() => parseConfigBundle({ ...bundleFixture(), extra: true }),
    'invalid_config_bundle_format');
  assertCode(() => parseConfigBundle({ ...bundleFixture(), version: 2 }),
    'unsupported_config_bundle_version');
  assertCode(() => parseConfigBundle({ ...bundleFixture(), exportedAt: -1 }),
    'invalid_config_bundle_format');
  assertCode(() => buildConfigBundle(portableFixture(), { exportedAt: -1 }),
    'invalid_config_bundle_format');
});

test('rejects sensitive names recursively before accepting portable data', () => {
  for (const [key, value] of [
    ['apiKey', 'secret-value'],
    ['password', 'secret-value'],
    ['cloud_sync_secret', 'secret-value'],
    ['authorization', 'secret-value'],
    ['token', 'secret-value'],
    ['credential', 'secret-value']
  ]) {
    const input = bundleFixture();
    input.data.llm[key] = value;
    assertCode(() => parseConfigBundle(input), 'sensitive_config_bundle_field');
  }
});

test('rejects unknown data keys at every portable schema level', () => {
  for (const mutate of [
    (input) => { input.data.extra = true; },
    (input) => { input.data.llm.extra = true; },
    (input) => { input.data.batchDefaults.extra = true; },
    (input) => { input.data.preferences.extra = true; }
  ]) {
    const input = bundleFixture();
    mutate(input);
    assertCode(() => parseConfigBundle(input), 'invalid_config_bundle_format');
  }
});

test('rejects invalid public LLM settings', () => {
  for (const mutate of [
    (input) => { input.data.llm.apiBaseUrl = 'file:///private/api'; },
    (input) => { input.data.llm.model = ' '; }
  ]) {
    const input = bundleFixture();
    mutate(input);
    assertCode(() => parseConfigBundle(input), 'invalid_config_bundle_llm');
  }
});

test('parse rejects API URLs with query or hash credentials without echoing them', () => {
  const secret = 'sk-query-hash-secret';
  for (const apiBaseUrl of [
    `https://provider.example/v1?api_key=${secret}`,
    `https://provider.example/v1#token=${secret}`
  ]) {
    const input = bundleFixture();
    input.data.llm.apiBaseUrl = apiBaseUrl;
    assert.throws(() => parseConfigBundle(input), (error) => (
      error?.code === 'invalid_config_bundle_llm'
        && !error.message.includes(secret)
    ));
  }
});

test('build rejects API URLs with query or hash credentials without echoing them', () => {
  const secret = 'sk-query-hash-secret';
  for (const apiBaseUrl of [
    `https://provider.example/v1?api_key=${secret}`,
    `https://provider.example/v1#token=${secret}`
  ]) {
    const data = portableFixture();
    data.llm.apiBaseUrl = apiBaseUrl;
    assert.throws(() => buildConfigBundle(data), (error) => (
      error?.code === 'invalid_config_bundle_llm'
        && !error.message.includes(secret)
    ));
  }
});

test('parse rejects promotion URLs with query or hash credentials without echoing them', () => {
  const secret = 'sk-promotion-secret';
  for (const promotionUrl of [
    `https://promo.example/landing?api_key=${secret}`,
    `https://promo.example/landing#access_token=${secret}`
  ]) {
    const input = bundleFixture();
    addPromotionSite(input.data, promotionUrl);
    assert.throws(() => parseConfigBundle(input), (error) => (
      error?.code === 'sensitive_config_bundle_url'
        && !error.message.includes(secret)
    ));
  }
});

test('build rejects promotion URLs with query or hash credentials without echoing them', () => {
  const secret = 'sk-promotion-secret';
  for (const promotionUrl of [
    `https://promo.example/landing?client_secret=${secret}`,
    `https://promo.example/landing#password=${secret}`
  ]) {
    const data = portableFixture();
    addPromotionSite(data, promotionUrl);
    assert.throws(() => buildConfigBundle(data), (error) => (
      error?.code === 'sensitive_config_bundle_url'
        && !error.message.includes(secret)
    ));
  }
});

test('promotion URLs retain safe ordinary query parameters and fragments', () => {
  const input = bundleFixture();
  addPromotionSite(
    input.data,
    'https://promo.example/landing?utm_source=autocomment&campaign=summer#comments'
  );

  const parsed = parseConfigBundle(input);
  assert.equal(
    parsed.domainConfig.promotionSites[0].url,
    'https://promo.example/landing?utm_source=autocomment&campaign=summer#comments'
  );
});

test('rejects invalid batch defaults', () => {
  for (const mutate of [
    (input) => { input.data.batchDefaults.concurrency = 0; },
    (input) => { input.data.batchDefaults.concurrency = 11; },
    (input) => { input.data.batchDefaults.timeoutSeconds = 9; },
    (input) => { input.data.batchDefaults.timeoutSeconds = 601; },
    (input) => {
      input.data.batchDefaults.autoSubmit = true;
      input.data.batchDefaults.autoGenerate = false;
    }
  ]) {
    const input = bundleFixture();
    mutate(input);
    assertCode(() => parseConfigBundle(input), 'invalid_config_bundle_batch_defaults');
  }
});

test('rejects invalid preferences', () => {
  const input = bundleFixture();
  input.data.preferences.showExportOutlinksFloatingButton = 'yes';
  assertCode(() => parseConfigBundle(input), 'invalid_config_bundle_preferences');
});

test('build output contains no sensitive or runtime state key', () => {
  const output = buildConfigBundle(portableFixture(), { exportedAt: 100 });
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(
    serialized,
    /api[_-]?key|password|secret|token|authorization|credential|checkpoint|history|batchDraft|submitContext/i
  );
  assert.equal(Object.isFrozen(output), true);
});
