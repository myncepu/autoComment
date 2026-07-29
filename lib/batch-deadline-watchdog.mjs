import {
  BATCH_RUNTIME_CHECKPOINT_KEY
} from './batch-runtime-checkpoint.mjs';

const ALARM_PREFIX = 'auto-comment:batch-deadline:';

function alarmName(identity) {
  return `${ALARM_PREFIX}${encodeURIComponent(identity.batchId)}:` +
    `${identity.urlIndex}:${identity.attempt}`;
}

function parseAlarmName(name) {
  if (typeof name !== 'string' || !name.startsWith(ALARM_PREFIX)) {
    return null;
  }
  const parts = name.slice(ALARM_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const urlIndex = Number(parts[1]);
  const attempt = Number(parts[2]);
  let batchId;
  try {
    batchId = decodeURIComponent(parts[0]);
  } catch (_) {
    return null;
  }
  if (
    !batchId ||
    !Number.isInteger(urlIndex) ||
    urlIndex < 0 ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    return null;
  }
  return { batchId, urlIndex, attempt };
}

function desiredDeadlines(checkpoint) {
  const timeoutSeconds = Number(checkpoint?.settings?.timeoutSeconds);
  if (
    typeof checkpoint?.batchId !== 'string' ||
    checkpoint.status !== 'running' ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return new Map();
  }
  return new Map(
    Object.values(checkpoint.tasks || {}).flatMap((task) => {
      if (
        !['active', 'submitting'].includes(task?.state) ||
        !Number.isInteger(task?.urlIndex) ||
        !Number.isInteger(task?.attempt) ||
        !Number.isFinite(task?.startedAt)
      ) {
        return [];
      }
      const identity = {
        batchId: checkpoint.batchId,
        urlIndex: task.urlIndex,
        attempt: task.attempt
      };
      return [[alarmName(identity), {
        identity,
        tabId: Number.isInteger(task.tabId) ? task.tabId : null,
        deadlineAt: task.startedAt + (timeoutSeconds * 1000),
        timeoutSeconds
      }]];
    })
  );
}

export function createBatchDeadlineWatchdog({
  alarms,
  storageArea,
  storageChanged,
  runtimeController,
  runtime,
  diagnosticService,
  now = Date.now
}) {
  let operation = Promise.resolve();
  let started = false;

  function enqueue(work) {
    const current = operation.then(work, work);
    operation = current.catch(() => {});
    return current;
  }

  async function appendDiagnostic(
    identity,
    event,
    details,
    sourceTabId,
    sourceUrl = ''
  ) {
    if (typeof diagnosticService?.appendSystem !== 'function') return;
    await diagnosticService.appendSystem({
      ...identity,
      event,
      details
    }, { sourceTabId, sourceUrl }).catch(() => {});
  }

  async function reconcileNow(checkpoint) {
    const desired = desiredDeadlines(checkpoint);
    const current = (await alarms.getAll())
      .filter(({ name }) => name.startsWith(ALARM_PREFIX));
    const currentByName = new Map(current.map((alarm) => [alarm.name, alarm]));
    for (const alarm of current) {
      if (!desired.has(alarm.name)) {
        await alarms.clear(alarm.name);
      }
    }
    for (const [name, deadline] of desired) {
      const scheduledTime = currentByName.get(name)?.scheduledTime;
      if (
        Number.isFinite(scheduledTime) &&
        Math.abs(scheduledTime - deadline.deadlineAt) < 1000
      ) {
        continue;
      }
      const scheduledAt = Math.max(now() + 1, deadline.deadlineAt);
      await Promise.resolve(alarms.create(name, { when: scheduledAt }));
      await appendDiagnostic(
        deadline.identity,
        'deadline_scheduled',
        {
          deadlineAt: deadline.deadlineAt,
          scheduledDelayMs: Math.max(0, scheduledAt - now()),
          timeoutSeconds: deadline.timeoutSeconds
        },
        deadline.tabId
      );
    }
    return true;
  }

  function reconcile(checkpoint) {
    return enqueue(() => reconcileNow(checkpoint));
  }

  async function reconcileStored() {
    const stored = await storageArea.get([BATCH_RUNTIME_CHECKPOINT_KEY]);
    return reconcileNow(stored[BATCH_RUNTIME_CHECKPOINT_KEY] || null);
  }

  function onStorageChanged(changes, areaName) {
    if (
      areaName !== 'local' ||
      !Object.hasOwn(changes || {}, BATCH_RUNTIME_CHECKPOINT_KEY)
    ) {
      return;
    }
    void reconcile(
      changes[BATCH_RUNTIME_CHECKPOINT_KEY]?.newValue || null
    ).catch(() => {});
  }

  function onAlarm(alarm) {
    const identity = parseAlarmName(alarm?.name);
    if (!identity) return;
    void enqueue(async () => {
      const stored = await storageArea.get([BATCH_RUNTIME_CHECKPOINT_KEY]);
      const checkpoint = stored[BATCH_RUNTIME_CHECKPOINT_KEY];
      const task = checkpoint?.tasks?.[String(identity.urlIndex)];
      if (
        checkpoint?.batchId !== identity.batchId ||
        task?.attempt !== identity.attempt ||
        !['active', 'submitting'].includes(task?.state)
      ) {
        await reconcileNow(checkpoint || null);
        return;
      }
      const deadlineAt = task.startedAt +
        (checkpoint.settings.timeoutSeconds * 1000);
      if (now() < deadlineAt) {
        await Promise.resolve(alarms.create(alarm.name, {
          when: deadlineAt
        }));
        return;
      }
      await appendDiagnostic(
        identity,
        'deadline_fired',
        {
          deadlineAt,
          elapsedMs: Math.max(0, now() - task.startedAt),
          timeoutSeconds: checkpoint.settings.timeoutSeconds
        },
        task.tabId,
        checkpoint.source?.parsedUrls?.[identity.urlIndex]
      );
      const response = await runtimeController.expireTask(identity);
      await appendDiagnostic(
        identity,
        'deadline_terminalized',
        {
          success: response?.ok === true,
          errorCode: response?.ok
            ? 'task_timeout'
            : String(response?.error || 'deadline_terminal_failed')
        },
        task.tabId,
        checkpoint.source?.parsedUrls?.[identity.urlIndex]
      );
      if (!response?.ok) {
        await Promise.resolve(alarms.create(alarm.name, {
          when: now() + 30_000
        }));
        return;
      }
      if (response?.ok && response.changed && response.expiration) {
        let notified = false;
        try {
          await runtime.sendMessage({
            type: 'BATCH_WORKER_TAB_REMOVED',
            ...response.expiration,
            deadlineExpired: true,
            checkpoint: response.checkpoint
          });
          notified = true;
        } catch (_) {}
        await appendDiagnostic(
          identity,
          'deadline_replenish_notified',
          { success: notified },
          task.tabId,
          checkpoint.source?.parsedUrls?.[identity.urlIndex]
        );
      }
      await reconcileNow(response?.checkpoint || checkpoint);
    }).catch(() => {});
  }

  function start() {
    if (started) return false;
    if (
      typeof alarms?.getAll !== 'function' ||
      typeof alarms?.create !== 'function' ||
      typeof alarms?.clear !== 'function' ||
      typeof alarms?.onAlarm?.addListener !== 'function' ||
      typeof storageChanged?.addListener !== 'function'
    ) {
      return false;
    }
    started = true;
    alarms.onAlarm.addListener(onAlarm);
    storageChanged.addListener(onStorageChanged);
    void enqueue(reconcileStored).catch(() => {});
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    alarms.onAlarm.removeListener(onAlarm);
    storageChanged.removeListener(onStorageChanged);
    return true;
  }

  return Object.freeze({
    reconcile,
    start,
    stop
  });
}
