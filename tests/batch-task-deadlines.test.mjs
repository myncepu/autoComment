import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchTaskDeadlines
} from '../lib/batch-task-deadlines.mjs';

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  const delays = new Map();
  return {
    callbacks,
    delays,
    api: {
      setTimeout(callback, delay) {
        const id = nextId++;
        callbacks.set(id, callback);
        delays.set(id, delay);
        return id;
      },
      clearTimeout(id) {
        callbacks.delete(id);
        delays.delete(id);
      }
    },
    fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      delays.delete(id);
      callback?.();
    }
  };
}

function identity(attempt = 1) {
  return {
    batchId: 'batch-a',
    urlIndex: 2,
    attempt
  };
}

test('arms an attempt-scoped deadline from the original start time', () => {
  const timers = fakeTimers();
  const expired = [];
  const deadlines = createBatchTaskDeadlines({
    timers: timers.api,
    now: () => 1_250,
    onExpire: (task) => expired.push(task)
  });

  deadlines.arm(identity(), 1_000, 1_000);

  assert.equal(deadlines.has(identity()), true);
  assert.deepEqual([...timers.delays.values()], [750]);
  timers.fire([...timers.callbacks.keys()][0]);
  assert.deepEqual(expired, [identity()]);
  assert.equal(deadlines.has(identity()), false);
});

test('rearming and clearing one attempt cannot expire a replacement attempt', () => {
  const timers = fakeTimers();
  const expired = [];
  const deadlines = createBatchTaskDeadlines({
    timers: timers.api,
    now: () => 2_000,
    onExpire: (task) => expired.push(task)
  });

  deadlines.arm(identity(1), 1_000, 5_000);
  const staleId = [...timers.callbacks.keys()][0];
  deadlines.clear(identity(1));
  deadlines.arm(identity(2), 2_000, 5_000);

  timers.fire(staleId);
  assert.deepEqual(expired, []);
  assert.equal(deadlines.has(identity(2)), true);
  timers.fire([...timers.callbacks.keys()][0]);
  assert.deepEqual(expired, [identity(2)]);
});

test('clearAll cancels every task deadline', () => {
  const timers = fakeTimers();
  const deadlines = createBatchTaskDeadlines({
    timers: timers.api,
    now: () => 1_000,
    onExpire() {
      throw new Error('cleared deadline must not expire');
    }
  });
  deadlines.arm(identity(1), 1_000, 1_000);
  deadlines.arm({ ...identity(1), urlIndex: 3 }, 1_000, 1_000);

  deadlines.clearAll();

  assert.equal(timers.callbacks.size, 0);
  assert.equal(deadlines.size, 0);
});

test('rejects malformed identities and timeout values', () => {
  const timers = fakeTimers();
  const deadlines = createBatchTaskDeadlines({
    timers: timers.api,
    now: () => 1_000,
    onExpire() {}
  });

  assert.throws(
    () => deadlines.arm({ batchId: '', urlIndex: 0, attempt: 1 }, 1, 1),
    /invalid_task_deadline_identity/
  );
  assert.throws(
    () => deadlines.arm(identity(), 1_000, 0),
    /invalid_task_deadline/
  );
});
