import {
  buildCommentHistoryRecord,
  buildLegacyCommentHistoryRecord
} from './comment-history-record.mjs';
import {
  CSV_ROWS_PER_PART,
  buildCsvPartName
} from './comment-history-csv.mjs';

const PENDING_PREFIX = 'historyPending:';
const PENDING_V2_PREFIX = `${PENDING_PREFIX}v2:`;
const PENDING_QUEUE_VERSION = 2;
const LEGACY_MIGRATION_KEY = 'legacyMigrationV1';
const EXPORT_META_PREFIX = 'historyExport:';
const EXPORT_CHUNK_LIMIT = 500;
const MAX_PENDING_RETRIES_PER_TRIGGER = 25;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function currentTime(now) {
  return typeof now === 'function' ? now() : now;
}

function effectiveResult(message) {
  return message?.result ?? 'success';
}

function validHistoryRevision(value) {
  return Boolean(
    value
    && Number.isFinite(value.capturedAt)
    && Number.isFinite(value.recordedAt)
    && Number.isInteger(value.sequence)
    && value.sequence >= 0
    && typeof value.id === 'string'
    && value.id
  );
}

function normalizedHistoryRevision(message) {
  const explicit = message?.history?.historyRevision;
  if (validHistoryRevision(explicit)) return explicit;
  const capturedAt = message?.history?.submittedAt;
  return {
    capturedAt,
    recordedAt: capturedAt,
    sequence: 0,
    id: `legacy:${message?.batchId || ''}:${message?.urlIndex ?? ''}:${capturedAt}`
  };
}

function withHistoryRevision(message) {
  if (!message?.history) return message;
  const historyRevision = normalizedHistoryRevision(message);
  if (message.history.historyRevision === historyRevision) return message;
  return {
    ...message,
    history: {
      ...message.history,
      historyRevision
    }
  };
}

function sameHistoryRevision(left, right) {
  return validHistoryRevision(left)
    && validHistoryRevision(right)
    && left.capturedAt === right.capturedAt
    && left.recordedAt === right.recordedAt
    && left.sequence === right.sequence
    && left.id === right.id;
}

function buildLiveBundle(message, now) {
  const versionedMessage = withHistoryRevision(message);
  const bundle = buildCommentHistoryRecord({
    batchId: versionedMessage?.batchId,
    urlIndex: versionedMessage?.urlIndex,
    history: versionedMessage?.history
  }, { now: currentTime(now) });
  return {
    ...bundle,
    comment: {
      ...bundle.comment,
      historyRevision: versionedMessage.history.historyRevision
    }
  };
}

function pendingMessage(key, storedValue) {
  if (!key.startsWith(PENDING_V2_PREFIX)) return storedValue;
  if (
    storedValue?.queueVersion !== PENDING_QUEUE_VERSION
    ||
    typeof storedValue.entryId !== 'string'
    || !storedValue.entryId
    || key !== `${PENDING_V2_PREFIX}${storedValue.entryId}`
    || !storedValue.message
  ) {
    return null;
  }
  const message = withHistoryRevision(storedValue.message);
  const commentId = `${message?.batchId}:${message?.urlIndex}`;
  if (
    storedValue.commentId !== commentId
    || !sameHistoryRevision(
      storedValue.revision,
      message?.history?.historyRevision
    )
  ) {
    return null;
  }
  return message;
}

function legacyEntries(data) {
  const entries = [];
  if (Array.isArray(data.batchResults)) {
    for (const entry of data.batchResults) {
      entries.push({ entry, batchId: entry?.batchId });
    }
  }

  const localResults = data.batchLocalResults;
  if (localResults && Array.isArray(localResults.results)) {
    for (const entry of localResults.results) {
      entries.push({
        entry,
        batchId: entry?.batchId || localResults.batchId
      });
    }
  }
  return entries;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedText(value, { lowercase = false } = {}) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return lowercase ? text.toLowerCase() : text;
}

function normalizeExportCriteria(filter = {}) {
  const criteria = {
    from: finiteNumber(filter.from ?? filter.dateFrom),
    to: finiteNumber(filter.to ?? filter.dateTo),
    targetDomain: normalizedText(filter.targetDomain, { lowercase: true }),
    promotedDomain: normalizedText(filter.promotedDomain, { lowercase: true }),
    anchorTextPrefix: normalizedText(filter.anchorTextPrefix, { lowercase: true }),
    hrefDomain: normalizedText(filter.hrefDomain, { lowercase: true })
  };
  return Object.fromEntries(
    Object.entries(criteria).filter(([, value]) => value !== undefined)
  );
}

