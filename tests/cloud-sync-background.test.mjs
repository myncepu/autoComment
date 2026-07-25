import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_SYNC_ALARM_NAME,
  createCloudRetentionService,
  createCloudSyncRuntime,
  createLazyCloudSyncRepository,
  installCloudSyncBackground
} from '../lib/cloud-sync-background.mjs';
import { CLOUD_SYNC_API_BASE_URL } from '../lib/cloud-sync-config.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createChromeFixture() {
  const createdAlarms = [];
  const alarmListeners = [];
  const storageListeners = [];
  return {
    createdAlarms,
    alarmListeners,
    storageListeners,
    chromeApi: {
      alarms: {
        create(name, info) {
          createdAlarms.push({ name, info });
        },
        onAlarm: {
          addListener(listener) {
            alarmListeners.push(listener);
          }
        }
      },
      storage: {
        onChanged: {
          addListener(listener) {
            storageListeners.push(listener);
          }
        }
      }
    },
    async triggerAlarm(name) {
      alarmListeners.forEach((listener) => listener({ name }));
      await new Promise((resolve) => setImmediate(resolve));
    },
    async triggerStorage(changes, areaName) {
      storageListeners.forEach((listener) => listener(changes, areaName));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function createSyncService(overrides = {}) {
  const runReasons = [];
  const settingChanges = [];
  const domainChanges = [];
  let initialUploads = 0;
  return {
    runReasons,
    settingChanges,
    domainChanges,
    get initialUploads() {
      return initialUploads;
    },
    async runOnce(reason) {
      runReasons.push(reason);
      return { reason };
    },
    async enqueueInitialHistory() {
      initialUploads += 1;
      return { done: true };
    },
    async enqueueSettingChanges(changes, areaName) {
      settingChanges.push({ changes, areaName });
      return { queued: Object.keys(changes).length };
    },
    async enqueueDomainConfigChanges(change, areaName) {
      domainChanges.push({ change, areaName });
      return { queued: 1 };
    },
    ...overrides
  };
}

test('installs one five-minute alarm and runs guarded startup work', async () => {
  const fixture = createChromeFixture();
  const service = createSyncService();
  const migrations = [];

  await installCloudSyncBackground(fixture.chromeApi, service, {
    async migratePassword() {
      migrations.push('password');
      return { status: 'migrated' };
    },
    async migrateDomainConfig() {
      migrations.push('domain');
      return { status: 'migrated' };
    }
  });

  assert.deepEqual(fixture.createdAlarms, [{
    name: CLOUD_SYNC_ALARM_NAME,
    info: { periodInMinutes: 5 }
  }]);
  assert.deepEqual(migrations, ['password', 'domain']);
  assert.equal(service.initialUploads, 1);
  assert.deepEqual(service.runReasons, ['startup']);
  assert.equal(fixture.alarmListeners.length, 1);
  assert.equal(fixture.storageListeners.length, 1);
});

test('installation is idempotent and matching alarms run exactly once', async () => {
  const fixture = createChromeFixture();
  const service = createSyncService();

  const first = installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  const second = installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  assert.strictEqual(second, first);
  await first;

  await fixture.triggerAlarm('other-alarm');
  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);

  assert.equal(fixture.createdAlarms.length, 1);
  assert.equal(fixture.alarmListeners.length, 1);
  assert.equal(fixture.storageListeners.length, 1);
  assert.equal(service.initialUploads, 2);
  assert.deepEqual(service.runReasons, ['startup', 'alarm']);
});

test('each matching alarm advances one initial-history page before sync', async () => {
  const fixture = createChromeFixture();
  const sequence = [];
  const service = createSyncService({
    async enqueueInitialHistory() {
      sequence.push('initial');
      return { scanned: 50, queued: 50, done: false };
    },
    async runOnce(reason) {
      sequence.push(`run:${reason}`);
      return { reason };
    }
  });
  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  sequence.length = 0;

  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);

  assert.deepEqual(sequence, ['initial', 'run:alarm']);
});

test('queues local domain config changes without treating them as sync settings', async () => {
  const fixture = createChromeFixture();
  const service = createSyncService();
  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  service.runReasons.length = 0;

  const change = {
    oldValue: { version: 2, revision: 1 },
    newValue: { version: 2, revision: 2 }
  };
  await fixture.triggerStorage({
    autoCommentDomainConfig: change
  }, 'local');

  assert.deepEqual(service.domainChanges, [{
    change,
    areaName: 'local'
  }]);
  assert.deepEqual(service.settingChanges, []);
  assert.deepEqual(service.runReasons, ['domain_config_change']);
});

