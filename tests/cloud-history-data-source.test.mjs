import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_HISTORY_OFFLINE_ERROR,
  createCloudHistoryDataSource
} from '../lib/cloud-history-data-source.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 25, 12);
const CUTOFF = NOW - 90 * DAY_MS;

function ok(data) {
  return { ok: true, data };
}

function localRecord(id, submittedAt = NOW) {
  return {
    id,
    submittedAt,
    targetPageUrl: 'https://target.test/post',
    promotedWebsiteUrl: 'https://promo.test/',
    commentText: id,
    commentHtml: `<p>${id}</p>`
  };
}

function cloudRecord(id, submittedAt = CUTOFF - 1) {
  return {
    comment: localRecord(id, submittedAt),
    anchors: []
  };
}

test('disabled sync always uses local history without applying the cloud cache cutoff', async () => {
  const sent = [];
  const source = createCloudHistoryDataSource({
    sendMessage: async (message) => {
      sent.push(message);
      return ok({
        records: [localRecord('local:1', CUTOFF - DAY_MS)],
        nextCursor: null
      });
    },
    now: () => NOW
  });

  const page = await source.list({
    syncEnabled: false,
    online: true,
    targetDomain: 'target.test',
    limit: 50
  }, null);

  assert.deepEqual(sent, [{
    type: 'HISTORY_LIST',
    targetDomain: 'target.test',
    limit: 50
  }]);
  assert.equal(page.records[0].storageSource, 'local');
  assert.equal(page.records[0].comment.id, 'local:1');
  assert.equal(page.nextCursor, null);
});

test('enabled recent unfiltered pages finish local cache before cloud history older than one fixed cutoff', async () => {
  let currentNow = NOW;
  const sent = [];
  const source = createCloudHistoryDataSource({
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'HISTORY_LIST' && sent.length === 1) {
        return ok({
          records: [localRecord('local:2')],
          nextCursor: { submittedAt: NOW, id: 'local:2' },
          hasMore: true
        });
      }
      if (message.type === 'HISTORY_LIST') {
        return ok({
          records: [localRecord('local:1', CUTOFF)],
          nextCursor: null,
          hasMore: false
        });
      }
      return ok({
        records: [cloudRecord('cloud:old')],
        nextCursor: null,
        hasMore: false
      });
    },
    now: () => currentNow
  });

  const first = await source.list({
    syncEnabled: true,
    online: true,
    limit: 50
  }, null);
  currentNow += 10 * DAY_MS;
  const second = await source.list({
    syncEnabled: true,
    online: true,
    limit: 50
  }, first.nextCursor);
  const third = await source.list({
    syncEnabled: true,
    online: true,
    limit: 50
  }, second.nextCursor);

  assert.deepEqual(sent, [
    {
      type: 'HISTORY_LIST',
      from: CUTOFF,
      limit: 50
    },
    {
      type: 'HISTORY_LIST',
      from: CUTOFF,
      limit: 50,
      cursor: { submittedAt: NOW, id: 'local:2' }
    },
    {
      type: 'CLOUD_HISTORY_LIST',
      query: {
        to: CUTOFF - 1,
        limit: 50
      }
    }
  ]);
  assert.equal(first.records[0].storageSource, 'local');
  assert.equal(second.records[0].storageSource, 'local');
  assert.equal(second.nextCursor.phase, 'cloud');
  assert.equal(second.nextCursor.cutoff, CUTOFF);
  assert.equal(third.records[0].storageSource, 'cloud');
  assert.equal(third.nextCursor, null);
});

test('cross-cutoff ranges and every searchable field go directly to cloud when online', async () => {
  const filters = [
    { from: CUTOFF - 1, to: CUTOFF + 1 },
    { targetDomain: 'target.test' },
    { promotedDomain: 'promo.test' },
    { anchorTextPrefix: 'product' },
    { hrefDomain: 'docs.test' },
    { profileId: 'profile-a' },
    { promotionSiteId: 'site-b' }
  ];

  for (const distinguishingFilter of filters) {
    const sent = [];
    const source = createCloudHistoryDataSource({
      sendMessage: async (message) => {
        sent.push(message);
        return ok({ records: [], nextCursor: null, hasMore: false });
      },
      now: () => NOW
    });

    await source.list({
      ...distinguishingFilter,
      syncEnabled: true,
      online: true,
      limit: 50
    }, null);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'CLOUD_HISTORY_LIST');
    assert.deepEqual(sent[0].query, {
      ...distinguishingFilter,
      limit: 50
    });
  }
});

