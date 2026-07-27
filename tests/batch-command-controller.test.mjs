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

function fixtureError(code) {
  const error = new Error(`unsafe raw details for ${code}`);
  error.code = code;
  return error;
}

async function waitForCall(calls, predicate, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (calls.some(predicate)) return;
    await Promise.resolve();
  }
  assert.fail(`Timed out waiting for ${label}`);
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
      if (options.workerFailures?.start) {
        throw options.workerFailures.start;
      }
      return nextCheckpoint;
    },
    async pause(reason) {
      calls.push(['worker.pause', reason]);
      if (pauseGate) await pauseGate.promise;
      if (options.workerFailures?.pause) {
        throw options.workerFailures.pause;
      }
      return checkpoint;
    },
    async resume(nextCheckpoint) {
      calls.push(['worker.resume', structuredClone(nextCheckpoint)]);
      if (options.workerFailures?.resume) {
        if (options.workerFailures.resume === 'reject') return false;
        throw options.workerFailures.resume;
      }
      return true;
    },
    async stop() {
      calls.push(['worker.stop']);
      if (options.workerFailures?.stop) {
        if (options.workerFailures.stop === 'reject') return false;
        throw options.workerFailures.stop;
      }
      return checkpoint;
    },
    async refill(nextCheckpoint) {
      calls.push(['worker.refill', structuredClone(nextCheckpoint)]);
      if (options.workerFailures?.refill) {
        if (options.workerFailures.refill === 'reject') return false;
        throw options.workerFailures.refill;
      }
      return true;
    }
  };

  const runtimeRequest = async (type, payload) => {
    calls.push(['runtime', type, structuredClone(payload)]);
    if (options.runtimeGates?.[type]) {
      await options.runtimeGates[type].promise;
    }
    const runtimeFailure = options.runtimeFailures?.[type] ||
      (options.runtimeFailure?.type === type
        ? options.runtimeFailure
        : null);
    if (runtimeFailure) {
      return {
        ok: false,
        error: runtimeFailure.error,
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
      },
      async close(handle) {
        calls.push(['manual.close', structuredClone(handle)]);
        if (options.manualCloseFailure) throw options.manualCloseFailure;
      }
    },
    onlineTarget,
    draftStorage: {
      async set(draft) {
        calls.push(['draft.set', structuredClone(draft)]);
        if (options.draftSetFailure) throw options.draftSetFailure;
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

function runtimeDiagnostic(harness) {
  const event = harness.published.findLast(
    (candidate) => candidate.type === 'runtime-error'
  );
  return event
    ? {
        type: event.type,
        command: event.command,
        errorCode: event.errorCode,
        recoveryErrorCodes: event.recoveryErrorCodes,
        checkpointStatus: event.checkpoint?.status,
        requiresUserResume: event.requiresUserResume
      }
    : null;
}

function assertPendingRecoveryProjection(harness) {
  const snapshot = harness.published.findLast(
    (candidate) => candidate.persisted === false &&
      candidate.recoveryPersistenceRequired === true
  );
  const diagnostic = harness.published.findLast(
    (candidate) => candidate.type === 'runtime-error'
  );
  assert.ok(snapshot);
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.checkpoint, snapshot.checkpoint);
  assert.equal(diagnostic.persisted, false);
  assert.equal(diagnostic.recoveryPersistenceRequired, true);
  assert.deepEqual({
    status: snapshot.checkpoint.status,
    persistencePending: snapshot.checkpoint.persistencePending,
    lastPersistedStatus: snapshot.checkpoint.lastPersistedStatus
  }, {
    status: 'paused_recovery',
    persistencePending: true,
    lastPersistedStatus: 'running'
  });
  assert.equal(harness.checkpoint.status, 'running');
  return snapshot.checkpoint;
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

test('forwards a finalized plan and confirmation without rebuilding assignments', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    })
  });
  const plan = {
    version: 2,
    planId: 'batch-plan',
    planFingerprint: 'a'.repeat(64),
    tasks: []
  };
  const confirmation = {
    version: 1,
    planFingerprint: 'a'.repeat(64),
    normalConfirmed: true,
    requiredRisks: [],
    highRiskConfirmed: false,
    confirmedAt: 1
  };

  await harness.controller.start({
    batchId: 'batch-plan',
    plan,
    confirmation,
    settings: {
      concurrency: 3,
      timeoutSeconds: 60
    }
  });

  const runtimePayload = harness.calls.find(
    ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_START'
  )[2];
  assert.deepEqual(runtimePayload.plan, plan);
  assert.deepEqual(runtimePayload.confirmation, confirmation);
  assert.equal(runtimePayload.source, undefined);
});

