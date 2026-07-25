import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchCommandController
} from '../lib/batch-command-controller.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCheckpoint({
  status = 'running',
  attempt = 1,
  taskState = 'terminal',
  result = 'fail',
  errorCode = 'task_timeout'
} = {}) {
  const url = 'https://target.test/page';
  return {
    version: 2,
    batchId: 'batch-1',
    status,
    createdAt: 1000,
    updatedAt: 1000,
    source: {
      fileName: 'targets.csv',
      headers: ['URL'],
      rows: [[url]],
      parsedUrls: [{
        originalIndex: 0,
        url,
        sourceDomain: 'target.test',
        originalRow: [url]
      }]
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site'
      }
    },
    cursor: { nextIndex: taskState === 'terminal' ? 1 : 0 },
    tasks: {
      0: {
        urlIndex: 0,
        attempt,
        state: taskState,
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1000,
        manualResolution: {
          status: 'idle',
          updatedAt: null
        }
      }
    },
    results: taskState === 'terminal'
      ? [{
          originalIndex: 0,
          attempt,
          url,
          sourceDomain: 'target.test',
          result,
          aiContent: null,
          errorCode,
          errorMessage: 'fixture failure',
          timestamp: 1000,
          elapsed: 1,
          originalRow: [url]
        }]
      : []
  };
}

function createOnlineTarget() {
  const callbacks = new Map();
  return {
    callbacks,
    addEventListener(type, callback) {
      callbacks.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (callbacks.get(type) === callback) callbacks.delete(type);
    },
    emit(type) {
      callbacks.get(type)?.();
    }
  };
}

function transitionCheckpoint(checkpoint, type, payload) {
  const next = structuredClone(checkpoint);
  next.updatedAt += 1;
  if (type === 'BATCH_SESSION_START') {
    return createCheckpoint({ status: 'running', taskState: 'queued' });
  }
  if (type === 'BATCH_SESSION_PAUSE') next.status = 'paused_recovery';
  if (type === 'BATCH_SESSION_RESUME') next.status = 'running';
  if (type === 'BATCH_SESSION_STOP') next.status = 'terminated';
  if (type === 'BATCH_TASK_RETRY') {
    next.tasks[String(payload.urlIndex)].attempt += 1;
    next.tasks[String(payload.urlIndex)].state = 'queued';
    next.cursor.nextIndex = payload.urlIndex;
  }
  if (type === 'BATCH_TASK_MANUAL_UPDATE') {
    next.tasks[String(payload.urlIndex)].manualResolution = {
      status: payload.status,
      updatedAt: next.updatedAt
    };
  }
  return next;
}

function createCommandHarness(options = {}) {
  const calls = [];
  const published = [];
  const onlineTarget = createOnlineTarget();
  let checkpoint = options.checkpoint || createCheckpoint();
  const pauseGate = options.pauseGate || null;

  const workerRuntime = {
    async start(nextCheckpoint) {
      calls.push(['worker.start', structuredClone(nextCheckpoint)]);
      return nextCheckpoint;
    },
    async pause(reason) {
      calls.push(['worker.pause', reason]);
      if (pauseGate) await pauseGate.promise;
      return checkpoint;
    },
    async resume(nextCheckpoint) {
      calls.push(['worker.resume', structuredClone(nextCheckpoint)]);
      return true;
    },
    async stop() {
      calls.push(['worker.stop']);
      return checkpoint;
    },
    async refill(nextCheckpoint) {
      calls.push(['worker.refill', structuredClone(nextCheckpoint)]);
      return true;
    }
  };

  const runtimeRequest = async (type, payload) => {
    calls.push(['runtime', type, structuredClone(payload)]);
    if (options.runtimeFailure?.type === type) {
      return {
        ok: false,
        error: options.runtimeFailure.error,
        checkpoint
      };
    }
    checkpoint = transitionCheckpoint(checkpoint, type, payload);
    return {
      ok: true,
      checkpoint: structuredClone(checkpoint)
    };
  };

  const dependencies = {
    getCheckpoint() {
      return structuredClone(checkpoint);
    },
    runtimeRequest,
    workerRuntime,
    manualWindows: {
      async open(url) {
        calls.push(['manual.open', url]);
        return { id: 91, type: 'normal' };
      }
    },
    onlineTarget,
    draftStorage: {
      async set(draft) {
        calls.push(['draft.set', structuredClone(draft)]);
      },
      async remove() {
        calls.push(['draft.remove']);
      }
    }
  };

  const controller = createBatchCommandController(dependencies);
  controller.subscribe((update) => published.push(structuredClone(update)));

  return {
    calls,
    controller,
    dependencies,
    get checkpoint() {
      return checkpoint;
    },
    onlineTarget,
    published,
    workerRuntime
  };
}

