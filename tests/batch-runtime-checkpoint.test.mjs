import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_RUNTIME_VERSION,
  applyBatchRuntimeEvent,
  createBatchRuntimeCheckpoint,
  migrateBatchRuntimeCheckpoint,
  normalizeInterruptedBatch,
  validateBatchRuntimeCheckpoint
} from '../lib/batch-runtime-checkpoint.mjs';

function createItems(count) {
  return Array.from({ length: count }, (_, originalIndex) => ({
    originalIndex,
    url: `https://example.test/${originalIndex}`,
    sourceDomain: 'example.test',
    originalRow: [
      String(originalIndex),
      `https://example.test/${originalIndex}`
    ]
  }));
}

test('creates a versioned checkpoint with the complete dataset', () => {
  const items = createItems(125);
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-1',
    source: {
      fileName: 'input.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    }
  }, 1000);

  assert.equal(checkpoint.version, BATCH_RUNTIME_VERSION);
  assert.equal(checkpoint.status, 'paused_recovery');
  assert.equal(checkpoint.createdAt, 1000);
  assert.equal(checkpoint.updatedAt, 1000);
  assert.equal(checkpoint.source.rows.length, 125);
  assert.equal(checkpoint.source.parsedUrls.length, 125);
  assert.equal(checkpoint.results.length, 0);
  assert.equal(Object.keys(checkpoint.tasks).length, 125);
  assert.ok(
    Object.values(checkpoint.tasks).every((task) => task.state === 'queued')
  );
  assert.equal(validateBatchRuntimeCheckpoint(checkpoint).ok, true);

  items[0].originalRow[0] = 'mutated';
  assert.equal(checkpoint.source.rows[0][0], '0');
  assert.equal(checkpoint.source.parsedUrls[0].originalRow[0], '0');
});

test('checkpoint creation rejects URL credentials before persistence', () => {
  const item = {
    originalIndex: 0,
    url: 'https://alice:hunter2@example.test/post',
    sourceDomain: 'example.test',
    originalRow: ['https://alice:hunter2@example.test/post']
  };

  assert.throws(
    () => createBatchRuntimeCheckpoint({
      batchId: 'batch-secret',
      source: {
        fileName: 'secret.csv',
        headers: ['URL'],
        rows: [item.originalRow],
        parsedUrls: [item]
      },
      settings: { timeoutSeconds: 60, concurrency: 1 }
    }, 1000),
    /batch_url_credentials_forbidden/
  );
});

test('checkpoint creation redacts sensitive query values across source copies and results', () => {
  const item = {
    originalIndex: 0,
    url: 'https://example.test/post?view=full&token=secret-token',
    sourceDomain: 'example.test',
    originalRow: [
      'https://example.test/post?view=full&token=secret-token'
    ]
  };
  let checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-safe',
    source: {
      fileName: 'safe.csv',
      headers: ['URL'],
      rows: [item.originalRow],
      parsedUrls: [item]
    },
    settings: { timeoutSeconds: 60, concurrency: 1 }
  }, 1000);
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-safe'
  }, 1100).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-safe',
    urlIndex: 0,
    attempt: 1,
    result: { result: 'fail', errorMessage: 'safe failure' }
  }, 1200).checkpoint;

  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.match(serialized, /view=full/);
  assert.match(serialized, /token=REDACTED/);
});

test('task terminal events redact secrets before checkpoint history persistence', () => {
  let checkpoint = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  const rawError = [
    'Authorization: Bearer event-bearer-secret',
    '{"client_secret":"event-client-secret"}',
    'https://target.test/final#route?access_token=event-hash-secret'
  ].join('; ');

  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'fail',
      errorCode: 'task_failed',
      errorMessage: rawError
    }
  }, 1200).checkpoint;

  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(
    serialized,
    /event-bearer-secret|event-client-secret|event-hash-secret/
  );
  assert.match(serialized, /REDACTED/);
});

test('task terminal events persist only the normalized result preview', () => {
  let checkpoint = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;

  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'success',
      aiContent: '<p>generated</p>',
      resultPreview: {
        commentText: '  The full\ncomment  ',
        anchors: [{ anchorText: ' Product link ' }],
        promotedWebsiteUrl:
          'https://promo.test/?campaign=one&token=private'
      }
    }
  }, 1200).checkpoint;

  assert.deepEqual(
    {
      commentText: checkpoint.results[0].commentText,
      anchorTexts: checkpoint.results[0].anchorTexts,
      promotedWebsiteUrl: checkpoint.results[0].promotedWebsiteUrl
    },
    {
      commentText: 'The full comment',
      anchorTexts: ['Product link'],
      promotedWebsiteUrl:
        'https://promo.test/?campaign=one&token=REDACTED'
    }
  );
  assert.doesNotMatch(JSON.stringify(checkpoint), /commentHtml|private/);
});

test('rejects malformed and unsupported checkpoints', () => {
  assert.deepEqual(
    validateBatchRuntimeCheckpoint(null),
    { ok: false, error: 'invalid_checkpoint' }
  );
  assert.deepEqual(
    validateBatchRuntimeCheckpoint({ version: 99 }),
    { ok: false, error: 'unsupported_version' }
  );
});

test('version 2 migration adds request and reservation defaults exactly once', () => {
  const legacyVersion2 = createCheckpoint(1);
  delete legacyVersion2.tasks['0'].requestId;
  delete legacyVersion2.openingReservations;

  const migrated = migrateBatchRuntimeCheckpoint(legacyVersion2, 2000);
  const stable = migrateBatchRuntimeCheckpoint(migrated.checkpoint, 2100);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.tasks['0'].requestId, null);
  assert.deepEqual(migrated.checkpoint.openingReservations, {});
  assert.equal(stable.ok, true);
  assert.equal(stable.changed, false);
});

