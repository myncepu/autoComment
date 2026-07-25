import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore
} from 'fake-indexeddb';
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

async function openRepo(t, options = {}) {
  const indexedDBImpl = new IDBFactory();
  const dbName = `comment-history-test-${databaseSequence += 1}`;
  const repo = await openCommentHistoryDb({ indexedDBImpl, dbName, ...options });
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

function createVersion1Database(indexedDBImpl, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      const comments = database.createObjectStore('comment_records', { keyPath: 'id' });
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

      const anchors = database.createObjectStore('comment_anchors', { keyPath: 'id' });
      anchors.createIndex('by_comment_id', 'commentId');
      anchors.createIndex('by_anchor_text', 'anchorTextNormalized');
      anchors.createIndex('by_href_domain', 'hrefDomain');
      database.createObjectStore('archive_events', { keyPath: 'id' });
      database.createObjectStore('history_meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function storeFinalizedExportSession(repo, {
  exportSessionId = 'export-session-a',
  criteria = {},
  exportedBefore,
  expectedCount
}) {
  const descriptor = {
    exportSessionId,
    criteria,
    exportedBefore,
    expectedCount,
    startedAt: exportedBefore,
    filenames: ['comment-history-part-001.csv'],
    finalizedAt: exportedBefore + 1,
    consumedAt: null
  };
  await repo.setMeta(`historyExport:${exportSessionId}`, descriptor);
  return descriptor;
}

test('upgrades version 1 without recreating stores or losing records', async (t) => {
  const indexedDBImpl = new IDBFactory();
  const dbName = `comment-history-test-${databaseSequence += 1}`;
  const original = makeBundle({
    id: 'batch-upgrade:1',
    anchors: [{ anchorText: 'Preserved', hrefDomain: 'preserved.test' }]
  });
  original.comment.commentText = 'preserved';

  const version1 = await createVersion1Database(indexedDBImpl, dbName);
  const seedTransaction = version1.transaction(
    ['comment_records', 'comment_anchors'],
    'readwrite'
  );
  seedTransaction.objectStore('comment_records').add(original.comment);
  seedTransaction.objectStore('comment_anchors').add(original.anchors[0]);
  await new Promise((resolve, reject) => {
    seedTransaction.oncomplete = resolve;
    seedTransaction.onabort = () => reject(seedTransaction.error);
    seedTransaction.onerror = () => {};
  });
  version1.close();

  const repo = await openCommentHistoryDb({ indexedDBImpl, dbName });
  t.after(() => repo.close());
  const database = await openDatabase(indexedDBImpl, dbName);
  t.after(() => database.close());

  assert.equal(database.version, 2);
  assert.deepEqual([...database.objectStoreNames], [
    'archive_events',
    'comment_anchors',
    'comment_records',
    'history_meta',
    'sync_entities',
    'sync_meta',
    'sync_outbox'
  ]);
  assert.equal((await repo.getRecord('batch-upgrade:1')).comment.commentText, 'preserved');
});

test('creates the version 2 stores while preserving version 1 indexes', async (t) => {
  const { repo, indexedDBImpl, dbName } = await openRepo(t);
  repo.close();

  const db = await openDatabase(indexedDBImpl, dbName);
  t.after(() => db.close());
  assert.equal(db.version, 2);
  assert.deepEqual([...db.objectStoreNames], [
    'archive_events',
    'comment_anchors',
    'comment_records',
    'history_meta',
    'sync_entities',
    'sync_meta',
    'sync_outbox'
  ]);

  const transaction = db.transaction(['comment_records', 'comment_anchors'], 'readonly');
  const comments = transaction.objectStore('comment_records');
  const anchors = transaction.objectStore('comment_anchors');
  assert.deepEqual([...comments.indexNames], [
    'by_archive_month',
    'by_batch_task',
    'by_promoted_domain_submitted_at',
    'by_promoted_domain',
    'by_submitted_at',
    'by_submitted_at_id',
    'by_target_domain_submitted_at',
    'by_target_domain'
  ].sort());
  assert.deepEqual([...anchors.indexNames], [
    'by_anchor_text',
    'by_comment_id',
    'by_href_domain'
  ]);
  assert.equal(comments.index('by_batch_task').unique, true);
});

test('sync outbox schedules due mutations per vault and completes acknowledgements', async (t) => {
  const { repo } = await openRepo(t);
  await repo.enqueueSyncMutation({
    mutationId: 'm-late',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: 'batch-a:1',
    operation: 'upsert',
    payload: { comment: { id: 'batch-a:1' }, anchors: [] },
    createdAt: 100,
    attemptCount: 1,
    nextAttemptAt: 500,
    lastErrorCode: null,
    state: 'pending'
  });
  await repo.enqueueSyncMutation({
    mutationId: 'm-due',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: 'batch-a:2',
    operation: 'upsert',
    payload: { comment: { id: 'batch-a:2' }, anchors: [] },
    createdAt: 101,
    attemptCount: 0,
    nextAttemptAt: 200,
    lastErrorCode: null,
    state: 'pending'
  });
  await repo.enqueueSyncMutation({
    mutationId: 'm-other-vault',
    vaultId: 'vault-b',
    entityType: 'comment',
    entityId: 'batch-b:1',
    operation: 'upsert',
    payload: { comment: { id: 'batch-b:1' }, anchors: [] },
    createdAt: 99,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  });

  assert.deepEqual(
    (await repo.listDueSyncMutations({
      vaultId: 'vault-a',
      now: 300,
      limit: 100
    })).map((item) => item.mutationId),
    ['m-due']
  );
  await repo.completeSyncMutations([{
    mutationId: 'm-due',
    vaultId: 'vault-a',
    entityKey: 'vault-a:comment:batch-a:2',
    revisionId: 'revision-2',
    serverSeq: 7
  }]);
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 1000,
    limit: 100
  }), [
    {
      mutationId: 'm-late',
      vaultId: 'vault-a',
      entityType: 'comment',
      entityId: 'batch-a:1',
      operation: 'upsert',
      payload: { comment: { id: 'batch-a:1' }, anchors: [] },
      createdAt: 100,
      attemptCount: 1,
      nextAttemptAt: 500,
      lastErrorCode: null,
      state: 'pending'
    }
  ]);
  assert.deepEqual(
    (await repo.listDueSyncMutations({
      vaultId: 'vault-b',
      now: 1000,
      limit: 100
    })).map((item) => item.mutationId),
    ['m-other-vault']
  );
});

