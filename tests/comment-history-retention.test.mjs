import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  classifyRetentionAge,
  shouldNotifyRetention,
  installCommentHistoryRetention
} from '../lib/comment-history-retention.mjs';
import { openCommentHistoryDb } from '../lib/comment-history-db.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);

function daysAgo(days) {
  return NOW - days * DAY_MS;
}

function syncedBundle(id, revisionId) {
  const submittedAt = daysAgo(91);
  const [batchId, rawIndex] = id.split(':');
  return {
    comment: {
      id,
      batchId,
      urlIndex: Number(rawIndex),
      submittedAt,
      archiveMonth: '2026-04',
      targetPageUrl: 'https://target.test/post',
      targetDomain: 'target.test',
      promotedWebsiteUrl: 'https://promo.test/',
      promotedDomain: 'promo.test',
      commentHtml: `<p>${id}</p>`,
      commentText: id,
      submitStatus: 'submitted',
      source: 'live',
      createdAt: submittedAt,
      updatedAt: submittedAt + 1,
      historyRevision: {
        capturedAt: submittedAt,
        recordedAt: submittedAt + 1,
        sequence: 0,
        id: revisionId
      }
    },
    anchors: []
  };
}

function createChromeApi() {
  const alarmListeners = [];
  const notificationListeners = [];
  const createdAlarms = [];
  const createdNotifications = [];
  const openedTabs = [];
  return {
    alarms: {
      create(name, info) {
        createdAlarms.push({ name, info });
      },
      onAlarm: {
        addListener(listener) {
          alarmListeners.push(listener);
        }
      }
    },
    notifications: {
      create(id, options) {
        createdNotifications.push({ id, options });
        return Promise.resolve(id);
      },
      onClicked: {
        addListener(listener) {
          notificationListeners.push(listener);
        }
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://history-test/${path}`;
      }
    },
    tabs: {
      create(info) {
        openedTabs.push(info);
        return Promise.resolve();
      }
    },
    createdAlarms,
    createdNotifications,
    openedTabs,
    async triggerAlarm(name) {
      for (const listener of alarmListeners) await listener({ name });
    },
    async clickNotification(id) {
      for (const listener of notificationListeners) await listener(id);
    }
  };
}

test('classifies retention with rolling 24-hour day boundaries', () => {
  assert.equal(classifyRetentionAge(daysAgo(79), NOW), 'active');
  assert.equal(classifyRetentionAge(daysAgo(80), NOW), 'due_soon');
  assert.equal(classifyRetentionAge(daysAgo(86), NOW), 'due_soon');
  assert.equal(classifyRetentionAge(daysAgo(87), NOW), 'due_soon');
  assert.equal(classifyRetentionAge(daysAgo(89), NOW), 'due_soon');
  assert.equal(classifyRetentionAge(daysAgo(90), NOW), 'expired_pending_confirmation');
  assert.equal(classifyRetentionAge(daysAgo(96), NOW), 'expired_pending_confirmation');
  assert.equal(classifyRetentionAge(daysAgo(97), NOW), 'expired_pending_confirmation');
});

test('schedules reminders at days 80, 87, 90, and every seven overdue days', () => {
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(79),
    lastReminderAt: null,
    now: NOW
  }), false);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(80),
    lastReminderAt: null,
    now: NOW
  }), true);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(86),
    lastReminderAt: NOW - 6 * DAY_MS,
    now: NOW
  }), false);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(87),
    lastReminderAt: NOW - 7 * DAY_MS,
    now: NOW
  }), true);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(89),
    lastReminderAt: NOW - 2 * DAY_MS,
    now: NOW
  }), false);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(90),
    lastReminderAt: NOW - 3 * DAY_MS,
    now: NOW
  }), true);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(96),
    lastReminderAt: NOW - 6 * DAY_MS,
    now: NOW
  }), false);
  assert.equal(shouldNotifyRetention({
    oldestSubmittedAt: daysAgo(97),
    lastReminderAt: NOW - 7 * DAY_MS,
    now: NOW
  }), true);
});

