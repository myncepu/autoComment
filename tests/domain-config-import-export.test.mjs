import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultDomainConfig } from '../lib/domain-config-schema.mjs';
import {
  applyDomainConfigImport,
  buildDomainConfigExport,
  previewDomainConfigImport
} from '../lib/domain-config-import-export.mjs';

function legacyValues(overrides = {}) {
  return {
    auto_fill_user_name: 'Alice',
    auto_fill_user_email: 'alice@example.test',
    promotion_website_url: 'https://product-a.example',
    promotion_website_content: 'Product A summary',
    ...overrides
  };
}

function currentConfig() {
  return createDefaultDomainConfig(legacyValues(), { now: () => 10 });
}

function importedConfig() {
  const config = createDefaultDomainConfig({
    ...legacyValues(),
    auto_fill_user_name: 'Imported Alice',
    promotion_website_content: 'Updated product summary'
  }, { now: () => 20 });
  config.revision = 15;
  config.profiles.push({
    id: 'profile-b',
    displayName: 'Profile B',
    name: 'Bob',
    email: 'bob@example.test',
    createdAt: 20,
    updatedAt: 20
  });
  config.promotionSites.push({
    id: 'site-b',
    name: 'Site B',
    url: 'https://product-b.example',
    content: 'Product B summary',
    enabled: true,
    createdAt: 20,
    updatedAt: 20
  });
  config.assignmentPolicy.pairs.push({
    id: 'pair-b',
    profileId: 'profile-b',
    promotionSiteId: 'site-b',
    weight: 2,
    enabled: true
  });
  return config;
}

function repositories({ configured = true, replaceError } = {}) {
  const calls = [];
  let savedConfig;
  let savedPassword = 'original-local-password';
  return {
    calls,
    get savedConfig() {
      return savedConfig;
    },
    get savedPassword() {
      return savedPassword;
    },
    configRepository: {
      async replace(config) {
        calls.push(['config.replace', structuredClone(config)]);
        if (replaceError) throw new Error(replaceError);
        savedConfig = structuredClone(config);
        savedConfig.revision += 1;
        return structuredClone(savedConfig);
      }
    },
    secretRepository: {
      async setPassword(profileId, password) {
        calls.push(['secret.set', profileId]);
        savedPassword = password;
      },
      async getConfiguredStates(profileIds) {
        calls.push(['secret.states', [...profileIds]]);
        return Object.fromEntries(profileIds.map((id) => [id, configured]));
      },
      async getPasswordForBackground() {
        return savedPassword;
      }
    }
  };
}

test('exports only a cloned non-sensitive domain document', () => {
  const source = currentConfig();
  const exported = buildDomainConfigExport(source, { exportedAt: 100 });
  const json = JSON.stringify(exported);

  assert.deepEqual(exported, {
    format: 'autocomment-domain-config',
    version: 2,
    exportedAt: 100,
    data: source
  });
  assert.doesNotMatch(json, /password|apiKey|cookie|token|checkpoint|submitContext|urlQueue/i);
  source.profiles[0].name = 'Caller mutation';
  assert.equal(exported.data.profiles[0].name, 'Alice');
});

test('blocks malformed or sensitive values before export without exposing them', () => {
  const malformed = currentConfig();
  malformed.checkpoint = { token: 'DO_NOT_ECHO' };

  assert.throws(() => buildDomainConfigExport(malformed), (error) => (
    error.code === 'sensitive_field_forbidden'
      && !error.message.includes('DO_NOT_ECHO')
  ));
});

test('previews stable-ID updates and creations with the current revision', () => {
  const input = buildDomainConfigExport(importedConfig(), { exportedAt: 100 });
  const preview = previewDomainConfigImport(currentConfig(), input);

  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.creates, [
    { entityType: 'profile', id: 'profile-b' },
    { entityType: 'promotion_site', id: 'site-b' },
    { entityType: 'assignment_pair', id: 'pair-b' }
  ]);
  assert.deepEqual(preview.updates, [
    { entityType: 'profile', id: 'default-profile' },
    { entityType: 'promotion_site', id: 'default-promotion-site' },
    { entityType: 'assignment_pair', id: 'default-assignment-pair' }
  ]);
  assert.equal(preview.mergedConfig.revision, 0);
  assert.equal(preview.mergedConfig.profiles[0].name, 'Imported Alice');
  assert.equal(preview.mergedConfig.profiles[1].name, 'Bob');
  assert.equal(preview.localSecretImport, null);
});

