import {
  CLOUD_SYNC_SETTING_KEYS,
  normalizeCommentRevision,
  pickCloudSyncSettings
} from './cloud-sync-protocol.mjs';

const DEFAULT_DB_NAME = 'auto_comment_history';
const DATABASE_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const EXPORT_META_PREFIX = 'historyExport:';

const stores = {
  comments: 'comment_records',
  anchors: 'comment_anchors',
  archives: 'archive_events',
  meta: 'history_meta',
  syncOutbox: 'sync_outbox',
  syncMeta: 'sync_meta',
  syncEntities: 'sync_entities'
};

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => {};
  });
}

function historyDbError(code, publicMessage) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
}

function openDatabase(indexedDBImpl, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(stores.comments)) {
        const comments = database.createObjectStore(stores.comments, { keyPath: 'id' });
        comments.createIndex('by_submitted_at', 'submittedAt');
        comments.createIndex('by_archive_month', 'archiveMonth');
        comments.createIndex('by_target_domain', 'targetDomain');
        comments.createIndex('by_promoted_domain', 'promotedDomain');
        comments.createIndex('by_batch_task', ['batchId', 'urlIndex'], { unique: true });
        comments.createIndex('by_submitted_at_id', ['submittedAt', 'id']);
        comments.createIndex(
          'by_target_domain_submitted_at',
          ['targetDomain', 'submittedAt', 'id']
        );
        comments.createIndex(
          'by_promoted_domain_submitted_at',
          ['promotedDomain', 'submittedAt', 'id']
        );
      }

      if (!database.objectStoreNames.contains(stores.anchors)) {
        const anchors = database.createObjectStore(stores.anchors, { keyPath: 'id' });
        anchors.createIndex('by_comment_id', 'commentId');
        anchors.createIndex('by_anchor_text', 'anchorTextNormalized');
        anchors.createIndex('by_href_domain', 'hrefDomain');
      }

      if (!database.objectStoreNames.contains(stores.archives)) {
        database.createObjectStore(stores.archives, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(stores.meta)) {
        database.createObjectStore(stores.meta, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(stores.syncOutbox)) {
        const outbox = database.createObjectStore(stores.syncOutbox, {
          keyPath: 'mutationId'
        });
        outbox.createIndex(
          'by_vault_state_next_attempt',
          ['vaultId', 'state', 'nextAttemptAt', 'createdAt']
        );
      }
      if (!database.objectStoreNames.contains(stores.syncMeta)) {
        database.createObjectStore(stores.syncMeta, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(stores.syncEntities)) {
        database.createObjectStore(stores.syncEntities, { keyPath: 'entityKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB open blocked for ${dbName}`));
  });
}

function normalizedFilter(filter = {}) {
  return {
    from: filter.from ?? filter.dateFrom,
    to: filter.to ?? filter.dateTo,
    targetDomain: filter.targetDomain,
    promotedDomain: filter.promotedDomain,
    anchorTextPrefix: filter.anchorTextPrefix == null
      ? undefined
      : String(filter.anchorTextPrefix).toLowerCase(),
    hrefDomain: filter.hrefDomain,
    exportedBefore: filter.exportedBefore
  };
}

function matchesComment(comment, filter) {
  if (filter.from != null && comment.submittedAt < filter.from) return false;
  if (filter.to != null && comment.submittedAt > filter.to) return false;
  if (filter.targetDomain != null && comment.targetDomain !== filter.targetDomain) return false;
  if (filter.promotedDomain != null && comment.promotedDomain !== filter.promotedDomain) return false;
  if (filter.exportedBefore != null && comment.updatedAt > filter.exportedBefore) return false;
  return true;
}

function compareIdbStrings(left, right) {
  const leftString = String(left);
  const rightString = String(right);
  if (leftString < rightString) return -1;
  if (leftString > rightString) return 1;
  return 0;
}

function compareCommentFreshness(left, right) {
  const leftSourceRank = left?.source === 'legacy' ? 0 : 1;
  const rightSourceRank = right?.source === 'legacy' ? 0 : 1;
  if (leftSourceRank !== rightSourceRank) {
    return leftSourceRank < rightSourceRank ? -1 : 1;
  }

  const leftRevision = normalizeCommentRevision(left);
  const rightRevision = normalizeCommentRevision(right);
  for (const field of ['capturedAt', 'recordedAt', 'sequence']) {
    if (leftRevision[field] < rightRevision[field]) return -1;
    if (leftRevision[field] > rightRevision[field]) return 1;
  }
  return compareIdbStrings(leftRevision.id, rightRevision.id);
}

function isAfterCommentCursor(comment, cursor) {
  if (!cursor) return true;
  return comment.submittedAt < cursor.submittedAt
    || (
      comment.submittedAt === cursor.submittedAt
      && compareIdbStrings(comment.id, cursor.id) < 0
    );
}

function cursorAll(source, range, direction, visit) {
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        visit(cursor, () => cursor.continue());
      } catch (error) {
        reject(error);
      }
    };
  });
}

function collectCursor(source, range, direction, map = (cursor) => cursor.value) {
  const values = [];
  return cursorAll(source, range, direction, (cursor, next) => {
    values.push(map(cursor));
    next();
  }).then(() => values);
}

function deleteAnchorsForComment(anchorStore, commentId) {
  return cursorAll(
    anchorStore.index('by_comment_id'),
    commentId,
    'next',
    (cursor, next) => {
      cursor.delete();
      next();
    }
  );
}

function anchorTupleAfter(cursor, anchorKey, anchorPrimaryKey) {
  if (!cursor) return true;
  const keyComparison = compareIdbStrings(anchorKey, cursor.anchorKey);
  if (keyComparison > 0) return true;
  return keyComparison === 0
    && compareIdbStrings(anchorPrimaryKey, cursor.anchorPrimaryKey) > 0;
}

function compareAnchorCandidates(left, right) {
  const keyComparison = compareIdbStrings(left.anchorKey, right.anchorKey);
  if (keyComparison !== 0) return keyComparison;
  return compareIdbStrings(left.anchorPrimaryKey, right.anchorPrimaryKey);
}

function safeLimit(value, fallback = 50) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, 1000);
}

function validateInboundSettings(values = {}) {
  if (
    !values
    || typeof values !== 'object'
    || Array.isArray(values)
    || Object.getPrototypeOf(values) !== Object.prototype
  ) {
    throw historyDbError(
      'INVALID_REMOTE_SETTING',
      '远端同步设置无效。'
    );
  }
  let picked;
  try {
    picked = pickCloudSyncSettings(values);
  } catch {
    throw historyDbError(
      'INVALID_REMOTE_SETTING',
      '远端同步设置无效。'
    );
  }
  if (Object.keys(picked).length !== Object.keys(values).length) {
    throw historyDbError(
      'INVALID_REMOTE_SETTING',
      '远端同步设置无效。'
    );
  }
  return picked;
}

