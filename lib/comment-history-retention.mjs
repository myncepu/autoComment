const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAY = 80;
const SECOND_REMINDER_DAY = 87;
const EXPIRY_DAY = 90;
const OVERDUE_REMINDER_INTERVAL_MS = 7 * DAY_MS;

export const COMMENT_HISTORY_RETENTION_ALARM = 'comment-history-retention-check';
export const COMMENT_HISTORY_RETENTION_NOTIFICATION = 'comment-history-retention';
export const COMMENT_HISTORY_RETENTION_META_KEY = 'retentionReminder';

function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function reminderThresholds(oldestSubmittedAt) {
  return [DUE_SOON_DAY, SECOND_REMINDER_DAY, EXPIRY_DAY]
    .map((days) => oldestSubmittedAt + days * DAY_MS);
}

function notificationCount(summary) {
  return summary.expiredCount > 0 ? summary.expiredCount : summary.dueSoonCount;
}

function oldestDate(submittedAt) {
  return new Date(submittedAt).toISOString().slice(0, 10);
}

export function classifyRetentionAge(submittedAt, now) {
  if (!isTimestamp(submittedAt) || !isTimestamp(now)) return 'active';
  const ageMs = now - submittedAt;
  if (ageMs < DUE_SOON_DAY * DAY_MS) return 'active';
  if (ageMs < EXPIRY_DAY * DAY_MS) return 'due_soon';
  return 'expired_pending_confirmation';
}

export function shouldNotifyRetention({ oldestSubmittedAt, lastReminderAt, now }) {
  if (!isTimestamp(oldestSubmittedAt) || !isTimestamp(now)) return false;
  if (now - oldestSubmittedAt < DUE_SOON_DAY * DAY_MS) return false;

  const hasReminder = isTimestamp(lastReminderAt);
  for (const threshold of reminderThresholds(oldestSubmittedAt)) {
    if (now >= threshold && (!hasReminder || lastReminderAt < threshold)) return true;
  }

  return now - oldestSubmittedAt >= EXPIRY_DAY * DAY_MS
    && (!hasReminder || now - lastReminderAt >= OVERDUE_REMINDER_INTERVAL_MS);
}

export function installCommentHistoryRetention(chromeApi, service, {
  now = Date.now,
  startImmediately = true
} = {}) {
  async function runRetentionCheck() {
    const summary = await service.getRetentionStatus();
    const oldestSubmittedAt = summary?.oldestSubmittedAt;
    const checkedAt = now();
    const reminderMeta = await service.getMeta(COMMENT_HISTORY_RETENTION_META_KEY);
    const lastReminderAt = reminderMeta?.lastReminderAt;

    if (!shouldNotifyRetention({ oldestSubmittedAt, lastReminderAt, now: checkedAt })) {
      return { notified: false };
    }

    const count = notificationCount(summary);
    const state = classifyRetentionAge(oldestSubmittedAt, checkedAt);
    await chromeApi.notifications.create(COMMENT_HISTORY_RETENTION_NOTIFICATION, {
      type: 'basic',
      title: state === 'expired_pending_confirmation'
        ? '评论历史等待确认清理'
        : '评论历史即将到期',
      message: `共有 ${count} 条评论历史记录，最早日期为 ${oldestDate(oldestSubmittedAt)}。请导出后在历史页面确认清理。`,
      iconUrl: chromeApi.runtime.getURL('icons/history.svg')
    });
    await service.setMeta(COMMENT_HISTORY_RETENTION_META_KEY, {
      lastReminderAt: checkedAt,
      oldestSubmittedAt,
      lastCheckedAt: checkedAt
    });
    return { notified: true };
  }

  if (chromeApi.alarms?.create && chromeApi.alarms.onAlarm?.addListener) {
    chromeApi.alarms.create(COMMENT_HISTORY_RETENTION_ALARM, { periodInMinutes: 1440 });
    chromeApi.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name === COMMENT_HISTORY_RETENTION_ALARM) return runRetentionCheck();
      return undefined;
    });
  }
  if (chromeApi.notifications?.onClicked?.addListener) {
    chromeApi.notifications.onClicked.addListener((notificationId) => {
      if (notificationId !== COMMENT_HISTORY_RETENTION_NOTIFICATION) return undefined;
      return chromeApi.tabs.create({
        url: chromeApi.runtime.getURL('history.html?filter=expired')
      });
    });
  }

  return {
    checkNow: runRetentionCheck,
    startupCheck: startImmediately ? runRetentionCheck() : Promise.resolve({ deferred: true })
  };
}
