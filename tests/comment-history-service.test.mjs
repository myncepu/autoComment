import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommentHistoryService } from '../lib/comment-history-service.mjs';
import { buildCsvPartName } from '../lib/comment-history-csv.mjs';

function makeMessage(overrides = {}) {
  return {
    batchId: 'batch-a',
    urlIndex: 7,
    result: 'success',
    history: {
      submittedAt: 1721000000000,
      targetPageUrl: 'https://target.test/post',
      promotedWebsiteUrl: 'https://promo.test/',
      commentHtml: 'Exact <a href="/go">comment</a>',
      commentText: 'Exact comment',
      anchors: [{
        anchorText: 'comment',
        hrefRaw: '/go',
        hrefResolved: 'https://target.test/go',
        hrefDomain: 'target.test'
      }]
    },
    ...overrides
  };
}

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, structuredClone(data[key])])
      );
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

test('stores exactly one normalized bundle for a confirmed success', async () => {
  const writes = [];
  const repository = {
    async upsertRecord(bundle) {
      writes.push(bundle);
    }
  };
  const storageLocal = createStorage();
  const service = createCommentHistoryService({
    repository,
    storageLocal,
    now: () => 1721000000100
  });

  assert.deepEqual(await service.saveConfirmedSuccess(makeMessage()), {
    historySaveStatus: 'saved',
    pendingCount: 0
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].comment.id, 'batch-a:7');
  assert.equal(writes[0].comment.commentHtml, 'Exact <a href="/go">comment</a>');
  assert.equal(writes[0].anchors[0].hrefRaw, '/go');
});

test('skips history writes for every non-success result', async () => {
  let writeCount = 0;
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { writeCount += 1; } },
    storageLocal: createStorage()
  });

  for (const result of ['fail', 'skipped', 'manual_required', 'blocked_illegal']) {
    assert.deepEqual(
      await service.saveConfirmedSuccess(makeMessage({ result })),
      { historySaveStatus: 'not_applicable' }
    );
  }
  assert.equal(writeCount, 0);
});

test('defaults only nullish results to success and preserves explicit falsey results', async () => {
  let writeCount = 0;
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { writeCount += 1; } },
    storageLocal: createStorage()
  });

  for (const result of ['', false, 0]) {
    assert.deepEqual(
      await service.saveConfirmedSuccess(makeMessage({ result })),
      { historySaveStatus: 'not_applicable' }
    );
  }
  assert.equal(writeCount, 0);
});

test('treats only marked pre-upgrade success contexts without history as not applicable', async () => {
  let writeCount = 0;
  const storageLocal = createStorage();
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { writeCount += 1; } },
    storageLocal
  });

  assert.deepEqual(
    await service.saveConfirmedSuccess(makeMessage({
      history: undefined,
      historyUnavailableReason: 'legacy_context'
    })),
    { historySaveStatus: 'not_applicable' }
  );
  assert.deepEqual(
    await service.saveConfirmedSuccess(makeMessage({
      history: undefined,
      historyUnavailableReason: 'unexpected'
    })),
    { historySaveStatus: 'failed' }
  );
  assert.equal(writeCount, 0);
  assert.deepEqual(storageLocal.data, {});
});

test('queues a repository failure under the independent record key', async () => {
  const storageLocal = createStorage();
  const message = makeMessage();
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { throw new Error('db down'); } },
    storageLocal
  });

  assert.deepEqual(await service.saveConfirmedSuccess(message), {
    historySaveStatus: 'queued',
    pendingCount: 1
  });
  assert.deepEqual(storageLocal.data['historyPending:batch-a:7'], message);
});

test('retry removes only successful pending keys and leaves failures isolated', async () => {
  const first = makeMessage({ urlIndex: 1 });
  const second = makeMessage({ urlIndex: 2 });
  const storageLocal = createStorage({
    'historyPending:batch-a:1': first,
    'historyPending:batch-a:2': second,
    unrelated: { keep: true }
  });
  const attempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertPendingUnlessLive(bundle) {
        attempts.push(bundle.comment.id);
        if (bundle.comment.id === 'batch-a:2') throw new Error('still down');
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 2,
    saved: 1,
    pending: 1
  });
  assert.deepEqual(attempts, ['batch-a:1', 'batch-a:2']);
  assert.equal(Object.hasOwn(storageLocal.data, 'historyPending:batch-a:1'), false);
  assert.deepEqual(storageLocal.data['historyPending:batch-a:2'], second);
  assert.deepEqual(storageLocal.data.unrelated, { keep: true });
});

