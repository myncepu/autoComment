import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_DIAGNOSTIC_LOG_KEY,
  appendBatchDiagnosticEvent,
  createBatchDiagnosticExport,
  createBatchDiagnosticService,
  sanitizeBatchDiagnosticEvent
} from '../lib/batch-diagnostic-log.mjs';
import {
  BATCH_RUNTIME_CHECKPOINT_KEY
} from '../lib/batch-runtime-checkpoint.mjs';

test('diagnostic events retain submission signals without comments or secrets', () => {
  const event = sanitizeBatchDiagnosticEvent({
    batchId: 'batch-1',
    urlIndex: 4,
    attempt: 2,
    event: 'submission_dispatch_result',
    details: {
      success: true,
      strategy: 'request-submit',
      dispatchResult: 'ajax-success',
      contentLength: 387,
      commentText: 'private generated comment',
      apiKey: 'private-key',
      submitSelector: '#submit'
    }
  }, {
    now: 1234,
    sourceTabId: 99,
    sourceUrl: 'https://blog.test/post?token=private#comment'
  });

  assert.deepEqual(event, {
    timestamp: 1234,
    batchId: 'batch-1',
    urlIndex: 4,
    attempt: 2,
    event: 'submission_dispatch_result',
    host: 'blog.test',
    sourceTabId: 99,
    details: {
      success: true,
      strategy: 'request-submit',
      dispatchResult: 'ajax-success',
      contentLength: 387
    }
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /private|token|selector|commentText|apiKey/
  );
});

test('bounded diagnostic documents retain the newest events and count drops', () => {
  const first = sanitizeBatchDiagnosticEvent({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    event: 'task_started'
  }, { now: 1 });
  const second = {
    ...first,
    timestamp: 2,
    event: 'form_detected'
  };
  const third = {
    ...first,
    timestamp: 3,
    event: 'comment_generated'
  };
  let document = appendBatchDiagnosticEvent(null, first, {
    now: 1,
    maximum: 2
  });
  document = appendBatchDiagnosticEvent(document, second, {
    now: 2,
    maximum: 2
  });
  document = appendBatchDiagnosticEvent(document, third, {
    now: 3,
    maximum: 2
  });

  assert.deepEqual(
    document.events.map(({ event }) => event),
    ['form_detected', 'comment_generated']
  );
  assert.equal(document.droppedEventCount, 1);
});

test('diagnostic export summarizes confirmed results and submission funnel', () => {
  const checkpoint = {
    batchId: 'batch-1',
    status: 'running',
    settings: { concurrency: 3, timeoutSeconds: 90 },
    tasks: { 0: {}, 1: {}, 2: {} },
    results: [
      { result: 'success' },
      { result: 'skipped', skipReason: 'recent_success' },
      { result: 'manual_required' }
    ]
  };
  const events = [
    ['comment_generated', {}],
    ['form_filled', { success: true }],
    ['submit_control_detected', { buttonClickable: true }],
    ['submission_dispatch_result', {
      success: true,
      dispatchResult: 'ajax-success'
    }],
    ['submission_confirmation', {
      confirmed: true,
      confirmationStatus: 'success'
    }]
  ].map(([event, details], urlIndex) => ({
    timestamp: 1000 + urlIndex,
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    event,
    host: 'blog.test',
    sourceTabId: 10,
    details
  }));

  const exported = createBatchDiagnosticExport(checkpoint, {
    batchId: 'batch-1',
    droppedEventCount: 2,
    events
  }, 2000);

  assert.deepEqual(exported.summary.resultCounts, {
    success: 1,
    skipped: 1,
    manual_required: 1
  });
  assert.deepEqual(exported.summary.skipReasonCounts, {
    recent_success: 1
  });
  assert.deepEqual(exported.summary.publishedEvidence, {
    currentBatchSuccess: 1,
    recentSuccess: 1,
    total: 2
  });
  assert.equal(exported.summary.rates.confirmedResultPercent, 66.67);
  assert.equal(exported.summary.rates.newTaskSuccessPercent, 50);
  assert.equal(exported.summary.rates.submitConfirmationPercent, 100);
  assert.equal(exported.summary.funnel.serverConfirmed, 1);
  assert.equal(exported.summary.droppedDiagnosticEvents, 2);
  assert.deepEqual(exported.privacy, {
    commentsIncluded: false,
    credentialsIncluded: false,
    fullUrlsIncluded: false
  });
});

test('diagnostic funnel counts only final confirmation states', () => {
  const confirmationEvents = [
    [0, 'submission_confirmation', {
      confirmed: false,
      navigationPending: true,
      confirmationStatus: 'verification-navigation'
    }],
    [0, 'submission_restored_confirmation', {
      confirmed: true,
      confirmationStatus: 'success'
    }],
    [1, 'submission_confirmation', {
      confirmed: false,
      navigationPending: true,
      confirmationStatus: 'verification-navigation'
    }],
    [1, 'submission_restored_confirmation', {
      confirmed: false,
      confirmationStatus: 'rejected'
    }],
    [2, 'submission_confirmation', {
      confirmed: false,
      navigationPending: true,
      confirmationStatus: 'verification-reload'
    }],
    [2, 'submission_restored_confirmation', {
      confirmed: false,
      confirmationStatus: 'uncertain'
    }],
    [3, 'submission_dispatch_result', {
      success: true,
      dispatchResult: 'navigating'
    }],
    [3, 'submission_confirmation', {
      confirmed: false,
      navigationPending: true,
      confirmationStatus: 'verification-navigation'
    }]
  ].map(([urlIndex, event, details], index) => ({
    timestamp: 1000 + index,
    batchId: 'batch-1',
    urlIndex,
    attempt: 1,
    event,
    host: 'blog.test',
    sourceTabId: 10 + urlIndex,
    details
  }));

  const exported = createBatchDiagnosticExport({
    batchId: 'batch-1',
    status: 'completed',
    settings: { concurrency: 3, timeoutSeconds: 90 },
    tasks: {},
    results: []
  }, {
    batchId: 'batch-1',
    events: confirmationEvents
  }, 2000);

  assert.equal(exported.summary.funnel.serverConfirmed, 1);
  assert.equal(exported.summary.funnel.submissionRejected, 1);
  assert.equal(exported.summary.funnel.submissionUncertain, 1);
  assert.equal(exported.summary.funnel.dispatchAttempted, 4);
  assert.equal(exported.summary.funnel.submitDispatched, 4);
  assert.equal(
    exported.summary.funnel.submissionWithoutFinalConfirmation,
    1
  );
});

test('diagnostic export identifies non-terminal tasks past their deadline', () => {
  const exported = createBatchDiagnosticExport({
    batchId: 'batch-1',
    status: 'running',
    settings: { concurrency: 1, timeoutSeconds: 90 },
    tasks: {
      7: {
        urlIndex: 7,
        attempt: 1,
        state: 'submitting',
        phase: 'confirming',
        startedAt: 1000,
        updatedAt: 2000
      }
    },
    results: []
  }, {
    batchId: 'batch-1',
    events: []
  }, 100_000);

  assert.deepEqual(exported.runtimeSnapshot.nonTerminalTasks, [{
    urlIndex: 7,
    attempt: 1,
    state: 'submitting',
    phase: 'confirming',
    startedAt: 1000,
    updatedAt: 2000,
    elapsedMs: 99_000,
    deadlineAt: 91_000,
    deadlineExceeded: true
  }]);
});

test('diagnostic service accepts only the exact owned worker and trusted batch page', async () => {
  const data = {
    [BATCH_RUNTIME_CHECKPOINT_KEY]: {
      batchId: 'batch-1',
      status: 'running',
      settings: { concurrency: 1, timeoutSeconds: 60 },
      tasks: {
        0: {
          state: 'active',
          attempt: 1,
          tabId: 22
        }
      },
      results: []
    }
  };
  const storageArea = {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, data[key]]));
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    }
  };
  const runtime = {
    id: 'extension-id',
    getURL(path) {
      return `chrome-extension://extension-id/${path}`;
    }
  };
  let clock = 1000;
  const service = createBatchDiagnosticService({
    storageArea,
    runtime,
    now: () => ++clock
  });
  const message = {
    type: 'BATCH_DIAGNOSTIC_EVENT',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    event: 'form_filled',
    details: { success: true }
  };

  assert.deepEqual(await service.append(message, {
    id: 'extension-id',
    tab: { id: 21, url: 'https://wrong.test/' }
  }), {
    ok: false,
    error: 'stale_worker_tab'
  });
  assert.deepEqual(await service.append(message, {
    id: 'extension-id',
    tab: { id: 22, url: 'https://right.test/post?secret=hidden' }
  }), { ok: true });
  assert.equal(
    data[BATCH_DIAGNOSTIC_LOG_KEY].events[0].host,
    'right.test'
  );
  Object.assign(data[BATCH_RUNTIME_CHECKPOINT_KEY].tasks[0], {
    state: 'terminal',
    tabId: null
  });
  assert.deepEqual(await service.append({
    ...message,
    event: 'submission_confirmation',
    details: {
      confirmed: true,
      confirmationStatus: 'success'
    }
  }, {
    id: 'extension-id',
    tab: { id: 22, url: 'https://right.test/post-complete' }
  }), { ok: true });

  assert.deepEqual(await service.exportLog({
    type: 'BATCH_DIAGNOSTICS_EXPORT',
    batchId: 'batch-1'
  }, {
    id: 'extension-id',
    tab: { id: 50 },
    url: 'https://external.test/batch.html'
  }), {
    ok: false,
    error: 'forbidden_sender'
  });
  const response = await service.exportLog({
    type: 'BATCH_DIAGNOSTICS_EXPORT',
    batchId: 'batch-1'
  }, {
    id: 'extension-id',
    tab: { id: 50 },
    url: 'chrome-extension://extension-id/batch.html'
  });
  assert.equal(response.ok, true);
  assert.equal(response.diagnostics.events.length, 2);
  assert.equal(response.diagnostics.summary.funnel.serverConfirmed, 1);
});
