import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRetentionAge,
  shouldNotifyRetention,
  installCommentHistoryRetention
} from '../lib/comment-history-retention.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);

function daysAgo(days) {
  return NOW - days * DAY_MS;
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