test('bounds each retry trigger and reports the full remaining pending count', async () => {
  const pending = {};
  for (let index = 0; index < 30; index += 1) {
    pending[`historyPending:batch-retry:${index}`] = makeMessage({
      batchId: 'batch-retry',
      urlIndex: index
    });
  }
  const storageLocal = createStorage(pending);
  const attempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertPendingUnlessLive(bundle) {
        attempts.push(bundle.comment.id);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 25,
    saved: 25,
    pending: 5
  });
  assert.equal(attempts.length, 25);
  assert.equal(
    Object.keys(storageLocal.data)
      .filter((key) => key.startsWith('historyPending:')).length,
    5
  );
});

test('direct save removes its stale key and non-recursively retries other pending records', async () => {
  const direct = makeMessage({ batchId: 'batch-live', urlIndex: 7 });
  const pending = {
    'historyPending:batch-live:7': {
      ...direct,
      history: {
        ...direct.history,
        commentHtml: 'stale queued body',
        commentText: 'stale queued body'
      }
    }
  };
  for (let index = 0; index < 27; index += 1) {
    pending[`historyPending:batch-other:${index}`] = makeMessage({
      batchId: 'batch-other',
      urlIndex: index
    });
  }
  const storageLocal = createStorage(pending);
  const attempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertRecord(bundle) {
        attempts.push(bundle.comment.id);
      },
      async upsertPendingUnlessLive(bundle) {
        attempts.push(bundle.comment.id);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.saveConfirmedSuccess(direct), {
    historySaveStatus: 'saved',
    pendingCount: 2
  });
  assert.equal(attempts[0], 'batch-live:7');
  assert.equal(attempts.filter((id) => id === 'batch-live:7').length, 1);
  assert.equal(attempts.length, 26);
  assert.equal(
    Object.hasOwn(storageLocal.data, 'historyPending:batch-live:7'),
    false
  );
  assert.equal(
    Object.keys(storageLocal.data)
      .filter((key) => key.startsWith('historyPending:')).length,
    2
  );
});

test('direct save preserves fresh data and reports the queue when stale-key removal fails', async () => {
  const direct = makeMessage({
    batchId: 'batch-live',
    urlIndex: 7,
    history: {
      ...makeMessage().history,
      submittedAt: 1721000001000,
      commentHtml: 'fresh direct body',
      commentText: 'fresh direct body'
    }
  });
  const staleKey = 'historyPending:batch-live:7';
  const otherKey = 'historyPending:batch-other:1';
  const storageLocal = createStorage({
    [staleKey]: {
      ...direct,
      history: {
        ...direct.history,
        submittedAt: 1721000000000,
        commentHtml: 'stale queued body',
        commentText: 'stale queued body'
      }
    },
    [otherKey]: makeMessage({ batchId: 'batch-other', urlIndex: 1 })
  });
  const originalRemove = storageLocal.remove.bind(storageLocal);
  storageLocal.remove = async (key) => {
    if (key === staleKey) throw new Error('targeted stale-key removal failure');
    return originalRemove(key);
  };
  const storedBodies = new Map();
  const directAttempts = [];
  const pendingAttempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertRecord(bundle) {
        directAttempts.push(bundle.comment.id);
        storedBodies.set(bundle.comment.id, bundle.comment.commentHtml);
      },
      async upsertPendingUnlessLive(bundle) {
        pendingAttempts.push(bundle.comment.id);
        if (storedBodies.has(bundle.comment.id)) return false;
        storedBodies.set(bundle.comment.id, bundle.comment.commentHtml);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.saveConfirmedSuccess(direct), {
    historySaveStatus: 'saved',
    pendingCount: 2
  });
  assert.deepEqual(directAttempts, ['batch-live:7']);
  assert.equal(storedBodies.get('batch-live:7'), 'fresh direct body');
  assert.equal(Object.hasOwn(storageLocal.data, staleKey), true);
  assert.equal(Object.hasOwn(storageLocal.data, otherKey), true);

  storageLocal.remove = originalRemove;
  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 2,
    saved: 1,
    discarded: 1,
    pending: 0
  });
  assert.deepEqual(pendingAttempts, ['batch-live:7', 'batch-other:1']);
  assert.equal(storedBodies.get('batch-live:7'), 'fresh direct body');
  assert.equal(Object.hasOwn(storageLocal.data, staleKey), false);
  assert.equal(Object.hasOwn(storageLocal.data, otherKey), false);
});