test('offline cloud-required pages fail with a stable safe error before sending a request', async () => {
  let calls = 0;
  const source = createCloudHistoryDataSource({
    sendMessage: async () => {
      calls += 1;
      throw new Error('must not send');
    },
    now: () => NOW
  });

  await assert.rejects(
    source.list({
      syncEnabled: true,
      online: false,
      targetDomain: 'target.test',
      limit: 50
    }, null),
    (error) => {
      assert.deepEqual({
        code: error.code,
        message: error.message,
        retryable: error.retryable
      }, CLOUD_HISTORY_OFFLINE_ERROR);
      return true;
    }
  );
  assert.equal(calls, 0);
});

test('cloud cursors become Task 9 scalar query parameters and cannot be mixed, cloned, or reused with another filter', async () => {
  const sent = [];
  const source = createCloudHistoryDataSource({
    sendMessage: async (message) => {
      sent.push(message);
      return ok({
        records: [],
        nextCursor: {
          submittedAt: CUTOFF - DAY_MS,
          id: 'cloud:2'
        },
        hasMore: true
      });
    },
    now: () => NOW
  });
  const first = await source.list({
    syncEnabled: true,
    online: true,
    targetDomain: 'target.test',
    limit: 50
  }, null);
  await source.list({
    syncEnabled: true,
    online: true,
    targetDomain: 'target.test',
    limit: 50
  }, first.nextCursor);

  assert.deepEqual(sent[1], {
    type: 'CLOUD_HISTORY_LIST',
    query: {
      targetDomain: 'target.test',
      limit: 50,
      cursorSubmittedAt: CUTOFF - DAY_MS,
      cursorId: 'cloud:2'
    }
  });
  assert.equal(Object.hasOwn(sent[1].query, 'cursor'), false);
  assert.equal(
    Reflect.set(first.nextCursor.cloudCursor, 'id', 'tampered'),
    false
  );
  assert.equal(first.nextCursor.cloudCursor.id, 'cloud:2');

  await assert.rejects(
    source.list({
      syncEnabled: true,
      online: true,
      promotedDomain: 'promo.test',
      limit: 50
    }, first.nextCursor),
    { code: 'INVALID_HISTORY_CURSOR' }
  );
  await assert.rejects(
    source.list({
      syncEnabled: true,
      online: true,
      targetDomain: 'target.test',
      limit: 50
    }, structuredClone(first.nextCursor)),
    { code: 'INVALID_HISTORY_CURSOR' }
  );

  const otherSource = createCloudHistoryDataSource({
    sendMessage: async () => ok({ records: [], nextCursor: null }),
    now: () => NOW
  });
  await assert.rejects(
    otherSource.list({
      syncEnabled: true,
      online: true,
      targetDomain: 'target.test',
      limit: 50
    }, first.nextCursor),
    { code: 'INVALID_HISTORY_CURSOR' }
  );
});

test('status and permanent deletion use the fixed cloud message contracts', async () => {
  const sent = [];
  const source = createCloudHistoryDataSource({
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'CLOUD_SYNC_STATUS') {
        return ok({ enabled: true, vaultId: 'vault-a', state: 'idle' });
      }
      return ok({ status: 'applied' });
    },
    now: () => NOW
  });

  assert.deepEqual(await source.status(), {
    enabled: true,
    vaultId: 'vault-a',
    state: 'idle'
  });
  assert.deepEqual(await source.deleteEverywhere('batch-a:1'), {
    status: 'applied'
  });
  assert.deepEqual(sent, [
    { type: 'CLOUD_SYNC_STATUS' },
    { type: 'CLOUD_HISTORY_DELETE', recordId: 'batch-a:1' }
  ]);
});
