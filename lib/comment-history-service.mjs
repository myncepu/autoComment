import {
  buildCommentHistoryRecord,
  buildLegacyCommentHistoryRecord
} from './comment-history-record.mjs';

const PENDING_PREFIX = 'historyPending:';
const LEGACY_MIGRATION_KEY = 'legacyMigrationV1';

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

export function createCommentHistoryService({
  repository,
  storageLocal,
  now = Date.now
}) {
  async function saveConfirmedSuccess(message) {
    if (effectiveResult(message) !== 'success') {
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

  return {
    saveConfirmedSuccess,
    retryPendingWrites,
    migrateLegacyResults,
    getSummary,
    listRecords,
    getAnchors,
    getRetentionStatus,
    listArchiveEvents
  };
}