test('retry consumes reachable not-applicable and malformed pending entries', async () => {
  const storageLocal = createStorage({
    'historyPending:bad:1': makeMessage({
      batchId: 'bad',
      urlIndex: 1,
      history: undefined,
      historyUnavailableReason: 'legacy_context'
    }),
    'historyPending:bad:2': makeMessage({
      batchId: 'bad',
      urlIndex: 2,
      result: 'manual_required',
      history: undefined
    }),
    'historyPending:bad:3': {
      batchId: 'bad',
      urlIndex: 3,
      result: 'success',
      history: { submittedAt: 'not-a-number' }
    }
  });
  let writeCount = 0;
  const service = createCommentHistoryService({
    repository: {
      async upsertRecord() {
        writeCount += 1;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 3,
    saved: 0,
    discarded: 3,
    pending: 0
  });
  assert.equal(writeCount, 0);
  assert.deepEqual(storageLocal.data, {});
});

test('bounded retries eventually reach valid entries behind more than 25 poison keys', async () => {
  const pending = {};
  for (let index = 0; index < 27; index += 1) {
    pending[`historyPending:000-bad:${String(index).padStart(2, '0')}`] = {
      batchId: '000-bad',
      urlIndex: index,
      result: 'success',
      history: undefined
    };
  }
  pending['historyPending:zzz-valid:1'] = makeMessage({
    batchId: 'zzz-valid',
    urlIndex: 1
  });
  const storageLocal = createStorage(pending);
  const attempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertPendingUnlessLive(bundle) {
        attempts.push(bundle.comment.id);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 25,
    saved: 1,
    discarded: 24,
    pending: 3
  });
  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 3,
    saved: 0,
    discarded: 3,
    pending: 0
  });
  assert.deepEqual(attempts, ['zzz-valid:1']);
  assert.deepEqual(storageLocal.data, {});
});

test('terminal cleanup failures cannot consume the valid write-attempt budget', async () => {
  const pending = {};
  const poisonKeys = new Set();
  for (let index = 0; index < 25; index += 1) {
    const key = `historyPending:000-poison:${String(index).padStart(2, '0')}`;
    poisonKeys.add(key);
    if (index % 3 === 0) {
      pending[key] = makeMessage({ result: 'fail' });
    } else if (index % 3 === 1) {
      pending[key] = makeMessage({
        history: undefined,
        historyUnavailableReason: 'legacy_context'
      });
    } else {
      pending[key] = makeMessage({ history: { submittedAt: 'bad' } });
    }
  }
  const validKey = 'historyPending:zzz-valid:1';
  pending[validKey] = makeMessage({ batchId: 'zzz-valid', urlIndex: 1 });
  const storageLocal = createStorage(pending);
  const originalRemove = storageLocal.remove.bind(storageLocal);
  storageLocal.remove = async (key) => {
    if (poisonKeys.has(key)) throw new Error('poison cleanup unavailable');
    return originalRemove(key);
  };
  const attempts = [];
  const service = createCommentHistoryService({
    repository: {
      async upsertRecord() {
        throw new Error('retry must use the atomic pending path');
      },
      async upsertPendingUnlessLive(bundle) {
        attempts.push(bundle.comment.id);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.retryPendingWrites(), {
    retried: 25,
    saved: 1,
    pending: 25
  });
  assert.deepEqual(attempts, ['zzz-valid:1']);
  assert.equal(Object.hasOwn(storageLocal.data, validKey), false);
});

test('queue maintenance failures never downgrade an already durable direct save', async () => {
  let writeCount = 0;
  const service = createCommentHistoryService({
    repository: {
      async upsertRecord() {
        writeCount += 1;
      }
    },
    storageLocal: {
      async remove() {
        throw new Error('storage remove unavailable');
      },
      async get() {
        throw new Error('storage get unavailable');
      },
      async set() {
        throw new Error('must not requeue a saved record');
      }
    }
  });

  assert.deepEqual(await service.saveConfirmedSuccess(makeMessage()), {
    historySaveStatus: 'saved'
  });
  assert.equal(writeCount, 1);
});

test('returns failed when both repository and retry storage fail', async () => {
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { throw new Error('db down'); } },
    storageLocal: {
      async set() { throw new Error('storage down'); }
    }
  });

  assert.deepEqual(await service.saveConfirmedSuccess(makeMessage()), {
    historySaveStatus: 'failed'
  });
});

