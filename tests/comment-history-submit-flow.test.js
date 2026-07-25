const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = content.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return content.slice(start, end);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBatchResultFallbackHarness(initial = {}) {
  const storageData = {
    batchResults: [],
    batchReportedUrls: [],
    ...plain(initial)
  };
  const runtime = {
    lastError: null,
    sendMessage(_message, callback) {
      runtime.lastError = { message: 'background unavailable' };
      callback();
      runtime.lastError = null;
    }
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date,
    chrome: {
      runtime,
      storage: {
        local: {
          get(_keys, callback) {
            callback(plain(storageData));
          },
          set(values, callback) {
            Object.assign(storageData, plain(values));
            callback();
          }
        }
      }
    }
  });
  const reporterSource = sourceBetween(
    'async function reportBatchResult(',
    '\n})();'
  );
  const identitySource = sourceBetween(
    'function hasCompleteBatchResultIdentity(',
    '\n\n  function hasHistoryRevision'
  );
  vm.runInContext(
    `${identitySource}
${reporterSource}
globalThis.reportBatchResult = reportBatchResult;`,
    context
  );
  return { reportBatchResult: context.reportBatchResult, storageData };
}

test('local result fallback keeps attempts distinct and preserves error codes', async () => {
  const harness = createBatchResultFallbackHarness();

  await harness.reportBatchResult(
    'batch-fallback',
    5,
    1,
    'fail',
    'old content',
    'late failure',
    'https://target.test/post',
    'submission_uncertain'
  );
  await harness.reportBatchResult(
    'batch-fallback',
    5,
    2,
    'success',
    'new content',
    null,
    'https://target.test/post',
    null
  );

  assert.deepEqual(
    harness.storageData.batchResults.map(
      ({ batchId, urlIndex, attempt, result, errorCode }) => ({
        batchId,
        urlIndex,
        attempt,
        result,
        errorCode
      })
    ),
    [
      {
        batchId: 'batch-fallback',
        urlIndex: 5,
        attempt: 1,
        result: 'fail',
        errorCode: 'submission_uncertain'
      },
      {
        batchId: 'batch-fallback',
        urlIndex: 5,
        attempt: 2,
        result: 'success',
        errorCode: null
      }
    ]
  );
  assert.deepEqual(harness.storageData.batchReportedUrls, [
    'batch-fallback:5:1',
    'batch-fallback:5:2'
  ]);
});

test('full local fallback ignores an older attempt without evicting current data', async () => {
  const targetResult = {
    batchId: 'fallback-capacity',
    urlIndex: 5,
    attempt: 2,
    result: 'success',
    errorCode: null
  };
  const initial = {
    batchResults: [
      targetResult,
      ...Array.from({ length: 99 }, (_, index) => ({
        batchId: 'other-fallback',
        urlIndex: index,
        attempt: 1,
        result: 'success'
      }))
    ],
    batchReportedUrls: [
      'fallback-capacity:5:2',
      ...Array.from(
        { length: 499 },
        (_, index) => `fallback-reported-${index}:0:1`
      )
    ]
  };
  const harness = createBatchResultFallbackHarness(initial);

  await harness.reportBatchResult(
    'fallback-capacity',
    5,
    1,
    'fail',
    'old content',
    'late failure',
    'https://target.test/post',
    'submission_uncertain'
  );

  assert.deepEqual(harness.storageData, initial);
});

function loadFieldValidation({ name = '', email = '', reportStatus } = {}) {
  const context = vm.createContext({
    console: { log() {}, error() {} },
    getUserProfile: async () => ({ name, email }),
    getWebsiteUrl: async () => 'https://promo.test/'
  });
  const functionSource = sourceBetween(
    'async function ensureAllCommentFormFieldsFilled',
    '\n\n  // 收集当前页面内容'
  );
  vm.runInContext(
    `${functionSource}
globalThis.ensureAllCommentFormFieldsFilled = ensureAllCommentFormFieldsFilled;`,
    context
  );
  return {
    validate: (commentText = '', skipCommentValidation = true) => (
      context.ensureAllCommentFormFieldsFilled(
        commentText,
        skipCommentValidation,
        reportStatus
      )
    )
  };
}

