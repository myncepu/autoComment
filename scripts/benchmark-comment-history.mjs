import os from 'node:os';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openCommentHistoryDb } from '../lib/comment-history-db.mjs';

const RECORD_COUNT = 360_000;
const INSERT_BATCH_SIZE = 2_500;
const QUERY_SAMPLES = 5;
const QUERY_LIMIT = 50;
const EXPORT_LIMIT = 500;
const DELETE_PREPARATION_LIMIT = 50_000;
const QUERY_MEDIAN_LIMIT_MS = 2_000;
const FIXED_NOW = Date.UTC(2026, 6, 23, 12);
const DAY_MS = 24 * 60 * 60 * 1_000;
const DB_NAME = 'auto-comment-history-scale-benchmark';

function formatMilliseconds(value) {
  return `${value.toFixed(2)} ms`;
}

function formatBytes(value) {
  return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(
      transaction.error || new Error('IndexedDB transaction aborted')
    );
    transaction.onerror = () => {};
  });
}

function openDatabase(indexedDBImpl, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB open blocked for ${dbName}`));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function generatedBundle(index) {
  const id = `bench:${String(index).padStart(6, '0')}`;
  const submittedAt = FIXED_NOW - ((index % 120) * DAY_MS) - Math.floor(index / 120);
  const targetDomain = `target-${index % 12}.example`;
  const promotedDomain = `promo-${index % 8}.example`;
  const promotedWebsiteUrl = `https://${promotedDomain}/`;
  const comment = {
    id,
    batchId: `bench-${Math.floor(index / 100)}`,
    urlIndex: index % 100,
    submittedAt,
    archiveMonth: '2026-07',
    targetPageUrl: `https://${targetDomain}/p/${index}`,
    targetDomain,
    promotedWebsiteUrl,
    promotedDomain,
    commentHtml: `<p>benchmark ${index}</p>`,
    commentText: `benchmark ${index}`,
    submitStatus: 'submitted',
    source: 'live',
    createdAt: submittedAt,
    updatedAt: submittedAt
  };
  const anchor = {
    id: `${id}:0`,
    commentId: id,
    position: 0,
    anchorText: `promo ${index}`,
    anchorTextNormalized: `promo ${index}`,
    hrefRaw: promotedWebsiteUrl,
    hrefResolved: promotedWebsiteUrl,
    hrefDomain: promotedDomain
  };
  return { comment, anchor };
}

async function insertDataset(database) {
  const startedAt = performance.now();
  for (let offset = 0; offset < RECORD_COUNT; offset += INSERT_BATCH_SIZE) {
    const transaction = database.transaction(
      ['comment_records', 'comment_anchors'],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const commentStore = transaction.objectStore('comment_records');
    const anchorStore = transaction.objectStore('comment_anchors');
    const end = Math.min(offset + INSERT_BATCH_SIZE, RECORD_COUNT);
    for (let index = offset; index < end; index += 1) {
      const bundle = generatedBundle(index);
      commentStore.put(bundle.comment);
      anchorStore.put(bundle.anchor);
    }
    await completion;
  }
  return performance.now() - startedAt;
}

async function timed(operation) {
  const startedAt = performance.now();
  const result = await operation();
  return { result, durationMs: performance.now() - startedAt };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function sampleMedian(operation, validate) {
  const samples = [];
  for (let index = 0; index < QUERY_SAMPLES; index += 1) {
    const measurement = await timed(operation);
    validate(measurement.result);
    samples.push(measurement.durationMs);
  }
  return { samples, medianMs: median(samples) };
}

function validateCommentPage(result, predicate = () => true) {
  assert.equal(result.records.length, QUERY_LIMIT);
  assert.ok(result.records.every(predicate));
}

function validateExportPage(result) {
  assert.equal(result.records.length, EXPORT_LIMIT);
  assert.ok(result.records.every(({ comment, anchors }) => (
    anchors.length === 1 && anchors[0].commentId === comment.id
  )));
}

function validateDeletePreparation(ids) {
  assert.equal(ids.length, DELETE_PREPARATION_LIMIT);
  assert.ok(ids.every((id) => Number(id.slice('bench:'.length)) % 120 >= 90));
}

async function prepareDeleteIds(database) {
  const transaction = database.transaction('comment_records', 'readonly');
  const completion = transactionCompletion(transaction);
  const index = transaction.objectStore('comment_records').index('by_submitted_at_id');
  const expiredAt = FIXED_NOW - (90 * DAY_MS);
  const range = IDBKeyRange.upperBound([expiredAt, '\uffff\uffff']);
  const ids = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(range, 'next');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || ids.length >= DELETE_PREPARATION_LIMIT) {
        resolve();
        return;
      }
      ids.push(cursor.value.id);
      cursor.continue();
    };
  });
  await completion;
  return ids;
}

