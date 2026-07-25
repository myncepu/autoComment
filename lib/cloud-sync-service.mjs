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
const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

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

function safeLifecycleError(error, fallbackCode) {
  if (
    typeof error?.code === 'string'
    && STABLE_ERROR_CODE.test(error.code)
  ) {
    return {
      code: error.code,
      status: Number.isInteger(error.status) && error.status >= 0
        ? error.status
        : 0,
      retryable: typeof error.retryable === 'boolean'
        ? error.retryable
        : true
    };
  }
  return {
    code: fallbackCode,
    status: 0,
    retryable: true
  };
}

function invalidSyncResponse() {
  return serviceError(
    'INVALID_SYNC_RESPONSE',
    'Cloud sync returned an invalid response.',
    true
  );
}

function validatePullPage(page, { cursor, limit }) {
  if (
    !page
    || !Array.isArray(page.changes)
    || page.changes.length > limit
    || !Number.isSafeInteger(page.nextCursor)
    || page.nextCursor < 0
    || !Number.isSafeInteger(page.highWatermark)
    || page.highWatermark < cursor
    || typeof page.hasMore !== 'boolean'
  ) {
    throw invalidSyncResponse();
  }
  let previousSequence = cursor;
  for (const change of page.changes) {
    if (
      !Number.isSafeInteger(change?.serverSeq)
      || change.serverSeq <= previousSequence
      || change.serverSeq > page.highWatermark
    ) {
      throw invalidSyncResponse();
    }
    previousSequence = change.serverSeq;
  }
  if (
    page.nextCursor !== previousSequence
    || page.nextCursor > page.highWatermark
    || (page.hasMore && page.changes.length === 0)
  ) {
    throw invalidSyncResponse();
  }
  return page;
}

function splitPullChanges(changes) {
  const settings = {};
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
    }
  }
  return settings;
}

function validateBootstrapPage(page, {
  cursor,
  limit,
  serverCursor,
  serverNow,
  phase
}) {
  if (
    !page
    || !Array.isArray(page.comments)
    || page.comments.length > limit
    || !Array.isArray(page.settings)
    || !Array.isArray(page.tombstones)
    || page.tombstones.length > limit
    || typeof page.hasMore !== 'boolean'
    || !Number.isSafeInteger(page.serverCursor)
    || page.serverCursor < 0
    || !Number.isSafeInteger(page.serverNow)
    || page.serverNow < 0
    || (
      page.nextCursor !== null
      && (typeof page.nextCursor !== 'string' || !page.nextCursor)
    )
    || (page.hasMore && page.nextCursor === null)
    || (!page.hasMore && page.nextCursor !== null)
    || (page.hasMore && page.comments.length + page.tombstones.length === 0)
    || (cursor !== null && page.settings.length !== 0)
    || (serverCursor !== null && page.serverCursor !== serverCursor)
    || (serverNow !== null && page.serverNow !== serverNow)
    || (phase === 'tombstones' && page.comments.length !== 0)
  ) {
    throw invalidSyncResponse();
  }
  const nextPhase = phase === 'tombstones' || page.tombstones.length > 0
    ? 'tombstones'
    : 'comments';
  return { ...page, phase: nextPhase };
}