test('new-format import preserves local passwords and never calls the secret setter', async () => {
  const preview = previewDomainConfigImport(
    currentConfig(),
    buildDomainConfigExport(importedConfig(), { exportedAt: 100 })
  );
  const harness = repositories();

  await applyDomainConfigImport(preview, harness);

  assert.equal(await harness.secretRepository.getPasswordForBackground('default-profile'),
    'original-local-password');
  assert.deepEqual(harness.calls.map(([name]) => name), ['config.replace']);
});

test('reports blocking conflicts for duplicate names, dangling pairs, and invalid URLs', () => {
  const cases = [
    ['duplicate_profile_display_name', (config) => {
      config.profiles[1].displayName = config.profiles[0].displayName;
    }],
    ['invalid_assignment_pair', (config) => {
      config.assignmentPolicy.pairs[1].profileId = 'missing';
    }],
    ['invalid_promotion_site_url', (config) => {
      config.promotionSites[1].url = 'file:///private/path';
    }]
  ];

  for (const [code, mutate] of cases) {
    const imported = importedConfig();
    mutate(imported);
    const preview = previewDomainConfigImport(currentConfig(), {
      format: 'autocomment-domain-config',
      version: 2,
      exportedAt: 100,
      data: imported
    });
    assert.deepEqual(preview.conflicts, [{ code }]);
    assert.equal(preview.mergedConfig, null);
  }
});

test('blocks secrets and unknown fields in new-format data', () => {
  const imported = importedConfig();
  imported.profiles[0].hasPassword = true;
  const preview = previewDomainConfigImport(currentConfig(), {
    format: 'autocomment-domain-config',
    version: 2,
    exportedAt: 100,
    data: imported
  });

  assert.deepEqual(preview.conflicts, [{ code: 'sensitive_field_forbidden' }]);
  assert.equal(preview.mergedConfig, null);
});

test('accepts a wrapped legacy password only through the default Profile secret path', async () => {
  const preview = previewDomainConfigImport(createDefaultDomainConfig(), {
    _version: 2,
    _exportTime: '2025-01-01T00:00:00.000Z',
    data: legacyValues({
      auto_fill_user_password: ' legacy password ',
      llm_api_key: undefined
    })
  });

  assert.deepEqual(preview.localSecretImport, {
    profileId: 'default-profile',
    password: ' legacy password '
  });
  assert.equal(Object.hasOwn(preview.mergedConfig.profiles[0], 'password'), false);

  const harness = repositories();
  await applyDomainConfigImport(preview, harness);
  assert.equal(harness.savedPassword, ' legacy password ');
  assert.deepEqual(harness.calls.map(([name]) => name), [
    'secret.set',
    'secret.states',
    'config.replace'
  ]);
});

test('blocks non-legacy secrets even when a legacy password field is present', () => {
  const preview = previewDomainConfigImport(createDefaultDomainConfig(), {
    data: legacyValues({
      auto_fill_user_password: 'allowed-path',
      apiKey: 'DO_NOT_ECHO'
    })
  });

  assert.deepEqual(preview.conflicts, [{ code: 'sensitive_field_forbidden' }]);
  assert.equal(JSON.stringify(preview).includes('DO_NOT_ECHO'), false);
});

test('verifies legacy secret configuration before writing merged config', async () => {
  const preview = previewDomainConfigImport(createDefaultDomainConfig(), {
    data: legacyValues({ auto_fill_user_password: 'runtime-secret' })
  });
  const harness = repositories({ configured: false });

  await assert.rejects(() => applyDomainConfigImport(preview, harness),
    (error) => error.code === 'legacy_password_verification_failed'
      && !error.message.includes('runtime-secret'));
  assert.equal(harness.savedConfig, undefined);
});

test('refuses to apply a preview with conflicts or caller-tampered config', async () => {
  const invalidPreview = previewDomainConfigImport(currentConfig(), {
    format: 'wrong-format',
    version: 2,
    exportedAt: 100,
    data: importedConfig()
  });
  const harness = repositories();
  await assert.rejects(() => applyDomainConfigImport(invalidPreview, harness),
    (error) => error.code === 'invalid_import_format');

  const validPreview = previewDomainConfigImport(
    currentConfig(),
    buildDomainConfigExport(importedConfig(), { exportedAt: 100 })
  );
  validPreview.mergedConfig.profiles[0].password = 'DO_NOT_ECHO';
  await assert.rejects(() => applyDomainConfigImport(validPreview, harness),
    (error) => error.code === 'sensitive_field_forbidden'
      && !error.message.includes('DO_NOT_ECHO'));
  assert.deepEqual(harness.calls, []);
});