export async function openCommentHistoryDb({
  indexedDBImpl = globalThis.indexedDB,
  dbName = DEFAULT_DB_NAME,
  IDBKeyRangeImpl = globalThis.IDBKeyRange,
  onQueryCursorVisit = () => {},
  onCleanupCursorVisit = () => {},
  onBeforeExportSessionConsume = () => {}
} = {}) {
  if (!indexedDBImpl) throw new TypeError('indexedDBImpl is required');
  const database = await openDatabase(indexedDBImpl, dbName);
  database.onversionchange = () => database.close();

  async function upsertRecord({ comment, anchors }) {
    const transaction = database.transaction([stores.comments, stores.anchors], 'readwrite');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);

    try {
      commentStore.put(comment);
      await deleteAnchorsForComment(anchorStore, comment.id);
      for (const anchor of anchors) anchorStore.put(anchor);
      await completion;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of the failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function upsertIfFresher(
    { comment, anchors },
    { syncMutation, syncRepairMarker } = {}
  ) {
    if (syncMutation && syncRepairMarker) {
      throw historyDbError(
        'INVALID_SYNC_REPAIR',
        '同步修复标记无效。'
      );
    }
    const transactionStores = [stores.comments, stores.anchors];
    if (syncMutation) transactionStores.push(stores.syncOutbox);
    if (syncRepairMarker) transactionStores.push(stores.syncMeta);
    const transaction = database.transaction(
      transactionStores,
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    let outboxError = null;
    let repairMarkerError = null;

    try {
      let repairMarkerKey = null;
      if (syncRepairMarker) {
        try {
          const repairVaultId = requireSyncString(
            syncRepairMarker.vaultId,
            'INVALID_SYNC_VAULT'
          );
          const markerId = requireSyncString(
            syncRepairMarker.markerId,
            'INVALID_SYNC_REPAIR'
          );
          repairMarkerKey = `initialUploadRepair:${repairVaultId}`;
          await requestResult(
            transaction.objectStore(stores.syncMeta).put({
              key: repairMarkerKey,
              value: markerId
            })
          );
        } catch (error) {
          repairMarkerError = error;
          throw error;
        }
      }
      const existing = await requestResult(commentStore.get(comment.id));
      if (existing && compareCommentFreshness(comment, existing) <= 0) {
        await completion;
        return false;
      }
      if (syncMutation) {
        try {
          requireSyncString(syncMutation.vaultId, 'INVALID_SYNC_VAULT');
        } catch (error) {
          outboxError = error;
          throw error;
        }
      }
      commentStore.put(comment);
      await deleteAnchorsForComment(anchorStore, comment.id);
      for (const anchor of anchors) anchorStore.put(anchor);
      if (syncMutation) {
        try {
          await requestResult(
            transaction.objectStore(stores.syncOutbox).add(syncMutation)
          );
        } catch (error) {
          outboxError = error;
          throw error;
        }
      }
      await completion;
      return true;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of the failed request.
        }
      }
      await completion.catch(() => {});
      if (repairMarkerError) {
        const wrapped = historyDbError(
          'SYNC_REPAIR_MARKER_FAILED',
          '同步修复标记写入失败。'
        );
        wrapped.cause = repairMarkerError;
        throw wrapped;
      }
      if (outboxError) {
        const wrapped = historyDbError(
          'SYNC_OUTBOX_WRITE_FAILED',
          '同步队列写入失败。'
        );
        wrapped.cause = outboxError;
        throw wrapped;
      }
      throw error;
    }
  }

  async function enqueueSyncMutation(mutation) {
    requireSyncString(mutation?.vaultId, 'INVALID_SYNC_VAULT');
    const transaction = database.transaction(stores.syncOutbox, 'readwrite');
    transaction.objectStore(stores.syncOutbox).add(mutation);
    await transactionCompletion(transaction);
  }

  async function listDueSyncMutations({ vaultId, now, limit }) {
    if (!IDBKeyRangeImpl) {
      throw new TypeError('IDBKeyRange is required for sync outbox queries');
    }
    const transaction = database.transaction(stores.syncOutbox, 'readonly');
    const completion = transactionCompletion(transaction);
    const index = transaction.objectStore(stores.syncOutbox).index(
      'by_vault_state_next_attempt'
    );
    const range = IDBKeyRangeImpl.bound(
      [vaultId, 'pending', -Number.MAX_VALUE, -Number.MAX_VALUE],
      [vaultId, 'pending', now, Number.MAX_VALUE]
    );
    const mutations = [];
    const maxResults = safeLimit(limit);
    await new Promise((resolve, reject) => {
      const request = index.openCursor(range, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        mutations.push(cursor.value);
        if (mutations.length >= maxResults) {
          resolve();
        } else {
          cursor.continue();
        }
      };
    });
    await completion;
    return mutations;
  }

  async function markSyncMutationAttempt({
    mutationId,
    attemptCount,
    nextAttemptAt,
    lastErrorCode,
    state
  }) {
    const transaction = database.transaction(stores.syncOutbox, 'readwrite');
    const completion = transactionCompletion(transaction);
    const outbox = transaction.objectStore(stores.syncOutbox);
    const mutation = await requestResult(outbox.get(mutationId));
    if (mutation) {
      outbox.put({
        ...mutation,
        attemptCount,
        nextAttemptAt,
        lastErrorCode,
        state
      });
    }
    await completion;
  }

  async function completeSyncMutations(receipts) {
    const validatedReceipts = receipts.map((receipt) => {
      const vaultId = requireSyncString(receipt?.vaultId, 'INVALID_SYNC_VAULT');
      const mutationId = requireSyncString(
        receipt?.mutationId,
        'INVALID_SYNC_MUTATION'
      );
      const entityKey = requireSyncString(receipt?.entityKey, 'INVALID_SYNC_ENTITY');
      const validEntityKey = ['comment', 'setting', 'comment_delete'].some(
        (entityType) => entityKey.startsWith(`${vaultId}:${entityType}:`)
          && entityKey.length > `${vaultId}:${entityType}:`.length
      );
      if (!validEntityKey) {
        throw historyDbError('INVALID_SYNC_ENTITY', '同步实体状态无效。');
      }
      if (
        !Number.isSafeInteger(receipt?.serverSeq)
        || receipt.serverSeq < 0
      ) {
        throw historyDbError(
          'INVALID_SYNC_RECEIPT',
          '同步回执无效。'
        );
      }
      return { ...receipt, vaultId, mutationId, entityKey };
    });
    const transaction = database.transaction(
      [stores.syncOutbox, stores.syncEntities],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const outbox = transaction.objectStore(stores.syncOutbox);
    const entities = transaction.objectStore(stores.syncEntities);
    try {
      for (const receipt of validatedReceipts) {
        const mutation = await requestResult(outbox.get(receipt.mutationId));
        if (mutation && mutation.vaultId !== receipt.vaultId) {
          throw historyDbError('SYNC_VAULT_MISMATCH', '同步保险库不匹配。');
        }
        if (
          mutation
          && receipt.entityKey !== (
            `${receipt.vaultId}:${mutation.entityType}:${mutation.entityId}`
          )
        ) {
          throw historyDbError('SYNC_ENTITY_MISMATCH', '同步实体不匹配。');
        }
        outbox.delete(receipt.mutationId);
        const existingEntity = await requestResult(entities.get(receipt.entityKey));
        if (
          !existingEntity
          || !Number.isInteger(existingEntity.serverSeq)
          || receipt.serverSeq > existingEntity.serverSeq
        ) {
          entities.put({
            entityKey: receipt.entityKey,
            vaultId: receipt.vaultId,
            revisionId: receipt.revisionId ?? null,
            serverSeq: receipt.serverSeq
          });
        }
      }
      await completion;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of a failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function getSyncMeta(key) {
    const transaction = database.transaction(stores.syncMeta, 'readonly');
    const completion = transactionCompletion(transaction);
    const record = await requestResult(transaction.objectStore(stores.syncMeta).get(key));
    await completion;
    return record && record.value;
  }

  async function setSyncMeta(key, value) {
    const transaction = database.transaction(stores.syncMeta, 'readwrite');
    const completion = transactionCompletion(transaction);
    transaction.objectStore(stores.syncMeta).put({ key, value });
    await completion;
  }

  async function clearSyncMetaIfEqual({ key, expected }) {
    const validatedKey = requireSyncString(key, 'INVALID_SYNC_META');
    const transaction = database.transaction(stores.syncMeta, 'readwrite');
    const completion = transactionCompletion(transaction);
    const meta = transaction.objectStore(stores.syncMeta);
    const existing = await requestResult(meta.get(validatedKey));
    const matches = existing
      && JSON.stringify(existing.value) === JSON.stringify(expected);
    if (matches) meta.delete(validatedKey);
    await completion;
    return Boolean(matches);
  }

  function requireSyncString(value, code) {
    if (typeof value !== 'string' || !value) throw historyDbError(code, code);
    return value;
  }

  function validateRemoteBundle(record) {
    if (
      !record
      || typeof record !== 'object'
      || !record.comment
      || typeof record.comment !== 'object'
      || !Array.isArray(record.anchors)
    ) {
      throw historyDbError('INVALID_REMOTE_COMMENT', '远端评论记录无效。');
    }
    const commentId = requireSyncString(
      record.comment.id,
      'INVALID_REMOTE_COMMENT'
    );
    for (const anchor of record.anchors) {
      if (
        !anchor
        || typeof anchor !== 'object'
        || typeof anchor.id !== 'string'
        || !anchor.id
        || anchor.commentId !== commentId
      ) {
        throw historyDbError('INVALID_REMOTE_COMMENT', '远端评论记录无效。');
      }
    }
    return record;
  }

  async function applyRemoteChangeInTransaction(transaction, vaultId, change) {
    if (
      !change
      || typeof change !== 'object'
      || !Number.isSafeInteger(change.serverSeq)
      || change.serverSeq < 0
    ) {
      throw historyDbError('INVALID_REMOTE_CHANGE', '远端同步变更无效。');
    }
    const comments = transaction.objectStore(stores.comments);
    const anchors = transaction.objectStore(stores.anchors);
    const entities = transaction.objectStore(stores.syncEntities);

    if (change.entityType === 'comment' && change.operation === 'upsert') {
      const record = validateRemoteBundle(change.record);
      const commentId = record.comment.id;
      const existing = await requestResult(comments.get(commentId));
      if (!existing || compareCommentFreshness(record.comment, existing) > 0) {
        comments.put(record.comment);
        await deleteAnchorsForComment(anchors, commentId);
        for (const anchor of record.anchors) anchors.put(anchor);
      }
      entities.put({
        entityKey: `${vaultId}:comment:${commentId}`,
        vaultId,
        revisionId: normalizeCommentRevision(record.comment).id,
        serverSeq: change.serverSeq
      });
      return;
    }

    if (change.entityType === 'setting' && change.operation === 'upsert') {
      if (!CLOUD_SYNC_SETTING_KEYS.includes(change.entityId)) {
        throw historyDbError(
          'INVALID_REMOTE_SETTING',
          '远端同步设置无效。'
        );
      }
      validateInboundSettings({ [change.entityId]: change.value });
      entities.put({
        entityKey: `${vaultId}:setting:${change.entityId}`,
        vaultId,
        revisionId: null,
        serverSeq: change.serverSeq
      });
      return;
    }

    if (
      (change.entityType === 'comment_delete' || change.entityType === 'comment')
      && change.operation === 'delete'
    ) {
      const commentId = requireSyncString(
        change.entityId ?? change.recordId,
        'INVALID_REMOTE_CHANGE'
      );
      comments.delete(commentId);
      await deleteAnchorsForComment(anchors, commentId);
      entities.put({
        entityKey: `${vaultId}:comment_delete:${commentId}`,
        vaultId,
        revisionId: change.revisionId ?? null,
        serverSeq: change.serverSeq
      });
      return;
    }

    throw historyDbError('INVALID_REMOTE_CHANGE', '远端同步变更无效。');
  }

  async function mergePendingInboundSettings(
    meta,
    vaultId,
    pendingInboundSettings
  ) {
    if (Object.keys(pendingInboundSettings).length === 0) return;
    const key = `pendingInboundSettings:${vaultId}`;
    const existing = await requestResult(meta.get(key));
    meta.put({
      key,
      value: {
        ...(existing?.value || {}),
        ...pendingInboundSettings
      }
    });
  }

  async function applyRemoteChangesAtomic({
    vaultId,
    changes,
    pendingInboundSettings = {},
    nextCursor
  }) {
    const validatedVaultId = requireSyncString(vaultId, 'INVALID_SYNC_VAULT');
    if (!Array.isArray(changes)) {
      throw historyDbError('INVALID_REMOTE_CHANGE', '远端同步变更无效。');
    }
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) {
      throw historyDbError(
        'SYNC_CURSOR_REGRESSION',
        '同步游标不能倒退。'
      );
    }
    const validatedPendingSettings = validateInboundSettings(
      pendingInboundSettings
    );
    const transaction = database.transaction([
      stores.comments,
      stores.anchors,
      stores.syncEntities,
      stores.syncMeta
    ], 'readwrite');
    const completion = transactionCompletion(transaction);
    try {
      const meta = transaction.objectStore(stores.syncMeta);
      const cursorKey = `serverCursor:${validatedVaultId}`;
      const savedCursor = await requestResult(meta.get(cursorKey));
      const currentCursor = savedCursor === undefined
        ? 0
        : savedCursor.value;
      if (
        !Number.isSafeInteger(currentCursor)
        || currentCursor < 0
        || nextCursor < currentCursor
      ) {
        throw historyDbError(
          'SYNC_CURSOR_REGRESSION',
          '同步游标不能倒退。'
        );
      }
      let previousSequence = currentCursor;
      for (const change of changes) {
        if (
          !Number.isSafeInteger(change?.serverSeq)
          || change.serverSeq <= previousSequence
        ) {
          throw historyDbError(
            'SYNC_CURSOR_REGRESSION',
            '同步游标不能倒退。'
          );
        }
        previousSequence = change.serverSeq;
      }
      if (nextCursor !== previousSequence) {
        throw historyDbError(
          'SYNC_CURSOR_REGRESSION',
          '同步游标不能倒退。'
        );
      }
      for (const change of changes) {
        await applyRemoteChangeInTransaction(transaction, validatedVaultId, change);
      }
      await mergePendingInboundSettings(
        meta,
        validatedVaultId,
        validatedPendingSettings
      );
      meta.put({
        key: `serverCursor:${validatedVaultId}`,
        value: nextCursor
      });
      await completion;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of a failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function applyBootstrapPageAtomic({
    vaultId,
    comments,
    tombstones,
    pendingInboundSettings = {},
    nextCursor,
    serverCursor,
    serverNow,
    phase,
    hasMore
  }) {
    const validatedVaultId = requireSyncString(vaultId, 'INVALID_SYNC_VAULT');
    const validatedPendingSettings = validateInboundSettings(
      pendingInboundSettings
    );
    if (
      !Array.isArray(comments)
      || !Array.isArray(tombstones)
      || !Number.isSafeInteger(serverCursor)
      || serverCursor < 0
      || !Number.isSafeInteger(serverNow)
      || serverNow < 0
      || (phase !== 'comments' && phase !== 'tombstones')
      || comments.length > 100
      || tombstones.length > 100
      || typeof hasMore !== 'boolean'
      || (
        nextCursor !== null
        && (typeof nextCursor !== 'string' || !nextCursor)
      )
      || (hasMore && nextCursor === null)
      || (!hasMore && nextCursor !== null)
    ) {
      throw historyDbError(
        'INVALID_BOOTSTRAP_PAGE',
        '初始同步页面无效。'
      );
    }
    for (const tombstone of tombstones) {
      requireSyncString(tombstone?.recordId, 'INVALID_BOOTSTRAP_PAGE');
      if (!Number.isFinite(tombstone.deletedAt)) {
        throw historyDbError(
          'INVALID_BOOTSTRAP_PAGE',
          '初始同步页面无效。'
        );
      }
    }

    const transaction = database.transaction([
      stores.comments,
      stores.anchors,
      stores.syncEntities,
      stores.syncMeta
    ], 'readwrite');
    const completion = transactionCompletion(transaction);
    try {
      const meta = transaction.objectStore(stores.syncMeta);
      const stateKey = `bootstrapState:${validatedVaultId}`;
      const savedStateRecord = await requestResult(meta.get(stateKey));
      const savedState = savedStateRecord?.value;
      const savedPhase = savedState?.phase === 'tombstones'
        ? 'tombstones'
        : 'comments';
      const expectedPhase =
        savedPhase === 'tombstones' || tombstones.length > 0
          ? 'tombstones'
          : 'comments';
      if (
        (
          Number.isSafeInteger(savedState?.serverCursor)
          && savedState.serverCursor !== serverCursor
        )
        || (
          Number.isSafeInteger(savedState?.serverNow)
          && savedState.serverNow !== serverNow
        )
        || (savedPhase === 'tombstones' && comments.length > 0)
        || phase !== expectedPhase
        || (
          savedState?.cursor !== null
          && savedState?.cursor !== undefined
          && Object.keys(validatedPendingSettings).length > 0
        )
      ) {
        throw historyDbError(
          'INVALID_BOOTSTRAP_PAGE',
          '初始同步页面无效。'
        );
      }
      for (const record of comments) {
        await applyRemoteChangeInTransaction(
          transaction,
          validatedVaultId,
          {
            serverSeq: serverCursor,
            entityType: 'comment',
            operation: 'upsert',
            record
          }
        );
      }
      for (const tombstone of tombstones) {
        await applyRemoteChangeInTransaction(
          transaction,
          validatedVaultId,
          {
            serverSeq: serverCursor,
            entityType: 'comment_delete',
            entityId: tombstone.recordId,
            operation: 'delete'
          }
        );
      }
      for (const settingKey of Object.keys(validatedPendingSettings)) {
        transaction.objectStore(stores.syncEntities).put({
          entityKey: `${validatedVaultId}:setting:${settingKey}`,
          vaultId: validatedVaultId,
          revisionId: null,
          serverSeq: serverCursor
        });
      }
      await mergePendingInboundSettings(
        meta,
        validatedVaultId,
        validatedPendingSettings
      );
      meta.put({
        key: stateKey,
        value: {
          cursor: nextCursor,
          serverCursor,
          serverNow,
          phase,
          done: !hasMore
        }
      });
      if (!hasMore) {
        meta.put({
          key: `serverCursor:${validatedVaultId}`,
          value: serverCursor
        });
      }
      await completion;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of a failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function clearPendingInboundSettings({ vaultId, expected }) {
    const validatedVaultId = requireSyncString(vaultId, 'INVALID_SYNC_VAULT');
    const validatedExpected = validateInboundSettings(expected);
    const key = `pendingInboundSettings:${validatedVaultId}`;
    const transaction = database.transaction(stores.syncMeta, 'readwrite');
    const completion = transactionCompletion(transaction);
    const meta = transaction.objectStore(stores.syncMeta);
    const existing = await requestResult(meta.get(key));
    if (
      existing
      && JSON.stringify(existing.value) === JSON.stringify(validatedExpected)
    ) {
      meta.delete(key);
    }
    await completion;
  }

  async function applyCloudHistoryDeletion({
    vaultId,
    recordId,
    serverSeq
  }) {
    const validatedVaultId = requireSyncString(vaultId, 'INVALID_SYNC_VAULT');
    const validatedRecordId = requireSyncString(
      recordId,
      'INVALID_REMOTE_CHANGE'
    );
    if (
      serverSeq !== null
      && (!Number.isSafeInteger(serverSeq) || serverSeq < 0)
    ) {
      throw historyDbError(
        'INVALID_REMOTE_CHANGE',
        '远端同步变更无效。'
      );
    }
    const transaction = database.transaction([
      stores.comments,
      stores.anchors,
      stores.syncEntities
    ], 'readwrite');
    const completion = transactionCompletion(transaction);
    try {
      transaction.objectStore(stores.comments).delete(validatedRecordId);
      await deleteAnchorsForComment(
        transaction.objectStore(stores.anchors),
        validatedRecordId
      );
      transaction.objectStore(stores.syncEntities).put({
        entityKey: `${validatedVaultId}:comment_delete:${validatedRecordId}`,
        vaultId: validatedVaultId,
        revisionId: null,
        serverSeq
      });
      await completion;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of a failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function scanRecordsForInitialSync({ cursor, limit }) {
    if (cursor != null && typeof cursor !== 'string') {
      throw historyDbError('INVALID_INITIAL_SYNC_CURSOR', '初始同步游标无效。');
    }
    if (cursor != null && !IDBKeyRangeImpl) {
      throw new TypeError('IDBKeyRange is required for initial sync scans');
    }
    const transaction = database.transaction(
      [stores.comments, stores.anchors],
      'readonly'
    );
    const completion = transactionCompletion(transaction);
    const comments = transaction.objectStore(stores.comments);
    const anchors = transaction.objectStore(stores.anchors);
    const maxResults = safeLimit(limit);
    const bundles = [];
    const range = cursor == null ? null : IDBKeyRangeImpl.lowerBound(cursor, true);

    await new Promise((resolve, reject) => {
      const request = comments.openCursor(range, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const commentCursor = request.result;
        if (!commentCursor) {
          resolve();
          return;
        }
        anchorsForComment(anchors, commentCursor.value.id).then((commentAnchors) => {
          bundles.push({
            comment: commentCursor.value,
            anchors: commentAnchors
          });
          if (bundles.length > maxResults) {
            resolve();
          } else {
            commentCursor.continue();
          }
        }, reject);
      };
    });
    await completion;

    const records = bundles.slice(0, maxResults);
    return {
      records,
      cursor: records.length ? records.at(-1).comment.id : (cursor ?? null),
      done: bundles.length <= maxResults
    };
  }

  async function evictSyncedCacheBefore({ vaultId, cutoff }) {
    const validatedVaultId = requireSyncString(vaultId, 'INVALID_SYNC_VAULT');
    if (!Number.isFinite(cutoff)) {
      throw historyDbError('INVALID_CACHE_CUTOFF', '同步缓存截止时间无效。');
    }
    if (!IDBKeyRangeImpl) {
      throw new TypeError('IDBKeyRange is required for synced cache eviction');
    }
    const transaction = database.transaction(
      [stores.comments, stores.anchors, stores.syncEntities, stores.syncOutbox],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const comments = transaction.objectStore(stores.comments);
    const anchors = transaction.objectStore(stores.anchors);
    const entities = transaction.objectStore(stores.syncEntities);
    const outbox = transaction.objectStore(stores.syncOutbox);
    let deletedCount = 0;

    try {
      const pendingCommentIds = new Set();
      await cursorAll(outbox, null, 'next', (outboxCursor, next) => {
        const mutation = outboxCursor.value;
        if (
          mutation.vaultId === validatedVaultId
          && (mutation.entityType === 'comment' || mutation.entityType === 'comment_delete')
        ) {
          pendingCommentIds.add(mutation.entityId);
        }
        next();
      });

      await new Promise((resolve, reject) => {
        const request = comments.index('by_submitted_at').openCursor(
          IDBKeyRangeImpl.upperBound(cutoff, true),
          'next'
        );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const commentCursor = request.result;
          if (!commentCursor) {
            resolve();
            return;
          }
          const comment = commentCursor.value;
          if (pendingCommentIds.has(comment.id)) {
            commentCursor.continue();
            return;
          }
          requestResult(
            entities.get(`${validatedVaultId}:comment:${comment.id}`)
          ).then(async (entity) => {
            if (
              entity?.vaultId === validatedVaultId
              && Number.isSafeInteger(entity.serverSeq)
              && entity.serverSeq >= 0
              && entity.revisionId === normalizeCommentRevision(comment).id
            ) {
              commentCursor.delete();
              await deleteAnchorsForComment(anchors, comment.id);
              deletedCount += 1;
            }
            commentCursor.continue();
          }, reject);
        };
      });
      await completion;
      return deletedCount;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of a failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function insertLegacyIfAbsent({ comment, anchors }) {
    const transaction = database.transaction([stores.comments, stores.anchors], 'readwrite');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);

    try {
      const existing = await requestResult(commentStore.get(comment.id));
      if (existing) {
        await completion;
        return false;
      }
      commentStore.add(comment);
      for (const anchor of anchors) anchorStore.add(anchor);
      await completion;
      return true;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of the failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function getRecord(id) {
    const transaction = database.transaction([stores.comments, stores.anchors], 'readonly');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    const commentRequest = commentStore.get(id);
    const anchorsPromise = collectCursor(anchorStore.index('by_comment_id'), id, 'next');
    const [comment, anchors] = await Promise.all([requestResult(commentRequest), anchorsPromise]);
    await completion;
    if (!comment) return null;
    anchors.sort((left, right) => left.position - right.position);
    return { comment, anchors };
  }

  function normalCursorPlan(commentStore, filter, cursor) {
    if (!IDBKeyRangeImpl) throw new TypeError('IDBKeyRange is required for history queries');
    let indexName = 'by_submitted_at_id';
    let prefix = [];
    if (filter.targetDomain != null) {
      indexName = 'by_target_domain_submitted_at';
      prefix = [filter.targetDomain];
    } else if (filter.promotedDomain != null) {
      indexName = 'by_promoted_domain_submitted_at';
      prefix = [filter.promotedDomain];
    }

    const lower = [...prefix, filter.from ?? -Number.MAX_VALUE, ''];
    let upper = [...prefix, filter.to ?? Number.MAX_VALUE, '\uffff\uffff'];
    let upperOpen = false;
    if (cursor && cursor.submittedAt <= upper.at(-2)) {
      upper = [...prefix, cursor.submittedAt, String(cursor.id)];
      upperOpen = true;
    }
    const comparison = indexedDBImpl.cmp(lower, upper);
    return {
      indexName,
      source: commentStore.index(indexName),
      range: comparison > 0 || (comparison === 0 && upperOpen)
        ? null
        : IDBKeyRangeImpl.bound(lower, upper, false, upperOpen),
      empty: comparison > 0 || (comparison === 0 && upperOpen)
    };
  }

  async function anchorsForComment(anchorStore, commentId) {
    const anchors = await collectCursor(anchorStore.index('by_comment_id'), commentId, 'next');
    anchors.sort((left, right) => left.position - right.position);
    return anchors;
  }

  async function collectNormalEntries(
    transaction,
    filter,
    cursor,
    maxResults,
    includeAnchors
  ) {
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = includeAnchors ? transaction.objectStore(stores.anchors) : null;
    const plan = normalCursorPlan(commentStore, filter, cursor);
    if (plan.empty) return [];
    const entries = [];

    await new Promise((resolve, reject) => {
      const request = plan.source.openCursor(plan.range, 'prev');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const recordCursor = request.result;
        if (!recordCursor) {
          resolve();
          return;
        }
        onQueryCursorVisit({ kind: 'normal', indexName: plan.indexName });
        const comment = recordCursor.value;
        if (!matchesComment(comment, filter) || !isAfterCommentCursor(comment, cursor)) {
          recordCursor.continue();
          return;
        }
        if (!includeAnchors) {
          entries.push(comment);
          if (entries.length >= maxResults) {
            resolve();
          } else {
            recordCursor.continue();
          }
          return;
        }

        anchorsForComment(anchorStore, comment.id).then((anchors) => {
          entries.push({ comment, anchors });
          if (entries.length >= maxResults) {
            resolve();
          } else {
            recordCursor.continue();
          }
        }, reject);
      };
    });
    return entries;
  }

  function anchorMatches(anchor, filter) {
    if (
      filter.anchorTextPrefix != null
      && !anchor.anchorTextNormalized.startsWith(filter.anchorTextPrefix)
    ) {
      return false;
    }
    if (filter.hrefDomain != null && anchor.hrefDomain !== filter.hrefDomain) return false;
    return true;
  }

  function anchorTuple(anchor, byText) {
    return {
      anchorKey: byText ? anchor.anchorTextNormalized : anchor.hrefDomain,
      anchorPrimaryKey: anchor.id
    };
  }

  async function inspectCommentAnchors(anchorStore, commentId, filter, byText, currentTuple) {
    const anchors = [];
    let canonical = null;
    await cursorAll(anchorStore.index('by_comment_id'), commentId, 'next', (cursor, next) => {
      const anchor = cursor.value;
      anchors.push(anchor);
      if (anchorMatches(anchor, filter)) {
        const tuple = anchorTuple(anchor, byText);
        if (!canonical || compareAnchorCandidates(tuple, canonical) < 0) canonical = tuple;
      }
      next();
    });
    anchors.sort((left, right) => left.position - right.position);
    return {
      anchors,
      isCanonical: canonical != null
        && canonical.anchorKey === currentTuple.anchorKey
        && compareIdbStrings(canonical.anchorPrimaryKey, currentTuple.anchorPrimaryKey) === 0
    };
  }

  function anchorCursorPlan(anchorStore, filter, cursor) {
    const byText = filter.anchorTextPrefix != null;
    const indexName = byText ? 'by_anchor_text' : 'by_href_domain';
    const index = anchorStore.index(indexName);
    if (!byText) {
      return {
        byText,
        index,
        indexName,
        range: IDBKeyRangeImpl.only(filter.hrefDomain)
      };
    }
    const lower = cursor && compareIdbStrings(cursor.anchorKey, filter.anchorTextPrefix) > 0
      ? cursor.anchorKey
      : filter.anchorTextPrefix;
    return {
      byText,
      index,
      indexName,
      range: IDBKeyRangeImpl.bound(lower, `${filter.anchorTextPrefix}\uffff`)
    };
  }

  async function collectAnchorEntries(
    transaction,
    filter,
    cursor,
    maxResults,
    includeAnchors,
    countOnly = false
  ) {
    if (!IDBKeyRangeImpl) throw new TypeError('IDBKeyRange is required for anchor queries');
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    const plan = anchorCursorPlan(anchorStore, filter, cursor);
    const candidates = [];
    let count = 0;

    await new Promise((resolve, reject) => {
      const request = plan.index.openCursor(plan.range, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const anchorCursor = request.result;
        if (!anchorCursor) {
          resolve();
          return;
        }
        const currentTuple = {
          anchorKey: anchorCursor.key,
          anchorPrimaryKey: anchorCursor.primaryKey
        };
        if (!anchorTupleAfter(cursor, currentTuple.anchorKey, currentTuple.anchorPrimaryKey)) {
          if (
            cursor
            && currentTuple.anchorKey === cursor.anchorKey
            && compareIdbStrings(currentTuple.anchorPrimaryKey, cursor.anchorPrimaryKey) < 0
            && typeof anchorCursor.continuePrimaryKey === 'function'
          ) {
            anchorCursor.continuePrimaryKey(cursor.anchorKey, cursor.anchorPrimaryKey);
          } else {
            anchorCursor.continue();
          }
          return;
        }
        onQueryCursorVisit({ kind: 'anchor', indexName: plan.indexName });
        if (!anchorMatches(anchorCursor.value, filter)) {
          anchorCursor.continue();
          return;
        }

        inspectCommentAnchors(
          anchorStore,
          anchorCursor.value.commentId,
          filter,
          plan.byText,
          currentTuple
        ).then((inspection) => {
          if (!inspection.isCanonical) {
            anchorCursor.continue();
            return;
          }
          const commentRequest = commentStore.get(anchorCursor.value.commentId);
          commentRequest.onerror = () => reject(commentRequest.error);
          commentRequest.onsuccess = () => {
            const comment = commentRequest.result;
            if (comment && matchesComment(comment, filter)) {
              count += 1;
              if (!countOnly) {
                candidates.push({
                  comment,
                  anchors: includeAnchors ? inspection.anchors : undefined,
                  ...currentTuple
                });
              }
            }
            if (count >= maxResults) {
              resolve();
            } else {
              anchorCursor.continue();
            }
          };
        }, reject);
      };
    });
    return { candidates, count };
  }

  async function queryRecords(filter = {}) {
    const criteria = normalizedFilter(filter);
    const limit = safeLimit(filter.limit);
    const isAnchorQuery = criteria.anchorTextPrefix != null || criteria.hrefDomain != null;
    const transaction = database.transaction(
      isAnchorQuery ? [stores.comments, stores.anchors] : stores.comments,
      'readonly'
    );
    const completion = transactionCompletion(transaction);
    if (isAnchorQuery) {
      const { candidates } = await collectAnchorEntries(
        transaction,
        criteria,
        filter.cursor,
        limit + 1,
        false
      );
      await completion;
      const page = candidates.slice(0, limit);
      return {
        records: page.map(({ comment }) => comment),
        nextCursor: candidates.length > limit
          ? {
              anchorKey: page.at(-1).anchorKey,
              anchorPrimaryKey: page.at(-1).anchorPrimaryKey
            }
          : null
      };
    }

    const comments = await collectNormalEntries(
      transaction,
      criteria,
      filter.cursor,
      limit + 1,
      false
    );
    await completion;
    const page = comments.slice(0, limit);
    return {
      records: page,
      nextCursor: comments.length > limit && page.length
        ? { submittedAt: page.at(-1).submittedAt, id: page.at(-1).id }
        : null
    };
  }

  async function countRecords(filter = {}) {
    const criteria = normalizedFilter(filter);
    if (criteria.anchorTextPrefix != null || criteria.hrefDomain != null) {
      const transaction = database.transaction([stores.comments, stores.anchors], 'readonly');
      const completion = transactionCompletion(transaction);
      const { count } = await collectAnchorEntries(
        transaction,
        criteria,
        null,
        Number.POSITIVE_INFINITY,
        false,
        true
      );
      await completion;
      return count;
    }
    const transaction = database.transaction(stores.comments, 'readonly');
    const completion = transactionCompletion(transaction);
    const plan = normalCursorPlan(transaction.objectStore(stores.comments), criteria, null);
    let count = 0;
    await cursorAll(plan.source, plan.range, 'next', (cursor, next) => {
      if (matchesComment(cursor.value, criteria)) count += 1;
      next();
    });
    await completion;
    return count;
  }

  async function getRetentionSummary(now) {
    if (!IDBKeyRangeImpl) {
      throw new TypeError('IDBKeyRange is required for retention summaries');
    }
    const transaction = database.transaction(stores.comments, 'readonly');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const submittedAtIndex = commentStore.index('by_submitted_at');
    const last24Hours = now - DAY_MS;
    const dueSoon = now - 80 * DAY_MS;
    const expired = now - 90 * DAY_MS;
    const totalCountRequest = commentStore.count();
    const last24HoursCountRequest = submittedAtIndex.count(
      IDBKeyRangeImpl.lowerBound(last24Hours)
    );
    const dueSoonCountRequest = submittedAtIndex.count(
      IDBKeyRangeImpl.bound(expired, dueSoon, true, false)
    );
    const expiredCountRequest = submittedAtIndex.count(
      IDBKeyRangeImpl.upperBound(expired)
    );
    const oldestSubmittedAtPromise = new Promise((resolve, reject) => {
      const request = submittedAtIndex.openKeyCursor(null, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.key ?? null);
    });
    const [
      totalCount,
      last24HoursCount,
      dueSoonCount,
      expiredCount,
      oldestSubmittedAt
    ] = await Promise.all([
      requestResult(totalCountRequest),
      requestResult(last24HoursCountRequest),
      requestResult(dueSoonCountRequest),
      requestResult(expiredCountRequest),
      oldestSubmittedAtPromise
    ]);
    await completion;
    return {
      totalCount,
      last24HoursCount,
      dueSoonCount,
      expiredCount,
      oldestSubmittedAt
    };
  }

  async function getExportChunk(filter = {}) {
    const criteria = normalizedFilter(filter);
    const limit = safeLimit(filter.limit);
    const transaction = database.transaction([stores.comments, stores.anchors], 'readonly');
    const completion = transactionCompletion(transaction);
    const isAnchorQuery = criteria.anchorTextPrefix != null || criteria.hrefDomain != null;
    if (isAnchorQuery) {
      const { candidates } = await collectAnchorEntries(
        transaction,
        criteria,
        filter.cursor,
        limit + 1,
        true
      );
      await completion;
      const page = candidates.slice(0, limit);
      return {
        records: page.map(({ comment, anchors }) => ({ comment, anchors })),
        nextCursor: candidates.length > limit
          ? {
              anchorKey: page.at(-1).anchorKey,
              anchorPrimaryKey: page.at(-1).anchorPrimaryKey
            }
          : null
      };
    }

    const bundles = await collectNormalEntries(
      transaction,
      criteria,
      filter.cursor,
      limit + 1,
      true
    );
    await completion;
    const page = bundles.slice(0, limit);
    return {
      records: page,
      nextCursor: bundles.length > limit && page.length
        ? { submittedAt: page.at(-1).comment.submittedAt, id: page.at(-1).comment.id }
        : null
    };
  }

  async function deleteConfirmed(criteria = {}, archiveEvent) {
    const filter = normalizedFilter(criteria);
    const transaction = database.transaction(
      [stores.comments, stores.anchors, stores.archives],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    const archiveStore = transaction.objectStore(stores.archives);
    let deletedCount = 0;

    try {
      archiveStore.add(archiveEvent);
      let commentIds;
      if (filter.anchorTextPrefix != null || filter.hrefDomain != null) {
        if (!IDBKeyRangeImpl) throw new TypeError('IDBKeyRange is required for anchor queries');
        const plan = anchorCursorPlan(anchorStore, filter, null);
        commentIds = new Set();
        await cursorAll(plan.index, plan.range, 'next', (cursor, next) => {
          if (anchorMatches(cursor.value, filter)) commentIds.add(cursor.value.commentId);
          next();
        });
      } else {
        const plan = normalCursorPlan(commentStore, filter, null);
        commentIds = new Set(await collectCursor(
          plan.source,
          plan.range,
          'next',
          (cursor) => cursor.value.id
        ));
      }

      for (const commentId of commentIds) {
        const comment = await requestResult(commentStore.get(commentId));
        if (!comment || !matchesComment(comment, filter)) continue;
        commentStore.delete(commentId);
        await deleteAnchorsForComment(anchorStore, commentId);
        deletedCount += 1;
      }
      await completion;
      return deletedCount;
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of the failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  function commentHasMatchingAnchor(anchorStore, commentId, filter) {
    return new Promise((resolve, reject) => {
      const request = anchorStore.index('by_comment_id').openCursor(commentId, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(false);
          return;
        }
        if (anchorMatches(cursor.value, filter)) {
          resolve(true);
          return;
        }
        cursor.continue();
      };
    });
  }

  async function streamMatchingSnapshotComments(
    commentStore,
    anchorStore,
    filter,
    pass,
    visit
  ) {
    const isAnchorQuery = (
      filter.anchorTextPrefix != null
      || filter.hrefDomain != null
    );
    const plan = normalCursorPlan(commentStore, filter, null);
    if (plan.empty) return;
    let inFlightRecords = 0;

    await new Promise((resolve, reject) => {
      const request = plan.source.openCursor(plan.range, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const comment = cursor.value;
        if (!matchesComment(comment, filter)) {
          cursor.continue();
          return;
        }

        const handleMatch = (matchesAnchors) => {
          if (!matchesAnchors) {
            cursor.continue();
            return;
          }
          inFlightRecords += 1;
          onCleanupCursorVisit({
            pass,
            kind: isAnchorQuery ? 'anchor' : 'normal',
            commentId: comment.id,
            inFlightRecords
          });
          const continueAfterVisit = () => {
            inFlightRecords -= 1;
            cursor.continue();
          };
          try {
            const visitResult = visit(comment, cursor);
            if (visitResult && typeof visitResult.then === 'function') {
              visitResult.then(continueAfterVisit, reject);
            } else {
              continueAfterVisit();
            }
          } catch (error) {
            reject(error);
          }
        };

        if (isAnchorQuery) {
          commentHasMatchingAnchor(anchorStore, comment.id, filter)
            .then(handleMatch, reject);
        } else {
          handleMatch(true);
        }
      };
    });
  }

  async function deleteExportSessionAtomic({
    exportSessionId,
    confirmedAt
  } = {}) {
    const sessionId = typeof exportSessionId === 'string' ? exportSessionId.trim() : '';
    if (!sessionId) {
      throw historyDbError('EXPORT_SESSION_REQUIRED', '缺少有效的导出会话。');
    }
    if (!Number.isFinite(confirmedAt)) {
      throw historyDbError('HISTORY_REQUEST_FAILED', '评论历史请求失败。');
    }

    const transaction = database.transaction(
      [stores.comments, stores.anchors, stores.archives, stores.meta],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    const archiveStore = transaction.objectStore(stores.archives);
    const metaStore = transaction.objectStore(stores.meta);
    const metaKey = `${EXPORT_META_PREFIX}${sessionId}`;

    try {
      const metaRecord = await requestResult(metaStore.get(metaKey));
      const descriptor = metaRecord?.value;
      if (!descriptor || descriptor.exportSessionId !== sessionId) {
        throw historyDbError(
          'EXPORT_SESSION_NOT_FOUND',
          '导出会话不存在，请重新导出。'
        );
      }
      if (descriptor.consumedAt != null) {
        throw historyDbError(
          'EXPORT_SESSION_CONSUMED',
          '该导出会话已完成清理，请重新导出。'
        );
      }
      if (
        descriptor.finalizedAt == null
        || !Array.isArray(descriptor.filenames)
        || descriptor.filenames.length === 0
      ) {
        throw historyDbError('EXPORT_NOT_FINALIZED', '请先完成导出归档。');
      }
      if (
        !Number.isInteger(descriptor.expectedCount)
        || descriptor.expectedCount < 0
        || !Number.isFinite(descriptor.exportedBefore)
        || !descriptor.criteria
        || typeof descriptor.criteria !== 'object'
      ) {
        throw historyDbError(
          'EXPORT_SESSION_INVALID',
          '导出会话无效，请重新导出。'
        );
      }

      const snapshotFilter = normalizedFilter({
        ...descriptor.criteria,
        exportedBefore: descriptor.exportedBefore
      });
      const expiryCutoff = confirmedAt - RETENTION_DAYS * DAY_MS;
      let matchingCount = 0;
      let includesUnexpiredRecord = false;
      await streamMatchingSnapshotComments(
        commentStore,
        anchorStore,
        snapshotFilter,
        'validate',
        (comment) => {
          matchingCount += 1;
          if (comment.submittedAt > expiryCutoff) includesUnexpiredRecord = true;
        }
      );
      if (matchingCount !== descriptor.expectedCount) {
        throw historyDbError(
          'EXPORT_SET_CHANGED',
          '导出后的记录集合已变化，请重新导出。'
        );
      }
      if (includesUnexpiredRecord) {
        throw historyDbError(
          'RETENTION_NOT_EXPIRED',
          '只能删除已保留满 90 天的评论历史。'
        );
      }

      let deletedCount = 0;
      await streamMatchingSnapshotComments(
        commentStore,
        anchorStore,
        snapshotFilter,
        'delete',
        (comment, cursor) => {
          deletedCount += 1;
          return Promise.all([
            requestResult(cursor.delete()),
            deleteAnchorsForComment(anchorStore, comment.id)
          ]);
        }
      );
      if (deletedCount !== descriptor.expectedCount) {
        throw historyDbError(
          'EXPORT_SET_CHANGED',
          '导出后的记录集合已变化，请重新导出。'
        );
      }
      const archiveEvent = {
        id: `archive:${sessionId}`,
        rangeStart: descriptor.criteria.from ?? null,
        rangeEnd: descriptor.criteria.to ?? expiryCutoff,
        recordCount: descriptor.expectedCount,
        fileNames: descriptor.filenames,
        exportStartedAt: descriptor.startedAt,
        deleteConfirmedAt: confirmedAt,
        deletedAt: confirmedAt
      };
      archiveStore.add(archiveEvent);
      onBeforeExportSessionConsume({
        exportSessionId: sessionId,
        descriptor,
        archiveEvent
      });
      metaStore.put({
        key: metaKey,
        value: {
          ...descriptor,
          consumedAt: confirmedAt
        }
      });
      await completion;
      return {
        deletedCount,
        exportSessionId: sessionId
      };
    } catch (error) {
      if (transaction.readyState !== 'done') {
        try {
          transaction.abort();
        } catch (_) {
          // The transaction may already have aborted because of the failed request.
        }
      }
      await completion.catch(() => {});
      throw error;
    }
  }

  async function listArchiveEvents() {
    const transaction = database.transaction(stores.archives, 'readonly');
    const completion = transactionCompletion(transaction);
    const events = await collectCursor(transaction.objectStore(stores.archives), null, 'next');
    await completion;
    return events;
  }

  async function getMeta(key) {
    const transaction = database.transaction(stores.meta, 'readonly');
    const completion = transactionCompletion(transaction);
    const record = await requestResult(transaction.objectStore(stores.meta).get(key));
    await completion;
    return record && record.value;
  }

  async function setMeta(key, value) {
    const transaction = database.transaction(stores.meta, 'readwrite');
    const completion = transactionCompletion(transaction);
    transaction.objectStore(stores.meta).put({ key, value });
    await completion;
  }

  return {
    upsertRecord,
    upsertIfFresher,
    enqueueSyncMutation,
    listDueSyncMutations,
    markSyncMutationAttempt,
    completeSyncMutations,
    getSyncMeta,
    setSyncMeta,
    clearSyncMetaIfEqual,
    scanRecordsForInitialSync,
    applyRemoteChangesAtomic,
    applyBootstrapPageAtomic,
    clearPendingInboundSettings,
    applyCloudHistoryDeletion,
    evictSyncedCacheBefore,
    insertLegacyIfAbsent,
    getRecord,
    queryRecords,
    countRecords,
    getRetentionSummary,
    getExportChunk,
    deleteConfirmed,
    deleteExportSessionAtomic,
    listArchiveEvents,
    getMeta,
    setMeta,
    close: () => database.close()
  };
}
