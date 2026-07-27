import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOptionsConfigBundleController
} from '../lib/options-config-bundle-controller.mjs';
import {
  createDefaultDomainConfig
} from '../lib/domain-config-schema.mjs';
import {
  buildDomainConfigExport
} from '../lib/domain-config-import-export.mjs';

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

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function createHarness({
  failSettingsSave = false,
  failRollback = false,
  deferSettingsSave = false
} = {}) {
  let currentDomain = domainConfig();
  let currentSettings = settings();
  let domainWrites = 0;
  let settingsWrites = 0;
  const domainControllerCalls = [];
  const settingsStarted = deferred();
  const settingsRelease = deferred();
  const configRepository = {
    async load() { return structuredClone(currentDomain); },
    async replace(next) {
      domainWrites += 1;
      if (failRollback && domainWrites === 2) throw new Error('rollback failed');
      currentDomain = structuredClone({ ...next, revision: currentDomain.revision + 1 });
      return structuredClone(currentDomain);
    },
    async replaceIfRevision(expectedRevision, next) {
      if (currentDomain.revision !== expectedRevision) {
        const error = new Error('stale_domain_config_revision');
        error.code = 'stale_domain_config_revision';
        throw error;
      }
      return this.replace(next);
    }
  };
  const settingsAdapter = {
    async load() { return structuredClone(currentSettings); },
    async save(next) {
      settingsWrites += 1;
      settingsStarted.resolve();
      if (deferSettingsSave) await settingsRelease.promise;
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
    settingsSaveStarted: settingsStarted.promise,
    releaseSettingsSave: settingsRelease.resolve,
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

test('rejects a preview when the domain revision changed before apply', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());
  const concurrent = await harness.configRepository.load();
  concurrent.profiles[0].name = 'Concurrent Alice';
  await harness.configRepository.replace(concurrent);

  await assert.rejects(
    harness.controller.applyImport(preview),
    (error) => error.code === 'stale_config_bundle_preview'
  );
  assert.equal(
    (await harness.configRepository.load()).profiles[0].name,
    'Concurrent Alice'
  );
  assert.equal(harness.writeCounts().settingsWrites, 0);
});

test('does not roll back over a domain edit made while settings save is pending', async () => {
  const harness = createHarness({
    failSettingsSave: true,
    deferSettingsSave: true
  });
  const preview = await harness.controller.previewImport(bundleFixture());
  const applying = harness.controller.applyImport(preview);
  await harness.settingsSaveStarted;
  const concurrent = await harness.configRepository.load();
  concurrent.profiles[0].name = 'Concurrent Alice';
  await harness.configRepository.replace(concurrent);
  harness.releaseSettingsSave();

  await assert.rejects(
    applying,
    (error) => error.code === 'config_bundle_rollback_failed'
  );
  const current = await harness.configRepository.load();
  assert.equal(current.profiles[0].name, 'Concurrent Alice');
  assert.equal(current.profiles.length, 3);
});

test('rejects a forged preview object without consuming the real capability', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());
  const forged = structuredClone(preview);

  await assert.rejects(
    harness.controller.applyImport(forged),
    (error) => error.code === 'stale_config_bundle_preview'
  );
  await harness.controller.applyImport(preview);
  assert.equal((await harness.configRepository.load()).profiles.length, 3);
});

test('does not exchange preview capabilities between controller instances', async () => {
  const first = createHarness();
  const second = createHarness();
  const firstPreview = await first.controller.previewImport(bundleFixture());
  const secondPreview = await second.controller.previewImport(bundleFixture());

  await assert.rejects(
    first.controller.applyImport(secondPreview),
    (error) => error.code === 'stale_config_bundle_preview'
  );
  await first.controller.applyImport(firstPreview);
  await second.controller.applyImport(secondPreview);
});

test('a new preview invalidates the prior preview capability', async () => {
  const harness = createHarness();
  const oldPreview = await harness.controller.previewImport(bundleFixture());
  const currentPreview = await harness.controller.previewImport(bundleFixture());

  await assert.rejects(
    harness.controller.applyImport(oldPreview),
    (error) => error.code === 'stale_config_bundle_preview'
  );
  await harness.controller.applyImport(currentPreview);
  assert.equal(harness.writeCounts().settingsWrites, 1);
});

test('concurrent apply attempts consume one preview capability only once', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());

  const results = await Promise.allSettled([
    harness.controller.applyImport(preview),
    harness.controller.applyImport(preview)
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.deepEqual(
    results.filter(({ status }) => status === 'rejected')
      .map(({ reason }) => reason.code),
    ['stale_config_bundle_preview']
  );
  assert.deepEqual(harness.writeCounts(), { domainWrites: 1, settingsWrites: 1 });
});

test('deeply freezes the summary and ignores attempted nested mutation on apply', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());

  assert.equal(Object.isFrozen(preview.creates), true);
  assert.equal(Object.isFrozen(preview.creates[0]), true);
  assert.equal(Object.isFrozen(preview.settingChanges), true);
  assert.throws(() => { preview.creates[0].id = 'forged-profile'; }, TypeError);
  assert.throws(() => { preview.settingChanges.push('forged-setting'); }, TypeError);

  await harness.controller.applyImport(preview);
  assert.deepEqual(
    (await harness.configRepository.load()).profiles.map(({ id }) => id),
    ['default-profile', 'profile-2', 'profile-3']
  );
});

test('delegates a real v2 domain wrapper without saving public settings', async () => {
  const harness = createHarness();
  const input = buildDomainConfigExport(domainConfig({ profileCount: 2 }), {
    exportedAt: 100
  });
  const preview = await harness.controller.previewImport(input);
  const result = await harness.controller.applyImport(preview);

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(harness.domainControllerCalls[0], ['preview', input]);
  assert.equal(harness.domainControllerCalls[1][0], 'apply');
  assert.equal(harness.writeCounts().settingsWrites, 0);
});

test('delegates a complete legacy config without saving public settings', async () => {
  const harness = createHarness();
  const input = {
    auto_fill_user_name: 'Legacy Alice',
    auto_fill_user_email: 'legacy-alice@example.test',
    promotion_website_url: 'https://legacy-product.example/',
    promotion_website_content: 'Legacy product description'
  };
  const preview = await harness.controller.previewImport(input);
  const result = await harness.controller.applyImport(preview);

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(harness.domainControllerCalls[0], ['preview', input]);
  assert.equal(harness.domainControllerCalls[1][0], 'apply');
  assert.equal(harness.writeCounts().settingsWrites, 0);
});