test('migrates successful entries from both legacy shapes and marks the migration', async () => {
  const shared = {
    result: 'success',
    urlIndex: 1,
    url: 'https://legacy.test/one',
    aiContent: '<a href="/one">One</a>',
    timestamp: 1721000000000
  };
  const storageLocal = createStorage({
    batchResults: [
      { ...shared, batchId: 'batch-old' },
      { ...shared, batchId: 'batch-old', result: 'fail', urlIndex: 2 }
    ],
    batchLocalResults: {
      batchId: 'batch-local',
      results: [
        { ...shared, urlIndex: 3, url: 'https://legacy.test/three' },
        { ...shared, urlIndex: 4, result: 'skipped' }
      ]
    }
  });
  const migrated = [];
  const service = createCommentHistoryService({
    repository: {
      async insertLegacyIfAbsent(bundle) {
        migrated.push(bundle);
        return true;
      }
    },
    storageLocal
  });

  assert.deepEqual(await service.migrateLegacyResults(), {
    migrationStatus: 'migrated',
    migrated: 2
  });
  assert.deepEqual(migrated.map((bundle) => bundle.comment.id), [
    'batch-old:1',
    'batch-local:3'
  ]);
  assert.ok(migrated.every((bundle) => bundle.comment.source === 'legacy'));
  assert.equal(storageLocal.data.legacyMigrationV1, true);
});

test('migration restart is idempotent after the completion marker is written', async () => {
  const storageLocal = createStorage({
    batchResults: [{
      batchId: 'batch-old',
      result: 'success',
      urlIndex: 1,
      url: 'https://legacy.test/one',
      aiContent: 'One',
      timestamp: 1721000000000
    }]
  });
  let writeCount = 0;
  const service = createCommentHistoryService({
    repository: {
      async insertLegacyIfAbsent() {
        writeCount += 1;
        return true;
      }
    },
    storageLocal
  });

  assert.equal((await service.migrateLegacyResults()).migrationStatus, 'migrated');
  assert.deepEqual(await service.migrateLegacyResults(), {
    migrationStatus: 'already_migrated',
    migrated: 0
  });
  assert.equal(writeCount, 1);
});

test('an interrupted migration rerun counts only transactional inserts', async () => {
  const storageLocal = createStorage({
    batchResults: [{
      batchId: 'batch-interrupted',
      result: 'success',
      urlIndex: 1,
      url: 'https://legacy.test/one',
      aiContent: 'Legacy fallback',
      timestamp: 1721000000000
    }]
  });
  const originalSet = storageLocal.set.bind(storageLocal);
  let markerAttempts = 0;
  storageLocal.set = async (values) => {
    if (Object.hasOwn(values, 'legacyMigrationV1') && markerAttempts++ === 0) {
      throw new Error('worker stopped before marker write');
    }
    return originalSet(values);
  };
  let present = false;
  let insertAttempts = 0;
  const service = createCommentHistoryService({
    repository: {
      async insertLegacyIfAbsent() {
        insertAttempts += 1;
        if (present) return false;
        present = true;
        return true;
      }
    },
    storageLocal
  });

  await assert.rejects(
    service.migrateLegacyResults(),
    /worker stopped before marker write/
  );
  assert.deepEqual(await service.migrateLegacyResults(), {
    migrationStatus: 'migrated',
    migrated: 0
  });
  assert.equal(insertAttempts, 2);
  assert.equal(storageLocal.data.legacyMigrationV1, true);
});