test('rejects malformed opening reservations and inconsistent task request identities', () => {
  const malformed = createCheckpoint(1);
  malformed.openingReservations = {
    forged: {
      requestId: 'different-key',
      batchId: 'batch-1',
      urlIndex: 7,
      attempt: 3,
      windowId: 42,
      tabId: 777,
      updatedAt: 2000
    }
  };
  const invalidTask = createCheckpoint(1);
  invalidTask.tasks['0'].requestId = 42;

  assert.equal(validateBatchRuntimeCheckpoint(malformed).ok, false);
  assert.equal(validateBatchRuntimeCheckpoint(invalidTask).ok, false);
});

test('enforces the task ownership matrix and canonical active request identity', () => {
  const active = applyBatchRuntimeEvent(
    applyBatchRuntimeEvent(createCheckpoint(1), {
      type: 'session_started',
      batchId: 'batch-1'
    }, 1100).checkpoint,
    {
      type: 'task_activated',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      requestId: 'batch-1:0:1',
      tabId: 41,
      windowId: 51,
      ownerPageTabId: 61,
      ownershipEpoch: 'epoch-1',
      startedAt: 1200
    },
    1200
  ).checkpoint;
  const mutations = [
    (checkpoint) => { checkpoint.tasks['0'].requestId = 'forged-request'; },
    (checkpoint) => { checkpoint.tasks['0'].requestId = 'batch-1:0:2'; },
    (checkpoint) => { checkpoint.tasks['0'].tabId = 0; },
    (checkpoint) => { checkpoint.tasks['0'].windowId = null; },
    (checkpoint) => { checkpoint.tasks['0'].startedAt = null; },
    (checkpoint) => {
      Object.assign(checkpoint.tasks['0'], {
        state: 'queued',
        requestId: null,
        tabId: 777,
        windowId: 42,
        startedAt: 1200
      });
    }
  ];

  assert.equal(validateBatchRuntimeCheckpoint(active).ok, true);
  for (const mutate of mutations) {
    const malformed = structuredClone(active);
    mutate(malformed);
    assert.equal(validateBatchRuntimeCheckpoint(malformed).ok, false);
  }
});

test('migrates only canonical legacy reservations that are missing batchId', () => {
  const safe = createCheckpoint(1);
  safe.openingReservations = {
    'batch-1:0:1': {
      requestId: 'batch-1:0:1',
      urlIndex: 0,
      attempt: 1,
      windowId: 42,
      tabId: null,
      updatedAt: 2000
    }
  };
  const unsafe = structuredClone(safe);
  unsafe.openingReservations = {
    forged: {
      requestId: 'forged',
      urlIndex: 0,
      attempt: 1,
      windowId: 42,
      tabId: 777,
      updatedAt: 2000
    }
  };

  const migratedSafe = migrateBatchRuntimeCheckpoint(safe, 2100);
  const migratedUnsafe = migrateBatchRuntimeCheckpoint(unsafe, 2100);

  assert.equal(migratedSafe.ok, true);
  assert.equal(migratedSafe.changed, true);
  assert.equal(
    migratedSafe.checkpoint.openingReservations['batch-1:0:1'].batchId,
    'batch-1'
  );
  assert.equal(
    migratedSafe.checkpoint.openingReservations['batch-1:0:1'].cleanupOnly,
    false
  );
  assert.equal(migratedUnsafe.ok, true);
  assert.equal(migratedUnsafe.changed, true);
  assert.deepEqual(migratedUnsafe.checkpoint.openingReservations, {});
});

test('migrates valid legacy ACTIVE ownership to canonical identity and rejects incomplete ownership', () => {
  const legacy = createCheckpoint(1);
  Object.assign(legacy.tasks['0'], {
    state: 'active',
    requestId: null,
    tabId: 41,
    windowId: 51,
    startedAt: 1200
  });
  const incomplete = structuredClone(legacy);
  incomplete.tasks['0'].windowId = null;

  const migrated = migrateBatchRuntimeCheckpoint(legacy, 2000);
  const rejected = migrateBatchRuntimeCheckpoint(incomplete, 2000);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.tasks['0'].requestId, 'batch-1:0:1');
  assert.equal(rejected.ok, false);
});

test('task activation events reject every non-positive ownership field', () => {
  const running = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  for (const patch of [
    { tabId: 0 },
    { windowId: 0 },
    { startedAt: 0 },
    { startedAt: Number.NaN }
  ]) {
    const result = applyBatchRuntimeEvent(running, {
      type: 'task_activated',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      requestId: 'batch-1:0:1',
      tabId: 41,
      windowId: 51,
      ownerPageTabId: 61,
      ownershipEpoch: 'epoch-1',
      startedAt: 1200,
      ...patch
    }, 1200);
    assert.equal(result.ok, false);
  }
});

test('task activation requires a positive owner page and a non-empty ownership epoch', () => {
  const running = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  const baseEvent = {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    requestId: 'batch-1:0:1',
    tabId: 41,
    windowId: 51,
    ownerPageTabId: 61,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  };

  for (const patch of [
    { ownerPageTabId: 0 },
    { ownerPageTabId: -1 },
    { ownershipEpoch: '' },
    { ownershipEpoch: null }
  ]) {
    const rejected = applyBatchRuntimeEvent(
      running,
      { ...baseEvent, ...patch },
      1200
    );
    assert.equal(rejected.ok, false);
  }

  const accepted = applyBatchRuntimeEvent(running, baseEvent, 1200);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.checkpoint.tasks['0'].ownerPageTabId, 61);
  assert.equal(accepted.checkpoint.tasks['0'].ownershipEpoch, 'epoch-1');
});