function startDraft() {
  const url = 'https://target.test/page';
  return {
    batchId: 'batch-1',
    step: 4,
    source: {
      fileName: 'targets.csv',
      headers: ['URL', 'Password'],
      rows: [[url, 'csv-password-sentinel']],
      parsedUrls: [{
        originalIndex: 0,
        url,
        sourceDomain: 'target.test',
        originalRow: [url, 'csv-password-sentinel']
      }]
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site',
        identitySnapshot: {
          displayName: 'Alice',
          email: 'alice@example.test',
          password: 'checkpoint-password-sentinel'
        }
      },
      password: 'settings-password-sentinel'
    },
    password: 'draft-password-sentinel'
  };
}

test('persists a sanitized session before starting workers and clears the draft last', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    })
  });

  await harness.controller.start(startDraft());

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'draft.set',
    'runtime:BATCH_SESSION_START',
    'worker.start',
    'draft.remove'
  ]);
  const runtimePayload = harness.calls[1][2];
  const workerCheckpoint = harness.calls[2][1];
  for (const value of [
    runtimePayload,
    workerCheckpoint,
    harness.published,
    harness.calls
  ]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('checkpoint-password-sentinel'), false);
    assert.equal(serialized.includes('settings-password-sentinel'), false);
    assert.equal(serialized.includes('draft-password-sentinel'), false);
    assert.equal(serialized.includes('csv-password-sentinel'), false);
  }
  assert.equal(
    runtimePayload.settings.assignment.identityId,
    'default-identity'
  );
});

test('pauses through worker sealing before the session pause command', async () => {
  const harness = createCommandHarness();

  await harness.controller.pause();

  assert.deepEqual(harness.calls, [
    ['worker.pause', 'user'],
    ['runtime', 'BATCH_SESSION_PAUSE', { batchId: 'batch-1' }]
  ]);
  assert.equal(
    harness.published.at(-1).checkpoint.status,
    'paused_recovery'
  );
});

test('resumes workers only from the checkpoint returned by session resume', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    })
  });

  await harness.controller.resume();

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_SESSION_RESUME',
    'worker.resume'
  ]);
  assert.equal(harness.calls[1][1].status, 'running');
});

test('requires explicit danger confirmation before permanently stopping', async () => {
  const harness = createCommandHarness();

  await assert.rejects(
    harness.controller.stop(),
    (error) => error?.code === 'stop_confirmation_required'
  );
  assert.deepEqual(harness.calls, []);

  await harness.controller.stop(true);

  assert.deepEqual(harness.calls, [
    ['worker.stop'],
    ['runtime', 'BATCH_SESSION_STOP', { batchId: 'batch-1' }]
  ]);
  assert.equal(harness.published.at(-1).checkpoint.status, 'terminated');
});

test('persists a safe retry before refilling a running worker runtime', async () => {
  const harness = createCommandHarness();
  const task = {
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    retryPolicy: 'safe'
  };

  await harness.controller.retry(task, false);

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_TASK_RETRY',
    'worker.refill'
  ]);
  assert.deepEqual(harness.calls[0][2], {
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    confirmedRisk: false
  });
  assert.equal(harness.calls[1][1].tasks['0'].attempt, 2);
});