test('exposes repository-backed history queries with the injected clock', async () => {
  const calls = [];
  const repository = {
    async getRetentionSummary(timestamp) {
      calls.push(['getRetentionSummary', timestamp]);
      return { total: 3 };
    },
    async queryRecords(query) {
      calls.push(['queryRecords', query]);
      return { records: [{ id: 'batch-a:7' }] };
    },
    async getRecord(commentId) {
      calls.push(['getRecord', commentId]);
      if (commentId === 'missing') return null;
      return {
        comment: { id: commentId },
        anchors: [{ id: `${commentId}:0` }]
      };
    },
    async listArchiveEvents() {
      calls.push(['listArchiveEvents']);
      return [{ id: 'archive-a' }];
    }
  };
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => 1721000000100
  });

  assert.deepEqual(await service.getSummary(), { total: 3 });
  assert.deepEqual(
    await service.listRecords({ targetDomain: 'target.test', limit: 50 }),
    { records: [{ id: 'batch-a:7' }] }
  );
  assert.deepEqual(await service.getAnchors('batch-a:7'), [{
    id: 'batch-a:7:0'
  }]);
  assert.deepEqual(await service.getAnchors('missing'), []);
  assert.deepEqual(await service.getRetentionStatus(), { total: 3 });
  assert.deepEqual(await service.listArchiveEvents(), [{ id: 'archive-a' }]);
  assert.deepEqual(calls, [
    ['getRetentionSummary', 1721000000100],
    ['queryRecords', { targetDomain: 'target.test', limit: 50 }],
    ['getRecord', 'batch-a:7'],
    ['getRecord', 'missing'],
    ['getRetentionSummary', 1721000000100],
    ['listArchiveEvents']
  ]);
});

function createExportRepository({
  count = 2,
  expiredCount = count,
  chunk = { records: [], nextCursor: null },
  deletedCount = count,
  atomicErrorCode = ''
} = {}) {
  const meta = new Map();
  const calls = [];
  const repository = {
    calls,
    meta,
    atomicErrorCode,
    async countRecords(criteria) {
      calls.push(['countRecords', criteria]);
      const expiryBound = criteria.to;
      return Number.isFinite(expiryBound) && expiryBound <= Date.UTC(2026, 3, 25, 12)
        ? expiredCount
        : count;
    },
    async getExportChunk(criteria) {
      calls.push(['getExportChunk', criteria]);
      return chunk;
    },
    async deleteConfirmed(criteria, archiveEvent) {
      calls.push(['deleteConfirmed', criteria, archiveEvent]);
      return deletedCount;
    },
    async deleteExportSessionAtomic(payload) {
      calls.push(['deleteExportSessionAtomic', payload]);
      if (repository.atomicErrorCode) {
        const error = new Error(repository.atomicErrorCode);
        error.code = repository.atomicErrorCode;
        throw error;
      }
      const key = `historyExport:${payload.exportSessionId}`;
      const descriptor = meta.get(key);
      if (descriptor?.consumedAt != null) {
        const error = new Error('EXPORT_SESSION_CONSUMED');
        error.code = 'EXPORT_SESSION_CONSUMED';
        throw error;
      }
      meta.set(key, {
        ...descriptor,
        consumedAt: payload.confirmedAt
      });
      return {
        deletedCount,
        exportSessionId: payload.exportSessionId
      };
    },
    async getMeta(key) {
      calls.push(['getMeta', key]);
      return structuredClone(meta.get(key));
    },
    async setMeta(key, value) {
      calls.push(['setMeta', key, value]);
      meta.set(key, structuredClone(value));
    }
  };
  return repository;
}

