import {
  CLOUD_SYNC_SETTING_KEYS,
  normalizeSyncMutation,
  pickCloudSyncSettings
} from './cloud-sync-protocol.mjs';

const USER_PASSWORD_STORAGE_KEY = 'auto_fill_user_password';
const PASSWORD_MIGRATION_VERSION_KEY = 'cloudSyncPasswordMigrationVersion';
const REMOTE_ECHO_TTL_MS = 5_000;

function serializeValue(value) {
  return JSON.stringify(value);
}

function echoEntry(areaName, key, value) {
  return `${areaName}\u0000${key}\u0000${serializeValue(value)}`;
}

function markRemoteEcho(echoGuard, entry) {
  if (!echoGuard) return;
  if (typeof echoGuard.mark === 'function') {
    echoGuard.mark(entry);
  } else {
    echoGuard.add(entry);
  }
}

function clearRemoteEcho(echoGuard, entry) {
  if (!echoGuard) return;
  if (typeof echoGuard.clear === 'function') {
    echoGuard.clear(entry);
  } else {
    echoGuard.delete(entry);
  }
}

function consumeRemoteEcho(echoGuard, entry) {
  if (!echoGuard) return false;
  if (typeof echoGuard.consume === 'function') return echoGuard.consume(entry);
  if (!echoGuard.has(entry)) return false;
  echoGuard.delete(entry);
  return true;
}

function createRemoteEchoGuard() {
  const entries = new Set();
  return {
    mark(entry) {
      entries.add(entry);
      setTimeout(() => entries.delete(entry), REMOTE_ECHO_TTL_MS);
    },
    clear(entry) {
      entries.delete(entry);
    },
    consume(entry) {
      if (!entries.has(entry)) return false;
      entries.delete(entry);
      return true;
    }
  };
}

export async function migratePasswordToLocal(storage) {
  const [syncValues, localValues] = await Promise.all([
    storage.sync.get([USER_PASSWORD_STORAGE_KEY]),
    storage.local.get([USER_PASSWORD_STORAGE_KEY, PASSWORD_MIGRATION_VERSION_KEY])
  ]);

  if (localValues[PASSWORD_MIGRATION_VERSION_KEY] === 1) {
    return { status: 'already_migrated' };
  }

  const password = localValues[USER_PASSWORD_STORAGE_KEY]
    ?? syncValues[USER_PASSWORD_STORAGE_KEY];
  if (password !== undefined) {
    await storage.local.set({ [USER_PASSWORD_STORAGE_KEY]: password });
  }
  await storage.sync.remove(USER_PASSWORD_STORAGE_KEY);
  await storage.local.set({ [PASSWORD_MIGRATION_VERSION_KEY]: 1 });
  return { status: 'migrated' };
}

export async function loadSyncableSettings(storage) {
  return pickCloudSyncSettings(await storage.sync.get(CLOUD_SYNC_SETTING_KEYS));
}

export async function saveRemoteSettings(storage, values, echoGuard) {
  const syncValues = pickCloudSyncSettings(values);
  const entries = Object.entries(syncValues)
    .map(([key, value]) => echoEntry('sync', key, value));
  entries.forEach((entry) => markRemoteEcho(echoGuard, entry));
  try {
    if (entries.length > 0) await storage.sync.set(syncValues);
  } catch (error) {
    entries.forEach((entry) => clearRemoteEcho(echoGuard, entry));
    throw error;
  }
}

export function createStorageChangeMutations(changes, areaName, {
  now = Date.now,
  createMutationId = () => crypto.randomUUID(),
  echoGuard
} = {}) {
  if (!changes || typeof changes !== 'object') return [];

  return Object.entries(changes).flatMap(([key, change]) => {
    const value = change?.newValue;
    if (!CLOUD_SYNC_SETTING_KEYS.includes(key) || value === undefined) return [];
    if (consumeRemoteEcho(echoGuard, echoEntry(areaName, key, value))) return [];
    try {
      return [normalizeSyncMutation({
        mutationId: createMutationId(),
        entityType: 'setting',
        entityId: key,
        operation: 'upsert',
        payload: { value },
        createdAt: now()
      })];
    } catch {
      return [];
    }
  });
}

export function buildExportableSettings(syncValues, localValues) {
  void localValues;
  return pickCloudSyncSettings(syncValues);
}

export function splitImportedSettings(values = {}) {
  const localValues = {};
  if (Object.hasOwn(values, USER_PASSWORD_STORAGE_KEY)) {
    localValues[USER_PASSWORD_STORAGE_KEY] = values[USER_PASSWORD_STORAGE_KEY];
  }
  return {
    syncValues: pickCloudSyncSettings(values),
    localValues
  };
}

export function createCloudSyncSettings(storage) {
  const echoGuard = createRemoteEchoGuard();
  return {
    load: () => loadSyncableSettings(storage),
    saveRemote: (values) => saveRemoteSettings(storage, values, echoGuard),
    createMutations: (changes, areaName, options) => createStorageChangeMutations(
      changes,
      areaName,
      { ...options, echoGuard }
    )
  };
}