test('sync outbox attempt state and sync metadata persist independently', async (t) => {
  const { repo } = await openRepo(t);
  const mutation = {
    mutationId: 'm-retry',
    vaultId: 'vault-a',
    entityType: 'setting',
    entityId: 'batch_concurrency',
    operation: 'upsert',
    payload: { value: 4 },
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  };
  await repo.enqueueSyncMutation(mutation);
  await repo.markSyncMutationAttempt({
    mutationId: 'm-retry',
    attemptCount: 1,
    nextAttemptAt: 500,
    lastErrorCode: 'NETWORK_ERROR',
    state: 'pending'
  });
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 500,
    limit: 1
  }), [{
    ...mutation,
    attemptCount: 1,
    nextAttemptAt: 500,
    lastErrorCode: 'NETWORK_ERROR'
  }]);

  assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), undefined);
  await repo.setSyncMeta('serverCursor:vault-a', 12);
  assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), 12);
  assert.equal(await repo.getSyncMeta('serverCursor:vault-b'), undefined);
});

test('sync outbox write failure rolls freshness changes back with a stable code', async (t) => {
  const { repo } = await openRepo(t);
  const original = makeBundle({
    id: 'batch-sync-atomic:1',
    submittedAt: 100,
    anchors: [{ anchorText: 'Original', hrefDomain: 'original.test' }]
  });
  original.comment.historyRevision = {
    capturedAt: 100,
    recordedAt: 101,
    sequence: 0,
    id: 'revision-1'
  };
  const originalMutation = {
    mutationId: 'm-duplicate',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: original.comment.id,
    operation: 'upsert',
    payload: original,
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  };
  assert.equal(await repo.upsertIfFresher(original, {
    syncMutation: originalMutation
  }), true);

  const replacement = makeBundle({
    id: original.comment.id,
    submittedAt: 200,
    anchors: [{ anchorText: 'Replacement', hrefDomain: 'replacement.test' }]
  });
  replacement.comment.historyRevision = {
    capturedAt: 200,
    recordedAt: 201,
    sequence: 0,
    id: 'revision-2'
  };
  await assert.rejects(
    repo.upsertIfFresher(replacement, {
      syncMutation: {
        ...originalMutation,
        payload: replacement,
        createdAt: 200
      }
    }),
    (error) => error.code === 'SYNC_OUTBOX_WRITE_FAILED'
  );
  assert.deepEqual(await repo.getRecord(original.comment.id), original);
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 1000,
    limit: 100
  }), [originalMutation]);
});

test('sync outbox rejects missing vaults and does not mislabel comment write failures', async (t) => {
  const { repo } = await openRepo(t);
  await assert.rejects(repo.enqueueSyncMutation({
    mutationId: 'missing-vault',
    entityType: 'comment',
    entityId: 'batch-missing-vault:1',
    operation: 'upsert',
    payload: { comment: { id: 'batch-missing-vault:1' }, anchors: [] },
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  }));

  const missingVaultBundle = makeBundle({
    id: 'batch-missing-vault:1',
    submittedAt: 50
  });
  await assert.rejects(
    repo.upsertIfFresher(missingVaultBundle, {
      syncMutation: {
        mutationId: 'missing-vault-atomic',
        entityType: 'comment',
        entityId: missingVaultBundle.comment.id,
        operation: 'upsert',
        payload: missingVaultBundle,
        createdAt: 50,
        attemptCount: 0,
        nextAttemptAt: 50,
        lastErrorCode: null,
        state: 'pending'
      }
    }),
    (error) => error.code === 'SYNC_OUTBOX_WRITE_FAILED'
  );
  assert.equal(await repo.getRecord(missingVaultBundle.comment.id), null);

  const original = makeBundle({
    id: 'batch-invalid-anchor:1',
    submittedAt: 100,
    anchors: [{ anchorText: 'Original', hrefDomain: 'original.test' }]
  });
  await repo.upsertRecord(original);
  const invalid = makeBundle({
    id: original.comment.id,
    submittedAt: 200,
    anchors: [{ anchorText: 'Invalid', hrefDomain: 'invalid.test' }]
  });
  delete invalid.anchors[0].id;
  await assert.rejects(
    repo.upsertIfFresher(invalid, {
      syncMutation: {
        mutationId: 'valid-outbox-row',
        vaultId: 'vault-a',
        entityType: 'comment',
        entityId: invalid.comment.id,
        operation: 'upsert',
        payload: invalid,
        createdAt: 200,
        attemptCount: 0,
        nextAttemptAt: 200,
        lastErrorCode: null,
        state: 'pending'
      }
    }),
    (error) => error.code !== 'SYNC_OUTBOX_WRITE_FAILED'
  );
  assert.deepEqual(await repo.getRecord(original.comment.id), original);
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 1000,
    limit: 100
  }), []);
});