function logEnvironment() {
  const cpu = os.cpus()[0]?.model || 'unknown';
  console.log('Comment history scale benchmark');
  console.log(`Node: ${process.version}`);
  console.log(`OS: ${os.type()} ${os.release()} ${os.arch()}`);
  console.log(`CPU: ${cpu}`);
  console.log(`Logical CPUs: ${os.cpus().length}`);
  console.log(`System memory: ${formatBytes(os.totalmem())}`);
  console.log(`Dataset: ${RECORD_COUNT.toLocaleString('en-US')} comment records`);
  console.log(`Insert batch size: ${INSERT_BATCH_SIZE.toLocaleString('en-US')}`);
  console.log(`Query samples: ${QUERY_SAMPLES}`);
  console.log(`Indexed query median limit: ${formatMilliseconds(QUERY_MEDIAN_LIMIT_MS)}`);
}

async function main() {
  logEnvironment();
  const indexedDBImpl = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  let repository;
  let database;

  try {
    repository = await openCommentHistoryDb({
      indexedDBImpl,
      IDBKeyRangeImpl: IDBKeyRange,
      dbName: DB_NAME
    });
    database = await openDatabase(indexedDBImpl, DB_NAME);

    let insertDurationMs;
    try {
      insertDurationMs = await insertDataset(database);
      const insertedCount = await requestResult(
        database.transaction('comment_records', 'readonly')
          .objectStore('comment_records')
          .count()
      );
      if (insertedCount !== RECORD_COUNT) {
        throw new Error(`insert count mismatch: expected ${RECORD_COUNT}, received ${insertedCount}`);
      }
      const insertedAnchorCount = await requestResult(
        database.transaction('comment_anchors', 'readonly')
          .objectStore('comment_anchors')
          .count()
      );
      assert.equal(insertedAnchorCount, RECORD_COUNT);
      console.log(`Inserted records: ${insertedCount.toLocaleString('en-US')}`);
      console.log(`Inserted anchors: ${insertedAnchorCount.toLocaleString('en-US')}`);
      console.log(`Total insert time: ${formatMilliseconds(insertDurationMs)}`);
    } catch (error) {
      console.error(
        `RESOURCE FAILURE: unable to allocate or populate the ${RECORD_COUNT.toLocaleString('en-US')}-record fake-indexeddb dataset.`
      );
      console.error(error?.stack || error);
      process.exitCode = 2;
      return;
    }

    const coldFirstPage = await timed(
      () => repository.queryRecords({ limit: QUERY_LIMIT })
    );
    validateCommentPage(coldFirstPage.result);
    const warmFirstPage = await sampleMedian(
      () => repository.queryRecords({ limit: QUERY_LIMIT }),
      validateCommentPage
    );
    const targetDomainFilter = await sampleMedian(
      () => repository.queryRecords({
        targetDomain: 'target-3.example',
        limit: QUERY_LIMIT
      }),
      (result) => validateCommentPage(
        result,
        (record) => record.targetDomain === 'target-3.example'
      )
    );
    const promotedDomainFilter = await sampleMedian(
      () => repository.queryRecords({
        promotedDomain: 'promo-5.example',
        limit: QUERY_LIMIT
      }),
      (result) => validateCommentPage(
        result,
        (record) => record.promotedDomain === 'promo-5.example'
      )
    );
    const exportCursor = await timed(
      () => repository.getExportChunk({ limit: EXPORT_LIMIT })
    );
    validateExportPage(exportCursor.result);
    const deletePreparation = await timed(
      () => prepareDeleteIds(database)
    );
    validateDeletePreparation(deletePreparation.result);

    console.log(`Cold first-page query (${coldFirstPage.result.records.length} rows): ${formatMilliseconds(coldFirstPage.durationMs)}`);
    console.log(`Warm first-page query median of 5: ${formatMilliseconds(warmFirstPage.medianMs)} [${warmFirstPage.samples.map(formatMilliseconds).join(', ')}]`);
    console.log(`Target-domain filter median of 5: ${formatMilliseconds(targetDomainFilter.medianMs)} [${targetDomainFilter.samples.map(formatMilliseconds).join(', ')}]`);
    console.log(`Promoted-domain filter median of 5: ${formatMilliseconds(promotedDomainFilter.medianMs)} [${promotedDomainFilter.samples.map(formatMilliseconds).join(', ')}]`);
    console.log(`500-row export cursor (${exportCursor.result.records.length} rows): ${formatMilliseconds(exportCursor.durationMs)}`);
    console.log(`50,000-row delete preparation (${deletePreparation.result.length} IDs): ${formatMilliseconds(deletePreparation.durationMs)}`);

    const indexedMedians = [
      ['warm first-page', warmFirstPage.medianMs],
      ['target-domain filter', targetDomainFilter.medianMs],
      ['promoted-domain filter', promotedDomainFilter.medianMs]
    ];
    const overLimit = indexedMedians.filter(([, durationMs]) => (
      durationMs > QUERY_MEDIAN_LIMIT_MS
    ));
    if (overLimit.length > 0) {
      console.error(
        `FAIL: indexed query median exceeded ${formatMilliseconds(QUERY_MEDIAN_LIMIT_MS)}: `
        + overLimit.map(([name, durationMs]) => `${name}=${formatMilliseconds(durationMs)}`).join(', ')
      );
      process.exitCode = 1;
      return;
    }
    console.log('PASS: all indexed query medians are at or below 2,000 ms.');
  } finally {
    database?.close();
    repository?.close();
  }
}

main().catch((error) => {
  console.error('BENCHMARK FAILURE: comment-history benchmark could not complete.');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