test('requires explicit confirmation for an uncertain retry', async () => {
  const checkpoint = createCheckpoint({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  });
  const harness = createCommandHarness({ checkpoint });
  const task = {
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: 'manual_required',
    errorCode: 'submission_uncertain',
    retryPolicy: 'confirm'
  };

  await assert.rejects(
    harness.controller.retry(task, false),
    (error) => error?.code === 'retry_confirmation_required'
  );
  assert.deepEqual(harness.calls, []);

  await harness.controller.retry(task, true);

  assert.equal(harness.calls[0][2].confirmedRisk, true);
  assert.equal(harness.calls[1][0], 'worker.refill');
});

test('blocks retry policies that can never be retried', async () => {
  const harness = createCommandHarness();

  await assert.rejects(
    harness.controller.retry({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      result: 'success',
      retryPolicy: 'blocked'
    }),
    (error) => error?.code === 'retry_blocked'
  );

  assert.deepEqual(harness.calls, []);
});

test('does not refill workers when a retry leaves the session paused', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({ status: 'paused_recovery' })
  });

  await harness.controller.retry({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    retryPolicy: 'safe'
  });

  assert.equal(
    harness.calls.some(([name]) => name === 'worker.refill'),
    false
  );
});

test('opens manual work outside the worker runtime and persists its state', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    })
  });

  await harness.controller.openManual({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    url: 'https://manual.test/page'
  });

  assert.deepEqual(harness.calls, [
    ['manual.open', 'https://manual.test/page'],
    ['runtime', 'BATCH_TASK_MANUAL_UPDATE', {
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      status: 'in_progress'
    }]
  ]);
  assert.equal(
    harness.calls.some(([name]) => name.startsWith('worker.')),
    false
  );
  assert.equal(JSON.stringify(harness.calls).includes('BATCH_HANDLE'), false);
});

test('persists explicit manual resolution without invoking automation', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    })
  });

  await harness.controller.updateManual({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  }, 'resolved');

  assert.deepEqual(harness.calls, [
    ['runtime', 'BATCH_TASK_MANUAL_UPDATE', {
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      status: 'resolved'
    }]
  ]);
});

test('offline detection safely pauses and online detection never auto-resumes', async () => {
  const harness = createCommandHarness();

  harness.onlineTarget.emit('offline');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls, [
    ['worker.pause', 'offline'],
    ['runtime', 'BATCH_SESSION_PAUSE', { batchId: 'batch-1' }]
  ]);

  harness.onlineTarget.emit('online');

  assert.equal(
    harness.calls.some(([name]) => name === 'worker.resume'),
    false
  );
  assert.deepEqual(harness.published.at(-1), {
    online: true,
    requiresUserResume: true
  });
});

test('detaches old online listeners before attaching a replacement target', async () => {
  const harness = createCommandHarness();
  const replacement = createOnlineTarget();

  harness.controller.attachOnlineListeners(replacement);
  harness.onlineTarget.emit('offline');
  replacement.emit('offline');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.calls.filter(([name]) => name === 'worker.pause').length,
    1
  );

  harness.controller.detachOnlineListeners();
  replacement.emit('online');
  assert.equal(harness.published.length, 1);
});

test('deduplicates the same command promise and rejects incompatible commands', async () => {
  const pauseGate = deferred();
  const harness = createCommandHarness({ pauseGate });

  const firstPause = harness.controller.pause();
  const secondPause = harness.controller.pause();
  const incompatibleResume = harness.controller.resume();

  assert.equal(secondPause, firstPause);
  await assert.rejects(
    incompatibleResume,
    (error) => error?.code === 'batch_command_in_progress'
  );

  pauseGate.resolve();
  await firstPause;
});

test('surfaces stable runtime errors without starting downstream side effects', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    runtimeFailure: {
      type: 'BATCH_SESSION_RESUME',
      error: 'power_request_failed'
    }
  });

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'power_request_failed'
  );

  assert.equal(
    harness.calls.some(([name]) => name === 'worker.resume'),
    false
  );
});