test('legacy active ownership remains visible but becomes unverified paused recovery', () => {
  const legacy = createCheckpoint(1);
  Object.assign(legacy, {
    status: 'running'
  });
  Object.assign(legacy.tasks['0'], {
    state: 'active',
    requestId: 'batch-1:0:1',
    tabId: 41,
    windowId: 51,
    ownerPageTabId: 61,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  });
  delete legacy.tasks['0'].ownerPageTabId;
  delete legacy.tasks['0'].ownershipEpoch;

  const migrated = migrateBatchRuntimeCheckpoint(legacy, 2000);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.status, 'paused_recovery');
  assert.deepEqual(
    {
      requestId: migrated.checkpoint.tasks['0'].requestId,
      tabId: migrated.checkpoint.tasks['0'].tabId,
      windowId: migrated.checkpoint.tasks['0'].windowId,
      startedAt: migrated.checkpoint.tasks['0'].startedAt,
      ownerPageTabId: migrated.checkpoint.tasks['0'].ownerPageTabId,
      ownershipEpoch: migrated.checkpoint.tasks['0'].ownershipEpoch,
      reason: migrated.checkpoint.recoveryCleanup.reason
    },
    {
      requestId: 'batch-1:0:1',
      tabId: 41,
      windowId: 51,
      startedAt: 1200,
      ownerPageTabId: null,
      ownershipEpoch: null,
      reason: 'ownership_unverified'
    }
  );
  assert.equal(
    validateBatchRuntimeCheckpoint(migrated.checkpoint).ok,
    true
  );
});

function createCheckpoint(count = 4) {
  const items = createItems(count);
  return createBatchRuntimeCheckpoint({
    batchId: 'batch-1',
    source: {
      fileName: 'input.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    }
  }, 1000);
}

test('moves one task through active, submitting, and terminal states', () => {
  const initial = createCheckpoint(2);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);
  const active = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
      tabId: 41,
      windowId: 51,
      ownerPageTabId: 61,
      ownershipEpoch: 'epoch-1',
      startedAt: 1200
  }, 1200);
  const submitting = applyBatchRuntimeEvent(active.checkpoint, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  }, 1300);
  const terminal = applyBatchRuntimeEvent(submitting.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'success',
      aiContent: 'saved comment',
      errorMessage: null
    }
  }, 1400);

  assert.equal(started.ok, true);
  assert.equal(started.checkpoint.status, 'running');
  assert.deepEqual(
    active.checkpoint.tasks['0'],
    {
      urlIndex: 0,
      taskId: 'batch-1:legacy:0',
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      assignmentPairId: 'default-assignment-pair',
      assignmentSource: 'legacy_default',
      attemptCount: 1,
      lastFailurePhase: null,
      lastErrorCode: null,
      attempt: 1,
      state: 'active',
      phase: null,
      tabId: 41,
      windowId: 51,
      ownerPageTabId: 61,
      ownershipEpoch: 'epoch-1',
      startedAt: 1200,
      updatedAt: 1200,
      requestId: 'batch-1:0:1',
      manualResolution: {
        status: 'idle',
        updatedAt: null
      }
    }
  );
  assert.equal(submitting.checkpoint.tasks['0'].state, 'submitting');
  assert.equal(terminal.checkpoint.tasks['0'].state, 'terminal');
  assert.equal(terminal.checkpoint.results.length, 1);
  assert.deepEqual(
    terminal.checkpoint.results[0],
    {
      originalIndex: 0,
      attempt: 1,
      url: 'https://example.test/0',
      sourceDomain: 'example.test',
      result: 'success',
      aiContent: 'saved comment',
      commentText: null,
      anchorTexts: [],
      promotedWebsiteUrl: null,
      errorCode: null,
      errorMessage: null,
      timestamp: 1400,
      elapsed: 0,
      originalRow: ['0', 'https://example.test/0'],
      taskId: 'batch-1:legacy:0',
      profileId: 'default-profile',
      profileDisplayName: '默认身份',
      promotionSiteId: 'default-promotion-site',
      promotionSiteName: '默认推广网站',
      promotionSiteUrl: '',
      assignmentPairId: 'default-assignment-pair',
      assignmentSource: 'legacy_default',
      configRevision: 0,
      attemptCount: 1,
      skipReason: null
    }
  );
  assert.equal(terminal.checkpoint.cursor.nextIndex, 1);
  assert.equal(initial.status, 'paused_recovery');
  assert.equal(initial.tasks['0'].state, 'queued');
});

test('terminal result elapsed is persisted once and never advances with session time', () => {
  let checkpoint = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1_100).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 41,
    windowId: 51,
    ownerPageTabId: 61,
    ownershipEpoch: 'epoch-frozen',
    startedAt: 2_000
  }, 2_000).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'success',
      aiContent: 'saved'
    }
  }, 9_000).checkpoint;
  const elapsed = checkpoint.results[0].elapsed;

  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_completed',
    batchId: 'batch-1'
  }, 90_000).checkpoint;

  assert.equal(elapsed, 7);
  assert.equal(checkpoint.results[0].elapsed, 7);
  assert.equal(checkpoint.results[0].timestamp, 9_000);
});