test('draft storage failure leaves Start safely unclaimed with no runtime side effects', async () => {
  const checkpoint = createCheckpoint({
    status: 'paused_recovery',
    taskState: 'queued'
  });
  const failure = new Error('draft storage unavailable');
  failure.code = 'draft_storage_failed';
  const harness = createCommandHarness({
    checkpoint,
    draftSetFailure: failure
  });

  await assert.rejects(
    harness.controller.start(startDraft()),
    (error) => error?.code === 'draft_storage_failed'
  );

  assert.deepEqual(harness.calls.map(([name]) => name), ['draft.set']);
  assert.equal(harness.checkpoint.status, 'paused_recovery');
  assert.equal(
    harness.calls.some(([name]) => name === 'worker.start'),
    false
  );
});

test('publishes the authoritative checkpoint before rejecting active ownership', async () => {
  const authoritative = createCheckpoint({
    status: 'paused_recovery',
    taskState: 'active'
  });
  authoritative.batchId = 'owned-batch';
  authoritative.source.fileName = 'owned-targets.csv';
  const harness = createCommandHarness({
    checkpoint: authoritative,
    runtimeFailure: {
      type: 'BATCH_SESSION_START',
      error: 'batch_ownership_active'
    }
  });

  await assert.rejects(
    harness.controller.start(startDraft()),
    (error) => error?.code === 'batch_ownership_active'
  );

  assert.deepEqual(harness.published, [{
    checkpoint: authoritative,
    authoritative: true
  }]);
  assert.equal(
    harness.calls.some(([name]) => name === 'worker.start'),
    false
  );
});

test('Start owns an immutable upload snapshot after the editable draft changes', async () => {
  const startGate = deferred();
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    runtimeGates: { BATCH_SESSION_START: startGate }
  });
  const draft = startDraft();

  const starting = harness.controller.start(draft);
  await waitForCall(
    harness.calls,
    ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_START',
    'claimed Start snapshot'
  );
  draft.source.parsedUrls[0].url = 'https://replacement.test/';
  draft.source.parsedUrls.length = 0;
  draft.settings.assignment.identityId = 'replacement-identity';
  startGate.resolve();
  await starting;

  const payload = harness.calls.find(
    ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_START'
  )[2];
  assert.equal(payload.source.parsedUrls.length, 1);
  assert.equal(payload.source.parsedUrls[0].url, 'https://target.test/page');
  assert.equal(
    payload.settings.assignment.identityId,
    'default-identity'
  );
});

