import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchDeadlineWatchdog
} from '../lib/batch-deadline-watchdog.mjs';
import {
  BATCH_RUNTIME_CHECKPOINT_KEY
} from '../lib/batch-runtime-checkpoint.mjs';

function listenerSet() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    }
  };
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('background alarm enforces the task deadline and notifies the batch page', async () => {
  let clock = 1000;
  const checkpoint = {
    batchId: 'batch-1',
    status: 'running',
    source: {
      parsedUrls: [
        null,
        null,
        null,
        null,
        'https://comments.example/article'
      ]
    },
    settings: { timeoutSeconds: 90 },
    tasks: {
      4: {
        urlIndex: 4,
        attempt: 2,
        state: 'active',
        phase: 'filling',
        tabId: 44,
        startedAt: 1000
      }
    }
  };
  const terminalCheckpoint = structuredClone(checkpoint);
  Object.assign(terminalCheckpoint.tasks[4], {
    state: 'terminal',
    phase: null,
    tabId: null,
    startedAt: null
  });
  const alarmListeners = listenerSet();
  const storageListeners = listenerSet();
  const scheduled = new Map();
  const alarms = {
    onAlarm: alarmListeners,
    async getAll() {
      return [...scheduled.entries()].map(([name, details]) => ({
        name,
        scheduledTime: details.when
      }));
    },
    create(name, details) {
      scheduled.set(name, { ...details });
    },
    async clear(name) {
      return scheduled.delete(name);
    }
  };
  const storageArea = {
    async get() {
      return { [BATCH_RUNTIME_CHECKPOINT_KEY]: checkpoint };
    }
  };
  const expirations = [];
  const broadcasts = [];
  const diagnostics = [];
  const watchdog = createBatchDeadlineWatchdog({
    alarms,
    storageArea,
    storageChanged: storageListeners,
    runtimeController: {
      async expireTask(identity) {
        expirations.push(structuredClone(identity));
        return {
          ok: true,
          changed: true,
          checkpoint: terminalCheckpoint,
          expiration: {
            ...identity,
            tabId: 44
          }
        };
      }
    },
    runtime: {
      async sendMessage(message) {
        broadcasts.push(structuredClone(message));
      }
    },
    diagnosticService: {
      async appendSystem(message, options) {
        diagnostics.push({
          ...structuredClone(message),
          options: structuredClone(options)
        });
        return { ok: true };
      }
    },
    now: () => clock
  });

  watchdog.start();
  await watchdog.reconcile(checkpoint);
  const [name, alarm] = [...scheduled.entries()][0];
  assert.equal(alarm.when, 91_000);
  assert.equal(
    diagnostics.some(({ event }) => event === 'deadline_scheduled'),
    true
  );

  clock = 91_001;
  for (const listener of alarmListeners.listeners) {
    listener({ name, scheduledTime: alarm.when });
  }
  await waitFor(() => broadcasts.length === 1, 'deadline broadcast');

  assert.deepEqual(expirations, [{
    batchId: 'batch-1',
    urlIndex: 4,
    attempt: 2
  }]);
  assert.equal(broadcasts[0].type, 'BATCH_WORKER_TAB_REMOVED');
  assert.equal(broadcasts[0].tabId, 44);
  assert.equal(broadcasts[0].deadlineExpired, true);
  assert.equal(scheduled.size, 0);
  assert.deepEqual(
    diagnostics.map(({ event }) => event),
    [
      'deadline_scheduled',
      'deadline_fired',
      'deadline_terminalized',
      'deadline_replenish_notified'
    ]
  );
  assert.deepEqual(
    diagnostics
      .filter(({ event }) => event !== 'deadline_scheduled')
      .map(({ options }) => options.sourceUrl),
    [
      'https://comments.example/article',
      'https://comments.example/article',
      'https://comments.example/article'
    ]
  );
  assert.equal(
    diagnostics.find(({ event }) => event === 'deadline_terminalized')
      .details.errorCode,
    'task_timeout'
  );
  watchdog.stop();
});

test('a failed background expiration retries without a tight alarm loop', async () => {
  let clock = 100_000;
  const checkpoint = {
    batchId: 'batch-1',
    status: 'running',
    settings: { timeoutSeconds: 10 },
    tasks: {
      0: {
        urlIndex: 0,
        attempt: 1,
        state: 'submitting',
        phase: 'confirming',
        tabId: 10,
        startedAt: 1000
      }
    }
  };
  const alarmListeners = listenerSet();
  const storageListeners = listenerSet();
  const scheduled = new Map();
  const alarms = {
    onAlarm: alarmListeners,
    async getAll() {
      return [...scheduled.entries()].map(([name, details]) => ({
        name,
        scheduledTime: details.when
      }));
    },
    create(name, details) {
      scheduled.set(name, { ...details });
    },
    async clear(name) {
      return scheduled.delete(name);
    }
  };
  const watchdog = createBatchDeadlineWatchdog({
    alarms,
    storageArea: {
      async get() {
        return { [BATCH_RUNTIME_CHECKPOINT_KEY]: checkpoint };
      }
    },
    storageChanged: storageListeners,
    runtimeController: {
      async expireTask() {
        return { ok: false, error: 'checkpoint_write_failed', checkpoint };
      }
    },
    runtime: { async sendMessage() {} },
    now: () => clock
  });

  watchdog.start();
  await watchdog.reconcile(checkpoint);
  const name = [...scheduled.keys()][0];
  for (const listener of alarmListeners.listeners) {
    listener({ name });
  }
  await waitFor(
    () => scheduled.get(name)?.when === 130_000,
    'bounded expiration retry'
  );
  assert.equal(scheduled.get(name).when, clock + 30_000);
  watchdog.stop();
});