test('paused terminal convergence is limited to internally proven cleanup ownership', () => {
  const started = applyBatchRuntimeEvent(createCheckpoint(1), {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  const active = applyBatchRuntimeEvent(started, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 41,
    windowId: 51,
    ownerPageTabId: 61,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  }, 1200).checkpoint;
  const terminalEvent = {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    terminalCleanupRetry: true,
    result: {
      result: 'fail',
      errorCode: 'task_failed',
      errorMessage: 'closed after retry'
    }
  };

  const navigation = structuredClone(active);
  navigation.status = 'paused_recovery';
  navigation.recoveryCleanup = {
    reason: 'navigation',
    diagnostic: 'tab_close_failed',
    updatedAt: 1300
  };
  assert.equal(
    applyBatchRuntimeEvent(navigation, terminalEvent, 1400).ok,
    false
  );

  const eligible = structuredClone(active);
  eligible.status = 'paused_recovery';
  eligible.recoveryCleanup = {
    reason: 'terminal_cleanup_failed',
    diagnostic: 'tab_close_failed',
    updatedAt: 1300
  };
  assert.equal(
    applyBatchRuntimeEvent(eligible, {
      ...terminalEvent,
      terminalCleanupRetry: false
    }, 1400).ok,
    false
  );

  for (
    const reason of ['terminal_cleanup_failed', 'ownership_unverified']
  ) {
    for (const state of ['active', 'submitting']) {
      const paused = structuredClone(eligible);
      paused.recoveryCleanup.reason = reason;
      paused.tasks['0'].state = state;
      if (state === 'submitting') paused.tasks['0'].phase = 'submitting';
      const converged = applyBatchRuntimeEvent(
        paused,
        terminalEvent,
        1400
      );

      assert.equal(converged.ok, true);
      assert.equal(converged.checkpoint.tasks['0'].state, 'terminal');
      assert.equal(converged.checkpoint.results.length, 1);
      assert.equal(
        validateBatchRuntimeCheckpoint(converged.checkpoint).ok,
        true
      );
    }
  }
});

test('rejects stale identities, skipped states, and conflicting terminal results', () => {
  const initial = createCheckpoint(1);
  const stale = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'other-batch'
  }, 1100);
  const skipped = applyBatchRuntimeEvent(initial, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1
  }, 1100);
  const outOfRange = applyBatchRuntimeEvent(initial, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 7,
    attempt: 1,
    tabId: 1,
    windowId: 2,
    ownerPageTabId: 3,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  }, 1100);

  assert.deepEqual(
    { ok: stale.ok, error: stale.error },
    { ok: false, error: 'stale_batch' }
  );
  assert.deepEqual(
    { ok: skipped.ok, error: skipped.error },
    { ok: false, error: 'invalid_transition' }
  );
  assert.deepEqual(
    { ok: outOfRange.ok, error: outOfRange.error },
    { ok: false, error: 'invalid_url_index' }
  );

  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1150);
  const active = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 1,
    windowId: 2,
    ownerPageTabId: 3,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  }, 1200);
  const terminal = applyBatchRuntimeEvent(active.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: { result: 'fail', errorMessage: 'first' }
  }, 1300);
  const duplicate = applyBatchRuntimeEvent(terminal.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: { result: 'fail', errorMessage: 'first' }
  }, 1400);
  const conflict = applyBatchRuntimeEvent(terminal.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: { result: 'success' }
  }, 1400);

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.changed, false);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'task_already_terminal');
  assert.equal(terminal.checkpoint.results.length, 1);
});

test('terminal session states cannot be restarted', () => {
  const initial = createCheckpoint(1);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);

  for (const type of ['session_terminated', 'session_completed']) {
    const stopped = applyBatchRuntimeEvent(started.checkpoint, {
      type,
      batchId: 'batch-1'
    }, 1200);
    const restarted = applyBatchRuntimeEvent(stopped.checkpoint, {
      type: 'session_started',
      batchId: 'batch-1'
    }, 1300);

    assert.equal(restarted.ok, false);
    assert.equal(restarted.error, 'invalid_transition');
  }
});

test('a queued task can terminate locally before a worker window opens', () => {
  const initial = createCheckpoint(1);
  const started = applyBatchRuntimeEvent(initial, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100);
  const terminal = applyBatchRuntimeEvent(started.checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'blocked_illegal',
      errorMessage: 'blocked before opening'
    }
  }, 1200);

  assert.equal(terminal.ok, true);
  assert.equal(terminal.checkpoint.tasks['0'].state, 'terminal');
  assert.equal(terminal.checkpoint.results[0].result, 'blocked_illegal');
});

test('normalizes active and submitting work into one safe paused checkpoint', () => {
  let checkpoint = createCheckpoint(4);
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 1,
    attempt: 1,
    tabId: 21,
    windowId: 31,
    ownerPageTabId: 41,
    ownershipEpoch: 'epoch-1',
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 1,
    tabId: 22,
    windowId: 31,
    ownerPageTabId: 41,
    ownershipEpoch: 'epoch-2',
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_submitting',
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 1
  }, 1300).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_activated',
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 1,
    tabId: 23,
    windowId: 33,
    ownerPageTabId: 43,
    ownershipEpoch: 'epoch-3',
    startedAt: 1200
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 1,
    result: { result: 'success', aiContent: 'done' }
  }, 1400).checkpoint;

  const normalized = normalizeInterruptedBatch(checkpoint, 2000);
  const repeated = normalizeInterruptedBatch(normalized.checkpoint, 3000);

  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.orphanTabIds, [21, 22]);
  assert.equal('orphanWindowIds' in normalized, false);
  assert.equal(normalized.checkpoint.status, 'paused_recovery');
  assert.equal(normalized.checkpoint.tasks['0'].state, 'queued');
  assert.deepEqual(
    normalized.checkpoint.tasks['1'],
    {
      urlIndex: 1,
      taskId: 'batch-1:legacy:1',
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      assignmentPairId: 'default-assignment-pair',
      assignmentSource: 'legacy_default',
      attemptCount: 1,
      lastFailurePhase: null,
      lastErrorCode: null,
      attempt: 1,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      ownerPageTabId: null,
      ownershipEpoch: null,
      startedAt: null,
      updatedAt: 2000,
      requestId: null,
      manualResolution: {
        status: 'idle',
        updatedAt: null
      }
    }
  );
  assert.equal(normalized.checkpoint.tasks['2'].state, 'terminal');
  assert.equal(normalized.checkpoint.tasks['3'].state, 'terminal');
  assert.equal(normalized.checkpoint.cursor.nextIndex, 0);
  assert.equal(normalized.checkpoint.results.length, 2);
  assert.deepEqual(
    normalized.checkpoint.results.find(
      (result) => result.originalIndex === 2
    ),
    {
      originalIndex: 2,
      attempt: 1,
      url: 'https://example.test/2',
      sourceDomain: 'example.test',
      result: 'manual_required',
      aiContent: null,
      commentText: null,
      anchorTexts: [],
      promotedWebsiteUrl: null,
      errorCode: 'submission_uncertain',
      errorMessage: '任务在提交确认前中断，评论可能已提交，请人工确认',
      timestamp: 2000,
      elapsed: 1,
      originalRow: ['2', 'https://example.test/2'],
      taskId: 'batch-1:legacy:2',
      profileId: 'default-profile',
      profileDisplayName: '默认身份',
      promotionSiteId: 'default-promotion-site',
      promotionSiteName: '默认推广网站',
      promotionSiteUrl: '',
      assignmentPairId: 'default-assignment-pair',
      assignmentSource: 'legacy_default',
      configRevision: 0,
      attemptCount: 1,
      skipReason: null
    }
  );
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.orphanTabIds, []);
  assert.equal('orphanWindowIds' in repeated, false);
  assert.equal(repeated.checkpoint.results.length, 2);
});

