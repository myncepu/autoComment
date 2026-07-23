const DEFAULT_DB_NAME = 'auto_comment_history';
const DATABASE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function compareCommentsDescending(left, right) {
  return right.submittedAt - left.submittedAt || String(right.id).localeCompare(String(left.id));
}

function isAfterCommentCursor(comment, cursor) {
  if (!cursor) return true;
  return comment.submittedAt < cursor.submittedAt
    || (comment.submittedAt === cursor.submittedAt && String(comment.id) < String(cursor.id));
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

function selectCommentSource(commentStore, filter) {
  if (filter.targetDomain != null) {
    return { source: commentStore.index('by_target_domain'), range: filter.targetDomain };
  }
  if (filter.promotedDomain != null) {
    return { source: commentStore.index('by_promoted_domain'), range: filter.promotedDomain };
  }
  return { source: commentStore.index('by_submitted_at'), range: null };
}

function anchorTupleAfter(cursor, anchorKey, anchorPrimaryKey) {
  if (!cursor) return true;
  if (anchorKey > cursor.anchorKey) return true;
  return anchorKey === cursor.anchorKey && String(anchorPrimaryKey) > String(cursor.anchorPrimaryKey);
}

function compareAnchorCandidates(left, right) {
  if (left.anchorKey < right.anchorKey) return -1;
  if (left.anchorKey > right.anchorKey) return 1;
  return String(left.anchorPrimaryKey).localeCompare(String(right.anchorPrimaryKey));
}

function safeLimit(value, fallback = 50) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, 1000);
}

export async function openCommentHistoryDb({
  indexedDBImpl = globalThis.indexedDB,
  dbName = DEFAULT_DB_NAME,
  IDBKeyRangeImpl = globalThis.IDBKeyRange
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

  async function collectNormalComments(filter, cursor, maxResults = Number.POSITIVE_INFINITY) {
    const transaction = database.transaction(stores.comments, 'readonly');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const selected = selectCommentSource(commentStore, filter);
    const comments = [];
    await cursorAll(selected.source, selected.range, 'prev', (entry, next) => {
      const comment = entry.value;
      if (matchesComment(comment, filter) && isAfterCommentCursor(comment, cursor)) {
        comments.push(comment);
        comments.sort(compareCommentsDescending);
        if (comments.length > maxResults) comments.length = maxResults;
      }
      next();
    });
    await completion;
    return comments;
  }

  async function collectAnchorComments(filter, cursor, maxResults = Number.POSITIVE_INFINITY) {
    if (!IDBKeyRangeImpl) throw new TypeError('IDBKeyRange is required for anchor queries');
    const transaction = database.transaction([stores.comments, stores.anchors], 'readonly');
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore(stores.comments);
    const anchorStore = transaction.objectStore(stores.anchors);
    const byText = filter.anchorTextPrefix != null;
    const index = anchorStore.index(byText ? 'by_anchor_text' : 'by_href_domain');
    const range = byText
      ? IDBKeyRangeImpl.bound(filter.anchorTextPrefix, `${filter.anchorTextPrefix}\uffff`)
      : IDBKeyRangeImpl.only(filter.hrefDomain);
    const candidates = new Map();
    const seenCommentIds = new Set();

    await new Promise((resolve, reject) => {
      const request = index.openCursor(range, 'next');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const anchorCursor = request.result;
        if (!anchorCursor) {
          resolve();
          return;
        }
        const anchorKey = anchorCursor.key;
        const anchorPrimaryKey = anchorCursor.primaryKey;
        if (seenCommentIds.has(anchorCursor.value.commentId)) {
          anchorCursor.continue();
          return;
        }
        seenCommentIds.add(anchorCursor.value.commentId);

        const commentRequest = commentStore.get(anchorCursor.value.commentId);
        commentRequest.onerror = () => reject(commentRequest.error);
        commentRequest.onsuccess = () => {
          const comment = commentRequest.result;
          if (comment && matchesComment(comment, filter)) {
            if (anchorTupleAfter(cursor, anchorKey, anchorPrimaryKey)) {
              candidates.set(comment.id, { comment, anchorKey, anchorPrimaryKey });
            }
          }
          if (candidates.size >= maxResults) {
            resolve();
            return;
          }
          anchorCursor.continue();
        };
      };
    });
    await completion;
    return [...candidates.values()].sort(compareAnchorCandidates);
  }

  async function queryRecords(filter = {}) {
    const criteria = normalizedFilter(filter);
    const limit = safeLimit(filter.limit);
    if (criteria.anchorTextPrefix != null || criteria.hrefDomain != null) {
      const candidates = await collectAnchorComments(criteria, filter.cursor, limit + 1);
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

    const comments = await collectNormalComments(criteria, filter.cursor, limit + 1);
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
      return (await collectAnchorComments(criteria, null)).length;
    }
    const transaction = database.transaction(stores.comments, 'readonly');
    const completion = transactionCompletion(transaction);
    const selected = selectCommentSource(transaction.objectStore(stores.comments), criteria);
    let count = 0;
    await cursorAll(selected.source, selected.range, 'next', (cursor, next) => {
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
    const page = await queryRecords(filter);
    const records = [];
    for (const comment of page.records) {
      const bundle = await getRecord(comment.id);
      if (bundle) records.push(bundle);
    }
    return { records, nextCursor: page.nextCursor };
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
        const byText = filter.anchorTextPrefix != null;
        const index = anchorStore.index(byText ? 'by_anchor_text' : 'by_href_domain');
        const range = byText
          ? IDBKeyRangeImpl.bound(filter.anchorTextPrefix, `${filter.anchorTextPrefix}\uffff`)
          : IDBKeyRangeImpl.only(filter.hrefDomain);
        commentIds = new Set(await collectCursor(
          index,
          range,
          'next',
          (cursor) => cursor.value.commentId
        ));
      } else {
        const selected = selectCommentSource(commentStore, filter);
        commentIds = new Set(await collectCursor(
          selected.source,
          selected.range,
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
    listArchiveEvents,
    getMeta,
    setMeta,
    close: () => database.close()
  };
}