function sessionMetaKey(exportSessionId) {
  return `${EXPORT_META_PREFIX}${exportSessionId}`;
}

function historyError(code, publicMessage) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
}

function validSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function defaultExportSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function defaultPendingEntryId() {
  return defaultExportSessionId();
}

function normalizedFilenames(filenames) {
  if (!Array.isArray(filenames)) return [];
  return filenames
    .filter((filename) => typeof filename === 'string')
    .map((filename) => filename.trim())
    .filter((filename) => filename && filename.toLowerCase().endsWith('.csv'));
}

function boundedRetryLimit(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return MAX_PENDING_RETRIES_PER_TRIGGER;
  }
  return Math.min(value, MAX_PENDING_RETRIES_PER_TRIGGER);
}

export function createCommentHistoryService({
  repository,
  storageLocal,
  cloudSync,
  now = Date.now,
  createExportSessionId = defaultExportSessionId,
  createPendingEntryId = defaultPendingEntryId
}) {
  async function pendingQueueCount() {
    const storageData = await storageLocal.get(null);
    return Object.keys(storageData)
      .filter((key) => key.startsWith(PENDING_PREFIX)).length;
  }

  async function enqueuePendingMessage(message, bundle) {
    const entryId = validSessionId(createPendingEntryId());
    if (!entryId) throw new Error('Invalid pending entry ID');
    const pendingKey = `${PENDING_V2_PREFIX}${entryId}`;
    await storageLocal.set({
      [pendingKey]: {
        queueVersion: PENDING_QUEUE_VERSION,
        entryId,
        commentId: bundle.comment.id,
        revision: bundle.comment.historyRevision,
        message
      }
    });
    try {
      return await pendingQueueCount();
    } catch (_) {
      // The exact item is durable even when queue visibility is unavailable.
      return null;
    }
  }

  async function saveConfirmedSuccess(message) {
    if (effectiveResult(message) !== 'success') {
      return { historySaveStatus: 'not_applicable' };
    }
    if (!message?.history && message?.historyUnavailableReason === 'legacy_context') {
      return { historySaveStatus: 'not_applicable' };
    }

    let versionedMessage;
    let bundle;
    try {
      versionedMessage = withHistoryRevision(message);
      bundle = buildLiveBundle(versionedMessage, now);
    } catch (_) {
      return { historySaveStatus: 'failed' };
    }

    let syncMutation;
    let cloudQueueStatus;
    if (cloudSync) {
      try {
        if (await cloudSync.isEnabled()) {
          syncMutation = cloudSync.buildCommentMutation(bundle);
          cloudQueueStatus = 'queued';
        } else {
          cloudQueueStatus = 'not_enabled';
        }
      } catch (_) {
        cloudQueueStatus = 'failed';
      }
    }

    try {
      const inserted = await repository.upsertIfFresher(
        bundle,
        syncMutation ? { syncMutation } : undefined
      );
      if (syncMutation && !inserted) cloudQueueStatus = 'not_needed';
    } catch (error) {
      if (syncMutation && error?.code === 'SYNC_OUTBOX_WRITE_FAILED') {
        let localRetrySaved = false;
        try {
          await repository.upsertIfFresher(bundle, {
            syncRepairMarker: {
              vaultId: syncMutation.vaultId,
              markerId: syncMutation.mutationId
            }
          });
          localRetrySaved = true;
          cloudQueueStatus = 'failed';
        } catch (_) {
          // Fall through to the existing durable pending-message queue.
        }
        if (localRetrySaved) {
          let retryResult;
          try {
            retryResult = await retryPendingWrites();
          } catch (_) {
            // A durable IndexedDB write must not be downgraded by queue maintenance.
          }
          return {
            historySaveStatus: 'saved',
            cloudQueueStatus,
            ...(Number.isInteger(retryResult?.pending) || retryResult?.pending === null
              ? { pendingCount: retryResult.pending }
              : {})
          };
        }
      }
      try {
        const pendingCount = await enqueuePendingMessage(versionedMessage, bundle);
        return {
          historySaveStatus: 'queued',
          pendingCount
        };
      } catch (_) {
        return { historySaveStatus: 'failed' };
      }
    }

    let retryResult;
    try {
      retryResult = await retryPendingWrites();
    } catch (_) {
      // A durable IndexedDB write must not be downgraded by queue maintenance.
    }
    return {
      historySaveStatus: 'saved',
      ...(cloudQueueStatus ? { cloudQueueStatus } : {}),
      ...(Number.isInteger(retryResult?.pending) || retryResult?.pending === null
        ? { pendingCount: retryResult.pending }
        : {})
    };
  }

  async function retryPendingWrites({ limit } = {}) {
    const storageData = await storageLocal.get(null);
    const pendingKeys = Object.keys(storageData)
      .filter((key) => key.startsWith(PENDING_PREFIX))
      .sort();
    const retryLimit = boundedRetryLimit(limit);
    const retryable = [];
    const terminalKeys = [];

    for (const key of pendingKeys) {
      const message = pendingMessage(key, storageData[key]);
      const isNotApplicable = effectiveResult(message) !== 'success'
        || (
          !message?.history
          && message?.historyUnavailableReason === 'legacy_context'
        );
      if (isNotApplicable) {
        terminalKeys.push(key);
        continue;
      }

      try {
        retryable.push({
          key,
          bundle: buildLiveBundle(message, now)
        });
        if (retryable.length === retryLimit) break;
      } catch (_) {
        terminalKeys.push(key);
      }
    }

    let retried = 0;
    let saved = 0;
    let discarded = 0;

    for (const { key, bundle } of retryable) {
      retried += 1;
      try {
        const inserted = await repository.upsertIfFresher(bundle);
        await storageLocal.remove(key);
        if (inserted) {
          saved += 1;
        } else {
          discarded += 1;
        }
      } catch (_) {
        // Leave this independent item queued while later records continue retrying.
      }
    }

    for (const key of terminalKeys.slice(0, retryLimit - retried)) {
      retried += 1;
      try {
        await storageLocal.remove(key);
        discarded += 1;
      } catch (_) {
        // Keep terminal data visible if storage cleanup is temporarily unavailable.
      }
    }

    let pending = null;
    try {
      pending = await pendingQueueCount();
    } catch (_) {
      // A snapshot-derived count could hide a concurrently enqueued item.
    }
    return {
      retried,
      saved,
      ...(discarded > 0 ? { discarded } : {}),
      pending
    };
  }

  async function migrateLegacyResults() {
    const data = await storageLocal.get([
      LEGACY_MIGRATION_KEY,
      'batchResults',
      'batchLocalResults'
    ]);
    if (data[LEGACY_MIGRATION_KEY] === true) {
      return { migrationStatus: 'already_migrated', migrated: 0 };
    }

    const migratedIds = new Set();
    let migrated = 0;
    for (const { entry, batchId } of legacyEntries(data)) {
      if (entry?.result !== 'success' || typeof batchId !== 'string' || batchId === '') continue;
      const bundle = buildLegacyCommentHistoryRecord(entry, batchId);
      if (!bundle || migratedIds.has(bundle.comment.id)) continue;
      const inserted = await repository.insertLegacyIfAbsent(bundle);
      migratedIds.add(bundle.comment.id);
      if (inserted) migrated += 1;
    }

    await storageLocal.set({ [LEGACY_MIGRATION_KEY]: true });
    return { migrationStatus: 'migrated', migrated };
  }

  async function getSummary() {
    return repository.getRetentionSummary(currentTime(now));
  }

  async function listRecords(query) {
    return repository.queryRecords(query);
  }

  async function listRecentSuccessfulTargetUrls({ since }) {
    return repository.listRecentSuccessfulTargetUrls({ since });
  }

  async function getAnchors(commentId) {
    const bundle = await repository.getRecord(commentId);
    return bundle?.anchors || [];
  }

  async function getRetentionStatus() {
    return repository.getRetentionSummary(currentTime(now));
  }

  async function listArchiveEvents() {
    return repository.listArchiveEvents();
  }

  async function loadExportDescriptor(exportSessionId) {
    const sessionId = validSessionId(exportSessionId);
    if (!sessionId) {
      throw historyError('EXPORT_SESSION_REQUIRED', '缺少有效的导出会话。');
    }
    const descriptor = await repository.getMeta(sessionMetaKey(sessionId));
    if (!descriptor || descriptor.exportSessionId !== sessionId) {
      throw historyError('EXPORT_SESSION_NOT_FOUND', '导出会话不存在，请重新导出。');
    }
    return descriptor;
  }

  async function startExport(filter = {}) {
    const exportedBefore = currentTime(now);
    const exportSessionId = validSessionId(createExportSessionId());
    if (!exportSessionId) {
      throw historyError('EXPORT_SESSION_FAILED', '无法创建导出会话。');
    }
    const criteria = normalizeExportCriteria(filter);
    const expectedCount = await repository.countRecords({
      ...criteria,
      exportedBefore
    });
    const cleanupCutoff = exportedBefore - RETENTION_MS;
    const cleanupTo = Math.min(criteria.to ?? cleanupCutoff, cleanupCutoff);
    const cleanupEligibleCount = await repository.countRecords({
      ...criteria,
      to: cleanupTo,
      exportedBefore
    });
    const cleanupEligible = expectedCount > 0
      && cleanupEligibleCount === expectedCount;
    const snapshotRange = {
      from: criteria.from ?? null,
      to: criteria.to ?? exportedBefore
    };
    const descriptor = {
      exportSessionId,
      criteria,
      exportedBefore,
      expectedCount,
      cleanupEligible,
      cleanupEligibleCount,
      snapshotRange,
      startedAt: exportedBefore,
      filenames: [],
      finalizedAt: null,
      consumedAt: null
    };
    await repository.setMeta(sessionMetaKey(exportSessionId), descriptor);
    return {
      exportSessionId,
      exportedBefore,
      expectedCount,
      cleanupEligible,
      cleanupEligibleCount,
      snapshotRange,
      criteria
    };
  }

  async function getExportChunk({
    exportSessionId,
    cursor,
    limit
  } = {}) {
    const descriptor = await loadExportDescriptor(exportSessionId);
    if (descriptor.consumedAt != null) {
      throw historyError('EXPORT_SESSION_CONSUMED', '该导出会话已完成清理，请重新导出。');
    }
    if (descriptor.finalizedAt != null) {
      throw historyError('EXPORT_SESSION_FINALIZED', '该导出会话已经完成。');
    }
    const boundedLimit = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, EXPORT_CHUNK_LIMIT)
      : EXPORT_CHUNK_LIMIT;
    return repository.getExportChunk({
      ...descriptor.criteria,
      exportedBefore: descriptor.exportedBefore,
      ...(cursor ? { cursor } : {}),
      limit: boundedLimit
    });
  }

  async function finishExport({
    exportSessionId,
    filenames
  } = {}) {
    const descriptor = await loadExportDescriptor(exportSessionId);
    if (descriptor.consumedAt != null) {
      throw historyError('EXPORT_SESSION_CONSUMED', '该导出会话已完成清理，请重新导出。');
    }
    if (descriptor.finalizedAt != null) {
      throw historyError('EXPORT_SESSION_FINALIZED', '该导出会话已经完成。');
    }
    const safeFilenames = normalizedFilenames(filenames);
    if (
      safeFilenames.length === 0
      || safeFilenames.length !== filenames?.length
      || new Set(safeFilenames).size !== safeFilenames.length
    ) {
      throw historyError('EXPORT_FILENAMES_REQUIRED', '导出文件列表无效，请重新导出。');
    }
    const expectedFilenames = Array.from(
      {
        length: Math.max(
          1,
          Math.ceil(descriptor.expectedCount / CSV_ROWS_PER_PART)
        )
      },
      (_, index) => buildCsvPartName({
        ...descriptor.criteria,
        exportedBefore: descriptor.exportedBefore,
        part: index + 1
      })
    );
    if (
      safeFilenames.length !== expectedFilenames.length
      || safeFilenames.some((filename, index) => filename !== expectedFilenames[index])
    ) {
      throw historyError(
        'EXPORT_FILENAMES_MISMATCH',
        '导出文件列表与记录数量不一致，请重新导出。'
      );
    }
    const finalized = {
      ...descriptor,
      filenames: safeFilenames,
      finalizedAt: currentTime(now)
    };
    await repository.setMeta(sessionMetaKey(descriptor.exportSessionId), finalized);
    return {
      exportSessionId: descriptor.exportSessionId,
      expectedCount: descriptor.expectedCount,
      filenames: safeFilenames
    };
  }

  async function deleteConfirmed({
    confirmed,
    exportSessionId
  } = {}) {
    if (confirmed !== true) {
      throw historyError('CONFIRMATION_REQUIRED', '删除评论历史需要明确确认。');
    }
    const sessionId = validSessionId(exportSessionId);
    if (!sessionId) {
      throw historyError('EXPORT_SESSION_REQUIRED', '缺少有效的导出会话。');
    }
    return repository.deleteExportSessionAtomic({
      exportSessionId: sessionId,
      confirmedAt: currentTime(now)
    });
  }

  return {
    saveConfirmedSuccess,
    retryPendingWrites,
    migrateLegacyResults,
    getSummary,
    listRecords,
    listRecentSuccessfulTargetUrls,
    getAnchors,
    getRetentionStatus,
    listArchiveEvents,
    startExport,
    getExportChunk,
    finishExport,
    deleteConfirmed
  };
}
