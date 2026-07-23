import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openCommentHistoryDb } from '../lib/comment-history-db.mjs';

globalThis.IDBKeyRange = IDBKeyRange;

let databaseSequence = 0;

function makeBundle({
  id = 'batch-a:0',
  submittedAt = 1721000000000,
  targetDomain = 'target.test',
  promotedDomain = 'promo.test',
  updatedAt = submittedAt + 1,
  anchors = []
} = {}) {
  const [batchId, rawUrlIndex] = id.split(':');
  return {
    comment: {
      id,
      batchId,
      urlIndex: Number(rawUrlIndex),
      submittedAt,
      archiveMonth: '2024-07',
      targetPageUrl: `https://${targetDomain}/post`,
      targetDomain,
      promotedWebsiteUrl: promotedDomain ? `https://${promotedDomain}/` : '',
      promotedDomain,
      commentHtml: `<p>${id}</p>`,
      commentText: id,
      submitStatus: 'submitted',
      source: 'live',
      createdAt: submittedAt,
      updatedAt
    },
    anchors: anchors.map((anchor, position) => ({
      id: `${id}:${position}`,
      commentId: id,
      position,
      anchorText: anchor.anchorText,
      anchorTextNormalized: anchor.anchorText.toLowerCase(),
      hrefRaw: anchor.hrefRaw || `https://${anchor.hrefDomain}/`,
      hrefResolved: anchor.hrefResolved || `https://${anchor.hrefDomain}/`,
      hrefDomain: anchor.hrefDomain
    }))
  };
}

async function openRepo(t) {
  const indexedDBImpl = new IDBFactory();
  const dbName = `comment-history-test-${databaseSequence += 1}`;
  const repo = await openCommentHistoryDb({ indexedDBImpl, dbName });
  t.after(() => repo.close());
  return { repo, indexedDBImpl, dbName };
}