test('installs a daily alarm that only reminds and never deletes', async () => {
  const chromeApi = createChromeApi();
  let deleteCalls = 0;
  let reminderMeta = null;
  const service = {
    async getCloudSyncStatus() {
      return { enabled: false };
    },
    async getRetentionStatus() {
      return {
        dueSoonCount: 2,
        expiredCount: 0,
        oldestSubmittedAt: daysAgo(80)
      };
    },
    async getMeta() {
      return reminderMeta;
    },
    async setMeta(key, value) {
      assert.equal(key, 'retentionReminder');
      assert.equal(value.lastReminderAt, NOW);
      reminderMeta = value;
    },
    async deleteConfirmed() {
      deleteCalls += 1;
    },
    async evictSyncedCacheBefore() {
      deleteCalls += 1;
    }
  };

  const retention = installCommentHistoryRetention(chromeApi, service, { now: () => NOW });
  await retention.startupCheck;
  await chromeApi.triggerAlarm('comment-history-retention-check');

  assert.deepEqual(chromeApi.createdAlarms, [{
    name: 'comment-history-retention-check',
    info: { periodInMinutes: 1440 }
  }]);
  assert.equal(deleteCalls, 0);
  assert.equal(chromeApi.createdNotifications.length, 1);
  assert.equal(chromeApi.createdNotifications[0].options.iconUrl, 'chrome-extension://history-test/icons/history.svg');
  assert.match(chromeApi.createdNotifications[0].options.message, /2/);
  assert.match(chromeApi.createdNotifications[0].options.message, /2026-05-05/);

  await chromeApi.clickNotification(chromeApi.createdNotifications[0].id);
  assert.deepEqual(chromeApi.openedTabs, [{
    url: 'chrome-extension://history-test/history.html?filter=expired'
  }]);
});

test('enabled cloud sync evicts only repository-approved cache rows at the exact rolling cutoff', async () => {
  const chromeApi = createChromeApi();
  const calls = [];
  const service = {
    async getCloudSyncStatus() {
      calls.push(['status']);
      return { enabled: true, vaultId: 'vault-a' };
    },
    async evictSyncedCacheBefore(options) {
      calls.push(['evict', options]);
      return 2;
    },
    async getRetentionStatus() {
      throw new Error('local reminder path must not run');
    },
    async getMeta() {
      throw new Error('local reminder metadata must not run');
    },
    async setMeta() {
      throw new Error('local reminder metadata must not run');
    },
    async deleteConfirmed() {
      throw new Error('retention must not create tombstones');
    }
  };

  const retention = installCommentHistoryRetention(chromeApi, service, {
    now: () => NOW,
    startImmediately: false
  });

  assert.deepEqual(await retention.checkNow(), {
    mode: 'synced_cache',
    evicted: 2
  });
  assert.deepEqual(calls, [
    ['status'],
    ['evict', {
      vaultId: 'vault-a',
      cutoff: NOW - 90 * DAY_MS
    }]
  ]);
  assert.equal(chromeApi.createdNotifications.length, 0);
});

test('cloud status failures fail safe to the existing local reminder and never auto-delete', async () => {
  const chromeApi = createChromeApi();
  let statusCalls = 0;
  let evictionCalls = 0;
  let tombstoneCalls = 0;
  const service = {
    async getCloudSyncStatus() {
      statusCalls += 1;
      throw new Error('temporary status failure');
    },
    async evictSyncedCacheBefore() {
      evictionCalls += 1;
    },
    async getRetentionStatus() {
      return {
        dueSoonCount: 1,
        expiredCount: 0,
        oldestSubmittedAt: daysAgo(80)
      };
    },
    async getMeta() {
      return null;
    },
    async setMeta() {},
    async deleteConfirmed() {
      tombstoneCalls += 1;
    }
  };
  const retention = installCommentHistoryRetention(chromeApi, service, {
    now: () => NOW,
    startImmediately: false
  });

  assert.deepEqual(await retention.checkNow(), { notified: true });
  assert.equal(statusCalls, 1);
  assert.equal(evictionCalls, 0);
  assert.equal(tombstoneCalls, 0);
  assert.equal(chromeApi.createdNotifications.length, 1);
});

