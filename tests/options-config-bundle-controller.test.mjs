import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOptionsConfigBundleController
} from '../lib/options-config-bundle-controller.mjs';
import {
  createDefaultDomainConfig
} from '../lib/domain-config-schema.mjs';

function domainConfig({ profileCount = 1 } = {}) {
  const config = createDefaultDomainConfig({
    auto_fill_user_name: 'Alice',
    auto_fill_user_email: 'alice@example.test',
    promotion_website_url: 'https://product.example/',
    promotion_website_content: 'Product description'
  }, { now: () => 10 });
  for (let index = 2; index <= profileCount; index += 1) {
    config.profiles.push({
      id: `profile-${index}`,
      displayName: `Profile ${index}`,
      name: `Author ${index}`,
      email: `author-${index}@example.test`,
      createdAt: 10,
      updatedAt: 10
    });
    config.promotionSites.push({
      id: `site-${index}`,
      name: `Site ${index}`,
      url: `https://site-${index}.example/`,
      content: `Content ${index}`,
      enabled: true,
      createdAt: 10,
      updatedAt: 10
    });
    config.assignmentPolicy.pairs.push({
      id: `pair-${index}`,
      profileId: `profile-${index}`,
      promotionSiteId: `site-${index}`,
      weight: 1,
      enabled: true
    });
  }
  return config;
}

function settings(overrides = {}) {
  return {
    llm: {
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen-plus'
    },
    batchDefaults: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 2,
      timeoutSeconds: 60
    },
    preferences: { showExportOutlinksFloatingButton: false },
    ...overrides
  };
}

function bundleFixture() {
  return {
    format: 'autocomment-config-bundle',
    version: 3,
    exportedAt: 100,
    data: {
      domainConfig: domainConfig({ profileCount: 3 }),
      llm: {
        apiBaseUrl: 'https://api.example/v1',
        model: 'model-b'
      },
      batchDefaults: {
        autoOpenPanel: true,
        autoGenerate: true,
        autoSubmit: false,
        concurrency: 3,
        timeoutSeconds: 120
      },
      preferences: { showExportOutlinksFloatingButton: true }
    }
  };
}

function createHarness({ failSettingsSave = false, failRollback = false } = {}) {
  let currentDomain = domainConfig();
  let currentSettings = settings();
  let domainWrites = 0;
  let settingsWrites = 0;
  const domainControllerCalls = [];
  const configRepository = {
    async load() { return structuredClone(currentDomain); },
    async replace(next) {
      domainWrites += 1;
      if (failRollback && domainWrites === 2) throw new Error('rollback failed');
      currentDomain = structuredClone({ ...next, revision: currentDomain.revision + 1 });
      return structuredClone(currentDomain);
    }
  };
  const settingsAdapter = {
    async load() { return structuredClone(currentSettings); },
    async save(next) {
      settingsWrites += 1;
      if (failSettingsSave) throw new Error('settings failed');
      currentSettings = structuredClone(next);
    }
  };
  const domainController = {
    async previewImport(input) {
      domainControllerCalls.push(['preview', input]);
      return {
        creates: [{ entityType: 'legacy', id: 'legacy-id' }],
        updates: [],
        conflicts: []
      };
    },
    async applyImport(preview) {
      domainControllerCalls.push(['apply', preview]);
      return { applied: true };
    }
  };
  return {
    controller: createOptionsConfigBundleController({
      configRepository,
      domainController,
      settingsAdapter,
      now: () => 500
    }),
    configRepository,
    settingsAdapter,
    domainControllerCalls,
    writeCounts: () => ({ domainWrites, settingsWrites })
  };
}

function stripRevision(config) {
  const copy = structuredClone(config);
  delete copy.revision;
  return copy;
}

test('exports domain and public settings as one v3 bundle', async () => {
  const harness = createHarness();
  const exported = await harness.controller.exportConfig();

  assert.equal(exported.format, 'autocomment-config-bundle');
  assert.equal(exported.version, 3);
  assert.equal(exported.data.domainConfig.profiles.length, 1);
  assert.equal(exported.data.batchDefaults.autoSubmit, false);
  assert.doesNotMatch(JSON.stringify(exported), /local-api-key|profile-password/);
});

test('previews v3 changes without writing either repository', async () => {
  const harness = createHarness();
  const before = harness.writeCounts();
  const preview = await harness.controller.previewImport(bundleFixture());

  assert.deepEqual([...preview.settingChanges].sort(), [
    'batchDefaults',
    'llm',
    'preferences'
  ]);
  assert.deepEqual(harness.writeCounts(), before);
  assert.equal(Object.isFrozen(preview), true);
});

test('applies one v3 preview exactly once', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());
  await harness.controller.applyImport(preview);

  assert.equal((await harness.configRepository.load()).profiles.length, 3);
  assert.equal((await harness.settingsAdapter.load()).batchDefaults.concurrency, 3);
  await assert.rejects(
    harness.controller.applyImport(preview),
    (error) => error.code === 'stale_config_bundle_preview'
  );
});

test('restores domain content when public settings save fails', async () => {
  const harness = createHarness({ failSettingsSave: true });
  const before = await harness.configRepository.load();
  const preview = await harness.controller.previewImport(bundleFixture());

  await assert.rejects(
    harness.controller.applyImport(preview),
    (error) => error.code === 'config_bundle_apply_failed'
  );
  assert.deepEqual(
    stripRevision(await harness.configRepository.load()),
    stripRevision(before)
  );
});

test('reports a dedicated error when rollback cannot restore the domain', async () => {
  const harness = createHarness({ failSettingsSave: true, failRollback: true });
  const preview = await harness.controller.previewImport(bundleFixture());

  await assert.rejects(
    harness.controller.applyImport(preview),
    (error) => error.code === 'config_bundle_rollback_failed'
  );
});

test('delegates non-v3 import and apply without saving public settings', async () => {
  const harness = createHarness();
  const input = { auto_fill_user_name: 'Legacy Alice' };
  const preview = await harness.controller.previewImport(input);
  const result = await harness.controller.applyImport(preview);

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(harness.domainControllerCalls, [
    ['preview', input],
    ['apply', {
      creates: [{ entityType: 'legacy', id: 'legacy-id' }],
      updates: [],
      conflicts: []
    }]
  ]);
  assert.equal(harness.writeCounts().settingsWrites, 0);
});
