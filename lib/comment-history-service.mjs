import {
  buildCommentHistoryRecord,
  buildLegacyCommentHistoryRecord
} from './comment-history-record.mjs';
import {
  CSV_ROWS_PER_PART,
  buildCsvPartName
} from './comment-history-csv.mjs';

const PENDING_PREFIX = 'historyPending:';
const LEGACY_MIGRATION_KEY = 'legacyMigrationV1';
const EXPORT_META_PREFIX = 'historyExport:';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const EXPORT_CHUNK_LIMIT = 500;

function currentTime(now) {
  return typeof now === 'function' ? now() : now;
}

function effectiveResult(message) {
  return message?.result ?? 'success';
}

function buildLiveBundle(message, now) {
  return buildCommentHistoryRecord({
    batchId: message?.batchId,
    urlIndex: message?.urlIndex,
    history: message?.history
  }, { now: currentTime(now) });
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

function normalizedFilenames(filenames) {
  if (!Array.isArray(filenames)) return [];
  return filenames
    .filter((filename) => typeof filename === 'string')
    .map((filename) => filename.trim())
    .filter((filename) => filename && filename.toLowerCase().endsWith('.csv'));
}

export function createCommentHistoryService({
  repository,
  storageLocal,
  now = Date.now,
  createExportSessionId = defaultExportSessionId
}) {
  async function saveConfirmedSuccess(message) {
    if (effectiveResult(message) !== 'success') {
      return { historySaveStatus: 'not_applicable' };
    }
    if (!message?.history && message?.historyUnavailableReason === 'legacy_context') {
      return { historySaveStatus: 'not_applicable' };
    }

    let bundle;
    try {
      bundle = buildLiveBundle(message, now);
      await repository.upsertRecord(bundle);
      return { historySaveStatus: 'saved' };
    } catch (_) {
      if (!bundle) {
        try {
          bundle = buildLiveBundle(message, now);
        } catch (_) {
          return { historySaveStatus: 'failed' };
        }
      }

      try {
        const pendingKey = `${PENDING_PREFIX}${bundle.comment.id}`;
        await storageLocal.set({ [pendingKey]: message });
        return { historySaveStatus: 'queued' };
      } catch (_) {
        return { historySaveStatus: 'failed' };
      }
    }
  }

  async function retryPendingWrites() {
    const storageData = await storageLocal.get(null);
    const pendingKeys = Object.keys(storageData)
      .filter((key) => key.startsWith(PENDING_PREFIX))
      .sort();
    let saved = 0;

    for (const key of pendingKeys) {
      try {
        const message = storageData[key];
        if (effectiveResult(message) !== 'success') continue;
        const bundle = buildLiveBundle(message, now);
        await repository.upsertRecord(bundle);
        await storageLocal.remove(key);
        saved += 1;
      } catch (_) {
        // Leave this independent item queued while later records continue retrying.
      }
    }

    return {
      retried: pendingKeys.length,
      saved,
      pending: pendingKeys.length - saved
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
      await repository.upsertRecord(bundle);
      migratedIds.add(bundle.comment.id);
      migrated += 1;
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
    const descriptor = {
      exportSessionId,
      criteria,
      exportedBefore,
      expectedCount,
      startedAt: exportedBefore,
      filenames: [],
      finalizedAt: null,
      consumedAt: null
    };
    await repository.setMeta(sessionMetaKey(exportSessionId), descriptor);
    return { exportSessionId, exportedBefore, expectedCount, criteria };
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
    const descriptor = await loadExportDescriptor(exportSessionId);
    if (descriptor.consumedAt != null) {
      throw historyError('EXPORT_SESSION_CONSUMED', '该导出会话已完成清理，请重新导出。');
    }
    if (
      descriptor.finalizedAt == null
      || !Array.isArray(descriptor.filenames)
      || descriptor.filenames.length === 0
    ) {
      throw historyError('EXPORT_NOT_FINALIZED', '请先完成导出归档。');
    }

    const confirmedAt = currentTime(now);
    const expiryCutoff = confirmedAt - RETENTION_DAYS * DAY_MS;
    const snapshotCriteria = {
      ...descriptor.criteria,
      exportedBefore: descriptor.exportedBefore
    };
    const currentCount = await repository.countRecords(snapshotCriteria);
    if (currentCount !== descriptor.expectedCount) {
      throw historyError('EXPORT_SET_CHANGED', '导出后的记录集合已变化，请重新导出。');
    }
    const deletionCriteria = {
      ...snapshotCriteria,
      to: Math.min(descriptor.criteria.to ?? expiryCutoff, expiryCutoff)
    };
    const expiredCount = await repository.countRecords(deletionCriteria);
    if (expiredCount !== currentCount) {
      throw historyError('RETENTION_NOT_EXPIRED', '只能删除已保留满 90 天的评论历史。');
    }

    const archiveEvent = {
      id: `archive:${descriptor.exportSessionId}`,
      rangeStart: descriptor.criteria.from ?? null,
      rangeEnd: descriptor.criteria.to ?? expiryCutoff,
      recordCount: descriptor.expectedCount,
      fileNames: descriptor.filenames,
      exportStartedAt: descriptor.startedAt,
      deleteConfirmedAt: confirmedAt,
      deletedAt: confirmedAt
    };
    const deletedCount = await repository.deleteConfirmed(deletionCriteria, archiveEvent);
    if (deletedCount !== descriptor.expectedCount) {
      throw historyError('EXPORT_SET_CHANGED', '导出后的记录集合已变化，请重新导出。');
    }
    await repository.setMeta(sessionMetaKey(descriptor.exportSessionId), {
      ...descriptor,
      consumedAt: confirmedAt
    });
    return {
      deletedCount,
      exportSessionId: descriptor.exportSessionId
    };
  }

  return {
    saveConfirmedSuccess,
    retryPendingWrites,
    migrateLegacyResults,
    getSummary,
    listRecords,
    getAnchors,
    getRetentionStatus,
    listArchiveEvents,
    startExport,
    getExportChunk,
    finishExport,
    deleteConfirmed
  };
}