test('retention integration leaves pending, needs-attention, and revision-mismatched rows in the real repository', async (t) => {
  const repo = await openCommentHistoryDb({
    indexedDBImpl: new IDBFactory(),
    IDBKeyRangeImpl: IDBKeyRange,
    dbName: `retention-integration-${Date.now()}`
  });
  t.after(() => repo.close());
  const eligible = syncedBundle('eligible:1', 'revision-eligible');
  const mismatched = syncedBundle('mismatched:1', 'revision-current');
  const pending = syncedBundle('pending:1', 'revision-pending');
  const needsAttention = syncedBundle('attention:1', 'revision-attention');
  for (const bundle of [eligible, mismatched, pending, needsAttention]) {
    await repo.upsertRecord(bundle);
  }
  await repo.completeSyncMutations([
    {
      mutationId: 'receipt-eligible',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:eligible:1',
      revisionId: 'revision-eligible',
      serverSeq: 1
    },
    {
      mutationId: 'receipt-mismatch',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:mismatched:1',
      revisionId: 'revision-old',
      serverSeq: 2
    },
    {
      mutationId: 'receipt-pending',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:pending:1',
      revisionId: 'revision-pending',
      serverSeq: 3
    },
    {
      mutationId: 'receipt-attention',
      vaultId: 'vault-a',
      entityKey: 'vault-a:comment:attention:1',
      revisionId: 'revision-attention',
      serverSeq: 4
    }
  ]);
  for (const [mutationId, bundle, state] of [
    ['outbox-pending', pending, 'pending'],
    ['outbox-attention', needsAttention, 'needs_attention']
  ]) {
    await repo.enqueueSyncMutation({
      mutationId,
      vaultId: 'vault-a',
      entityType: 'comment',
      entityId: bundle.comment.id,
      operation: 'upsert',
      payload: bundle,
      createdAt: NOW,
      attemptCount: state === 'pending' ? 0 : 1,
      nextAttemptAt: NOW,
      lastErrorCode: state === 'pending' ? null : 'INVALID_SYNC_RESPONSE',
      state
    });
  }

  const chromeApi = createChromeApi();
  const retention = installCommentHistoryRetention(chromeApi, {
    async getCloudSyncStatus() {
      return { enabled: true, vaultId: 'vault-a' };
    },
    evictSyncedCacheBefore: (options) => repo.evictSyncedCacheBefore(options),
    async getRetentionStatus() {
      throw new Error('local reminder path must not run');
    }
  }, {
    now: () => NOW,
    startImmediately: false
  });

  assert.deepEqual(await retention.checkNow(), {
    mode: 'synced_cache',
    evicted: 1
  });
  assert.equal(await repo.getRecord('eligible:1'), null);
  assert.deepEqual(await repo.getRecord('mismatched:1'), mismatched);
  assert.deepEqual(await repo.getRecord('pending:1'), pending);
  assert.deepEqual(await repo.getRecord('attention:1'), needsAttention);
  assert.equal(chromeApi.createdNotifications.length, 0);
});

test('a changed eligible-set fingerprint bypasses the prior set cooldown', async () => {
  const chromeApi = createChromeApi();
  let checkedAt = NOW;
  let summary = {
    totalCount: 2,
    dueSoonCount: 0,
    expiredCount: 2,
    oldestSubmittedAt: daysAgo(100)
  };
  let reminderMeta = null;
  const service = {
    async getRetentionStatus() {
      return summary;
    },
    async getMeta() {
      return reminderMeta;
    },
    async setMeta(key, value) {
      assert.equal(key, 'retentionReminder');
      reminderMeta = structuredClone(value);
    }
  };
  const retention = installCommentHistoryRetention(chromeApi, service, {
    now: () => checkedAt,
    startImmediately: false
  });

  assert.deepEqual(await retention.checkNow(), { notified: true });
  assert.deepEqual(reminderMeta.fingerprint, {
    stage: 'expired_pending_confirmation',
    oldestSubmittedAt: daysAgo(100),
    dueSoonCount: 0,
    expiredCount: 2
  });

  checkedAt += DAY_MS;
  summary = {
    totalCount: 1,
    dueSoonCount: 0,
    expiredCount: 1,
    oldestSubmittedAt: daysAgo(95)
  };
  assert.deepEqual(await retention.checkNow(), { notified: true });
  assert.equal(chromeApi.createdNotifications.length, 2);
  assert.deepEqual(reminderMeta.fingerprint, {
    stage: 'expired_pending_confirmation',
    oldestSubmittedAt: daysAgo(95),
    dueSoonCount: 0,
    expiredCount: 1
  });

  assert.deepEqual(await retention.checkNow(), { notified: false });
  assert.equal(chromeApi.createdNotifications.length, 2);
});