test('deduplicates repeated worker tab IDs during interruption recovery', () => {
  let checkpoint = createCheckpoint(2);
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 1100).checkpoint;
  for (const urlIndex of [0, 1]) {
    checkpoint = applyBatchRuntimeEvent(checkpoint, {
      type: 'task_activated',
      batchId: 'batch-1',
      urlIndex,
      attempt: 1,
      tabId: 21,
      windowId: 31,
      ownerPageTabId: 41,
      ownershipEpoch: `epoch-${urlIndex}`,
      startedAt: 1200
    }, 1200).checkpoint;
  }

  const normalized = normalizeInterruptedBatch(checkpoint, 2000);

  assert.deepEqual(normalized.orphanTabIds, [21]);
  assert.equal('orphanWindowIds' in normalized, false);
});

test('migrates a version 1 checkpoint to assignment-aware version 3', () => {
  const version1 = createVersion1CheckpointFixture();
  const migrated = migrateBatchRuntimeCheckpoint(version1, 2000);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.version, 3);
  assert.equal(migrated.checkpoint.tasks['0'].attempt, 1);
  assert.deepEqual(migrated.checkpoint.tasks['0'].manualResolution, {
    status: 'idle',
    updatedAt: null
  });
  assert.equal(migrated.checkpoint.results[0].attempt, 1);
});

test('migration sanitizes legacy and version 2 result diagnostics', () => {
  const version1 = createVersion1CheckpointFixture();
  version1.results[0].errorMessage = [
    'Authorization: Basic legacy-basic-secret',
    '{"id_token":"legacy-id-secret"}'
  ].join('; ');
  const migratedVersion1 = migrateBatchRuntimeCheckpoint(version1, 2000);
  const version2 = structuredClone(migratedVersion1.checkpoint);
  version2.results[0].errorMessage =
    '{"authorization":"Bearer version-two-secret"}';
  const versionTwoUrl =
    'https://target.test/0?view=full&id_token=version-two-url-secret';
  version2.source.rows[0] = [versionTwoUrl];
  version2.source.parsedUrls[0].url = versionTwoUrl;
  version2.source.parsedUrls[0].originalRow = [versionTwoUrl];
  version2.results[0].url = versionTwoUrl;
  version2.results[0].originalRow = [versionTwoUrl];

  const migratedVersion2 = migrateBatchRuntimeCheckpoint(version2, 2100);
  const serialized = JSON.stringify({
    version1: migratedVersion1.checkpoint,
    version2: migratedVersion2.checkpoint
  });

  assert.equal(migratedVersion1.ok, true);
  assert.equal(migratedVersion2.ok, true);
  assert.equal(migratedVersion2.changed, true);
  assert.doesNotMatch(
    serialized,
    /legacy-basic-secret|legacy-id-secret|version-two-secret|version-two-url-secret/
  );
  assert.match(serialized, /REDACTED/);
  assert.match(serialized, /view=full/);
});

test('clean version 2 checkpoint migration is unchanged', () => {
  const version2 = migrateBatchRuntimeCheckpoint(
    createVersion1CheckpointFixture(),
    2000
  ).checkpoint;

  const migrated = migrateBatchRuntimeCheckpoint(version2, 2100);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.checkpoint, version2);
});

test('current checkpoints backfill stable empty result preview values once', () => {
  const legacyCurrent = createTerminalCheckpoint({
    result: 'success',
    errorCode: null
  });
  delete legacyCurrent.results[0].commentText;
  delete legacyCurrent.results[0].anchorTexts;
  delete legacyCurrent.results[0].promotedWebsiteUrl;

  const migrated = migrateBatchRuntimeCheckpoint(legacyCurrent, 2200);
  const repeated = migrateBatchRuntimeCheckpoint(migrated.checkpoint, 2300);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.deepEqual(
    {
      commentText: migrated.checkpoint.results[0].commentText,
      anchorTexts: migrated.checkpoint.results[0].anchorTexts,
      promotedWebsiteUrl:
        migrated.checkpoint.results[0].promotedWebsiteUrl
    },
    {
      commentText: null,
      anchorTexts: [],
      promotedWebsiteUrl: null
    }
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
});

test('version 1 migration failures never echo the raw checkpoint', () => {
  const malformed = createVersion1CheckpointFixture();
  malformed.results[0].errorMessage =
    '{"authorization":"Bearer malformed-v1-secret"}';
  delete malformed.source.rows;

  const postValidationFailure = createVersion1CheckpointFixture();
  postValidationFailure.results[0].errorMessage =
    '{"authorization":"Bearer post-validation-secret"}';
  postValidationFailure.tasks['0'].phase = 'not-a-batch-phase';

  for (const checkpoint of [malformed, postValidationFailure]) {
    const migrated = migrateBatchRuntimeCheckpoint(checkpoint, 2100);

    assert.equal(migrated.ok, false);
    assert.equal(migrated.checkpoint, null);
    assert.doesNotMatch(
      JSON.stringify(migrated),
      /malformed-v1-secret|post-validation-secret/
    );
  }
});

test('apply sanitizes existing version 2 history before unrelated events', () => {
  const checkpoint = createTerminalCheckpoint({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  });
  const rawUrl =
    'https://target.test/0?view=full&token=existing-url-secret';
  checkpoint.source.rows[0] = [rawUrl];
  checkpoint.source.parsedUrls[0].url = rawUrl;
  checkpoint.source.parsedUrls[0].originalRow = [rawUrl];
  checkpoint.results[0].url = rawUrl;
  checkpoint.results[0].originalRow = [rawUrl];
  checkpoint.results[0].errorMessage = JSON.stringify({
    authorization: 'Bearer existing"stillsecret'
  });

  const applied = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-1'
  }, 2200);
  const serialized = JSON.stringify(applied);

  assert.equal(applied.ok, true);
  assert.equal(applied.changed, true);
  assert.doesNotMatch(
    serialized,
    /existing-url-secret|existing|stillsecret/
  );
  assert.match(serialized, /view=full/);
  assert.match(serialized, /REDACTED/);
});