function bootstrapSettings(entries) {
  const values = {};
  for (const entry of entries) {
    if (
      !entry
      || typeof entry !== 'object'
      || !CLOUD_SYNC_SETTING_KEYS.includes(entry.key)
      || !Object.hasOwn(entry, 'value')
      || Object.hasOwn(values, entry.key)
    ) {
      throw invalidSyncResponse();
    }
    values[entry.key] = structuredClone(entry.value);
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

function validatePushReceipts(due, result) {
  if (!Array.isArray(result?.results) || result.results.length !== due.length) {
    throw serviceError(
      'INVALID_SYNC_RESPONSE',
      'Cloud sync returned an invalid response.',
      true
    );
  }
  const dueIds = new Set(due.map(({ mutationId }) => mutationId));
  const receipts = new Map();
  for (const receipt of result.results) {
    if (
      !receipt
      || typeof receipt !== 'object'
      || typeof receipt.mutationId !== 'string'
      || !dueIds.has(receipt.mutationId)
      || receipts.has(receipt.mutationId)
    ) {
      throw serviceError(
        'INVALID_SYNC_RESPONSE',
        'Cloud sync returned an invalid response.',
        true
      );
    }
    const keys = Object.keys(receipt).sort();
    if (['applied', 'duplicate', 'stale'].includes(receipt.status)) {
      if (
        !Number.isSafeInteger(receipt.serverSeq)
        || receipt.serverSeq < 0
        || keys.join('\u0000') !== [
          'mutationId',
          'serverSeq',
          'status'
        ].join('\u0000')
      ) {
        throw serviceError(
          'INVALID_SYNC_RESPONSE',
          'Cloud sync returned an invalid response.',
          true
        );
      }
    } else if (receipt.status === 'rejected') {
      if (
        typeof receipt.errorCode !== 'string'
        || !STABLE_ERROR_CODE.test(receipt.errorCode)
        || keys.join('\u0000') !== [
          'errorCode',
          'mutationId',
          'status'
        ].join('\u0000')
      ) {
        throw serviceError(
          'INVALID_SYNC_RESPONSE',
          'Cloud sync returned an invalid response.',
          true
        );
      }
    } else {
      throw serviceError(
        'INVALID_SYNC_RESPONSE',
        'Cloud sync returned an invalid response.',
        true
      );
    }
    receipts.set(receipt.mutationId, receipt);
  }
  return receipts;
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
  let initialHistoryInFlight = null;
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

  async function flushPendingInboundSettings(credentials) {
    const key = `pendingInboundSettings:${credentials.vaultId}`;
    const pending = await repository.getSyncMeta(key);
    if (
      !pending
      || typeof pending !== 'object'
      || Object.keys(pending).length === 0
    ) {
      return { flushed: 0 };
    }
    const values = pickCloudSyncSettings(pending);
    if (Object.keys(values).length !== Object.keys(pending).length) {
      throw serviceError(
        'INVALID_REMOTE_SETTING',
        'Cloud sync returned an invalid setting.',
        false
      );
    }
    await settings.saveRemote(values);
    await repository.clearPendingInboundSettings({
      vaultId: credentials.vaultId,
      expected: values
    });
    return { flushed: Object.keys(values).length };
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
    try {
      await persistCredentials(credentials);
    } catch (error) {
      try {
        await transport.deleteVault(credentials.vaultId);
      } catch (_) {
        // The original persistence error is authoritative; compensation is best effort.
      }
      throw error;
    }
    let warning = null;
    try {
      await repository.setSyncMeta(
        `authBlocked:${credentials.vaultId}`,
        null
      );
    } catch (error) {
      warning = safeLifecycleError(error, 'SYNC_META_WRITE_FAILED');
    }
    let queuedSettings = 0;
    try {
      queuedSettings = await enqueueCurrentSettings(credentials);
    } catch (error) {
      warning ??= safeLifecycleError(error, 'SYNC_SETTING_QUEUE_FAILED');
    }
    return {
      connected: true,
      syncKey: credentials.syncKey,
      vaultId: credentials.vaultId,
      deviceId: credentials.deviceId,
      queuedSettings,
      ...(warning ? { warning } : {})
    };
  }

  async function bootstrapImportedVault(credentials, transport) {
    const stateKey = `bootstrapState:${credentials.vaultId}`;
    const savedState = await repository.getSyncMeta(stateKey);
    let cursor = savedState?.done ? null : (savedState?.cursor ?? null);
    let serverCursor = Number.isSafeInteger(savedState?.serverCursor)
      ? savedState.serverCursor
      : null;
    let serverNow = Number.isSafeInteger(savedState?.serverNow)
      ? savedState.serverNow
      : null;
    let phase = savedState?.phase === 'tombstones'
      ? 'tombstones'
      : 'comments';
    let pages = 0;
    let imported = 0;

    if (!savedState?.done) {
      let hasMore;
      do {
        const page = validateBootstrapPage(await transport.bootstrap({
          deviceId: credentials.deviceId,
          limit: PULL_LIMIT,
          ...(cursor ? { cursor } : {})
        }), {
          cursor,
          limit: PULL_LIMIT,
          serverCursor,
          serverNow,
          phase
        });
        const remoteSettings = !cursor
          ? bootstrapSettings(page.settings)
          : {};
        await repository.applyBootstrapPageAtomic({
          vaultId: credentials.vaultId,
          comments: page.comments,
          tombstones: page.tombstones,
          pendingInboundSettings: remoteSettings,
          nextCursor: page.nextCursor,
          serverCursor: page.serverCursor,
          serverNow: page.serverNow,
          phase: page.phase,
          hasMore: page.hasMore
        });
        await flushPendingInboundSettings(credentials);
        pages += 1;
        imported += page.comments.length + page.tombstones.length;
        cursor = page.nextCursor;
        serverCursor = page.serverCursor;
        serverNow = page.serverNow;
        phase = page.phase;
        hasMore = page.hasMore;
      } while (hasMore);
    }

    await repository.setSyncMeta(
      `bootstrapError:${credentials.vaultId}`,
      null
    );
    return { pages, imported, serverCursor };
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
    const bootstrapStateKey = `bootstrapState:${credentials.vaultId}`;
    if (!await repository.getSyncMeta(bootstrapStateKey)) {
      await repository.setSyncMeta(bootstrapStateKey, {
        cursor: null,
        serverCursor: null,
        serverNow: null,
        phase: 'comments',
        done: false
      });
    }
    try {
      await flushPendingInboundSettings(credentials);
    } catch (error) {
      return {
        connected: true,
        vaultId: credentials.vaultId,
        deviceId: credentials.deviceId,
        bootstrapPending: true,
        error: safeLifecycleError(error, 'SYNC_SETTING_FLUSH_FAILED')
      };
    }
    try {
      const bootstrap = await bootstrapImportedVault(credentials, transport);
      try {
        bootstrap.sync = await pullBoundedPages(credentials, transport, 0);
        return {
          connected: true,
          vaultId: credentials.vaultId,
          deviceId: credentials.deviceId,
          bootstrapPending: false,
          bootstrap
        };
      } catch (error) {
        return {
          connected: true,
          vaultId: credentials.vaultId,
          deviceId: credentials.deviceId,
          bootstrapPending: false,
          syncPending: true,
          error: safeLifecycleError(error, 'SYNC_PULL_FAILED')
        };
      }
    } catch (error) {
      const publicError = safeLifecycleError(
        error,
        'SYNC_BOOTSTRAP_FAILED'
      );
      try {
        await repository.setSyncMeta(
          `bootstrapError:${credentials.vaultId}`,
          publicError
        );
      } catch (_) {
        // Credentials and the last atomic bootstrap cursor remain durable.
      }
      return {
        connected: true,
        vaultId: credentials.vaultId,
        deviceId: credentials.deviceId,
        bootstrapPending: true,
        error: publicError
      };
    }
  }

  async function applyPushResult(credentials, due, result) {
    let receipts;
    try {
      receipts = validatePushReceipts(due, result);
    } catch (error) {
      for (const mutation of due) {
        await repository.markSyncMutationAttempt({
          mutationId: mutation.mutationId,
          attemptCount: mutation.attemptCount + 1,
          nextAttemptAt: nextRetryAt({
            attemptCount: mutation.attemptCount,
            now: now(),
            random
          }),
          lastErrorCode: 'INVALID_SYNC_RESPONSE',
          state: 'pending'
        });
      }
      await repository.setSyncMeta(
        `lastSyncError:${credentials.vaultId}`,
        {
          code: 'INVALID_SYNC_RESPONSE',
          status: 0,
          retryable: true
        }
      );
      throw error;
    }
    const completed = [];
    for (const mutation of due) {
      const receipt = receipts.get(mutation.mutationId);
      if (['applied', 'duplicate', 'stale'].includes(receipt.status)) {
        completed.push(
          receiptEntityState(credentials.vaultId, mutation, receipt)
        );
        continue;
      }
      await repository.markSyncMutationAttempt({
        mutationId: mutation.mutationId,
        attemptCount: mutation.attemptCount + 1,
        nextAttemptAt: now(),
        lastErrorCode: receipt.errorCode,
        state: 'needs_attention'
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
      let rawPage;
      try {
        rawPage = await transport.pull({
          cursor,
          limit: Math.min(PULL_LIMIT, remaining),
          deviceId: credentials.deviceId
        });
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
      const limit = Math.min(PULL_LIMIT, remaining);
      const page = validatePullPage(rawPage, { cursor, limit });
      const pendingInboundSettings = splitPullChanges(page.changes);
      await repository.applyRemoteChangesAtomic({
        vaultId: credentials.vaultId,
        changes: page.changes,
        pendingInboundSettings,
        nextCursor: page.nextCursor
      });
      await flushPendingInboundSettings(credentials);
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
    await flushPendingInboundSettings(credentials);
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
    const bootstrapState = await repository.getSyncMeta(
      `bootstrapState:${credentials.vaultId}`
    );
    if (bootstrapState && bootstrapState.done !== true) {
      try {
        await bootstrapImportedVault(credentials, transport);
      } catch (error) {
        const publicError = safeLifecycleError(
          error,
          'SYNC_BOOTSTRAP_FAILED'
        );
        try {
          await repository.setSyncMeta(
            `bootstrapError:${credentials.vaultId}`,
            publicError
          );
        } catch (_) {
          // The last atomic bootstrap cursor remains the recovery source.
        }
        return {
          skipped: 'bootstrap_pending',
          reason,
          error: publicError
        };
      }
    }
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

  async function performInitialHistoryEnqueue() {
    const credentials = await readCredentials();
    if (!credentials) {
      return { skipped: 'disabled', scanned: 0, queued: 0, done: false };
    }
    const stateKey = `initialUploadState:${credentials.vaultId}`;
    const repairKey = `initialUploadRepair:${credentials.vaultId}`;
    const savedState = await repository.getSyncMeta(stateKey);
    const repairMarker = await repository.getSyncMeta(repairKey);
    const hasRepairMarker =
      typeof repairMarker === 'string' && repairMarker.length > 0;
    if (savedState?.done && !hasRepairMarker) {
      return { scanned: 0, queued: 0, done: true };
    }
    const resumesRepair =
      hasRepairMarker && savedState?.repairMarker === repairMarker;
    const scanCursor = hasRepairMarker
      ? (resumesRepair ? savedState?.cursor ?? null : null)
      : savedState?.cursor ?? null;
    const page = await repository.scanRecordsForInitialSync({
      cursor: scanCursor,
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
        ...(hasRepairMarker ? { repairMarker } : {}),
        done: false
      });
    }
    await repository.setSyncMeta(stateKey, {
      cursor: page.cursor,
      ...(hasRepairMarker ? { repairMarker } : {}),
      done: page.done
    });
    if (page.done && hasRepairMarker) {
      await repository.clearSyncMetaIfEqual({
        key: repairKey,
        expected: repairMarker
      });
    }
    return {
      scanned: page.records.length,
      queued,
      done: page.done
    };
  }

  function enqueueInitialHistory() {
    if (initialHistoryInFlight) return initialHistoryInFlight;
    const flight = performInitialHistoryEnqueue().finally(() => {
      if (initialHistoryInFlight === flight) {
        initialHistoryInFlight = null;
      }
    });
    initialHistoryInFlight = flight;
    return flight;
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