test('sync outbox completion cannot acknowledge a mutation through another vault', async (t) => {
  const { repo } = await openRepo(t);
  const mutation = {
    mutationId: 'vault-bound-mutation',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: 'batch-vault-bound:1',
    operation: 'upsert',
    payload: { comment: { id: 'batch-vault-bound:1' }, anchors: [] },
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  };
  await repo.enqueueSyncMutation(mutation);

  await assert.rejects(repo.completeSyncMutations([{
    mutationId: mutation.mutationId,
    vaultId: 'vault-b',
    entityKey: 'vault-b:comment:batch-vault-bound:1',
    revisionId: 'revision-1',
    serverSeq: 10
  }]));
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 1000,
    limit: 100
  }), [mutation]);
});

test('sync outbox completion rejects entity keys outside the receipt vault', async (t) => {
  const { repo } = await openRepo(t);
  const receipt = {
    mutationId: 'entity-key-mutation',
    vaultId: 'vault-a',
    revisionId: 'revision-1',
    serverSeq: 10
  };
  await assert.rejects(repo.completeSyncMutations([{
    ...receipt,
    entityKey: 'vault-b:comment:batch-a:1'
  }]));
  await assert.rejects(repo.completeSyncMutations([{
    ...receipt,
    entityKey: 'vault-a:unknown:batch-a:1'
  }]));
  await assert.rejects(repo.completeSyncMutations([{
    ...receipt,
    entityKey: 'vault-a:comment:'
  }]));
});

test('remote change page aborts every record and cursor when a later change is invalid', async (t) => {
  const { repo } = await openRepo(t);
  await assert.rejects(repo.applyRemoteChangesAtomic({
    vaultId: 'vault-a',
    changes: [
      {
        serverSeq: 8,
        entityType: 'comment',
        operation: 'upsert',
        record: makeBundle({ id: 'remote:1', submittedAt: 100 })
      },
      {
        serverSeq: 9,
        entityType: 'comment',
        operation: 'upsert',
        record: { comment: { id: '' }, anchors: [] }
      }
    ],
    nextCursor: 9
  }));
  assert.equal(await repo.getRecord('remote:1'), null);
  assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), undefined);
});

test('remote changes preserve fresher comments and apply tombstones without an outbox row', async (t) => {
  const { repo } = await openRepo(t);
  const local = makeBundle({
    id: 'remote-order:1',
    submittedAt: 300,
    anchors: [{ anchorText: 'Local', hrefDomain: 'local.test' }]
  });
  local.comment.historyRevision = {
    capturedAt: 300,
    recordedAt: 301,
    sequence: 0,
    id: 'revision-local'
  };
  const staleRemote = makeBundle({
    id: local.comment.id,
    submittedAt: 100,
    anchors: [{ anchorText: 'Remote', hrefDomain: 'remote.test' }]
  });
  staleRemote.comment.historyRevision = {
    capturedAt: 100,
    recordedAt: 101,
    sequence: 0,
    id: 'revision-remote'
  };
  await repo.upsertRecord(local);

  await repo.applyRemoteChangesAtomic({
    vaultId: 'vault-a',
    changes: [{
      serverSeq: 10,
      entityType: 'comment',
      operation: 'upsert',
      record: staleRemote
    }],
    nextCursor: 10
  });
  assert.deepEqual(await repo.getRecord(local.comment.id), local);
  assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), 10);
  assert.deepEqual(await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 1000,
    limit: 100
  }), []);

  await repo.applyRemoteChangesAtomic({
    vaultId: 'vault-a',
    changes: [{
      serverSeq: 11,
      entityType: 'comment_delete',
      entityId: local.comment.id,
      operation: 'delete',
      revisionId: 'delete-revision-1'
    }],
    nextCursor: 11
  });
  assert.equal(await repo.getRecord(local.comment.id), null);
  assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), 11);
});

test('synced cache eviction requires matching vault revision and no outbox mutation', async (t) => {
  const { repo } = await openRepo(t);
  function versionedBundle(id, submittedAt, revisionId) {
    const bundle = makeBundle({ id, submittedAt });
    bundle.comment.historyRevision = {
      capturedAt: submittedAt,
      recordedAt: submittedAt + 1,
      sequence: 0,
      id: revisionId
    };
    return bundle;
  }
  const eligible = versionedBundle('synced:1', 100, 'revision-1');
  const mismatched = versionedBundle('synced:2', 100, 'revision-current');
  const pending = versionedBundle('synced:3', 100, 'revision-3');
  const otherVault = versionedBundle('synced:4', 100, 'revision-4');
  const recent = versionedBundle('synced:5', 300, 'revision-5');
  for (const bundle of [eligible, mismatched, pending, otherVault, recent]) {
    await repo.upsertRecord(bundle);
  }
  await repo.completeSyncMutations([
    {
      mutationId: 'sync-1',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:synced:1',
      revisionId: 'revision-1',
      serverSeq: 10
    },
    {
      mutationId: 'sync-2',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:synced:2',
      revisionId: 'revision-old',
      serverSeq: 11
    },
    {
      mutationId: 'sync-3',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:synced:3',
      revisionId: 'revision-3',
      serverSeq: 12
    },
    {
      mutationId: 'sync-4',
      vaultId: 'vault-b',
      entityKey: 'vault-b:comment:synced:4',
      revisionId: 'revision-4',
      serverSeq: 13
    },
    {
      mutationId: 'sync-5',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:synced:5',
      revisionId: 'revision-5',
      serverSeq: 14
    }
  ]);
  await repo.enqueueSyncMutation({
    mutationId: 'pending-3',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: 'synced:3',
    operation: 'upsert',
    payload: pending,
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending'
  });

  assert.equal(await repo.evictSyncedCacheBefore({
    vaultId: 'vault-a',
    cutoff: 200
  }), 1);
  assert.equal(await repo.getRecord('synced:1'), null);
  assert.deepEqual(await repo.getRecord('synced:2'), mismatched);
  assert.deepEqual(await repo.getRecord('synced:3'), pending);
  assert.deepEqual(await repo.getRecord('synced:4'), otherVault);
  assert.deepEqual(await repo.getRecord('synced:5'), recent);
});