test('invalid version 2 responses never echo raw checkpoint values', () => {
  const invalid = createTerminalCheckpoint({
    result: 'fail',
    errorCode: 'task_failed'
  });
  invalid.settings = null;
  invalid.results[0].errorMessage =
    '{"authorization":"Bearer invalid-result-secret"}';
  invalid.debugContext = 'Authorization: Bearer unknown-field-secret';

  const responses = [
    migrateBatchRuntimeCheckpoint(invalid, 2200),
    applyBatchRuntimeEvent(invalid, {
      type: 'session_started',
      batchId: 'batch-1'
    }, 2200),
    normalizeInterruptedBatch(invalid, 2200)
  ];

  for (const response of responses) {
    assert.equal(response.ok, false);
    assert.equal(response.checkpoint, null);
    assert.doesNotMatch(
      JSON.stringify(response),
      /invalid-result-secret|unknown-field-secret/
    );
  }
});

test('migration rejects result URL credentials without echoing them', () => {
  const version1 = createVersion1CheckpointFixture();
  version1.results[0].url =
    'https://migration-user:migration-password@target.test/0';
  const version2 = migrateBatchRuntimeCheckpoint(
    createVersion1CheckpointFixture(),
    2000
  ).checkpoint;
  version2.results[0].url =
    'https://migration-user:migration-password@target.test/0';

  for (const checkpoint of [version1, version2]) {
    let migrated;
    assert.doesNotThrow(() => {
      migrated = migrateBatchRuntimeCheckpoint(checkpoint, 2100);
    });
    assert.equal(migrated.ok, false);
    assert.doesNotMatch(
      JSON.stringify(migrated),
      /migration-user|migration-password/
    );
  }
});

test('retries a safe terminal attempt without deleting attempt history', () => {
  const terminal = createTerminalCheckpoint({
    result: 'fail',
    errorCode: 'task_timeout'
  });
  const retried = applyBatchRuntimeEvent(terminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    confirmedRisk: false
  }, 2200);

  assert.equal(retried.ok, true);
  assert.equal(retried.checkpoint.tasks['0'].state, 'queued');
  assert.equal(retried.checkpoint.tasks['0'].attempt, 2);
  assert.equal(retried.checkpoint.results.length, 1);
  assert.equal(retried.checkpoint.results[0].attempt, 1);
});

test('automatic retry is one-time, pre-submit, allowlisted, and assignment-stable', () => {
  const terminal = createTerminalCheckpoint({
    result: 'fail',
    errorCode: 'content_script_unavailable'
  });
  terminal.tasks['0'].lastFailurePhase = 'loading';
  const retried = applyBatchRuntimeEvent(terminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    taskId: 'batch-1:legacy:0',
    urlIndex: 0,
    attempt: 1,
    automatic: true,
    retryable: true,
    hasSubmitContext: false
  }, 2200);

  assert.equal(retried.ok, true);
  assert.equal(retried.checkpoint.tasks['0'].attempt, 2);
  assert.equal(retried.checkpoint.tasks['0'].profileId, 'default-profile');
  assert.equal(
    retried.checkpoint.tasks['0'].promotionSiteId,
    'default-promotion-site'
  );

  const secondTerminal = structuredClone(retried.checkpoint);
  secondTerminal.tasks['0'].state = 'terminal';
  secondTerminal.tasks['0'].lastFailurePhase = 'loading';
  secondTerminal.tasks['0'].lastErrorCode = 'content_script_unavailable';
  secondTerminal.results.push({
    ...secondTerminal.results[0],
    attempt: 2,
    attemptCount: 2,
    timestamp: 2300
  });
  const blocked = applyBatchRuntimeEvent(secondTerminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    taskId: 'batch-1:legacy:0',
    urlIndex: 0,
    attempt: 2,
    automatic: true,
    retryable: true,
    hasSubmitContext: false
  }, 2400);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'automatic_retry_blocked');
});

test('automatic retry rejects submit-risk, non-retryable, and unknown failures', () => {
  const cases = [{
    phase: 'submitting',
    errorCode: 'task_timeout',
    retryable: true,
    hasSubmitContext: false
  }, {
    phase: 'loading',
    errorCode: 'task_timeout',
    retryable: false,
    hasSubmitContext: false
  }, {
    phase: 'loading',
    errorCode: 'unknown_failure',
    retryable: true,
    hasSubmitContext: false
  }, {
    phase: 'loading',
    errorCode: 'task_timeout',
    retryable: true,
    hasSubmitContext: true
  }];

  for (const entry of cases) {
    const terminal = createTerminalCheckpoint({
      result: 'fail',
      errorCode: entry.errorCode
    });
    terminal.tasks['0'].lastFailurePhase = entry.phase;
    const response = applyBatchRuntimeEvent(terminal, {
      type: 'task_retried',
      batchId: 'batch-1',
      taskId: 'batch-1:legacy:0',
      urlIndex: 0,
      attempt: 1,
      automatic: true,
      retryable: entry.retryable,
      hasSubmitContext: entry.hasSubmitContext
    }, 2200);
    assert.equal(response.error, 'automatic_retry_blocked');
  }
});

test('requires confirmation for uncertain submissions and rejects stale attempts', () => {
  const terminal = createTerminalCheckpoint({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  });
  const unconfirmed = applyBatchRuntimeEvent(terminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    confirmedRisk: false
  }, 2200);
  const stale = applyBatchRuntimeEvent(terminal, {
    type: 'task_phase',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 0,
    phase: 'loading'
  }, 2200);

  assert.equal(unconfirmed.error, 'retry_confirmation_required');
  assert.equal(stale.error, 'stale_attempt');
});

