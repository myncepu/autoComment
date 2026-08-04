import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openOutlinkRecordDb } from '../lib/outlink-record-db.mjs';

let sequence = 0;

async function openRepo(t) {
  const repository = await openOutlinkRecordDb({
    indexedDBImpl: new IDBFactory(),
    dbName: `outlink-record-test-${sequence += 1}`
  });
  t.after(() => repository.close());
  return repository;
}

test('saves links and updates a repeated source-page/link pair', async (t) => {
  const repository = await openRepo(t);
  const first = await repository.saveExport({
    sourceUrl: 'https://blog.test/post',
    sourceTitle: 'Post',
    capturedAt: 100,
    links: [
      {
        url: 'https://external.test/a',
        host: 'external.test',
        text: 'First',
        isNofollow: false
      }
    ]
  });
  const second = await repository.saveExport({
    sourceUrl: 'https://blog.test/post',
    sourceTitle: 'Updated post',
    capturedAt: 200,
    links: [
      {
        url: 'https://external.test/a',
        host: 'external.test',
        text: 'Updated',
        isNofollow: true
      }
    ]
  });

  assert.deepEqual(first, { inserted: 1, updated: 0, total: 1, capturedAt: 100 });
  assert.deepEqual(second, { inserted: 0, updated: 1, total: 1, capturedAt: 200 });
  const page = await repository.list();
  assert.equal(page.total, 1);
  assert.equal(page.records[0].captureCount, 2);
  assert.equal(page.records[0].text, 'Updated');
  assert.equal(page.records[0].isNofollow, true);
});

test('lists, summarizes, filters, deletes, and clears records', async (t) => {
  const repository = await openRepo(t);
  await repository.saveExport({
    sourceUrl: 'https://first.test/post',
    capturedAt: 100,
    links: [{
      url: 'https://one.test/dofollow',
      text: 'Alpha',
      isNofollow: false
    }]
  });
  await repository.saveExport({
    sourceUrl: 'https://second.test/post',
    capturedAt: 200,
    links: [{
      url: 'https://two.test/nofollow',
      text: 'Beta',
      isNofollow: true
    }]
  });

  assert.deepEqual(await repository.summary(), {
    total: 2,
    sourceHosts: 2,
    targetHosts: 2,
    lastCapturedAt: 200
  });
  const filtered = await repository.list({
    filter: { sourceHost: 'second', linkType: 'nofollow', keyword: 'beta' }
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.records[0].host, 'two.test');

  assert.deepEqual(
    await repository.deleteRecords([filtered.records[0].id]),
    { deleted: 1 }
  );
  assert.equal((await repository.summary()).total, 1);
  await repository.clear();
  assert.equal((await repository.summary()).total, 0);
});
