import { CLOUD_SYNC_API_BASE_URL } from './cloud-sync-config.mjs';
import { CLOUD_SYNC_SETTING_KEYS } from './cloud-sync-protocol.mjs';
import { createCloudSyncService } from './cloud-sync-service.mjs';
import { createCloudSyncSettings } from './cloud-sync-settings.mjs';
import { createCloudSyncTransport } from './cloud-sync-transport.mjs';
import { DOMAIN_CONFIG_KEY } from './domain-config-schema.mjs';

export const CLOUD_SYNC_ALARM_NAME = 'cloud-sync-check';

const installations = new WeakMap();
const allowedSettingKeys = new Set(CLOUD_SYNC_SETTING_KEYS);
const REPOSITORY_METHODS = Object.freeze([
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
  'listRecentSuccessfulTargetUrls',
  'countRecords',
  'getRetentionSummary',
  'getExportChunk',
  'deleteConfirmed',
  'deleteExportSessionAtomic',
  'listArchiveEvents',
  'getMeta',
  'setMeta',
  'close'
]);

function safeWarn(warn, message) {
  try {
    warn(message);
  } catch {
    // Diagnostics must never break background lifecycle work.
  }
}

function guardedRun(operation, warn, message) {
  return Promise.resolve()
    .then(operation)
    .catch(() => {
      safeWarn(warn, message);
      return undefined;
    });
}

function allowedSyncChanges(changes, areaName) {
  if (areaName !== 'sync' || !changes || typeof changes !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(changes).filter(([key]) => allowedSettingKeys.has(key))
  );
}

export function createLazyCloudSyncRepository(loadRepository) {
  let repositoryPromise;
  const getRepository = () => {
    repositoryPromise ??= Promise.resolve().then(loadRepository);
    return repositoryPromise;
  };
  return Object.fromEntries(REPOSITORY_METHODS.map((method) => [
    method,
    async (...args) => {
      const repository = await getRepository();
      return repository[method](...args);
    }
  ]));
}

export function createCloudSyncRuntime({
  repository,
  domainConfigRepository,
  storage,
  fetchImpl = globalThis.fetch,
  createService = createCloudSyncService,
  createTransport = createCloudSyncTransport
}) {
  return createService({
    repository,
    domainConfigRepository,
    storageLocal: storage.local,
    settings: createCloudSyncSettings(storage),
    transportFactory: ({ syncKey }) => createTransport({
      baseUrl: CLOUD_SYNC_API_BASE_URL,
      syncKey,
      fetchImpl
    })
  });
}

export function createCloudRetentionService({
  commentHistoryService,
  cloudSyncService,
  repository
}) {
  return Object.freeze({
    getRetentionStatus: (...args) => (
      commentHistoryService.getRetentionStatus(...args)
    ),
    getCloudSyncStatus: (...args) => cloudSyncService.getStatus(...args),
    evictSyncedCacheBefore: (...args) => (
      repository.evictSyncedCacheBefore(...args)
    ),
    getMeta: (...args) => repository.getMeta(...args),
    setMeta: (...args) => repository.setMeta(...args)
  });
}

export function installCloudSyncBackground(
  chromeApi,
  syncService,
  {
    migratePassword = async () => undefined,
    migrateDomainConfig = async () => undefined,
    warn = console.warn
  } = {}
) {
  const existing = installations.get(chromeApi);
  if (existing) return existing;

  chromeApi.alarms.create(CLOUD_SYNC_ALARM_NAME, {
    periodInMinutes: 5
  });
  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== CLOUD_SYNC_ALARM_NAME) return;
    void (async () => {
      if (typeof syncService.enqueueInitialHistory === 'function') {
        await guardedRun(
          () => syncService.enqueueInitialHistory(),
          warn,
          '[background] Initial cloud history upload deferred'
        );
      }
      await guardedRun(
        () => syncService.runOnce('alarm'),
        warn,
        '[background] Cloud sync alarm deferred'
      );
    })();
  });
  if (typeof chromeApi.storage?.onChanged?.addListener === 'function') {
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      const filtered = allowedSyncChanges(changes, areaName);
      if (Object.keys(filtered).length > 0) {
        void guardedRun(
          async () => {
            const result = await syncService.enqueueSettingChanges(
              filtered,
              areaName
            );
            if (result?.queued > 0) {
              await syncService.runOnce('setting_change');
            }
          },
          warn,
          '[background] Cloud setting sync deferred'
        );
      }
      if (
        areaName === 'local'
        && Object.hasOwn(changes || {}, DOMAIN_CONFIG_KEY)
        && typeof syncService.enqueueDomainConfigChanges === 'function'
      ) {
        void guardedRun(
          async () => {
            const result = await syncService.enqueueDomainConfigChanges(
              changes[DOMAIN_CONFIG_KEY],
              areaName
            );
            if (result?.queued > 0) {
              await syncService.runOnce('domain_config_change');
            }
          },
          warn,
          '[background] Cloud domain configuration sync deferred'
        );
      }
    });
  }

  const startup = (async () => {
    await guardedRun(
      migratePassword,
      warn,
      '[background] Password migration deferred'
    );
    await guardedRun(
      migrateDomainConfig,
      warn,
      '[background] Domain configuration migration deferred'
    );
    if (typeof syncService.enqueueInitialHistory === 'function') {
      await guardedRun(
        () => syncService.enqueueInitialHistory(),
        warn,
        '[background] Initial cloud history upload deferred'
      );
    }
    await guardedRun(
      () => syncService.runOnce('startup'),
      warn,
      '[background] Cloud sync startup deferred'
    );
  })();
  installations.set(chromeApi, startup);
  return startup;
}