test('missing profile fields return structured failure without an open panel', async () => {
  const harness = loadFieldValidation({
    name: '',
    email: 'writer@example.test'
  });

  assert.deepEqual(plain(await harness.validate()), {
    success: false,
    missingFields: ['name config missing']
  });
});

test('missing profile fields can be reported by an open panel without global state', async () => {
  const statuses = [];
  const harness = loadFieldValidation({
    name: 'Writer',
    email: '',
    reportStatus(text, color) {
      statuses.push({ text, color });
    }
  });

  assert.deepEqual(plain(await harness.validate()), {
    success: false,
    missingFields: ['email config missing']
  });
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].text, /邮箱/);
  assert.equal(statuses[0].color, '#f97373');
});

test('automatic profile failure is attempt-scoped and cannot continue to submit', async () => {
  const phases = [];
  const pending = [];
  const reports = [];
  let clickCount = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://target.test/post' },
    lastGeneratedPromotionCopy: '',
    getBatchTaskKey: (batchId, urlIndex, attempt) => (
      `${batchId}:${urlIndex}:${attempt}`
    ),
    reportBatchPhase: async (batchContext, phase) => {
      phases.push({ ...batchContext, phase });
    },
    waitForPageReady: async () => {},
    evaluateCurrentPageForIllegalSite: () => ({ blocked: false }),
    checkExistingBatchResult: async () => null,
    findCommentForm: () => ({ id: 'commentform' }),
    findLikelyCommentTextarea: () => ({ value: '' }),
    triggerCommentFormFlow: async () => {},
    findCommentTargetsForBatchUsingManualFlow: async () => ({}),
    detectManualRequiredChallenge: () => ({ found: false }),
    getCachedPromotionCopy: async () => 'Cached promotion',
    generatePromotionCopyWithLlm: async () => {
      throw new Error('generation should not run');
    },
    tryFillCommentTextareaWithPromotion: () => true,
    ensureAllCommentFormFieldsFilled: async () => ({
      success: false,
      missingFields: ['name config missing']
    }),
    captureCurrentCommentHistory: async () => {
      throw new Error('history capture should not run');
    },
    writePendingResult: async (...args) => {
      pending.push(args);
    },
    reportBatchResult: async (...args) => {
      reports.push(args);
    },
    clickCommentSubmitButton: async () => {
      clickCount += 1;
      return { success: true };
    }
  });
  const taskSource = sourceBetween(
    'async function handleBatchTask(batchId, urlIndex, attempt, url)',
    '\n  /**\n   * 等待页面关键元素加载'
  );
  vm.runInContext(
    `let runningBatchTaskKey = null;
${taskSource}
globalThis.handleBatchTask = handleBatchTask;`,
    context
  );

  await context.handleBatchTask(
    'batch-config',
    4,
    2,
    'https://target.test/post'
  );

  assert.deepEqual(plain(phases), [
    {
      batchId: 'batch-config',
      urlIndex: 4,
      attempt: 2,
      phase: 'loading'
    },
    {
      batchId: 'batch-config',
      urlIndex: 4,
      attempt: 2,
      phase: 'detecting'
    },
    {
      batchId: 'batch-config',
      urlIndex: 4,
      attempt: 2,
      phase: 'filling'
    }
  ]);
  assert.deepEqual(pending, [[
    'batch-config',
    4,
    2,
    'https://target.test/post',
    'fail',
    null,
    '表单字段缺失: name config missing',
    'task_failed'
  ]]);
  assert.deepEqual(reports, [[
    'batch-config',
    4,
    2,
    'fail',
    null,
    '表单字段缺失: name config missing',
    'https://target.test/post',
    'task_failed'
  ]]);
  assert.equal(clickCount, 0);
});