test('pauses through worker sealing before the session pause command', async () => {
  const harness = createCommandHarness();

  await harness.controller.pause();

  assert.deepEqual(harness.calls, [
    ['worker.pause', 'user'],
    ['runtime', 'BATCH_SESSION_PAUSE', {
      batchId: 'batch-1',
      reason: 'user'
    }]
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

test('safely pauses a persisted start when worker startup fails', async () => {
  const original = fixtureError('worker_start_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: { start: original }
  });

  await assert.rejects(
    harness.controller.start(startDraft()),
    (error) => error === original
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'draft.set',
    'runtime:BATCH_SESSION_START',
    'worker.start',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
  assert.equal(harness.calls[3][1], 'runtime_error');
  assert.deepEqual(runtimeDiagnostic(harness), {
    type: 'runtime-error',
    command: 'start',
    errorCode: 'worker_start_fixture',
    recoveryErrorCodes: [],
    checkpointStatus: 'paused_recovery',
    requiresUserResume: true
  });
});

test('safely pauses a persisted resume when worker resume fails', async () => {
  const original = fixtureError('worker_resume_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: { resume: original }
  });

  await assert.rejects(
    harness.controller.resume(),
    (error) => error === original
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_SESSION_RESUME',
    'worker.resume',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
  assert.deepEqual(runtimeDiagnostic(harness), {
    type: 'runtime-error',
    command: 'resume',
    errorCode: 'worker_resume_fixture',
    recoveryErrorCodes: [],
    checkpointStatus: 'paused_recovery',
    requiresUserResume: true
  });
});

test('safely pauses when worker resume rejects the persisted checkpoint', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: { resume: 'reject' }
  });

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'worker_resume_rejected'
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_SESSION_RESUME',
    'worker.resume',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
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

test('pauses recoverably when terminal persistence fails after worker stop', async () => {
  const harness = createCommandHarness({
    runtimeFailures: {
      BATCH_SESSION_STOP: {
        error: 'checkpoint_stop_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.stop(true),
    (error) => error?.code === 'checkpoint_stop_fixture'
  );

  assert.deepEqual(harness.calls, [
    ['worker.stop'],
    ['runtime', 'BATCH_SESSION_STOP', { batchId: 'batch-1' }],
    ['runtime', 'BATCH_SESSION_PAUSE', {
      batchId: 'batch-1',
      reason: 'runtime_error'
    }]
  ]);
  assert.deepEqual(runtimeDiagnostic(harness), {
    type: 'runtime-error',
    command: 'stop',
    errorCode: 'checkpoint_stop_fixture',
    recoveryErrorCodes: [],
    checkpointStatus: 'paused_recovery',
    requiresUserResume: true
  });
});

test('does not terminate when worker stop cannot close every owned tab', async () => {
  const harness = createCommandHarness({
    workerFailures: { stop: 'reject' }
  });

  await assert.rejects(
    harness.controller.stop(true),
    (error) => error?.code === 'worker_stop_rejected'
  );

  assert.equal(
    harness.calls.some(
      ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_STOP'
    ),
    false
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'runtime').map((call) => call[1]),
    ['BATCH_SESSION_PAUSE']
  );
  assert.equal(harness.checkpoint.status, 'paused_recovery');
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

test('safely pauses a persisted retry when worker refill fails', async () => {
  const original = fixtureError('worker_refill_fixture');
  const harness = createCommandHarness({
    workerFailures: { refill: original }
  });

  await assert.rejects(
    harness.controller.retry({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      retryPolicy: 'safe'
    }),
    (error) => error === original
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_TASK_RETRY',
    'worker.refill',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
  assert.deepEqual(runtimeDiagnostic(harness), {
    type: 'runtime-error',
    command: 'retry',
    errorCode: 'worker_refill_fixture',
    recoveryErrorCodes: [],
    checkpointStatus: 'paused_recovery',
    requiresUserResume: true
  });
});

test('safely pauses when worker refill rejects the persisted retry', async () => {
  const harness = createCommandHarness({
    workerFailures: { refill: 'reject' }
  });

  await assert.rejects(
    harness.controller.retry({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      retryPolicy: 'safe'
    }),
    (error) => error?.code === 'worker_refill_rejected'
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'runtime:BATCH_TASK_RETRY',
    'worker.refill',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
});

test('preserves the worker error when cleanup and recovery pause also fail', async () => {
  const original = fixtureError('worker_start_fixture');
  const cleanupError = fixtureError('worker_cleanup_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: {
      start: original,
      pause: cleanupError
    },
    runtimeFailures: {
      BATCH_SESSION_PAUSE: {
        error: 'checkpoint_pause_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.start(startDraft()),
    (error) => error === original
  );

  assert.deepEqual(harness.calls.map(([name, type]) => (
    name === 'runtime' ? `${name}:${type}` : name
  )), [
    'draft.set',
    'runtime:BATCH_SESSION_START',
    'worker.start',
    'worker.pause',
    'runtime:BATCH_SESSION_PAUSE'
  ]);
  assert.deepEqual(runtimeDiagnostic(harness), {
    type: 'runtime-error',
    command: 'start',
    errorCode: 'worker_start_fixture',
    recoveryErrorCodes: [
      'worker_cleanup_fixture',
      'checkpoint_pause_fixture'
    ],
    checkpointStatus: 'paused_recovery',
    requiresUserResume: true
  });
  assertPendingRecoveryProjection(harness);
});

test('blocks resume after a start recovery pause cannot be persisted', async () => {
  const original = fixtureError('worker_start_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: { start: original },
    runtimeFailures: {
      BATCH_SESSION_PAUSE: {
        error: 'checkpoint_pause_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.start(startDraft()),
    (error) => error === original
  );
  assertPendingRecoveryProjection(harness);
  const callsAfterRecovery = structuredClone(harness.calls);

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'recovery_persistence_required'
  );

  assert.deepEqual(harness.calls, callsAfterRecovery);
});

test('blocks resume after a resume recovery pause cannot be persisted', async () => {
  const original = fixtureError('worker_resume_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    workerFailures: { resume: original },
    runtimeFailures: {
      BATCH_SESSION_PAUSE: {
        error: 'checkpoint_pause_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.resume(),
    (error) => error === original
  );
  assertPendingRecoveryProjection(harness);
  const callsAfterRecovery = structuredClone(harness.calls);

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'recovery_persistence_required'
  );

  assert.deepEqual(harness.calls, callsAfterRecovery);
});

test('blocks resume after a retry recovery pause cannot be persisted', async () => {
  const original = fixtureError('worker_refill_fixture');
  const harness = createCommandHarness({
    workerFailures: { refill: original },
    runtimeFailures: {
      BATCH_SESSION_PAUSE: {
        error: 'checkpoint_pause_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.retry({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      retryPolicy: 'safe'
    }),
    (error) => error === original
  );
  assertPendingRecoveryProjection(harness);
  const callsAfterRecovery = structuredClone(harness.calls);

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'recovery_persistence_required'
  );

  assert.deepEqual(harness.calls, callsAfterRecovery);
});

test('blocks resume after stop and recovery pause both fail persistence', async () => {
  const harness = createCommandHarness({
    runtimeFailures: {
      BATCH_SESSION_STOP: {
        error: 'checkpoint_stop_fixture'
      },
      BATCH_SESSION_PAUSE: {
        error: 'checkpoint_pause_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.stop(true),
    (error) => error?.code === 'checkpoint_stop_fixture'
  );
  assertPendingRecoveryProjection(harness);
  const callsAfterRecovery = structuredClone(harness.calls);

  await assert.rejects(
    harness.controller.resume(),
    (error) => error?.code === 'recovery_persistence_required'
  );

  assert.deepEqual(harness.calls, callsAfterRecovery);
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

test('rejects a missing manual task before opening a window', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    })
  });

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-1',
      urlIndex: 9,
      attempt: 1,
      url: 'https://manual.test/missing'
    }),
    (error) => error?.code === 'manual_task_not_found'
  );

  assert.deepEqual(harness.calls, []);
});

test('rejects a stale manual attempt before opening a window', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    })
  });

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 2,
      url: 'https://manual.test/stale'
    }),
    (error) => error?.code === 'stale_attempt'
  );

  assert.deepEqual(harness.calls, []);
});

test('rejects a stale manual batch before opening a window', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    })
  });

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-old',
      urlIndex: 0,
      attempt: 1,
      url: 'https://manual.test/stale-batch'
    }),
    (error) => error?.code === 'stale_batch'
  );

  assert.deepEqual(harness.calls, []);
});
test('rejects an ineligible terminal result before opening a manual window', async () => {
  const harness = createCommandHarness();

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      url: 'https://manual.test/ineligible'
    }),
    (error) => error?.code === 'manual_not_allowed'
  );

  assert.deepEqual(harness.calls, []);
});

