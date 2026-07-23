import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommentHistoryService } from '../lib/comment-history-service.mjs';

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
    historySaveStatus: 'saved'
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

test('queues a repository failure under the independent record key', async () => {
  const storageLocal = createStorage();
  const message = makeMessage();
  const service = createCommentHistoryService({
    repository: { async upsertRecord() { throw new Error('db down'); } },
    storageLocal
  });

  assert.deepEqual(await service.saveConfirmedSuccess(message), {
    historySaveStatus: 'queued'
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
      async upsertRecord(bundle) {
        attempts.push(bundle.comment.id);
        if (bundle.comment.id === 'batch-a:2') throw new Error('still down');
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
    repository: { async upsertRecord(bundle) { migrated.push(bundle); } },
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
    repository: { async upsertRecord() { writeCount += 1; } },
    storageLocal
  });

  assert.equal((await service.migrateLegacyResults()).migrationStatus, 'migrated');
  assert.deepEqual(await service.migrateLegacyResults(), {
    migrationStatus: 'already_migrated',
    migrated: 0
  });
  assert.equal(writeCount, 1);
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