test('batch handles reject a missing attempt before accepting task identity', () => {
  const identitySource = sourceBetween(
    'function getBatchTaskKey',
    '\n\n  function createHistoryUniqueId'
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${identitySource}
globalThis.getBatchHandleValidationError = getBatchHandleValidationError;
globalThis.getBatchTaskKey = getBatchTaskKey;`,
    context
  );

  assert.deepEqual(plain(context.getBatchHandleValidationError({
    batchId: 'batch-a',
    urlIndex: 3
  })), {
    ok: false,
    error: 'invalid_batch_attempt',
    urlIndex: 3
  });
  assert.equal(context.getBatchHandleValidationError({
    batchId: 'batch-a',
    urlIndex: 3,
    attempt: 2
  }), null);
  assert.equal(context.getBatchTaskKey('batch-a', 3, 1), 'batch-a:3:1');
  assert.equal(context.getBatchTaskKey('batch-a', 3, 2), 'batch-a:3:2');
});

test('a failed submitting phase write clears pre-click context and prevents a click', async () => {
  const cleared = [];
  let clicked = false;
  let markedSubmitting = false;
  const form = { id: 'commentform' };
  const editor = { value: 'Generated promotion' };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://target.test/post' },
    lastGeneratedPromotionCopy: '',
    getBatchTaskKey: (batchId, urlIndex, attempt) => (
      `${batchId}:${urlIndex}:${attempt}`
    ),
    async reportBatchPhase(_batchContext, phase) {
      if (phase === 'submitting') {
        throw new Error('checkpoint_write_failed');
      }
    },
    waitForPageReady: async () => {},
    evaluateCurrentPageForIllegalSite: () => ({ blocked: false }),
    checkExistingBatchResult: async () => null,
    findCommentForm: () => form,
    findLikelyCommentTextarea: () => editor,
    triggerCommentFormFlow: async () => {},
    findCommentTargetsForBatchUsingManualFlow: async () => ({
      form,
      textarea: editor
    }),
    detectManualRequiredChallenge: () => ({ found: false }),
    getCachedPromotionCopy: async () => 'Generated promotion',
    generatePromotionCopyWithLlm: async () => 'Generated promotion',
    tryFillCommentTextareaWithPromotion: () => true,
    ensureAllCommentFormFieldsFilled: async () => ({
      success: true,
      missingFields: []
    }),
    captureCurrentCommentHistory: async () => ({
      historyRevision: {
        capturedAt: 1,
        recordedAt: 2,
        sequence: 1,
        id: 'revision-phase-failure'
      }
    }),
    writePendingResult: async () => {},
    persistBatchSubmitContext: async () => {},
    markBatchTaskSubmitting: async () => {
      markedSubmitting = true;
    },
    clearBatchSubmitContext: async (match) => {
      cleared.push(plain(match));
    },
    reportBatchResult: async () => {},
    clickCommentSubmitButton: async () => {
      clicked = true;
      return { success: true };
    }
  });
  const taskSource = sourceBetween(
    'async function handleBatchTask(batchId, urlIndex, attempt, url)',
    '\n  /**\n   * 等待页面关键元素加载'
  );
  vm.runInContext(
    `let runningBatchTaskKey = null;
${taskSource}
globalThis.handleBatchTask = handleBatchTask;`,
    context
  );

  await context.handleBatchTask(
    'batch-phase',
    5,
    2,
    'https://target.test/post'
  );

  assert.deepEqual(cleared, [{
    batchId: 'batch-phase',
    urlIndex: 5,
    attempt: 2
  }]);
  assert.equal(markedSubmitting, false);
  assert.equal(clicked, false);
});

test('captures the fixture editor value and promoted URL at the submission boundary', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'comment-page.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://target.test/post',
    runScripts: 'outside-only'
  });
  const context = dom.getInternalVMContext();
  const captureSource = fs.readFileSync(
    path.join(root, 'lib', 'comment-history-capture.js'),
    'utf8'
  );
  vm.runInContext(captureSource, context);
  vm.runInContext('async function getWebsiteUrl() { return "https://promo.test/"; }', context);
  context.Date.now = () => 1721000000000;
  Object.defineProperty(context.crypto, 'randomUUID', {
    configurable: true,
    value: () => 'revision-capture-1'
  });

  const functionSource = sourceBetween(
    'function createHistoryUniqueId',
    '\n  async function persistBatchSubmitContext'
  );
  vm.runInContext(`let historyRevisionSequence = 0;
${functionSource}
globalThis.captureCurrentCommentHistory = captureCurrentCommentHistory;`, context);

  const editor = dom.window.document.getElementById('comment');
  editor.value = 'Actual <a href="/submitted">submitted value</a>';
  const history = await context.captureCurrentCommentHistory(editor, 'https://target.test/post');

  assert.equal(history.commentHtml, editor.value);
  assert.equal(history.promotedWebsiteUrl, 'https://promo.test/');
  assert.equal(history.targetPageUrl, 'https://target.test/post');
  assert.equal(history.anchors[0].hrefResolved, 'https://target.test/submitted');
  assert.deepEqual(plain(history.historyRevision), {
    capturedAt: 1721000000000,
    recordedAt: 1721000000000,
    sequence: 1,
    id: 'revision-capture-1'
  });
});

test('captures the final editor before pending context persistence and synthetic click', () => {
  const flow = sourceBetween(
    'async function handleBatchTask(batchId, urlIndex, attempt, url)',
    '\n  /**\n   * 等待页面关键元素加载'
  );
  const validationIndex = flow.indexOf('const manualCheckBeforeSubmit = detectManualRequiredChallenge(form);');
  const captureIndex = flow.indexOf('captureCurrentCommentHistory');
  const pendingIndex = flow.indexOf('writePendingResult');
  const contextIndex = flow.indexOf('persistBatchSubmitContext');
  const submittingIndex = flow.indexOf('markBatchTaskSubmitting');
  const clickIndex = flow.indexOf('clickCommentSubmitButton');

  assert.notEqual(validationIndex, -1, 'final form validation must remain in the flow');
  assert.notEqual(captureIndex, -1, 'actual editor history must be captured');
  assert.notEqual(pendingIndex, -1, 'pending result must remain persisted');
  assert.notEqual(contextIndex, -1, 'reload context must remain persisted');
  assert.notEqual(submittingIndex, -1, 'submitting phase must be durable');
  assert.notEqual(clickIndex, -1, 'synthetic click must remain dispatched');
  assert.ok(validationIndex < captureIndex, 'capture must happen after final validation');
  assert.ok(captureIndex < pendingIndex, 'capture must happen before pending result persistence');
  assert.ok(pendingIndex < contextIndex, 'pending result must precede submit context');
  assert.ok(
    contextIndex < submittingIndex,
    'submit context must precede the submitting checkpoint'
  );
  assert.ok(
    submittingIndex < clickIndex,
    'submitting checkpoint must be durable before the click'
  );
  assert.match(flow, /const editor = findLikelyCommentTextarea\(\{ allowGenericFallback: true \}\);/);
  assert.match(flow, /persistBatchSubmitContext\([\s\S]*?history\s*\)/);
  assert.match(flow, /confirmBatchHistoryDurably\(\{[\s\S]*history[\s\S]*\}\)/);
});

test('submitting checkpoint gate forwards task identity and rejects a failed write', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://target.test/post',
    runScripts: 'outside-only'
  });
  const context = dom.getInternalVMContext();
  const sentMessages = [];
  const clearedContexts = [];
  context.clearBatchSubmitContext = async (match) => {
    clearedContexts.push(plain(match));
  };
  context.chrome = {
    runtime: {
      async sendMessage(message) {
        sentMessages.push(plain(message));
        return message.batchId === 'accepted'
          ? { ok: true }
          : { ok: false, error: 'checkpoint_write_failed' };
      }
    }
  };
  const gateSource = sourceBetween(
    'async function markBatchTaskSubmitting',
    '\n  function clearBatchSubmitContext'
  );
  vm.runInContext(
    `${gateSource}
globalThis.markBatchTaskSubmitting = markBatchTaskSubmitting;`,
    context
  );

  await context.markBatchTaskSubmitting('accepted', 7, 1);
  await assert.rejects(
    context.markBatchTaskSubmitting('rejected', 8, 2),
    /checkpoint_write_failed/
  );
  assert.deepEqual(sentMessages, [
    {
      type: 'BATCH_TASK_SUBMITTING',
      batchId: 'accepted',
      urlIndex: 7,
      attempt: 1
    },
    {
      type: 'BATCH_TASK_SUBMITTING',
      batchId: 'rejected',
      urlIndex: 8,
      attempt: 2
    }
  ]);
  assert.deepEqual(clearedContexts, [{
    batchId: 'rejected',
    urlIndex: 8,
    attempt: 2
  }]);
});

test('forwards one captured history payload through direct, restored, and panel confirmations', () => {
  const persist = sourceBetween(
    'async function persistBatchSubmitContext',
    '\n  function clearBatchSubmitContext'
  );
  const restored = sourceBetween(
    'async function confirmRestoredBatchSubmit',
    '\n  // 从 storage 恢复提交后上下文'
  );
  const reporter = sourceBetween(
    'async function reportSuccessToBatch',
    '\n  /**\n   * 批处理模式（刷新后）'
  );
  const autoMode = sourceBetween(
    'async function handleBatchTaskForAutoMode',
    '\n  async function autoGeneratePromotionOnPageLoad'
  );
  const panel = sourceBetween(
    "generateBtn.addEventListener('click'",
    "\n    copyBtn.addEventListener('click'"
  );

  assert.match(persist, /AutoCommentBatchSubmitContext\.save\(\{[\s\S]*history\s*\n\s*\}\)/);
  assert.match(restored, /history:\s*ctx\.history/);
  assert.match(
    restored,
    /historyUnavailableReason:\s*ctx\.history\s*\?\s*undefined\s*:\s*'legacy_context'/
  );
  assert.match(restored, /confirmBatchHistoryDurably\(message\)/);
  assert.match(reporter, /async function reportSuccessToBatch\(aiContent, history\)/);
  assert.match(reporter, /confirmBatchHistoryDurably\(\{[\s\S]*history[\s\S]*\}\)/);

  const autoCaptureIndex = autoMode.indexOf('captureCurrentCommentHistory');
  const autoSubmittingIndex = autoMode.indexOf('markBatchTaskSubmitting');
  const autoWaitIndex = autoMode.indexOf('waitForNavigate');
  const autoReportIndex = autoMode.indexOf('reportSuccessToBatch(promotionText, history)');
  assert.ok(autoCaptureIndex < autoWaitIndex, 'auto-mode capture must precede navigation');
  assert.ok(
    autoSubmittingIndex > autoCaptureIndex &&
      autoSubmittingIndex < autoWaitIndex,
    'auto-mode submission phase must be durable before navigation'
  );
  assert.ok(autoWaitIndex < autoReportIndex, 'auto-mode success must forward the pre-navigation payload');

  const panelCaptureIndex = panel.indexOf('captureCurrentCommentHistory');
  const panelSubmittingIndex = panel.indexOf('markBatchTaskSubmitting');
  const panelClickIndex = panel.indexOf('clickCommentSubmitButton');
  const panelReportIndex = panel.indexOf('reportSuccessToBatch(text, history)');
  assert.ok(panelCaptureIndex < panelClickIndex, 'panel capture must precede the click');
  assert.ok(
    panelSubmittingIndex > panelCaptureIndex &&
      panelSubmittingIndex < panelClickIndex,
    'panel submitting checkpoint must precede the click'
  );
  assert.ok(panelClickIndex < panelReportIndex, 'panel success must reuse the pre-click payload');
  assert.match(
    panel,
    /else \{\s*if \(_batchCtx\) \{\s*clearBatchSubmitContext\(\{[\s\S]*attempt:\s*_batchCtx\.attempt/,
    'a definite panel no-click result must clear its pre-click success context'
  );
});

test('pre-click context persistence rejects quota errors and ambiguous post-click paths preserve it', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://target.test/post',
    runScripts: 'outside-only'
  });
  const context = dom.getInternalVMContext();
  context.AutoCommentBatchSubmitContext = {
    async save() {
      throw new Error('QUOTA_BYTES quota exceeded');
    }
  };
  const persistSource = sourceBetween(
    'async function persistBatchSubmitContext',
    '\n  function clearBatchSubmitContext'
  );
  vm.runInContext(
    `${persistSource}\nglobalThis.persistBatchSubmitContext = persistBatchSubmitContext;`,
    context
  );

  await assert.rejects(
    context.persistBatchSubmitContext(
      'batch-a',
      7,
      1,
      'https://target.test/post',
      'success',
      'Generated fallback',
      null,
      exactConfirmationMessage().history
    ),
    /quota/i
  );

  const taskFlow = sourceBetween(
    'async function handleBatchTask(batchId, urlIndex, attempt, url)',
    '\n  /**\n   * 等待页面关键元素加载'
  );
  const postClickFlow = taskFlow.slice(taskFlow.indexOf('const clickResult'));
  const definiteFailure = sourceBetween(
    'const clickResult = await clickCommentSubmitButton();',
    '\n\n      // 检测表单是否成功提交'
  );
  assert.match(
    definiteFailure,
    /if \(!clickResult\.success\) \{\s*await clearBatchSubmitContext\(\{\s*batchId,\s*urlIndex,\s*attempt\s*\}\);/,
    'a definite no-click result must clear the pre-click success context'
  );
  const ambiguousTimeout = sourceBetween(
    "if (submitResult === 'timeout')",
    '\n\n      // 页面点击成功后'
  );
  assert.doesNotMatch(
    ambiguousTimeout,
    /clearBatchSubmitContext\(\)/,
    'a dispatched click with an ambiguous timeout must preserve its context'
  );
  const taskCatch = postClickFlow.slice(postClickFlow.indexOf('} catch (err) {'));
  assert.doesNotMatch(
    taskCatch,
    /clearBatchSubmitContext\(\)/,
    'the generic catch must not discard an ambiguously dispatched submission'
  );
});

function createConfirmationHarness({
  response,
  rejection,
  fallbackLastError,
  fallbackThrows = false,
  pendingEntryIds = []
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://target.test/post',
    runScripts: 'outside-only'
  });
  const context = dom.getInternalVMContext();
  if (pendingEntryIds.length > 0) {
    const entryIds = [...pendingEntryIds];
    Object.defineProperty(context.crypto, 'randomUUID', {
      configurable: true,
      value: () => entryIds.shift()
    });
  }
  const sentMessages = [];
  const storageWrites = [];
  const storageRemovals = [];
  const runtime = {
    lastError: null,
    sendMessage(message) {
      sentMessages.push(plain(message));
      if (rejection) return Promise.reject(rejection);
      const resolved = typeof response === 'function'
        ? response(message)
        : response;
      return Promise.resolve(resolved);
    }
  };
  context.chrome = {
    runtime,
    storage: {
      local: {
        set(values, callback) {
          if (fallbackThrows) throw new Error('fallback storage threw');
          storageWrites.push(plain(values));
          runtime.lastError = fallbackLastError || null;
          callback();
          runtime.lastError = null;
        },
        remove(key, callback) {
          storageRemovals.push(key);
          callback?.();
        }
      }
    }
  };
  context.AutoCommentBatchSubmitContext = {
    clear() {
      storageRemovals.push('submit-context');
      return Promise.resolve();
    }
  };
  context.console = { log() {}, warn() {}, error() {} };
  const confirmationSource = sourceBetween(
    'function createHistoryUniqueId',
    '\n  // 从 storage 恢复提交后上下文'
  );
  vm.runInContext(`let historyRevisionSequence = 0;
${confirmationSource}
globalThis.confirmBatchHistoryDurably = confirmBatchHistoryDurably;
globalThis.confirmRestoredBatchSubmit = confirmRestoredBatchSubmit;`, context);
  return {
    context,
    sentMessages,
    storageWrites,
    storageRemovals
  };
}

function exactConfirmationMessage(overrides = {}) {
  return {
    type: 'BATCH_HANDLE_CONFIRM',
    batchId: 'batch-a',
    urlIndex: 7,
    attempt: 1,
    url: 'https://target.test/post',
    aiContent: 'Generated fallback',
    errorCode: null,
    history: {
      submittedAt: 1721000000000,
      targetPageUrl: 'https://target.test/post',
      promotedWebsiteUrl: 'https://promo.test/',
      commentHtml: 'Exact submitted body',
      commentText: 'Exact submitted body',
      anchors: [],
      historyRevision: {
        capturedAt: 1721000000000,
        recordedAt: 1721000000001,
        sequence: 1,
        id: 'revision-exact-default'
      }
    },
    ...overrides
  };
}

function expectedPendingWrite(entryId, message) {
  return {
    [`historyPending:v2:${entryId}`]: {
      queueVersion: 2,
      entryId,
      commentId: `${message.batchId}:${message.urlIndex}`,
      revision: message.history.historyRevision,
      message
    }
  };
}

test('rejected confirmations queue exact history and preserve context until close handoff', async () => {
  for (const rejection of [
    new Error('background rejected'),
    new Error('The message channel closed before a response was received.')
  ]) {
    const harness = createConfirmationHarness({
      rejection,
      pendingEntryIds: ['rejected-entry']
    });
    const message = exactConfirmationMessage();

    assert.deepEqual(
      plain(await harness.context.confirmBatchHistoryDurably(message)),
      { durable: true, acknowledgement: null }
    );
    assert.deepEqual(harness.sentMessages, [
      message,
      {
        type: 'BATCH_HISTORY_FALLBACK_DURABLE',
        batchId: message.batchId,
        urlIndex: message.urlIndex,
        attempt: message.attempt,
        url: message.url,
        result: 'success',
        aiContent: message.aiContent,
        errorCode: null,
        errorMessage: null,
        historyRevision: message.history.historyRevision
      }
    ]);
    assert.deepEqual(
      harness.storageWrites,
      [expectedPendingWrite('rejected-entry', message)]
    );
    assert.deepEqual(harness.storageRemovals, []);
  }
});

test('content fallback creates immutable queue entries for same-ID exact revisions', async () => {
  const harness = createConfirmationHarness({
    rejection: new Error('background unavailable'),
    pendingEntryIds: ['content-entry-first', 'content-entry-second']
  });
  const first = exactConfirmationMessage({
    history: {
      ...exactConfirmationMessage().history,
      submittedAt: 1721000000000,
      historyRevision: {
        capturedAt: 1721000000000,
        recordedAt: 1721000000001,
        sequence: 1,
        id: 'revision-first'
      }
    }
  });
  const second = exactConfirmationMessage({
    history: {
      ...exactConfirmationMessage().history,
      submittedAt: 1721000001000,
      commentHtml: 'New exact submitted body',
      commentText: 'New exact submitted body',
      historyRevision: {
        capturedAt: 1721000001000,
        recordedAt: 1721000001001,
        sequence: 2,
        id: 'revision-second'
      }
    }
  });

  await harness.context.confirmBatchHistoryDurably(first);
  await harness.context.confirmBatchHistoryDurably(second);

  const keys = harness.storageWrites.map((write) => Object.keys(write)[0]);
  assert.deepEqual(keys, [
    'historyPending:v2:content-entry-first',
    'historyPending:v2:content-entry-second'
  ]);
  const queued = harness.storageWrites.map((write, index) => write[keys[index]]);
  assert.deepEqual(
    queued.map(({ queueVersion, entryId, commentId, revision, message }) => ({
      queueVersion,
      entryId,
      commentId,
      revision,
      message
    })),
    [
      {
        queueVersion: 2,
        entryId: 'content-entry-first',
        commentId: 'batch-a:7',
        revision: first.history.historyRevision,
        message: first
      },
      {
        queueVersion: 2,
        entryId: 'content-entry-second',
        commentId: 'batch-a:7',
        revision: second.history.historyRevision,
        message: second
      }
    ]
  );
});

test('content announces a durable fallback before allowing the worker to close', async () => {
  const harness = createConfirmationHarness({
    response(message) {
      if (message.type === 'BATCH_HANDLE_CONFIRM') {
        return { ok: true, historySaveStatus: 'failed' };
      }
      if (message.type === 'BATCH_HISTORY_FALLBACK_DURABLE') {
        return { ok: true };
      }
      throw new Error(`unexpected message: ${message.type}`);
    },
    pendingEntryIds: ['fallback-handoff-entry']
  });
  const message = exactConfirmationMessage();

  assert.deepEqual(
    plain(await harness.context.confirmBatchHistoryDurably(message)),
    {
      durable: true,
      acknowledgement: { ok: true, historySaveStatus: 'failed' }
    }
  );
  assert.deepEqual(harness.sentMessages, [
    message,
    {
      type: 'BATCH_HISTORY_FALLBACK_DURABLE',
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      attempt: message.attempt,
      url: message.url,
      result: 'success',
      aiContent: message.aiContent,
      errorCode: null,
      errorMessage: null,
      historyRevision: message.history.historyRevision
    }
  ]);
  assert.deepEqual(harness.storageRemovals, ['submit-context']);
});

test('failed acknowledgement falls back, while a fallback write failure preserves submit context', async () => {
  const failedAck = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'failed' },
    pendingEntryIds: ['failed-ack-entry']
  });
  const message = exactConfirmationMessage();
  assert.deepEqual(
    plain(await failedAck.context.confirmBatchHistoryDurably(message)),
    {
      durable: true,
      acknowledgement: { ok: true, historySaveStatus: 'failed' }
    }
  );
  assert.deepEqual(
    failedAck.storageWrites,
    [expectedPendingWrite('failed-ack-entry', message)]
  );
  assert.deepEqual(failedAck.storageRemovals, ['submit-context']);

  for (const failureOptions of [
    { fallbackLastError: { message: 'quota exceeded' } },
    { fallbackThrows: true }
  ]) {
    const failedFallback = createConfirmationHarness({
      rejection: new Error('background unavailable'),
      ...failureOptions
    });
    assert.deepEqual(
      plain(await failedFallback.context.confirmBatchHistoryDurably(message)),
      { durable: false, acknowledgement: null }
    );
    assert.deepEqual(failedFallback.storageRemovals, []);
  }
});

test('restored exact and marked legacy contexts clear only after a valid acknowledgement', async () => {
  const exactHarness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'saved' }
  });
  const exactContext = {
    ...exactConfirmationMessage(),
    type: undefined,
    result: 'success',
    errorMessage: null,
    timestamp: 1
  };
  delete exactContext.type;
  await exactHarness.context.confirmRestoredBatchSubmit(exactContext);
  assert.equal(exactHarness.sentMessages[0].history.commentHtml, 'Exact submitted body');
  assert.deepEqual(exactHarness.storageWrites, []);
  assert.deepEqual(exactHarness.storageRemovals, ['submit-context']);

  const legacyHarness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'not_applicable' }
  });
  await legacyHarness.context.confirmRestoredBatchSubmit({
    batchId: 'batch-old',
    urlIndex: 3,
    attempt: 1,
    url: 'https://legacy.test/post',
    aiContent: 'Legacy AI fallback',
    result: 'success',
    timestamp: 1
  });
  assert.equal(
    legacyHarness.sentMessages[0].historyUnavailableReason,
    'legacy_context'
  );
  assert.deepEqual(legacyHarness.storageWrites, []);
  assert.deepEqual(legacyHarness.storageRemovals, ['submit-context']);
});

test('restored legacy context without an attempt is not reported or cleared', async () => {
  const harness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'not_applicable' }
  });

  await harness.context.confirmRestoredBatchSubmit({
    batchId: 'batch-old-incomplete',
    urlIndex: 3,
    url: 'https://legacy.test/post',
    aiContent: 'Legacy AI fallback',
    result: 'success',
    timestamp: 1
  });

  assert.deepEqual(harness.sentMessages, []);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.storageRemovals, []);
});

test('non-success confirmations do not attach history', () => {
  const nonSuccessFunctions = [
    ['async function reportIllegalSiteAndClose', '\n  async function handleBatchTask'],
    ['async function reportAlreadyCommented', '\n  const MANUAL_REQUIRED_MESSAGE'],
    ['async function reportManualRequiredAndClose', '\n  /**\n   * 将待确认结果写入 storage']
  ];

  for (const [start, end] of nonSuccessFunctions) {
    const source = sourceBetween(start, end);
    assert.doesNotMatch(source, /\bhistory\s*:/, `${start} must omit history`);
  }
});