test('rejects retries after the batch is completed or terminated', () => {
  for (const status of ['completed', 'terminated']) {
    const terminal = createTerminalCheckpoint({
      result: 'fail',
      errorCode: 'task_timeout'
    });
    terminal.status = status;

    const retried = applyBatchRuntimeEvent(terminal, {
      type: 'task_retried',
      batchId: 'batch-1',
      urlIndex: 0,
      attempt: 1,
      confirmedRisk: false
    }, 2200);

    assert.equal(retried.ok, false);
    assert.equal(retried.error, 'invalid_transition');
    assert.equal(retried.checkpoint.status, status);
    assert.equal(retried.checkpoint.tasks['0'].state, 'terminal');
    assert.equal(retried.checkpoint.tasks['0'].attempt, 1);
  }
});

test('assigns deterministic error codes to all version 1 result types', () => {
  const cases = [
    ['success', null],
    ['skipped', null],
    ['no_comment_box', 'no_comment_box'],
    ['manual_required', 'submission_uncertain'],
    ['blocked_illegal', 'illegal_site'],
    ['fail', 'task_failed']
  ];

  for (const [result, expectedErrorCode] of cases) {
    const version1 = createVersion1CheckpointFixture();
    version1.results[0].result = result;
    version1.results[0].errorCode = null;

    const migrated = migrateBatchRuntimeCheckpoint(version1, 2000);

    assert.equal(migrated.ok, true);
    assert.equal(migrated.checkpoint.results[0].errorCode, expectedErrorCode);
  }
});

test('assigns deterministic error codes when the legacy property is absent', () => {
  const cases = [
    ['success', null],
    ['skipped', null],
    ['no_comment_box', 'no_comment_box'],
    ['manual_required', 'submission_uncertain'],
    ['blocked_illegal', 'illegal_site'],
    ['fail', 'task_failed']
  ];

  for (const [result, expectedErrorCode] of cases) {
    const version1 = createVersion1CheckpointFixture();
    version1.results[0].result = result;
    delete version1.results[0].errorCode;

    const migrated = migrateBatchRuntimeCheckpoint(version1, 2000);

    assert.equal(migrated.ok, true);
    assert.equal(migrated.checkpoint.results[0].errorCode, expectedErrorCode);
  }
});

function assignmentPlanFixture() {
  return {
    version: 2,
    planId: 'batch-plan',
    planFingerprint: 'a'.repeat(64),
    configRevision: 7,
    createdAt: 900,
    illegalSiteRulesVersion: 'fixture-v1',
    quotas: {
      batch: 10,
      perProfile: 10,
      perPromotionSite: 10,
      perTargetDomain: 10
    },
    repeatOverrides: [],
    profiles: {
      'profile-a': {
        id: 'profile-a',
        displayName: '作者 A',
        name: 'Alice',
        email: 'alice@example.test'
      },
      'profile-b': {
        id: 'profile-b',
        displayName: '作者 B',
        name: 'Bob',
        email: 'bob@example.test'
      }
    },
    promotionSites: {
      'site-a': {
        id: 'site-a',
        name: '站点 A',
        url: 'https://promo-a.test/',
        content: 'Promotion A'
      },
      'site-b': {
        id: 'site-b',
        name: '站点 B',
        url: 'https://promo-b.test/',
        content: 'Promotion B'
      }
    },
    tasks: [{
      taskId: 'batch-plan:1',
      urlIndex: 0,
      rowNumber: 1,
      targetUrl: 'https://target.test/one',
      canonicalTargetUrl: 'https://target.test/one',
      targetDomain: 'target.test',
      sourceDomain: 'target.test',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      assignmentPairId: 'pair-a',
      assignmentSource: 'weighted',
      state: 'eligible',
      blockReason: null,
      recentSuccessOverride: false
    }, {
      taskId: 'batch-plan:2',
      urlIndex: 1,
      rowNumber: 2,
      targetUrl: 'https://blocked.test/two',
      canonicalTargetUrl: 'https://blocked.test/two',
      targetDomain: 'blocked.test',
      sourceDomain: 'blocked.test',
      profileId: 'profile-b',
      promotionSiteId: 'site-b',
      assignmentPairId: 'pair-b',
      assignmentSource: 'default_blocked',
      state: 'blocked',
      blockReason: 'blocked_illegal',
      recentSuccessOverride: false
    }],
    warnings: [],
    confirmationRequirements: ['multiple_assignments']
  };
}

function planConfirmationFixture() {
  return {
    version: 1,
    planFingerprint: 'a'.repeat(64),
    normalConfirmed: true,
    requiredRisks: ['multiple_assignments'],
    highRiskConfirmed: true,
    confirmedAt: 950
  };
}

function consoleVersion2Fixture() {
  const checkpoint = createVersion1CheckpointFixture();
  checkpoint.version = 2;
  checkpoint.status = 'paused_recovery';
  checkpoint.settings.assignment = {
    identityId: 'default-identity',
    promotionSiteId: 'default-promotion-site',
    identitySnapshot: {
      displayName: 'Legacy Alice',
      email: 'legacy@example.test'
    },
    promotionSiteSnapshot: {
      label: 'promo.test',
      url: 'https://promo.test/',
      contentSummary: 'Legacy promotion'
    }
  };
  checkpoint.openingReservations = {};
  checkpoint.tasks['0'] = {
    ...checkpoint.tasks['0'],
    attempt: 2,
    requestId: null,
    ownerPageTabId: null,
    ownershipEpoch: null,
    manualResolution: {
      status: 'unresolved',
      updatedAt: 1450
    }
  };
  checkpoint.results[0].attempt = 2;
  return checkpoint;
}

test('migrates v1 directly to v3 with a canonical default assignment', () => {
  const legacy = createVersion1CheckpointFixture();
  legacy.status = 'paused_recovery';
  const migrated = migrateBatchRuntimeCheckpoint(
    legacy,
    2000
  );

  assert.equal(migrated.ok, true);
  assert.equal(migrated.checkpoint.version, 3);
  assert.equal(migrated.checkpoint.tasks['0'].attempt, 1);
  assert.equal(migrated.checkpoint.tasks['0'].profileId, 'default-profile');
  assert.equal(
    migrated.checkpoint.tasks['0'].promotionSiteId,
    'default-promotion-site'
  );
  assert.equal(migrated.checkpoint.status, 'paused_recovery');
});