test('initial sync scan resumes by primary key and returns complete bundles', async (t) => {
  const { repo } = await openRepo(t);
  const records = [1, 2, 3].map((index) => makeBundle({
    id: `scan:${index}`,
    submittedAt: 100 + index,
    anchors: [{ anchorText: `Anchor ${index}`, hrefDomain: `${index}.test` }]
  }));
  for (const record of records) await repo.upsertRecord(record);

  assert.deepEqual(await repo.scanRecordsForInitialSync({
    cursor: null,
    limit: 2
  }), {
    records: records.slice(0, 2),
    cursor: 'scan:2',
    done: false
  });
  assert.deepEqual(await repo.scanRecordsForInitialSync({
    cursor: 'scan:2',
    limit: 2
  }), {
    records: records.slice(2),
    cursor: 'scan:3',
    done: true
  });
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

test('legacy insert-if-absent never downgrades live data across reruns or concurrent writes', async (t) => {
  const { repo } = await openRepo(t);
  function legacyBundle(id, createdAt) {
    const bundle = makeBundle({
      id,
      submittedAt: createdAt,
      anchors: [{ anchorText: 'Legacy', hrefDomain: 'legacy.test' }]
    });
    return {
      comment: {
        ...bundle.comment,
        source: 'legacy',
        commentHtml: 'Legacy AI fallback',
        commentText: 'Legacy AI fallback',
        createdAt,
        updatedAt: createdAt
      },
      anchors: bundle.anchors
    };
  }
  function liveBundle(id, createdAt) {
    const bundle = makeBundle({
      id,
      submittedAt: createdAt + 10,
      anchors: [{ anchorText: 'Exact live', hrefDomain: 'live.test' }]
    });
    return {
      comment: {
        ...bundle.comment,
        commentHtml: 'Exact live body',
        commentText: 'Exact live body',
        createdAt,
        updatedAt: createdAt + 20
      },
      anchors: bundle.anchors
    };
  }

  const interruptedLegacy = legacyBundle('batch-rerun:1', 100);
  const replacementLive = liveBundle('batch-rerun:1', 500);
  assert.equal(await repo.insertLegacyIfAbsent(interruptedLegacy), true);
  await repo.upsertRecord(replacementLive);
  assert.equal(await repo.insertLegacyIfAbsent(interruptedLegacy), false);
  assert.deepEqual(await repo.getRecord('batch-rerun:1'), replacementLive);
  assert.equal(
    (await repo.getRecord('batch-rerun:1')).comment.createdAt,
    replacementLive.comment.createdAt
  );

  const legacyFirst = legacyBundle('batch-concurrent:1', 200);
  const liveSecond = liveBundle('batch-concurrent:1', 600);
  await Promise.all([
    repo.insertLegacyIfAbsent(legacyFirst),
    repo.upsertRecord(liveSecond)
  ]);
  assert.deepEqual(await repo.getRecord('batch-concurrent:1'), liveSecond);

  const liveFirst = liveBundle('batch-concurrent:2', 700);
  const legacySecond = legacyBundle('batch-concurrent:2', 300);
  await Promise.all([
    repo.upsertRecord(liveFirst),
    repo.insertLegacyIfAbsent(legacySecond)
  ]);
  assert.deepEqual(await repo.getRecord('batch-concurrent:2'), liveFirst);
});

test('freshness upsert atomically preserves newer live data while upgrading legacy data', async (t) => {
  const { repo } = await openRepo(t);
  const live = makeBundle({
    id: 'batch-pending-live:1',
    submittedAt: 500,
    anchors: [{ anchorText: 'Fresh', hrefDomain: 'fresh.test' }]
  });
  const stalePending = makeBundle({
    id: 'batch-pending-live:1',
    submittedAt: 100,
    anchors: [{ anchorText: 'Stale', hrefDomain: 'stale.test' }]
  });
  stalePending.comment.commentHtml = 'stale queued body';
  stalePending.comment.commentText = 'stale queued body';
  await repo.upsertRecord(live);

  assert.equal(await repo.upsertIfFresher(stalePending), false);
  assert.deepEqual(await repo.getRecord(live.comment.id), live);

  const legacy = makeBundle({
    id: 'batch-pending-legacy:1',
    submittedAt: 200,
    anchors: [{ anchorText: 'Legacy', hrefDomain: 'legacy.test' }]
  });
  legacy.comment.source = 'legacy';
  legacy.comment.commentHtml = 'legacy fallback';
  legacy.comment.commentText = 'legacy fallback';
  const exactPending = makeBundle({
    id: 'batch-pending-legacy:1',
    submittedAt: 300,
    anchors: [{ anchorText: 'Exact', hrefDomain: 'exact.test' }]
  });
  exactPending.comment.commentHtml = 'exact pending body';
  exactPending.comment.commentText = 'exact pending body';
  await repo.upsertRecord(legacy);

  assert.equal(await repo.upsertIfFresher(exactPending), true);
  assert.deepEqual(await repo.getRecord(legacy.comment.id), exactPending);
});

test('freshness revisions converge to the newest exact record in either arrival order', async (t) => {
  const { repo } = await openRepo(t);
  function versionedBundle(id, submittedAt, revisionId, body) {
    const bundle = makeBundle({
      id,
      submittedAt,
      anchors: [{ anchorText: body, hrefDomain: `${revisionId}.test` }]
    });
    bundle.comment.commentHtml = body;
    bundle.comment.commentText = body;
    bundle.comment.historyRevision = {
      capturedAt: submittedAt,
      recordedAt: submittedAt + 1,
      sequence: 1,
      id: revisionId
    };
    return bundle;
  }

  const oldFirst = versionedBundle(
    'batch-version-order:1',
    100,
    'revision-old-first',
    'old first body'
  );
  const freshSecond = versionedBundle(
    'batch-version-order:1',
    200,
    'revision-fresh-second',
    'fresh second body'
  );
  assert.equal(await repo.upsertIfFresher(oldFirst), true);
  assert.equal(await repo.upsertIfFresher(freshSecond), true);
  assert.deepEqual(await repo.getRecord(oldFirst.comment.id), freshSecond);

  const freshFirst = versionedBundle(
    'batch-version-order:2',
    400,
    'revision-fresh-first',
    'fresh first body'
  );
  const oldSecond = versionedBundle(
    'batch-version-order:2',
    300,
    'revision-old-second',
    'old second body'
  );
  assert.equal(await repo.upsertIfFresher(freshFirst), true);
  assert.equal(await repo.upsertIfFresher(oldSecond), false);
  assert.deepEqual(await repo.getRecord(freshFirst.comment.id), freshFirst);
});

test('freshness comparison uses the complete revision tuple and never mutates an equal revision', async (t) => {
  const { repo } = await openRepo(t);
  function versionedBundle({
    id = 'batch-revision-ties:1',
    recordedAt,
    sequence,
    revisionId,
    body
  }) {
    const bundle = makeBundle({
      id,
      submittedAt: 500,
      anchors: [{ anchorText: body, hrefDomain: `${revisionId}.test` }]
    });
    bundle.comment.commentHtml = body;
    bundle.comment.commentText = body;
    bundle.comment.historyRevision = {
      capturedAt: 500,
      recordedAt,
      sequence,
      id: revisionId
    };
    return bundle;
  }

  const base = versionedBundle({
    recordedAt: 501,
    sequence: 1,
    revisionId: 'revision-a',
    body: 'base'
  });
  const newerRecordedAt = versionedBundle({
    recordedAt: 502,
    sequence: 0,
    revisionId: 'revision-a',
    body: 'newer recordedAt'
  });
  const newerSequence = versionedBundle({
    recordedAt: 502,
    sequence: 2,
    revisionId: 'revision-a',
    body: 'newer sequence'
  });
  const newerId = versionedBundle({
    recordedAt: 502,
    sequence: 2,
    revisionId: 'revision-z',
    body: 'newer id'
  });
  const equalConflict = structuredClone(newerId);
  equalConflict.comment.commentHtml = 'must not replace equal revision';
  equalConflict.comment.commentText = 'must not replace equal revision';
  equalConflict.anchors = makeBundle({
    id: newerId.comment.id,
    anchors: [{ anchorText: 'Conflict', hrefDomain: 'conflict.test' }]
  }).anchors;

  assert.equal(await repo.upsertIfFresher(base), true);
  assert.equal(await repo.upsertIfFresher(newerRecordedAt), true);
  assert.equal(await repo.upsertIfFresher(newerSequence), true);
  assert.equal(await repo.upsertIfFresher(newerId), true);
  assert.equal(await repo.upsertIfFresher(equalConflict), false);
  assert.deepEqual(await repo.getRecord(newerId.comment.id), newerId);

  const reverseId = 'batch-revision-ties:2';
  const reverseFresh = versionedBundle({
    id: reverseId,
    recordedAt: 502,
    sequence: 2,
    revisionId: 'revision-z',
    body: 'fresh first'
  });
  const reverseOld = versionedBundle({
    id: reverseId,
    recordedAt: 502,
    sequence: 2,
    revisionId: 'revision-a',
    body: 'old second'
  });
  assert.equal(await repo.upsertIfFresher(reverseFresh), true);
  assert.equal(await repo.upsertIfFresher(reverseOld), false);
  assert.deepEqual(await repo.getRecord(reverseId), reverseFresh);
});

test('exact data upgrades legacy regardless of timestamps and a failed fresh write rolls back atomically', async (t) => {
  const { repo } = await openRepo(t);
  const legacy = makeBundle({
    id: 'batch-source-order:1',
    submittedAt: 900,
    anchors: [{ anchorText: 'Legacy', hrefDomain: 'legacy.test' }]
  });
  legacy.comment.source = 'legacy';
  legacy.comment.commentHtml = 'legacy approximation';
  legacy.comment.commentText = 'legacy approximation';

  const exact = makeBundle({
    id: legacy.comment.id,
    submittedAt: 100,
    anchors: [{ anchorText: 'Exact', hrefDomain: 'exact.test' }]
  });
  exact.comment.historyRevision = {
    capturedAt: 100,
    recordedAt: 101,
    sequence: 1,
    id: 'revision-exact'
  };

  assert.equal(await repo.upsertIfFresher(legacy), true);
  assert.equal(await repo.upsertIfFresher(exact), true);
  assert.equal(await repo.upsertIfFresher(legacy), false);
  assert.deepEqual(await repo.getRecord(exact.comment.id), exact);

  const invalidFresh = structuredClone(exact);
  invalidFresh.comment.commentHtml = 'must roll back';
  invalidFresh.comment.commentText = 'must roll back';
  invalidFresh.comment.historyRevision = {
    capturedAt: 200,
    recordedAt: 201,
    sequence: 2,
    id: 'revision-invalid'
  };
  invalidFresh.anchors.push({
    ...invalidFresh.anchors[0],
    id: undefined,
    position: 1
  });
  await assert.rejects(repo.upsertIfFresher(invalidFresh));
  assert.deepEqual(await repo.getRecord(exact.comment.id), exact);
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

test('uses IndexedDB binary string ordering for normal and anchor cursors', async (t) => {
  const { repo } = await openRepo(t);
  await repo.upsertRecord(makeBundle({
    id: 'A:0',
    submittedAt: 200,
    anchors: [{ anchorText: 'Same', hrefDomain: 'links.test' }]
  }));
  await repo.upsertRecord(makeBundle({
    id: 'a:0',
    submittedAt: 200,
    anchors: [{ anchorText: 'Same', hrefDomain: 'links.test' }]
  }));

  const normalFirst = await repo.queryRecords({ limit: 1 });
  const normalSecond = await repo.queryRecords({ limit: 1, cursor: normalFirst.nextCursor });
  assert.deepEqual(
    [normalFirst.records[0].id, normalSecond.records[0].id],
    ['a:0', 'A:0']
  );
  assert.equal(normalSecond.nextCursor, null);

  const anchorFirst = await repo.queryRecords({ hrefDomain: 'links.test', limit: 1 });
  const anchorSecond = await repo.queryRecords({
    hrefDomain: 'links.test',
    limit: 1,
    cursor: anchorFirst.nextCursor
  });
  assert.deepEqual(
    [anchorFirst.records[0].id, anchorSecond.records[0].id],
    ['A:0', 'a:0']
  );
  assert.equal(anchorSecond.nextCursor, null);
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

test('requires combined anchor predicates to match the same anchor row', async (t) => {
  const { repo } = await openRepo(t);
  const splitAcrossRows = makeBundle({
    id: 'batch-a:0',
    anchors: [
      { anchorText: 'Alpha text', hrefDomain: 'wrong.test' },
      { anchorText: 'Other text', hrefDomain: 'links.test' }
    ]
  });
  const sameRow = makeBundle({
    id: 'batch-a:1',
    anchors: [{ anchorText: 'Alphabet', hrefDomain: 'links.test' }]
  });
  await repo.upsertRecord(splitAcrossRows);
  await repo.upsertRecord(sameRow);

  const filter = {
    anchorTextPrefix: 'alpha',
    hrefDomain: 'links.test',
    exportedBefore: Number.MAX_SAFE_INTEGER,
    limit: 10
  };
  assert.deepEqual(
    (await repo.queryRecords(filter)).records.map((record) => record.id),
    [sameRow.comment.id]
  );
  assert.equal(await repo.countRecords(filter), 1);
  assert.deepEqual(await repo.getExportChunk(filter), {
    records: [sameRow],
    nextCursor: null
  });

  assert.equal(await repo.deleteConfirmed(filter, {
    id: 'archive-combined',
    rangeStart: 0,
    rangeEnd: Date.now(),
    recordCount: 1,
    fileNames: ['combined.csv'],
    exportStartedAt: 1,
    deleteConfirmedAt: 2,
    deletedAt: 3
  }), 1);
  assert.deepEqual(await repo.getRecord(splitAcrossRows.comment.id), splitAcrossRows);
  assert.equal(await repo.getRecord(sameRow.comment.id), null);
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

test('retention summary uses range counts and a key cursor without cloning record values', async (t) => {
  const calls = [];
  const originalIndexCount = IDBIndex.prototype.count;
  const originalOpenCursor = IDBIndex.prototype.openCursor;
  const originalOpenKeyCursor = IDBIndex.prototype.openKeyCursor;
  const originalStoreCount = IDBObjectStore.prototype.count;
  IDBIndex.prototype.count = function (...args) {
    calls.push({ kind: 'index-count', name: this.name });
    return originalIndexCount.apply(this, args);
  };
  IDBIndex.prototype.openCursor = function (...args) {
    calls.push({ kind: 'value-cursor', name: this.name });
    return originalOpenCursor.apply(this, args);
  };
  IDBIndex.prototype.openKeyCursor = function (...args) {
    calls.push({ kind: 'key-cursor', name: this.name });
    return originalOpenKeyCursor.apply(this, args);
  };
  IDBObjectStore.prototype.count = function (...args) {
    calls.push({ kind: 'store-count', name: this.name });
    return originalStoreCount.apply(this, args);
  };
  t.after(() => {
    IDBIndex.prototype.count = originalIndexCount;
    IDBIndex.prototype.openCursor = originalOpenCursor;
    IDBIndex.prototype.openKeyCursor = originalOpenKeyCursor;
    IDBObjectStore.prototype.count = originalStoreCount;
  });

  const { repo } = await openRepo(t);
  const day = 24 * 60 * 60 * 1000;
  const now = 200 * day;
  for (const [index, age] of [0, 85, 95].entries()) {
    const bundle = makeBundle({
      id: `large-html:${index}`,
      submittedAt: now - age * day
    });
    bundle.comment.commentHtml = 'x'.repeat(250_000);
    await repo.upsertRecord(bundle);
  }
  calls.length = 0;

  assert.deepEqual(await repo.getRetentionSummary(now), {
    totalCount: 3,
    last24HoursCount: 1,
    dueSoonCount: 1,
    expiredCount: 1,
    oldestSubmittedAt: now - 95 * day
  });
  assert.deepEqual(calls, [
    { kind: 'store-count', name: 'comment_records' },
    { kind: 'index-count', name: 'by_submitted_at' },
    { kind: 'index-count', name: 'by_submitted_at' },
    { kind: 'index-count', name: 'by_submitted_at' },
    { kind: 'key-cursor', name: 'by_submitted_at' }
  ]);
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

test('reads export comments and anchors from one readonly snapshot', async (t) => {
  const { repo } = await openRepo(t);
  const original = makeBundle({
    id: 'batch-a:0',
    submittedAt: 100,
    updatedAt: 150,
    anchors: [{ anchorText: 'Original', hrefDomain: 'old.test' }]
  });
  const newer = {
    comment: {
      ...original.comment,
      commentHtml: '<p>newer</p>',
      commentText: 'newer',
      updatedAt: 250
    },
    anchors: makeBundle({
      id: 'batch-a:0',
      anchors: [{ anchorText: 'Newer', hrefDomain: 'new.test' }]
    }).anchors
  };
  await repo.upsertRecord(original);

  const exportPromise = repo.getExportChunk({
    exportedBefore: 200,
    limit: 10
  });
  const updatePromise = repo.upsertRecord(newer);
  const exported = await exportPromise;
  await updatePromise;

  assert.deepEqual(exported.records, [original]);
  assert.deepEqual(await repo.getRecord(original.comment.id), newer);
});

test('atomic export cleanup aborts before deletion when the set mutates after export', async (t) => {
  const { repo } = await openRepo(t);
  const day = 24 * 60 * 60 * 1000;
  const confirmedAt = 200 * day;
  const exportedBefore = confirmedAt - 1;
  const original = makeBundle({
    id: 'batch-a:0',
    submittedAt: confirmedAt - 100 * day,
    updatedAt: exportedBefore - 10,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Original', hrefDomain: 'links.test' }]
  });
  const concurrent = makeBundle({
    id: 'batch-a:1',
    submittedAt: confirmedAt - 95 * day,
    updatedAt: exportedBefore - 5,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Concurrent', hrefDomain: 'links.test' }]
  });
  await repo.upsertRecord(original);
  await storeFinalizedExportSession(repo, {
    criteria: { targetDomain: 'delete.test' },
    exportedBefore,
    expectedCount: 1
  });

  // Deterministically represents a write committed after export prechecks and
  // before the cleanup transaction begins.
  await repo.upsertRecord(concurrent);

  await assert.rejects(
    repo.deleteExportSessionAtomic({
      exportSessionId: 'export-session-a',
      confirmedAt
    }),
    (error) => error.code === 'EXPORT_SET_CHANGED'
  );
  assert.deepEqual(await repo.getRecord(original.comment.id), original);
  assert.deepEqual(await repo.getRecord(concurrent.comment.id), concurrent);
  assert.deepEqual(await repo.listArchiveEvents(), []);
  assert.equal(
    (await repo.getMeta('historyExport:export-session-a')).consumedAt,
    null
  );
});

test('atomic export cleanup rolls back comments anchors archive and session on meta failure', async (t) => {
  const { repo } = await openRepo(t, {
    onBeforeExportSessionConsume({ descriptor }) {
      descriptor.injectedUncloneable = () => {};
    }
  });
  const day = 24 * 60 * 60 * 1000;
  const confirmedAt = 200 * day;
  const exportedBefore = confirmedAt - 1;
  const original = makeBundle({
    id: 'batch-a:0',
    submittedAt: confirmedAt - 100 * day,
    updatedAt: exportedBefore - 10,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Rollback', hrefDomain: 'links.test' }]
  });
  await repo.upsertRecord(original);
  await storeFinalizedExportSession(repo, {
    criteria: { targetDomain: 'delete.test' },
    exportedBefore,
    expectedCount: 1
  });

  await assert.rejects(
    repo.deleteExportSessionAtomic({
      exportSessionId: 'export-session-a',
      confirmedAt
    }),
    (error) => error.name === 'DataCloneError'
  );
  assert.deepEqual(await repo.getRecord(original.comment.id), original);
  assert.deepEqual(await repo.listArchiveEvents(), []);
  assert.equal(
    (await repo.getMeta('historyExport:export-session-a')).consumedAt,
    null
  );
});

test('atomic export cleanup commits comments anchors archive and session together', async (t) => {
  const { repo } = await openRepo(t);
  const day = 24 * 60 * 60 * 1000;
  const confirmedAt = 200 * day;
  const exportedBefore = confirmedAt - 1;
  const original = makeBundle({
    id: 'batch-a:0',
    submittedAt: confirmedAt - 100 * day,
    updatedAt: exportedBefore - 10,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Archived', hrefDomain: 'links.test' }]
  });
  await repo.upsertRecord(original);
  const descriptor = await storeFinalizedExportSession(repo, {
    criteria: { targetDomain: 'delete.test' },
    exportedBefore,
    expectedCount: 1
  });

  assert.deepEqual(await repo.deleteExportSessionAtomic({
    exportSessionId: 'export-session-a',
    confirmedAt
  }), {
    deletedCount: 1,
    exportSessionId: 'export-session-a'
  });
  assert.equal(await repo.getRecord(original.comment.id), null);
  assert.deepEqual(await repo.listArchiveEvents(), [{
    id: 'archive:export-session-a',
    rangeStart: null,
    rangeEnd: confirmedAt - 90 * day,
    recordCount: 1,
    fileNames: descriptor.filenames,
    exportStartedAt: exportedBefore,
    deleteConfirmedAt: confirmedAt,
    deletedAt: confirmedAt
  }]);
  assert.equal(
    (await repo.getMeta('historyExport:export-session-a')).consumedAt,
    confirmedAt
  );
  await assert.rejects(
    repo.deleteExportSessionAtomic({
      exportSessionId: 'export-session-a',
      confirmedAt: confirmedAt + 1
    }),
    (error) => error.code === 'EXPORT_SESSION_CONSUMED'
  );
});

test('atomic cleanup streams two bounded-memory passes without retaining candidate IDs or comments', async (t) => {
  const cleanupVisits = [];
  const originalStoreGet = IDBObjectStore.prototype.get;
  let commentPointReads = 0;
  IDBObjectStore.prototype.get = function (...args) {
    if (this.name === 'comment_records') commentPointReads += 1;
    return originalStoreGet.apply(this, args);
  };
  t.after(() => {
    IDBObjectStore.prototype.get = originalStoreGet;
  });
  const { repo } = await openRepo(t, {
    onCleanupCursorVisit(event) {
      cleanupVisits.push(event);
    }
  });
  const day = 24 * 60 * 60 * 1000;
  const confirmedAt = 300 * day;
  const exportedBefore = confirmedAt - 1;
  const recordCount = 128;
  for (let index = 0; index < recordCount; index += 1) {
    const bundle = makeBundle({
      id: `stream-cleanup:${index}`,
      submittedAt: confirmedAt - (100 * day) - index,
      anchors: [
        { anchorText: `First ${index}`, hrefDomain: 'links.test' },
        { anchorText: `Second ${index}`, hrefDomain: 'links.test' }
      ]
    });
    bundle.comment.commentHtml = 'x'.repeat(50_000);
    await repo.upsertRecord(bundle);
  }
  await storeFinalizedExportSession(repo, {
    exportedBefore,
    expectedCount: recordCount
  });
  commentPointReads = 0;

  assert.deepEqual(await repo.deleteExportSessionAtomic({
    exportSessionId: 'export-session-a',
    confirmedAt
  }), {
    deletedCount: recordCount,
    exportSessionId: 'export-session-a'
  });
  assert.equal(commentPointReads, 0);
  assert.equal(cleanupVisits.length, recordCount * 2);
  assert.equal(
    cleanupVisits.filter(({ pass }) => pass === 'validate').length,
    recordCount
  );
  assert.equal(
    cleanupVisits.filter(({ pass }) => pass === 'delete').length,
    recordCount
  );
  assert.equal(
    Math.max(...cleanupVisits.map(({ inFlightRecords }) => inFlightRecords)),
    1
  );
  assert.ok(cleanupVisits.every(({ kind }) => kind === 'normal'));
  assert.equal((await repo.getRetentionSummary(confirmedAt)).totalCount, 0);
  assert.equal(
    (await repo.getMeta('historyExport:export-session-a')).consumedAt,
    confirmedAt
  );
  assert.equal((await repo.listArchiveEvents())[0].recordCount, recordCount);
});

test('atomic export cleanup rejects a matching record younger than 90 days without writes', async (t) => {
  const { repo } = await openRepo(t);
  const day = 24 * 60 * 60 * 1000;
  const confirmedAt = 200 * day;
  const exportedBefore = confirmedAt - 1;
  const recent = makeBundle({
    id: 'batch-a:0',
    submittedAt: confirmedAt - 89 * day,
    updatedAt: exportedBefore - 10,
    targetDomain: 'delete.test',
    anchors: [{ anchorText: 'Too recent', hrefDomain: 'links.test' }]
  });
  await repo.upsertRecord(recent);
  await storeFinalizedExportSession(repo, {
    criteria: { targetDomain: 'delete.test' },
    exportedBefore,
    expectedCount: 1
  });

  await assert.rejects(
    repo.deleteExportSessionAtomic({
      exportSessionId: 'export-session-a',
      confirmedAt
    }),
    (error) => error.code === 'RETENTION_NOT_EXPIRED'
  );
  assert.deepEqual(await repo.getRecord(recent.comment.id), recent);
  assert.deepEqual(await repo.listArchiveEvents(), []);
  assert.equal(
    (await repo.getMeta('historyExport:export-session-a')).consumedAt,
    null
  );
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

test('bounds default, date, domain, and anchor query cursor work to page lookahead', async (t) => {
  const visits = [];
  const { repo } = await openRepo(t, {
    onQueryCursorVisit: (event) => visits.push(event)
  });
  for (let index = 0; index < 20; index += 1) {
    await repo.upsertRecord(makeBundle({
      id: `batch-a:${index}`,
      submittedAt: 1000 + index,
      targetDomain: index < 10 ? 'bounded.test' : 'other.test',
      anchors: [{ anchorText: `Alpha ${index}`, hrefDomain: 'links.test' }]
    }));
  }

  await repo.queryRecords({ limit: 2 });
  assert.deepEqual(visits.splice(0), [
    { kind: 'normal', indexName: 'by_submitted_at_id' },
    { kind: 'normal', indexName: 'by_submitted_at_id' },
    { kind: 'normal', indexName: 'by_submitted_at_id' }
  ]);

  await repo.queryRecords({ from: 1005, to: 1010, limit: 2 });
  assert.deepEqual(visits.splice(0), [
    { kind: 'normal', indexName: 'by_submitted_at_id' },
    { kind: 'normal', indexName: 'by_submitted_at_id' },
    { kind: 'normal', indexName: 'by_submitted_at_id' }
  ]);

  await repo.queryRecords({ targetDomain: 'bounded.test', limit: 2 });
  assert.deepEqual(visits.splice(0), [
    { kind: 'normal', indexName: 'by_target_domain_submitted_at' },
    { kind: 'normal', indexName: 'by_target_domain_submitted_at' },
    { kind: 'normal', indexName: 'by_target_domain_submitted_at' }
  ]);

  await repo.queryRecords({ anchorTextPrefix: 'alpha', limit: 2 });
  assert.deepEqual(visits.splice(0), [
    { kind: 'anchor', indexName: 'by_anchor_text' },
    { kind: 'anchor', indexName: 'by_anchor_text' },
    { kind: 'anchor', indexName: 'by_anchor_text' }
  ]);
});