test('more than 100 initial records finish through three bounded alarm pages', async () => {
  const fixture = createChromeFixture();
  let enabled = false;
  let remaining = 120;
  const pages = [];
  const service = createSyncService({
    async enqueueInitialHistory() {
      if (!enabled) {
        pages.push({ skipped: 'disabled', scanned: 0, done: false });
        return pages.at(-1);
      }
      const scanned = Math.min(50, remaining);
      remaining -= scanned;
      pages.push({ scanned, done: remaining === 0 });
      return pages.at(-1);
    }
  });
  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  enabled = true;

  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);
  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);
  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);

  assert.deepEqual(pages, [
    { skipped: 'disabled', scanned: 0, done: false },
    { scanned: 50, done: false },
    { scanned: 50, done: false },
    { scanned: 20, done: true }
  ]);
  assert.equal(remaining, 0);
  assert.deepEqual(service.runReasons, [
    'startup',
    'alarm',
    'alarm',
    'alarm'
  ]);
});

test('startup and alarm rejections are caught without blocking later work', async () => {
  const fixture = createChromeFixture();
  const warnings = [];
  const service = createSyncService({
    async enqueueInitialHistory() {
      throw new Error('initial upload secret diagnostic');
    },
    async runOnce(reason) {
      if (reason === 'startup') throw new Error('startup secret diagnostic');
      throw new Error('alarm secret diagnostic');
    }
  });

  await installCloudSyncBackground(fixture.chromeApi, service, {
    async migratePassword() {
      throw new Error('password secret diagnostic');
    },
    warn(message) {
      warnings.push(message);
    }
  });
  await fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);

  assert.deepEqual(warnings, [
    '[background] Password migration deferred',
    '[background] Initial cloud history upload deferred',
    '[background] Cloud sync startup deferred',
    '[background] Initial cloud history upload deferred',
    '[background] Cloud sync alarm deferred'
  ]);
  assert.equal(
    warnings.some((message) => message.includes('secret diagnostic')),
    false
  );
});

test('storage listener forwards only allowlisted sync changes and runs after queueing', async () => {
  const fixture = createChromeFixture();
  const sequence = [];
  const service = createSyncService({
    async enqueueSettingChanges(changes, areaName) {
      sequence.push(['enqueue', changes, areaName]);
      return { queued: Object.keys(changes).length };
    },
    async runOnce(reason) {
      sequence.push(['run', reason]);
      return { reason };
    }
  });
  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });
  sequence.length = 0;

  await fixture.triggerStorage({
    promotion_website_url: { oldValue: '', newValue: 'https://promo.test' },
    batch_concurrency: { oldValue: 2, newValue: 3 },
    auto_fill_user_password: { newValue: 'must-not-forward' },
    llm_api_key: { newValue: 'sk-must-not-forward' }
  }, 'sync');
  await fixture.triggerStorage({
    promotion_website_url: { newValue: 'https://local-ignored.test' },
    cloud_sync_secret: { newValue: 'must-not-forward' },
    auto_fill_user_password: { newValue: 'must-not-forward' }
  }, 'local');

  assert.deepEqual(sequence, [
    ['enqueue', {
      batch_concurrency: {
        oldValue: 2,
        newValue: 3
      }
    }, 'sync'],
    ['run', 'setting_change']
  ]);
});

test('a pending comment queue operation is not awaited by background scheduling', async () => {
  const fixture = createChromeFixture();
  const pendingRun = deferred();
  const service = createSyncService({
    async runOnce(reason) {
      if (reason === 'startup') return { reason };
      return pendingRun.promise;
    }
  });
  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });

  const alarmTrigger = fixture.triggerAlarm(CLOUD_SYNC_ALARM_NAME);
  await alarmTrigger;
  assert.equal(fixture.alarmListeners.length, 1);
  pendingRun.resolve({ reason: 'alarm' });
});

