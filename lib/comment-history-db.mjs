const DEFAULT_DB_NAME = 'auto_comment_history';
const DATABASE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const EXPORT_META_PREFIX = 'historyExport:';

const stores = {
  comments: 'comment_records',
  anchors: 'comment_anchors',
  archives: 'archive_events',
  meta: 'history_meta'
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

      const anchors = database.createObjectStore(stores.anchors, { keyPath: 'id' });
      anchors.createIndex('by_comment_id', 'commentId');
      anchors.createIndex('by_anchor_text', 'anchorTextNormalized');
      anchors.createIndex('by_href_domain', 'hrefDomain');

      database.createObjectStore(stores.archives, { keyPath: 'id' });
      database.createObjectStore(stores.meta, { keyPath: 'key' });
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

export async function openCommentHistoryDb({
  indexedDBImpl = globalThis.indexedDB,
  dbName = DEFAULT_DB_NAME,
  IDBKeyRangeImpl = globalThis.IDBKeyRange,
  onQueryCursorVisit = () => {},
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
    const transaction = database.transaction(stores.comments, 'readonly');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const summary = {
      totalCount: 0,
      last24HoursCount: 0,
      dueSoonCount: 0,
      expiredCount: 0,
      oldestSubmittedAt: null
    };
    const last24Hours = now - DAY_MS;
    const dueSoon = now - 80 * DAY_MS;
    const expired = now - 90 * DAY_MS;

    await cursorAll(commentStore.index('by_submitted_at'), null, 'next', (cursor, next) => {
      const { submittedAt } = cursor.value;
      summary.totalCount += 1;
      if (submittedAt >= last24Hours) summary.last24HoursCount += 1;
      if (submittedAt <= dueSoon && submittedAt > expired) summary.dueSoonCount += 1;
      if (submittedAt <= expired) summary.expiredCount += 1;
      if (summary.oldestSubmittedAt == null) summary.oldestSubmittedAt = submittedAt;
      next();
    });
    await completion;
    return summary;
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
      let candidateIds;
      const isAnchorQuery = (
        snapshotFilter.anchorTextPrefix != null
        || snapshotFilter.hrefDomain != null
      );
      if (isAnchorQuery) {
        if (!IDBKeyRangeImpl) {
          throw new TypeError('IDBKeyRange is required for anchor queries');
        }
        const plan = anchorCursorPlan(anchorStore, snapshotFilter, null);
        candidateIds = new Set();
        await cursorAll(plan.index, plan.range, 'next', (cursor, next) => {
          if (anchorMatches(cursor.value, snapshotFilter)) {
            candidateIds.add(cursor.value.commentId);
          }
          next();
        });
      } else {
        const plan = normalCursorPlan(commentStore, snapshotFilter, null);
        candidateIds = new Set(await collectCursor(
          plan.source,
          plan.range,
          'next',
          (cursor) => cursor.value.id
        ));
      }

      const matchingComments = [];
      for (const commentId of candidateIds) {
        const comment = await requestResult(commentStore.get(commentId));
        if (comment && matchesComment(comment, snapshotFilter)) {
          matchingComments.push(comment);
        }
      }
      if (matchingComments.length !== descriptor.expectedCount) {
        throw historyDbError(
          'EXPORT_SET_CHANGED',
          '导出后的记录集合已变化，请重新导出。'
        );
      }

      const expiryCutoff = confirmedAt - RETENTION_DAYS * DAY_MS;
      if (matchingComments.some((comment) => comment.submittedAt > expiryCutoff)) {
        throw historyDbError(
          'RETENTION_NOT_EXPIRED',
          '只能删除已保留满 90 天的评论历史。'
        );
      }

      for (const comment of matchingComments) {
        commentStore.delete(comment.id);
        await deleteAnchorsForComment(anchorStore, comment.id);
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
        deletedCount: matchingComments.length,
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