test('closes a newly opened manual window when its status update loses a race', async () => {
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    }),
    runtimeFailures: {
      BATCH_TASK_MANUAL_UPDATE: {
        error: 'stale_attempt'
      }
    }
  });

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      url: 'https://manual.test/race'
    }),
    (error) => error?.code === 'stale_attempt'
  );

  assert.deepEqual(harness.calls, [
    ['manual.open', 'https://manual.test/race'],
    ['runtime', 'BATCH_TASK_MANUAL_UPDATE', {
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      status: 'in_progress'
    }],
    ['manual.close', { id: 91, type: 'normal' }]
  ]);
});

test('preserves a manual update error when rollback close also fails', async () => {
  const closeError = fixtureError('manual_close_fixture');
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      result: 'manual_required',
      errorCode: 'submission_uncertain'
    }),
    runtimeFailures: {
      BATCH_TASK_MANUAL_UPDATE: {
        error: 'stale_attempt'
      }
    },
    manualCloseFailure: closeError
  });

  await assert.rejects(
    harness.controller.openManual({
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      url: 'https://manual.test/race'
    }),
    (error) => error?.code === 'stale_attempt'
  );

  assert.equal(
    harness.calls.some(([name]) => name === 'manual.close'),
    true
  );
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
    ['runtime', 'BATCH_SESSION_PAUSE', {
      batchId: 'batch-1',
      reason: 'offline'
    }]
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