test('lazy repository facade exposes and delegates every history and cloud sync API', async () => {
  const calls = [];
  const methodNames = [
    'upsertRecord',
    'upsertIfFresher',
    'enqueueSyncMutation',
    'listDueSyncMutations',
    'markSyncMutationAttempt',
    'completeSyncMutations',
    'getSyncMeta',
    'setSyncMeta',
    'initializeBootstrapSentinel',
    'clearSyncMetaIfEqual',
    'scanRecordsForInitialSync',
    'applyRemoteChangesAtomic',
    'applyBootstrapPageAtomic',
    'clearPendingInboundSettings',
    'applyCloudHistoryDeletion',
    'evictSyncedCacheBefore',
    'insertLegacyIfAbsent',
    'getRecord',
    'queryRecords',
    'countRecords',
    'getRetentionSummary',
    'getExportChunk',
    'deleteConfirmed',
    'deleteExportSessionAtomic',
    'listArchiveEvents',
    'getMeta',
    'setMeta',
    'close'
  ];
  const repository = Object.fromEntries(methodNames.map((method) => [
    method,
    (...args) => {
      calls.push([method, args]);
      return `${method}:result`;
    }
  ]));
  let loads = 0;
  const facade = createLazyCloudSyncRepository(async () => {
    loads += 1;
    return repository;
  });

  assert.deepEqual(Object.keys(facade).sort(), [...methodNames].sort());
  for (const method of methodNames) {
    assert.equal(await facade[method]('arg-a', { value: 2 }), `${method}:result`);
  }
  assert.equal(loads, 1);
  assert.deepEqual(calls, methodNames.map((method) => [
    method,
    ['arg-a', { value: 2 }]
  ]));
});

test('retention wiring delegates cloud status and guarded cache eviction without a delete API', async () => {
  const calls = [];
  const service = createCloudRetentionService({
    commentHistoryService: {
      async getRetentionStatus(value) {
        calls.push(['local-status', value]);
        return 'local-status';
      }
    },
    cloudSyncService: {
      async getStatus(value) {
        calls.push(['cloud-status', value]);
        return 'cloud-status';
      }
    },
    repository: {
      async evictSyncedCacheBefore(value) {
        calls.push(['evict', value]);
        return 3;
      },
      async getMeta(value) {
        calls.push(['get-meta', value]);
        return 'meta';
      },
      async setMeta(...value) {
        calls.push(['set-meta', ...value]);
        return 'saved';
      }
    }
  });

  assert.equal(await service.getRetentionStatus('local'), 'local-status');
  assert.equal(await service.getCloudSyncStatus('cloud'), 'cloud-status');
  assert.equal(await service.evictSyncedCacheBefore({ cutoff: 10 }), 3);
  assert.equal(await service.getMeta('key'), 'meta');
  assert.equal(await service.setMeta('key', 'value'), 'saved');
  assert.equal(Object.hasOwn(service, 'deleteConfirmed'), false);
  assert.deepEqual(calls, [
    ['local-status', 'local'],
    ['cloud-status', 'cloud'],
    ['evict', { cutoff: 10 }],
    ['get-meta', 'key'],
    ['set-meta', 'key', 'value']
  ]);
});

test('runtime wiring creates transports only with the shipped fixed origin', () => {
  const transportCalls = [];
  const repository = {};
  const storage = {
    local: {
      cloud_sync_endpoint: 'https://attacker.test',
      async get() {
        return { cloud_sync_endpoint: 'https://attacker.test' };
      }
    },
    sync: {}
  };
  let capturedServiceOptions;
  const domainConfigRepository = {};

  const service = createCloudSyncRuntime({
    repository,
    domainConfigRepository,
    storage,
    fetchImpl: async () => {
      throw new Error('not called');
    },
    createService(options) {
      capturedServiceOptions = options;
      return { kind: 'service' };
    },
    createTransport(options) {
      transportCalls.push(options);
      return { kind: 'transport' };
    }
  });
  const transport = capturedServiceOptions.transportFactory({
    syncKey: 'acsync_only-explicit-credential-fields',
    endpoint: 'https://message-attacker.test'
  });

  assert.deepEqual(service, { kind: 'service' });
  assert.strictEqual(capturedServiceOptions.repository, repository);
  assert.strictEqual(
    capturedServiceOptions.domainConfigRepository,
    domainConfigRepository
  );
  assert.strictEqual(capturedServiceOptions.storageLocal, storage.local);
  assert.equal(typeof capturedServiceOptions.settings.load, 'function');
  assert.deepEqual(transport, { kind: 'transport' });
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].baseUrl, CLOUD_SYNC_API_BASE_URL);
  assert.equal(
    JSON.stringify(transportCalls[0]).includes('attacker.test'),
    false
  );
  assert.equal(
    transportCalls[0].syncKey,
    'acsync_only-explicit-credential-fields'
  );
});

test('installs startup and alarms when a focused Chrome fixture omits storage events', async () => {
  const fixture = createChromeFixture();
  delete fixture.chromeApi.storage;
  const service = createSyncService();

  await installCloudSyncBackground(fixture.chromeApi, service, {
    migratePassword: async () => undefined
  });

  assert.equal(fixture.alarmListeners.length, 1);
  assert.equal(service.initialUploads, 1);
  assert.deepEqual(service.runReasons, ['startup']);
});
