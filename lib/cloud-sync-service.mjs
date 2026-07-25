import {
  CLOUD_SYNC_LOCAL_KEYS,
  CLOUD_SYNC_SETTING_KEYS,
  normalizeCommentRevision,
  normalizeSyncMutation,
  pickCloudSyncSettings
} from './cloud-sync-protocol.mjs';
import {
  createSyncCredentials,
  hashSyncSecret,
  parseSyncKey
} from './cloud-sync-credentials.mjs';
import {
  classifySyncFailure,
  nextRetryAt
} from './cloud-sync-transport.mjs';

const PUSH_LIMIT = 100;
const PULL_LIMIT = 100;
const MAX_PULL_CHANGES_PER_RUN = 500;
const INITIAL_HISTORY_PAGE_SIZE = 50;
const CREDENTIAL_KEYS = Object.freeze(Object.values(CLOUD_SYNC_LOCAL_KEYS));

function serviceError(code, message = code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function syncKeyFor({ vaultId, secret }) {
  return `acsync_${vaultId}.${secret}`;
}

function createDeviceId() {
  return globalThis.crypto.randomUUID();
}

function createMutationId() {
  return globalThis.crypto.randomUUID();
}

function protocolMutation(mutation) {
  return normalizeSyncMutation({
    mutationId: mutation.mutationId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    operation: mutation.operation,
    payload: mutation.payload,
    createdAt: mutation.createdAt
  });
}

function outboxMutation(mutation, vaultId) {
  return {
    ...protocolMutation(mutation),
    vaultId,
    attemptCount: 0,
    nextAttemptAt: mutation.createdAt,
    lastErrorCode: null,
    state: 'pending'
  };
}

function safeError(error) {
  const classified = classifySyncFailure(error);
  return {
    code: classified.code,
    status: classified.status,
    retryable: classified.retryable
  };
}

function validatePullPage(page) {
  if (
    !page
    || !Array.isArray(page.changes)
    || !Number.isSafeInteger(page.nextCursor)
    || page.nextCursor < 0
    || typeof page.hasMore !== 'boolean'
  ) {
    throw serviceError(
      'INVALID_SYNC_RESPONSE',
      'Cloud sync returned an invalid response.',
      true
    );
  }
  return page;
}

function splitPullChanges(changes) {
  const settings = {};
  const entities = [];
  for (const change of changes) {
    if (change?.entityType === 'setting') {
      if (
        change.operation !== 'upsert'
        || !CLOUD_SYNC_SETTING_KEYS.includes(change.entityId)
      ) {
        throw serviceError(
          'INVALID_SYNC_RESPONSE',
          'Cloud sync returned an invalid response.',
          true
        );
      }
      settings[change.entityId] = structuredClone(change.value);
    } else {
      entities.push(change);
    }
  }
  return { settings, entities };
}

function validateBootstrapPage(page) {
  if (
    !page
    || !Array.isArray(page.comments)
    || !Array.isArray(page.settings)
    || !Array.isArray(page.tombstones)
    || typeof page.hasMore !== 'boolean'
    || !Number.isSafeInteger(page.serverCursor)
    || page.serverCursor < 0
    || (
      page.nextCursor !== null
      && typeof page.nextCursor !== 'string'
    )
    || (page.hasMore && !page.nextCursor)
  ) {
    throw serviceError(
      'INVALID_SYNC_RESPONSE',
      'Cloud sync returned an invalid response.',
      true
    );
  }
  return page;
}

function bootstrapSettings(entries) {
  const values = {};
  for (const entry of entries) {
    if (
      entry
      && CLOUD_SYNC_SETTING_KEYS.includes(entry.key)
      && Object.hasOwn(entry, 'value')
    ) {
      values[entry.key] = structuredClone(entry.value);
    }
  }
  return pickCloudSyncSettings(values);
}

function receiptEntityState(vaultId, mutation, receipt) {
  const revisionId = receipt.status === 'applied'
    && mutation.entityType === 'comment'
    ? normalizeCommentRevision(mutation.payload.comment).id
    : null;
  return {
    mutationId: mutation.mutationId,
    vaultId,
    entityKey: `${vaultId}:${mutation.entityType}:${mutation.entityId}`,
    revisionId,
    serverSeq: Number.isSafeInteger(receipt.serverSeq)
      ? receipt.serverSeq
      : null
  };
}

export function createCloudSyncService({
  repository,
  storageLocal,
  settings,
  transportFactory,
  now = Date.now,
  random = Math.random
}) {
  let inFlight = null;
  let activeCredentials = null;

  async function readCredentials({ requireEnabled = true } = {}) {
    const values = await storageLocal.get(CREDENTIAL_KEYS);
    if (requireEnabled && values[CLOUD_SYNC_LOCAL_KEYS.enabled] !== true) {
      activeCredentials = null;
      return null;
    }
    const vaultId = values[CLOUD_SYNC_LOCAL_KEYS.vaultId];
    const secret = values[CLOUD_SYNC_LOCAL_KEYS.secret];
    const deviceId = values[CLOUD_SYNC_LOCAL_KEYS.deviceId];
    if (
      typeof vaultId !== 'string'
      || typeof secret !== 'string'
      || typeof deviceId !== 'string'
      || !deviceId
    ) {
      activeCredentials = null;
      return null;
    }
    const syncKey = syncKeyFor({ vaultId, secret });
    try {
      parseSyncKey(syncKey);
    } catch {
      activeCredentials = null;
      return null;
    }
    activeCredentials = { vaultId, secret, deviceId, syncKey };
    return activeCredentials;
  }

  async function persistCredentials(credentials) {
    await storageLocal.set({
      [CLOUD_SYNC_LOCAL_KEYS.enabled]: true,
      [CLOUD_SYNC_LOCAL_KEYS.vaultId]: credentials.vaultId,
      [CLOUD_SYNC_LOCAL_KEYS.secret]: credentials.secret,
      [CLOUD_SYNC_LOCAL_KEYS.deviceId]: credentials.deviceId
    });
    activeCredentials = credentials;
  }

  async function enqueueCurrentSettings(credentials) {
    const current = pickCloudSyncSettings(await settings.load());
    let queued = 0;
    for (const [key, value] of Object.entries(current)) {
      const createdAt = now();
      const mutation = normalizeSyncMutation({
        mutationId: createMutationId(),
        entityType: 'setting',
        entityId: key,
        operation: 'upsert',
        payload: { value },
        createdAt
      });
      await repository.enqueueSyncMutation(
        outboxMutation(mutation, credentials.vaultId)
      );
      queued += 1;
    }
    return queued;
  }

  async function createVault() {
    const created = createSyncCredentials();
    const credentials = {
      ...created,
      deviceId: createDeviceId()
    };
    const transport = transportFactory(credentials);
    await transport.createVault(credentials.deviceId);
    await persistCredentials(credentials);
    await repository.setSyncMeta(
      `authBlocked:${credentials.vaultId}`,
      null
    );
    const queuedSettings = await enqueueCurrentSettings(credentials);
    return {
      syncKey: credentials.syncKey,
      vaultId: credentials.vaultId,
      deviceId: credentials.deviceId,
      queuedSettings
    };
  }

  async function bootstrapImportedVault(credentials, transport) {
    const stateKey = `bootstrapState:${credentials.vaultId}`;
    const savedState = await repository.getSyncMeta(stateKey);
    let cursor = savedState?.done ? null : (savedState?.cursor ?? null);
    let serverCursor = Number.isSafeInteger(savedState?.serverCursor)
      ? savedState.serverCursor
      : 0;
    let pages = 0;
    let imported = 0;

    if (!savedState?.done) {
      let hasMore;
      do {
        const page = validateBootstrapPage(await transport.bootstrap({
          deviceId: credentials.deviceId,
          limit: PULL_LIMIT,
          ...(cursor ? { cursor } : {})
        }));
        if (!cursor && page.settings.length > 0) {
          const remoteSettings = bootstrapSettings(page.settings);
          if (Object.keys(remoteSettings).length > 0) {
            await settings.saveRemote(remoteSettings);
          }
        }
        await repository.applyBootstrapPageAtomic({
          vaultId: credentials.vaultId,
          comments: page.comments,
          tombstones: page.tombstones,
          nextCursor: page.nextCursor,
          serverCursor: page.serverCursor,
          hasMore: page.hasMore
        });
        pages += 1;
        imported += page.comments.length + page.tombstones.length;
        cursor = page.nextCursor;
        serverCursor = page.serverCursor;
        hasMore = page.hasMore;
      } while (hasMore);
    }

    const sync = await pullBoundedPages(credentials, transport, 0);
    return { pages, imported, serverCursor, sync };
  }

  async function importKey(syncKey) {
    const parsed = parseSyncKey(syncKey);
    const credentials = {
      ...parsed,
      syncKey,
      deviceId: createDeviceId()
    };
    const transport = transportFactory(credentials);
    await transport.status(credentials.deviceId);
    await persistCredentials(credentials);
    await repository.setSyncMeta(
      `authBlocked:${credentials.vaultId}`,
      null
    );
    const bootstrap = await bootstrapImportedVault(credentials, transport);
    return {
      vaultId: credentials.vaultId,
      deviceId: credentials.deviceId,
      bootstrap
    };
  }

  async function applyPushResult(credentials, due, result) {
    const receipts = new Map(
      Array.isArray(result?.results)
        ? result.results.map((receipt) => [receipt?.mutationId, receipt])
        : []
    );
    const completed = [];
    for (const mutation of due) {
      const receipt = receipts.get(mutation.mutationId);
      if (
        receipt
        && ['applied', 'duplicate', 'stale'].includes(receipt.status)
      ) {
        completed.push(
          receiptEntityState(credentials.vaultId, mutation, receipt)
        );
        continue;
      }
      const errorCode = receipt?.status === 'rejected'
        ? (
            typeof receipt.errorCode === 'string'
              ? receipt.errorCode
              : 'MUTATION_REJECTED'
          )
        : 'INVALID_SYNC_RESPONSE';
      await repository.markSyncMutationAttempt({
        mutationId: mutation.mutationId,
        attemptCount: mutation.attemptCount + 1,
        nextAttemptAt: now(),
        lastErrorCode: errorCode,
        state: receipt?.status === 'rejected'
          ? 'needs_attention'
          : 'pending'
      });
    }
    if (completed.length > 0) {
      await repository.completeSyncMutations(completed);
    }
  }

  async function recordTransportFailure(credentials, due, error) {
    const classified = classifySyncFailure(error, now());
    const isAuthFailure = classified.status === 401 || classified.status === 403;
    const state = isAuthFailure
      ? 'blocked'
      : (classified.retryable ? 'pending' : 'needs_attention');
    for (const mutation of due) {
      const attemptCount = mutation.attemptCount + 1;
      await repository.markSyncMutationAttempt({
        mutationId: mutation.mutationId,
        attemptCount,
        nextAttemptAt: classified.retryable
          ? nextRetryAt({
              attemptCount: mutation.attemptCount,
              now: now(),
              retryAfter: classified.retryAfter,
              random
            })
          : now(),
        lastErrorCode: classified.code,
        state
      });
    }
    const publicError = safeError(classified);
    await repository.setSyncMeta(
      `lastSyncError:${credentials.vaultId}`,
      publicError
    );
    if (isAuthFailure) {
      await repository.setSyncMeta(
        `authBlocked:${credentials.vaultId}`,
        publicError
      );
    }
    return classified;
  }

  async function pullBoundedPages(credentials, transport, pushed) {
    let cursor = await repository.getSyncMeta(
      `serverCursor:${credentials.vaultId}`
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    let pulled = 0;
    let hasMore = false;
    do {
      const remaining = MAX_PULL_CHANGES_PER_RUN - pulled;
      if (remaining <= 0) break;
      let page;
      try {
        page = validatePullPage(await transport.pull({
          cursor,
          limit: Math.min(PULL_LIMIT, remaining),
          deviceId: credentials.deviceId
        }));
      } catch (error) {
        if (
          error?.name !== 'CloudSyncError'
          && !Number.isInteger(error?.status)
          && typeof error?.retryable !== 'boolean'
        ) {
          throw error;
        }
        throw await recordTransportFailure(credentials, [], error);
      }
      if (page.hasMore && page.changes.length === 0) {
        throw serviceError(
          'INVALID_SYNC_RESPONSE',
          'Cloud sync returned an invalid response.',
          true
        );
      }
      const split = splitPullChanges(page.changes);
      if (Object.keys(split.settings).length > 0) {
        await settings.saveRemote(split.settings);
      }
      await repository.applyRemoteChangesAtomic({
        vaultId: credentials.vaultId,
        changes: split.entities,
        nextCursor: page.nextCursor
      });
      pulled += page.changes.length;
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    } while (hasMore && pulled < MAX_PULL_CHANGES_PER_RUN);

    return {
      pushed,
      pulled,
      cursor,
      ...(hasMore ? { hasMore: true } : {})
    };
  }

  async function performSync(reason) {
    const credentials = await readCredentials();
    if (!credentials) return { skipped: 'disabled', reason };
    const blocked = await repository.getSyncMeta(
      `authBlocked:${credentials.vaultId}`
    );
    if (blocked && reason !== 'manual') {
      return {
        skipped: 'blocked',
        reason,
        errorCode: blocked.code
      };
    }
    const transport = transportFactory(credentials);
    const due = await repository.listDueSyncMutations({
      vaultId: credentials.vaultId,
      now: now(),
      limit: PUSH_LIMIT
    });
    if (due.length > 0) {
      let pushResult;
      try {
        pushResult = await transport.push({
          deviceId: credentials.deviceId,
          mutations: due.map(protocolMutation)
        });
      } catch (error) {
        throw await recordTransportFailure(credentials, due, error);
      }
      await applyPushResult(credentials, due, pushResult);
    }
    const result = await pullBoundedPages(
      credentials,
      transport,
      due.length
    );
    await repository.setSyncMeta(
      `lastSuccessfulSyncAt:${credentials.vaultId}`,
      now()
    );
    await repository.setSyncMeta(
      `lastSyncError:${credentials.vaultId}`,
      null
    );
    await repository.setSyncMeta(
      `authBlocked:${credentials.vaultId}`,
      null
    );
    return result;
  }

  function runOnce(reason = 'manual') {
    if (inFlight) return inFlight;
    const run = performSync(reason);
    inFlight = run.finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function isEnabled() {
    return Boolean(await readCredentials());
  }

  function buildCommentMutation(bundle) {
    if (!activeCredentials) {
      throw serviceError('CLOUD_SYNC_DISABLED', 'Cloud sync is disabled.');
    }
    const createdAt = now();
    return outboxMutation(normalizeSyncMutation({
      mutationId: createMutationId(),
      entityType: 'comment',
      entityId: bundle?.comment?.id,
      operation: 'upsert',
      payload: bundle,
      createdAt
    }), activeCredentials.vaultId);
  }

  async function enqueueInitialHistory() {
    const credentials = await readCredentials();
    if (!credentials) {
      return { skipped: 'disabled', scanned: 0, queued: 0, done: false };
    }
    const stateKey = `initialUploadState:${credentials.vaultId}`;
    const savedState = await repository.getSyncMeta(stateKey);
    if (savedState?.done) {
      return { scanned: 0, queued: 0, done: true };
    }
    const page = await repository.scanRecordsForInitialSync({
      cursor: savedState?.cursor ?? null,
      limit: INITIAL_HISTORY_PAGE_SIZE
    });
    let queued = 0;
    for (const record of page.records) {
      const revisionId = normalizeCommentRevision(record.comment).id;
      const mutationId = await hashSyncSecret(
        `initial-comment:${credentials.vaultId}:${record.comment.id}:${revisionId}`
      );
      const createdAt = now();
      const mutation = outboxMutation(normalizeSyncMutation({
        mutationId,
        entityType: 'comment',
        entityId: record.comment.id,
        operation: 'upsert',
        payload: record,
        createdAt
      }), credentials.vaultId);
      try {
        await repository.enqueueSyncMutation(mutation);
        queued += 1;
      } catch (error) {
        if (error?.name !== 'ConstraintError') throw error;
      }
      await repository.setSyncMeta(stateKey, {
        cursor: record.comment.id,
        done: false
      });
    }
    await repository.setSyncMeta(stateKey, {
      cursor: page.cursor,
      done: page.done
    });
    return {
      scanned: page.records.length,
      queued,
      done: page.done
    };
  }

  async function getStatus() {
    const credentials = await readCredentials();
    if (!credentials) {
      return {
        enabled: false,
        state: 'disabled',
        pendingCount: 0,
        lastSuccessfulSyncAt: null,
        lastSyncError: null
      };
    }
    const [
      pending,
      lastSuccessfulSyncAt,
      lastSyncError,
      blocked
    ] = await Promise.all([
      repository.listDueSyncMutations({
        vaultId: credentials.vaultId,
        now: Number.MAX_SAFE_INTEGER,
        limit: 1_000
      }),
      repository.getSyncMeta(
        `lastSuccessfulSyncAt:${credentials.vaultId}`
      ),
      repository.getSyncMeta(`lastSyncError:${credentials.vaultId}`),
      repository.getSyncMeta(`authBlocked:${credentials.vaultId}`)
    ]);
    return {
      enabled: true,
      state: blocked ? 'blocked' : (lastSyncError ? 'failed' : 'idle'),
      vaultId: credentials.vaultId,
      deviceId: credentials.deviceId,
      pendingCount: pending.length,
      lastSuccessfulSyncAt: lastSuccessfulSyncAt ?? null,
      lastSyncError: lastSyncError ?? null
    };
  }

  async function getCredentialsForDisplay() {
    const credentials = await readCredentials();
    if (!credentials) {
      throw serviceError('CLOUD_SYNC_DISABLED', 'Cloud sync is disabled.');
    }
    return {
      syncKey: credentials.syncKey,
      vaultId: credentials.vaultId,
      deviceId: credentials.deviceId
    };
  }

  async function enqueueSettingChanges(changes, areaName) {
    if (areaName !== 'local') return { queued: 0 };
    const credentials = await readCredentials();
    if (!credentials) return { queued: 0 };
    const mutations = settings.createMutations(changes, areaName, {
      now,
      createMutationId
    });
    let queued = 0;
    for (const mutation of mutations) {
      try {
        await repository.enqueueSyncMutation(
          outboxMutation(mutation, credentials.vaultId)
        );
        queued += 1;
      } catch (error) {
        if (
          error?.code === 'SENSITIVE_FIELD_NOT_SYNCABLE'
          || error?.code === 'SETTING_NOT_SYNCABLE'
          || error?.code === 'INVALID_MUTATION_PAYLOAD'
        ) {
          continue;
        }
        throw error;
      }
    }
    return { queued };
  }

  async function listCloudHistory(query = {}) {
    const credentials = await readCredentials();
    if (!credentials) {
      throw serviceError('CLOUD_SYNC_DISABLED', 'Cloud sync is disabled.');
    }
    return transportFactory(credentials).history(query);
  }

  async function deleteCloudHistory(recordId) {
    if (typeof recordId !== 'string' || !recordId) {
      throw serviceError('INVALID_RECORD_ID', 'Invalid cloud history record.');
    }
    const credentials = await readCredentials();
    if (!credentials) {
      throw serviceError('CLOUD_SYNC_DISABLED', 'Cloud sync is disabled.');
    }
    const mutationId = createMutationId();
    const result = await transportFactory(credentials).deleteHistory(
      recordId,
      mutationId
    );
    if (
      !result
      || !['applied', 'duplicate', 'stale'].includes(result.status)
    ) {
      throw serviceError(
        'CLOUD_HISTORY_DELETE_FAILED',
        'Cloud history deletion failed.'
      );
    }
    await repository.applyCloudHistoryDeletion({
      vaultId: credentials.vaultId,
      recordId,
      serverSeq: Number.isSafeInteger(result.serverSeq)
        ? result.serverSeq
        : null
    });
    return result;
  }

  async function disconnect() {
    await storageLocal.remove(CREDENTIAL_KEYS);
    activeCredentials = null;
    return { disconnected: true };
  }

  async function deleteVault(confirmation) {
    const credentials = await readCredentials();
    if (!credentials) {
      throw serviceError('CLOUD_SYNC_DISABLED', 'Cloud sync is disabled.');
    }
    if (confirmation !== credentials.vaultId) {
      throw serviceError(
        'VAULT_CONFIRMATION_MISMATCH',
        'Cloud sync vault confirmation does not match.'
      );
    }
    const result = await transportFactory(credentials).deleteVault(
      confirmation
    );
    await disconnect();
    return result;
  }

  return Object.freeze({
    createVault,
    importKey,
    runOnce,
    isEnabled,
    buildCommentMutation,
    enqueueInitialHistory,
    getStatus,
    getCredentialsForDisplay,
    enqueueSettingChanges,
    listCloudHistory,
    deleteCloudHistory,
    disconnect,
    deleteVault
  });
}