test('offline cancels an in-flight persisted start before worker creation', async () => {
  const startGate = deferred();
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    runtimeGates: { BATCH_SESSION_START: startGate }
  });

  const starting = harness.controller.start(startDraft());
  await waitForCall(
    harness.calls,
    ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_START',
    'persisted start'
  );
  const pausing = harness.controller.handleOffline();
  startGate.resolve();
  const [started, paused] = await Promise.all([starting, pausing]);

  assert.equal(started.status, 'paused_recovery');
  assert.equal(paused.status, 'paused_recovery');
  assert.equal(
    harness.calls.some(([name]) => name === 'worker.start'),
    false
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'draft.remove'),
    false
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'runtime').map((call) => call[1]),
    ['BATCH_SESSION_START', 'BATCH_SESSION_PAUSE']
  );
});

test('beginTeardown cancels a deferred persisted START without a page-owned pause', async () => {
  const startGate = deferred();
  const harness = createCommandHarness({
    checkpoint: createCheckpoint({
      status: 'paused_recovery',
      taskState: 'queued'
    }),
    runtimeGates: { BATCH_SESSION_START: startGate }
  });

  const starting = harness.controller.start(startDraft());
  await waitForCall(
    harness.calls,
    ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_START',
    'persisted start'
  );
  harness.controller.beginTeardown('pagehide');
  startGate.resolve();
  const started = await starting;

  assert.equal(started.status, 'running');
  assert.equal(
    harness.calls.some(([name]) => name === 'worker.start'),
    false
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'draft.remove'),
    false
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'runtime').map((call) => call[1]),
    ['BATCH_SESSION_START']
  );
});

test('teardown pause persistence failure publishes a local recovery checkpoint', async () => {
  const harness = createCommandHarness({
    runtimeFailures: {
      BATCH_SESSION_PAUSE: {
        error: 'teardown_pause_persistence_fixture'
      }
    }
  });

  await assert.rejects(
    harness.controller.pause('page_teardown'),
    (error) => error?.code === 'teardown_pause_persistence_fixture'
  );

  const recovery = assertPendingRecoveryProjection(harness);
  assert.equal(recovery.status, 'paused_recovery');
  assert.equal(recovery.persistencePending, true);
  assert.equal(
    harness.calls.some(
      ([name, type]) => name === 'runtime' && type === 'BATCH_SESSION_STOP'
    ),
    false
  );
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