const EXPORT_NOW = Date.UTC(2026, 6, 24, 12);
const OLD_TO = EXPORT_NOW - 90 * 24 * 60 * 60 * 1000;

async function finalizedExport(service, criteria = { to: OLD_TO }) {
  const started = await service.startExport(criteria);
  const filenames = Array.from(
    { length: Math.max(1, Math.ceil(started.expectedCount / 50_000)) },
    (_, index) => buildCsvPartName({
      ...started.criteria,
      exportedBefore: started.exportedBefore,
      part: index + 1
    })
  );
  await service.finishExport({
    exportSessionId: started.exportSessionId,
    filenames
  });
  return started;
}

test('stores one export snapshot descriptor and serves only 500-row session chunks', async () => {
  const repository = createExportRepository({
    count: 3,
    chunk: {
      records: [{ comment: { id: 'batch-a:7' }, anchors: [] }],
      nextCursor: { submittedAt: 100, id: 'batch-a:7' }
    }
  });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });

  assert.deepEqual(await service.startExport({
    targetDomain: ' TARGET.TEST ',
    to: OLD_TO,
    limit: 1,
    injected: true
  }), {
    exportSessionId: 'export-session-a',
    exportedBefore: EXPORT_NOW,
    expectedCount: 3,
    cleanupEligible: true,
    cleanupEligibleCount: 3,
    snapshotRange: {
      from: null,
      to: OLD_TO
    },
    criteria: {
      to: OLD_TO,
      targetDomain: 'target.test'
    }
  });
  assert.deepEqual(repository.meta.get('historyExport:export-session-a'), {
    exportSessionId: 'export-session-a',
    criteria: {
      to: OLD_TO,
      targetDomain: 'target.test'
    },
    exportedBefore: EXPORT_NOW,
    expectedCount: 3,
    cleanupEligible: true,
    cleanupEligibleCount: 3,
    snapshotRange: {
      from: null,
      to: OLD_TO
    },
    startedAt: EXPORT_NOW,
    filenames: [],
    finalizedAt: null,
    consumedAt: null
  });

  const cursor = { submittedAt: 100, id: 'batch-a:7' };
  assert.deepEqual(await service.getExportChunk({
    exportSessionId: 'export-session-a',
    cursor,
    limit: 50_000,
    targetDomain: 'injected.test'
  }), {
    records: [{ comment: { id: 'batch-a:7' }, anchors: [] }],
    nextCursor: cursor
  });
  assert.deepEqual(repository.calls.find(([name]) => name === 'getExportChunk')[1], {
    to: OLD_TO,
    targetDomain: 'target.test',
    exportedBefore: EXPORT_NOW,
    cursor,
    limit: 500
  });
});

test('marks a mixed-age export as archive-only from authoritative snapshot counts and range', async () => {
  const repository = createExportRepository({
    count: 3,
    expiredCount: 2
  });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'mixed-export-session'
  });

  assert.deepEqual(await service.startExport({ targetDomain: 'mixed.test' }), {
    exportSessionId: 'mixed-export-session',
    exportedBefore: EXPORT_NOW,
    expectedCount: 3,
    cleanupEligible: false,
    cleanupEligibleCount: 2,
    snapshotRange: {
      from: null,
      to: EXPORT_NOW
    },
    criteria: {
      targetDomain: 'mixed.test'
    }
  });
  assert.deepEqual(
    repository.calls.filter(([name]) => name === 'countRecords'),
    [
      ['countRecords', {
        targetDomain: 'mixed.test',
        exportedBefore: EXPORT_NOW
      }],
      ['countRecords', {
        targetDomain: 'mixed.test',
        to: OLD_TO,
        exportedBefore: EXPORT_NOW
      }]
    ]
  );
  assert.equal(
    repository.meta.get('historyExport:mixed-export-session').cleanupEligible,
    false
  );
});

test('requires explicit deletion confirmation even for a finalized export', async () => {
  const repository = createExportRepository();
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });
  const started = await finalizedExport(service);

  await assert.rejects(
    service.deleteConfirmed({
      confirmed: false,
      exportSessionId: started.exportSessionId
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED'
  );
  assert.equal(
    repository.calls.some(([name]) => name === 'deleteExportSessionAtomic'),
    false
  );
});