function openDatabase(indexedDBImpl, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

test('creates the version 1 stores and indexes exactly as designed', async (t) => {
  const { repo, indexedDBImpl, dbName } = await openRepo(t);
  repo.close();

  const db = await openDatabase(indexedDBImpl, dbName);
  t.after(() => db.close());
  assert.equal(db.version, 1);
  assert.deepEqual([...db.objectStoreNames], [
    'archive_events',
    'comment_anchors',
    'comment_records',
    'history_meta'
  ]);

  const transaction = db.transaction(['comment_records', 'comment_anchors'], 'readonly');
  const comments = transaction.objectStore('comment_records');
  const anchors = transaction.objectStore('comment_anchors');
  assert.deepEqual([...comments.indexNames], [
    'by_archive_month',
    'by_batch_task',
    'by_promoted_domain',
    'by_submitted_at',
    'by_target_domain'
  ]);
  assert.deepEqual([...anchors.indexNames], [
    'by_anchor_text',
    'by_comment_id',
    'by_href_domain'
  ]);
  assert.equal(comments.index('by_batch_task').unique, true);
});

test('upsert replaces anchors and rolls back the whole transaction on an invalid anchor', async (t) => {
  const { repo } = await openRepo(t);
  const original = makeBundle({
    anchors: [
      { anchorText: 'First', hrefDomain: 'one.test' },
      { anchorText: 'Second', hrefDomain: 'two.test' }
    ]
  });
  await repo.upsertRecord(original);

  const replacementAnchor = makeBundle({
    anchors: [{ anchorText: 'Replacement', hrefDomain: 'new.test' }]
  }).anchors[0];
  await repo.upsertRecord({ ...original, anchors: [replacementAnchor] });
  assert.deepEqual((await repo.getRecord(original.comment.id)).anchors, [replacementAnchor]);

  const changedComment = { ...original.comment, commentText: 'must roll back', updatedAt: original.comment.updatedAt + 20 };
  const invalidAnchor = { ...replacementAnchor };
  delete invalidAnchor.id;
  await assert.rejects(
    repo.upsertRecord({ comment: changedComment, anchors: [replacementAnchor, invalidAnchor] })
  );

  assert.deepEqual(await repo.getRecord(original.comment.id), {
    comment: original.comment,
    anchors: [replacementAnchor]
  });
});

test('paginates comments in descending submission order with a stable cursor', async (t) => {
  const { repo } = await openRepo(t);
  const records = [
    makeBundle({ id: 'batch-a:0', submittedAt: 100 }),
    makeBundle({ id: 'batch-a:1', submittedAt: 300 }),
    makeBundle({ id: 'batch-a:2', submittedAt: 200 }),
    makeBundle({ id: 'batch-a:3', submittedAt: 200 })
  ];
  for (const record of records) await repo.upsertRecord(record);

  const first = await repo.queryRecords({ limit: 2 });
  assert.deepEqual(first.records.map((record) => record.id), ['batch-a:1', 'batch-a:3']);
  assert.deepEqual(first.nextCursor, { submittedAt: 200, id: 'batch-a:3' });

  const second = await repo.queryRecords({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.records.map((record) => record.id), ['batch-a:2', 'batch-a:0']);
  assert.equal(second.nextCursor, null);
});

test('filters by target domain, promoted domain, and inclusive date bounds', async (t) => {
  const { repo } = await openRepo(t);
  const records = [
    makeBundle({ id: 'batch-a:0', submittedAt: 100, targetDomain: 'alpha.test', promotedDomain: 'one.test' }),
    makeBundle({ id: 'batch-a:1', submittedAt: 200, targetDomain: 'beta.test', promotedDomain: 'one.test' }),
    makeBundle({ id: 'batch-a:2', submittedAt: 300, targetDomain: 'alpha.test', promotedDomain: 'two.test' })
  ];
  for (const record of records) await repo.upsertRecord(record);

  assert.deepEqual(
    (await repo.queryRecords({ targetDomain: 'alpha.test', from: 150, to: 300, limit: 10 }))
      .records.map((record) => record.id),
    ['batch-a:2']
  );
  assert.deepEqual(
    (await repo.queryRecords({ promotedDomain: 'one.test', limit: 10 }))
      .records.map((record) => record.id),
    ['batch-a:1', 'batch-a:0']
  );
  assert.equal(await repo.countRecords({ targetDomain: 'alpha.test' }), 2);
});

test('joins unique comments for anchor text prefix and href domain filters', async (t) => {
  const { repo } = await openRepo(t);
  await repo.upsertRecord(makeBundle({
    id: 'batch-a:0',
    submittedAt: 100,
    anchors: [
      { anchorText: 'Alpha one', hrefDomain: 'links.test' },
      { anchorText: 'Alpha two', hrefDomain: 'links.test' }
    ]
  }));
  await repo.upsertRecord(makeBundle({
    id: 'batch-a:1',
    submittedAt: 200,
    anchors: [{ anchorText: 'Beta', hrefDomain: 'other.test' }]
  }));
  await repo.upsertRecord(makeBundle({
    id: 'batch-a:2',
    submittedAt: 300,
    anchors: [{ anchorText: 'Alphabet', hrefDomain: 'links.test' }]
  }));

  const byText = await repo.queryRecords({ anchorTextPrefix: 'alpha', limit: 10 });
  assert.deepEqual(new Set(byText.records.map((record) => record.id)), new Set(['batch-a:0', 'batch-a:2']));
  assert.equal(byText.nextCursor, null);
  const byHref = await repo.queryRecords({ hrefDomain: 'links.test', limit: 10 });
  assert.deepEqual(new Set(byHref.records.map((record) => record.id)), new Set(['batch-a:0', 'batch-a:2']));
  assert.equal(await repo.countRecords({ anchorTextPrefix: 'alpha' }), 2);
});

test('does not repeat a comment across anchor-filter pages', async (t) => {
  const { repo } = await openRepo(t);
  await repo.upsertRecord(makeBundle({
    id: 'batch-a:0',
    anchors: [
      { anchorText: 'Alpha first', hrefDomain: 'links.test' },
      { anchorText: 'Alpha last', hrefDomain: 'links.test' }
    ]
  }));
  await repo.upsertRecord(makeBundle({
    id: 'batch-a:1',
    anchors: [{ anchorText: 'Alpha middle', hrefDomain: 'links.test' }]
  }));

  const first = await repo.queryRecords({ anchorTextPrefix: 'alpha', limit: 1 });
  const second = await repo.queryRecords({
    anchorTextPrefix: 'alpha',
    limit: 1,
    cursor: first.nextCursor
  });
  assert.notEqual(second.records[0].id, first.records[0].id);
  assert.equal(second.nextCursor, null);
});

test('reports rolling retention counts at exact 24-hour boundaries', async (t) => {
  const { repo } = await openRepo(t);
  const day = 24 * 60 * 60 * 1000;
  const now = 200 * day;
  for (const [index, age] of [0, 1, 79, 80, 89, 90, 97].entries()) {
    await repo.upsertRecord(makeBundle({
      id: `batch-a:${index}`,
      submittedAt: now - age * day
    }));
  }

  assert.deepEqual(await repo.getRetentionSummary(now), {
    totalCount: 7,
    last24HoursCount: 2,
    dueSoonCount: 2,
    expiredCount: 2,
    oldestSubmittedAt: now - 97 * day
  });
});

test('exports an updatedAt snapshot and atomically deletes the exact confirmed criteria', async (t) => {
  const { repo } = await openRepo(t);
  const oldMatching = makeBundle({
    id: 'batch-a:0',
    submittedAt: 100,
    updatedAt: 150,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Delete', hrefDomain: 'link.test' }]
  });
  const changedAfterExport = makeBundle({
    id: 'batch-a:1',
    submittedAt: 110,
    updatedAt: 500,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Keep changed', hrefDomain: 'link.test' }]
  });
  const otherDomain = makeBundle({
    id: 'batch-a:2',
    submittedAt: 120,
    updatedAt: 150,
    targetDomain: 'keep.test'
  });
  for (const record of [oldMatching, changedAfterExport, otherDomain]) await repo.upsertRecord(record);

  const criteria = {
    targetDomain: 'delete.test',
    from: 0,
    to: 200,
    exportedBefore: 200,
    limit: 1
  };
  const exported = await repo.getExportChunk(criteria);
  assert.deepEqual(exported.records, [oldMatching]);
  assert.equal(exported.nextCursor, null);

  const archiveEvent = {
    id: 'archive-1',
    rangeStart: 0,
    rangeEnd: 200,
    recordCount: 1,
    fileNames: ['part.csv'],
    exportStartedAt: 201,
    deleteConfirmedAt: 202,
    deletedAt: 203
  };
  assert.equal(await repo.deleteConfirmed(criteria, archiveEvent), 1);
  assert.equal(await repo.getRecord(oldMatching.comment.id), null);
  assert.deepEqual(await repo.getRecord(changedAfterExport.comment.id), changedAfterExport);
  assert.deepEqual(await repo.getRecord(otherDomain.comment.id), otherDomain);
  assert.deepEqual(await repo.listArchiveEvents(), [archiveEvent]);
});

test('confirmed deletion honors anchor criteria', async (t) => {
  const { repo } = await openRepo(t);
  const matching = makeBundle({
    id: 'batch-a:0',
    anchors: [{ anchorText: 'Cleanup candidate', hrefDomain: 'delete-link.test' }]
  });
  const notMatching = makeBundle({
    id: 'batch-a:1',
    anchors: [{ anchorText: 'Keep candidate', hrefDomain: 'keep-link.test' }]
  });
  await repo.upsertRecord(matching);
  await repo.upsertRecord(notMatching);

  const deleted = await repo.deleteConfirmed(
    { hrefDomain: 'delete-link.test', exportedBefore: Number.MAX_SAFE_INTEGER },
    {
      id: 'archive-anchor',
      rangeStart: 0,
      rangeEnd: Date.now(),
      recordCount: 1,
      fileNames: ['anchor.csv'],
      exportStartedAt: 1,
      deleteConfirmedAt: 2,
      deletedAt: 3
    }
  );

  assert.equal(deleted, 1);
  assert.equal(await repo.getRecord(matching.comment.id), null);
  assert.deepEqual(await repo.getRecord(notMatching.comment.id), notMatching);
});

test('stores and retrieves metadata values', async (t) => {
  const { repo } = await openRepo(t);
  assert.equal(await repo.getMeta('missing'), undefined);
  await repo.setMeta('retention', { checkedAt: 123 });
  assert.deepEqual(await repo.getMeta('retention'), { checkedAt: 123 });
});