test('migrates console v2 to v3 without losing attempt or manual resolution', () => {
  const migrated = migrateBatchRuntimeCheckpoint(
    consoleVersion2Fixture(),
    2000
  );

  assert.equal(migrated.ok, true);
  assert.equal(migrated.checkpoint.version, 3);
  assert.equal(migrated.checkpoint.tasks['0'].attempt, 2);
  assert.equal(
    migrated.checkpoint.tasks['0'].manualResolution.status,
    'unresolved'
  );
  assert.equal(migrated.checkpoint.tasks['0'].profileId, 'default-profile');
  assert.equal(
    migrated.checkpoint.tasks['0'].promotionSiteId,
    'default-promotion-site'
  );
});

test('creates a frozen assignment checkpoint and terminalizes blocked plan rows', () => {
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-plan',
    plan: assignmentPlanFixture(),
    confirmation: planConfirmationFixture(),
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 60
    }
  }, 1000);

  assert.equal(checkpoint.version, 3);
  assert.equal(checkpoint.planFingerprint, 'a'.repeat(64));
  assert.deepEqual(checkpoint.profiles['profile-a'], {
    id: 'profile-a',
    displayName: '作者 A',
    name: 'Alice',
    email: 'alice@example.test'
  });
  assert.equal(checkpoint.promotionSites['site-a'].content, 'Promotion A');
  assert.deepEqual(
    {
      taskId: checkpoint.tasks['0'].taskId,
      profileId: checkpoint.tasks['0'].profileId,
      promotionSiteId: checkpoint.tasks['0'].promotionSiteId,
      assignmentPairId: checkpoint.tasks['0'].assignmentPairId,
      assignmentSource: checkpoint.tasks['0'].assignmentSource,
      state: checkpoint.tasks['0'].state
    },
    {
      taskId: 'batch-plan:1',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      assignmentPairId: 'pair-a',
      assignmentSource: 'weighted',
      state: 'queued'
    }
  );
  assert.equal(checkpoint.tasks['1'].state, 'terminal');
  assert.equal(checkpoint.results[0].result, 'blocked_illegal');
  assert.equal(checkpoint.results[0].profileId, 'profile-b');
  assert.equal(checkpoint.results[0].promotionSiteId, 'site-b');
  assert.equal(validateBatchRuntimeCheckpoint(checkpoint).ok, true);
});

test('rejects secrets recursively and keeps assignment stable through retry', () => {
  const secret = `runtime-secret-${crypto.randomUUID()}`;
  const unsafePlan = assignmentPlanFixture();
  unsafePlan.profiles['profile-a'].password = secret;
  assert.throws(() => createBatchRuntimeCheckpoint({
    batchId: 'batch-plan',
    plan: unsafePlan,
    confirmation: planConfirmationFixture(),
    settings: { concurrency: 1, timeoutSeconds: 60 }
  }, 1000), /sensitive_field_forbidden/);

  let checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-plan',
    plan: assignmentPlanFixture(),
    confirmation: planConfirmationFixture(),
    settings: { concurrency: 1, timeoutSeconds: 60 }
  }, 1000);
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'session_started',
    batchId: 'batch-plan'
  }, 1100).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_terminal',
    batchId: 'batch-plan',
    taskId: 'batch-plan:1',
    urlIndex: 0,
    attempt: 1,
    result: {
      result: 'fail',
      errorCode: 'content_script_timeout',
      errorMessage: 'timeout'
    }
  }, 1200).checkpoint;
  checkpoint = applyBatchRuntimeEvent(checkpoint, {
    type: 'task_retried',
    batchId: 'batch-plan',
    taskId: 'batch-plan:1',
    urlIndex: 0,
    attempt: 1
  }, 1300).checkpoint;

  assert.deepEqual(
    {
      taskId: checkpoint.tasks['0'].taskId,
      profileId: checkpoint.tasks['0'].profileId,
      promotionSiteId: checkpoint.tasks['0'].promotionSiteId,
      assignmentPairId: checkpoint.tasks['0'].assignmentPairId,
      assignmentSource: checkpoint.tasks['0'].assignmentSource,
      attempt: checkpoint.tasks['0'].attempt,
      state: checkpoint.tasks['0'].state
    },
    {
      taskId: 'batch-plan:1',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      assignmentPairId: 'pair-a',
      assignmentSource: 'weighted',
      attempt: 2,
      state: 'queued'
    }
  );
  assert.equal(JSON.stringify(checkpoint).includes(secret), false);
});

function createVersion1CheckpointFixture() {
  return {
    version: 1,
    batchId: 'batch-1',
    status: 'completed',
    createdAt: 1000,
    updatedAt: 1500,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: [['https://target.test/0']],
      parsedUrls: [{
        originalIndex: 0,
        url: 'https://target.test/0',
        sourceDomain: 'target.test',
        originalRow: ['https://target.test/0']
      }]
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    },
    cursor: { nextIndex: 1 },
    tasks: {
      0: {
        urlIndex: 0,
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1500
      }
    },
    results: [{
      originalIndex: 0,
      url: 'https://target.test/0',
      sourceDomain: 'target.test',
      result: 'success',
      aiContent: 'saved',
      errorCode: null,
      errorMessage: null,
      timestamp: 1500,
      elapsed: 1,
      originalRow: ['https://target.test/0']
    }]
  };
}

function createTerminalCheckpoint({ result, errorCode }) {
  const checkpoint = migrateBatchRuntimeCheckpoint(
    createVersion1CheckpointFixture(),
    2000
  ).checkpoint;
  checkpoint.status = 'paused_recovery';
  checkpoint.results[0].result = result;
  checkpoint.results[0].errorCode = errorCode;
  checkpoint.results[0].errorMessage = errorCode;
  return checkpoint;
}