test('finalizes only the canonical complete filename set for every 50,000-row part', async () => {
  const repository = createExportRepository({ count: 50_001 });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });
  const started = await service.startExport({ to: OLD_TO });

  await assert.rejects(
    service.finishExport({
      exportSessionId: started.exportSessionId,
      filenames: ['comment-history-all-20260425-part-001.csv']
    }),
    (error) => error.code === 'EXPORT_FILENAMES_MISMATCH'
  );
  assert.equal(repository.meta.get('historyExport:export-session-a').finalizedAt, null);
});

test('preserves the atomic repository error when the matching set is under 90 days old', async () => {
  const repository = createExportRepository({
    count: 2,
    expiredCount: 1,
    atomicErrorCode: 'RETENTION_NOT_EXPIRED'
  });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });
  const started = await finalizedExport(service, {});

  await assert.rejects(
    service.deleteConfirmed({
      confirmed: true,
      exportSessionId: started.exportSessionId
    }),
    (error) => error.code === 'RETENTION_NOT_EXPIRED'
  );
  assert.equal(
    repository.calls.filter(([name]) => name === 'deleteExportSessionAtomic').length,
    1
  );
});

test('preserves the atomic repository error when the exported set count changed', async () => {
  const repository = createExportRepository({ count: 2 });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });
  const started = await finalizedExport(service);
  repository.atomicErrorCode = 'EXPORT_SET_CHANGED';

  await assert.rejects(
    service.deleteConfirmed({
      confirmed: true,
      exportSessionId: started.exportSessionId
    }),
    (error) => error.code === 'EXPORT_SET_CHANGED'
  );
  assert.equal(
    repository.calls.filter(([name]) => name === 'deleteExportSessionAtomic').length,
    1
  );
});

test('delegates finalized deletion and observes the atomically consumed session', async () => {
  const repository = createExportRepository({ count: 2, deletedCount: 2 });
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    now: () => EXPORT_NOW,
    createExportSessionId: () => 'export-session-a'
  });
  const started = await finalizedExport(service, {
    from: 1,
    to: OLD_TO,
    hrefDomain: 'links.test'
  });

  assert.deepEqual(await service.deleteConfirmed({
    confirmed: true,
    exportSessionId: started.exportSessionId
  }), {
    deletedCount: 2,
    exportSessionId: 'export-session-a'
  });
  const deleteCall = repository.calls.find(
    ([name]) => name === 'deleteExportSessionAtomic'
  );
  assert.deepEqual(deleteCall[1], {
    exportSessionId: 'export-session-a',
    confirmedAt: EXPORT_NOW
  });
  assert.equal(
    repository.meta.get('historyExport:export-session-a').consumedAt,
    EXPORT_NOW
  );

  await assert.rejects(
    service.deleteConfirmed({
      confirmed: true,
      exportSessionId: started.exportSessionId
    }),
    (error) => error.code === 'EXPORT_SESSION_CONSUMED'
  );
  assert.equal(
    repository.calls.filter(([name]) => name === 'deleteExportSessionAtomic').length,
    2
  );
});

test('delegates confirmed cleanup to one atomic repository operation without service prechecks', async () => {
  const calls = [];
  const service = createCommentHistoryService({
    repository: {
      async getMeta() {
        throw new Error('service must not open a session read transaction');
      },
      async countRecords() {
        throw new Error('service must not open a count transaction');
      },
      async deleteExportSessionAtomic(payload) {
        calls.push(payload);
        return {
          deletedCount: 2,
          exportSessionId: 'export-session-a'
        };
      }
    },
    storageLocal: createStorage(),
    now: () => EXPORT_NOW
  });

  assert.deepEqual(await service.deleteConfirmed({
    confirmed: true,
    exportSessionId: ' export-session-a '
  }), {
    deletedCount: 2,
    exportSessionId: 'export-session-a'
  });
  assert.deepEqual(calls, [{
    exportSessionId: 'export-session-a',
    confirmedAt: EXPORT_NOW
  }]);
});
