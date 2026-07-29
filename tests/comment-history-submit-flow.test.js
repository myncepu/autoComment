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
  const messages = [];
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      messages.push(plain(message));
      if (typeof callback === 'function') {
        runtime.lastError = { message: 'background unavailable' };
        callback();
        runtime.lastError = null;
        return undefined;
      }
      return Promise.reject(new Error('background unavailable'));
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
  const transportSource = sourceBetween(
    'const BATCH_PROVEN_MESSAGE_MAX_ATTEMPTS',
    '\n\n  function isAcknowledgedBatchHistoryConfirmation'
  );
  vm.runInContext(
    `${identitySource}
${transportSource}
${reporterSource}
globalThis.reportBatchResult = reportBatchResult;`,
    context
  );
  return {
    reportBatchResult: context.reportBatchResult,
    storageData,
    messages
  };
}

test('content result transport exhaustion never writes local batch storage', async () => {
  const harness = createBatchResultFallbackHarness();

  const response = await harness.reportBatchResult(
    'batch-fallback',
    5,
    1,
    'fail',
    'old content',
    'late failure',
    'https://target.test/post',
    'submission_uncertain'
  );

  assert.deepEqual(plain(response), {
    ok: false,
    error: 'batch_transport_exhausted',
    retryable: true
  });
  assert.deepEqual(harness.storageData, {
    batchResults: [],
    batchReportedUrls: []
  });
  assert.equal(harness.messages.length, 2);
  assert.deepEqual(harness.messages[0], harness.messages[1]);
});

test('content result transport exhaustion does not alter authoritative local cache', async () => {
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
  harness.messages.length = 0;

  const response = await harness.reportBatchResult(
    'fallback-capacity',
    5,
    1,
    'fail',
    'old content',
    'late failure',
    'https://target.test/post',
    'submission_uncertain'
  );

  assert.equal(response?.ok, false);
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

test('task password is requested and filled only after a password input is detected', async () => {
  const dom = new JSDOM(`<!doctype html><form id="commentform">
    <input id="author" name="author">
    <input id="email" name="email" type="email">
    <input id="password" name="password" type="password">
    <input id="url" name="url" type="url">
    <textarea id="comment" name="comment"></textarea>
  </form>`);
  const requests = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: dom.window.document,
    getUserProfile: async (options) => {
      requests.push(options || {});
      return {
        name: 'Fixture Writer',
        email: 'writer@example.test',
        password: options?.includePassword ? 'task-only-password' : ''
      };
    },
    getWebsiteUrl: async () => 'https://promo.test/',
    findLikelyCommentTextarea: () => dom.window.document.getElementById('comment'),
    setValueRobust(element, value) {
      element.value = value;
    },
    setValue(element, value) {
      element.value = value;
    },
    setTimeout
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

  const result = await context.ensureAllCommentFormFieldsFilled(
    'A local fixture comment',
    false
  );

  assert.equal(result.success, true);
  assert.deepEqual(plain(requests), [{}, { includePassword: true }]);
  assert.equal(
    dom.window.document.getElementById('password').value,
    'task-only-password'
  );
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
      taskId: 'batch-config:legacy:4',
      urlIndex: 4,
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      attempt: 2,
      url: 'https://target.test/post',
      phase: 'loading'
    },
    {
      batchId: 'batch-config',
      taskId: 'batch-config:legacy:4',
      urlIndex: 4,
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      attempt: 2,
      url: 'https://target.test/post',
      phase: 'detecting'
    },
    {
      batchId: 'batch-config',
      taskId: 'batch-config:legacy:4',
      urlIndex: 4,
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      attempt: 2,
      url: 'https://target.test/post',
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

test('generate-only batch tasks finish as manual work without clicking submit', async () => {
  const phases = [];
  const manualReports = [];
  let clickCount = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://target.test/post' },
    lastGeneratedPromotionCopy: '',
    getBatchTaskKey: (task) => (
      `${task.batchId}:${task.urlIndex}:${task.attempt}`
    ),
    reportBatchPhase: async (_task, phase) => {
      phases.push(phase);
    },
    waitForPageReady: async () => {},
    evaluateCurrentPageForIllegalSite: () => ({ blocked: false }),
    checkExistingBatchResult: async () => null,
    findCommentForm: () => ({ id: 'commentform' }),
    findLikelyCommentTextarea: () => ({ value: 'Generated comment' }),
    triggerCommentFormFlow: async () => {},
    findCommentTargetsForBatchUsingManualFlow: async () => ({}),
    detectManualRequiredChallenge: () => ({ found: false }),
    getCachedPromotionCopy: async () => 'Generated comment',
    generatePromotionCopyWithLlm: async () => {
      throw new Error('generation should use the cached fixture value');
    },
    tryFillCommentTextareaWithPromotion: () => true,
    ensureAllCommentFormFieldsFilled: async () => ({ success: true }),
    captureCurrentCommentHistory: async () => ({
      commentText: 'Generated comment',
      anchors: [{ anchorText: 'Product' }],
      promotedWebsiteUrl: 'https://promo.test/'
    }),
    reportGeneratedCommentForManualHandling: async (...args) => {
      manualReports.push(args);
    },
    persistBatchSubmitContext: async () => {
      throw new Error('generate-only mode must not persist submit context');
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
let _batchCtx = {
  batchId: 'batch-generate',
  taskId: 'task-generate',
  urlIndex: 1,
  profileId: 'profile-a',
  promotionSiteId: 'site-a',
  attempt: 1,
  url: 'https://target.test/post',
  automation: { autoGenerate: true, autoSubmit: false }
};
${taskSource}
globalThis.handleBatchTask = handleBatchTask;`,
    context
  );

  await context.handleBatchTask(
    'batch-generate',
    1,
    1,
    'https://target.test/post'
  );

  assert.deepEqual(phases, ['loading', 'detecting', 'filling']);
  assert.equal(clickCount, 0);
  assert.equal(manualReports.length, 1);
  assert.equal(manualReports[0][0].taskId, 'task-generate');
  assert.equal(manualReports[0][1], 'Generated comment');
  assert.equal(manualReports[0][2].commentText, 'Generated comment');
});

test('generate-only manual result exposes a safe preview without submit history', async () => {
  const pending = [];
  const confirmations = [];
  const context = vm.createContext({
    GENERATED_MANUAL_MESSAGE: 'manual',
    writePendingResult: async (...args) => pending.push(args),
    confirmBatchHistoryDurably: async (message) => {
      confirmations.push(message);
    }
  });
  const functionSource = sourceBetween(
    'async function reportGeneratedCommentForManualHandling',
    '\n\n  /**\n   * 将待确认结果写入 storage'
  );
  vm.runInContext(
    `${functionSource}
globalThis.reportGeneratedCommentForManualHandling =
  reportGeneratedCommentForManualHandling;`,
    context
  );

  await context.reportGeneratedCommentForManualHandling({
    batchId: 'batch-a',
    urlIndex: 2,
    attempt: 1,
    url: 'https://target.test/post'
  }, 'Generated comment', {
    commentHtml: '<a href="https://promo.test/">Generated comment</a>',
    commentText: 'Generated comment',
    anchors: [{ anchorText: 'Product' }],
    promotedWebsiteUrl: 'https://promo.test/'
  });

  assert.equal(pending[0][4], 'manual_required');
  assert.deepEqual(plain(confirmations[0].resultPreview), {
    commentText: 'Generated comment',
    anchors: [{ anchorText: 'Product' }],
    promotedWebsiteUrl: 'https://promo.test/'
  });
  assert.equal(Object.hasOwn(confirmations[0], 'history'), false);
  assert.equal(
    JSON.stringify(confirmations[0]).includes('commentHtml'),
    false
  );
});

test('batch handles reject a missing attempt before accepting frozen task identity', () => {
  const identitySource = sourceBetween(
    'function getBatchTaskKey',
    '\n\n  function createHistoryUniqueId'
  );
  const context = vm.createContext({
    AutoCommentBatchTaskConfig: {
      acceptHandle(message) {
        return message;
      }
    }
  });
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
  assert.deepEqual(plain(context.getBatchHandleValidationError({
    batchId: 'batch-a',
    taskId: 'task-a',
    urlIndex: 3,
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    attempt: 2
  })), {
    taskConfig: {
      batchId: 'batch-a',
      taskId: 'task-a',
      urlIndex: 3,
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      attempt: 2
    }
  });
  assert.equal(context.getBatchTaskKey({
    batchId: 'batch-a',
    taskId: 'task-a',
    promotionSiteId: 'site-a',
    attempt: 1
  }), 'batch-a:task-a:site-a:1');
  assert.equal(context.getBatchTaskKey({
    batchId: 'batch-a',
    taskId: 'task-a',
    promotionSiteId: 'site-a',
    attempt: 2
  }), 'batch-a:task-a:site-a:2');
});

test('owned batch tabs fail closed before any manual default initialization', async () => {
  const initializationSource = sourceBetween(
    'async function getInitialPageMode()',
    '\n\n  async function initOnPageReady()'
  );
  const messages = [];
  const context = vm.createContext({
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(plain(message));
          return { ok: true, batchOwned: true };
        }
      }
    }
  });
  vm.runInContext(
    `${initializationSource}
globalThis.getInitialPageMode = getInitialPageMode;`,
    context
  );

  assert.deepEqual(plain(await context.getInitialPageMode()), {
    batchOwned: true
  });
  assert.deepEqual(messages, [{ type: 'BATCH_GET_TAB_MODE' }]);

  context.chrome.runtime.sendMessage = async () => {
    throw new Error('service worker unavailable');
  };
  assert.deepEqual(plain(await context.getInitialPageMode()), {
    batchOwned: true
  });
});

test('dynamic observers start only after ownership establishes manual mode', () => {
  const initializationSource = sourceBetween(
    'async function initOnPageReady()',
    '\n\n  let hasNotifiedCommentBox'
  );
  const ownershipIndex = initializationSource.indexOf(
    'const pageMode = await getInitialPageMode();'
  );
  const earlyReturnIndex = initializationSource.indexOf(
    'if (pageMode.batchOwned) return;'
  );
  const observerIndex = initializationSource.indexOf(
    'observeDynamicElements();'
  );
  const fillIndex = initializationSource.indexOf('fillInputs();');

  assert.ok(ownershipIndex >= 0);
  assert.ok(earlyReturnIndex > ownershipIndex);
  assert.ok(observerIndex > earlyReturnIndex);
  assert.ok(fillIndex > earlyReturnIndex);
});

test('a failed submitting phase write clears pre-click context and prevents a click', async () => {
  const cleared = [];
  const warningLogs = [];
  let clicked = false;
  let markedSubmitting = false;
  const form = { id: 'commentform' };
  const editor = { value: 'Generated promotion' };
  const context = vm.createContext({
    console: {
      log() {},
      warn(...args) { warningLogs.push(args); },
      error() {}
    },
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
  assert.deepEqual(
    warningLogs,
    [],
    'a queue-visible task failure must not create a Chrome extension warning'
  );
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
  assert.match(restored, /history:\s*confirmedSuccess\s*\?\s*ctx\.history\s*:\s*undefined/);
  assert.match(
    restored,
    /historyUnavailableReason:\s*confirmedSuccess\s*&&\s*!ctx\.history[\s\S]*?'legacy_context'/
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

test('pre-click context persistence rejects quota errors and post-click outcomes require confirmation', async () => {
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
    '\n\n      // submit 事件或请求开始都不能确认成功'
  );
  assert.match(
    definiteFailure,
    /if \(!clickResult\.success\) \{\s*await clearBatchSubmitContext\(\{\s*batchId,\s*urlIndex,\s*attempt\s*\}\);/,
    'a definite no-click result must clear the pre-click success context'
  );
  const outcomeGate = sourceBetween(
    'const submissionConfirmation =',
    '\n\n      // AJAX 已获得服务器响应和页面成功状态后'
  );
  assert.match(
    outcomeGate,
    /submissionConfirmation\.navigationPending[\s\S]*?return;/,
    'native navigation must leave confirmation to the restored document'
  );
  assert.match(
    outcomeGate,
    /!submissionConfirmation\.confirmed[\s\S]*?submission_uncertain/,
    'an unverified AJAX result must never continue as success'
  );
  const taskCatch = postClickFlow.slice(postClickFlow.indexOf('} catch (err) {'));
  assert.match(
    taskCatch,
    /submissionDispatched[\s\S]*?'submission_uncertain'[\s\S]*?'manual_required'/,
    'a dispatched but unverified submission must finish as manual review'
  );
});

function createConfirmationHarness({
  response,
  rejection,
  fallbackLastError,
  fallbackThrows = false,
  pendingEntryIds = [],
  html = '<!doctype html><body></body>'
} = {}) {
  const dom = new JSDOM(html, {
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
  context.detectManualRequiredChallenge = () => ({ found: false });
  context.findLikelyCommentTextarea = () => null;
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

test('content authorization rejection has zero history fallback or context side effects', async () => {
  const harness = createConfirmationHarness({
    response: {
      ok: false,
      error: 'stale_worker_tab'
    }
  });
  const message = exactConfirmationMessage();

  assert.deepEqual(
    plain(await harness.context.confirmBatchHistoryDurably(message)),
    {
      durable: false,
      acknowledgement: {
        ok: false,
        error: 'stale_worker_tab'
      }
    }
  );
  assert.deepEqual(harness.sentMessages, [message]);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.storageRemovals, []);
});

test('content retries the identical confirmation after cleanup failure', async () => {
  let calls = 0;
  const harness = createConfirmationHarness({
    response() {
      calls += 1;
      return calls === 1
        ? { ok: false, error: 'batch_teardown_cleanup_failed' }
        : {
            ok: true,
            historySaveStatus: 'saved',
            historyPendingCount: 0
          };
    }
  });
  const message = exactConfirmationMessage();

  assert.deepEqual(
    plain(await harness.context.confirmBatchHistoryDurably(message)),
    {
      durable: true,
      acknowledgement: {
        ok: true,
        historySaveStatus: 'saved',
        historyPendingCount: 0
      }
    }
  );
  assert.deepEqual(harness.sentMessages, [message, message]);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.storageRemovals, []);
});

test('content transport exhaustion preserves history and context in memory only', async () => {
  const harness = createConfirmationHarness({
    rejection: new Error('background unavailable')
  });
  const message = exactConfirmationMessage();

  assert.deepEqual(
    plain(await harness.context.confirmBatchHistoryDurably(message)),
    { durable: false, acknowledgement: null }
  );
  assert.deepEqual(harness.sentMessages, [message, message]);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.storageRemovals, []);
});

test('content requests a proven background history fallback without local writes', async () => {
  const harness = createConfirmationHarness({
    response(message) {
      if (message.type === 'BATCH_HANDLE_CONFIRM') {
        return { ok: true, historySaveStatus: 'failed' };
      }
      if (message.type === 'BATCH_HISTORY_PENDING_FALLBACK') {
        return {
          ok: true,
          historySaveStatus: 'queued',
          historyPendingCount: 1
        };
      }
      throw new Error(`unexpected message: ${message.type}`);
    }
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
      ...message,
      type: 'BATCH_HISTORY_PENDING_FALLBACK'
    }
  ]);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.storageRemovals, []);
});

test('restored exact and marked legacy contexts rely on background acknowledgement', async () => {
  const exactHarness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'saved' },
    html: '<!doctype html><body><section id="comments">'
      + '<article id="comment-7"><div class="comment-content">'
      + 'Exact submitted body'
      + '</div></article></section></body>'
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
  assert.deepEqual(exactHarness.storageRemovals, []);

  const legacyHarness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'not_applicable' },
    html: '<!doctype html><body>'
      + '<p class="comment-awaiting-moderation">Awaiting moderation</p>'
      + '</body>'
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
  assert.deepEqual(legacyHarness.storageRemovals, []);
});

test('restored confirmation maps explicit rejection to failure', async () => {
  const harness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'not_applicable' },
    html: '<!doctype html><body><main id="error-page">'
      + '<p class="wp-die-message">Duplicate comment detected</p>'
      + '</main></body>'
  });

  await harness.context.confirmRestoredBatchSubmit({
    ...exactConfirmationMessage(),
    type: undefined
  });

  assert.equal(harness.sentMessages[0].result, 'fail');
  assert.equal(
    harness.sentMessages[0].errorCode,
    'submission_rejected'
  );
  assert.equal(Object.hasOwn(harness.sentMessages[0], 'history'), false);
});

test('restored confirmation maps missing evidence to manual review', async () => {
  const harness = createConfirmationHarness({
    response: { ok: true, historySaveStatus: 'not_applicable' }
  });

  await harness.context.confirmRestoredBatchSubmit({
    ...exactConfirmationMessage(),
    type: undefined
  });

  assert.equal(harness.sentMessages[0].result, 'manual_required');
  assert.equal(
    harness.sentMessages[0].errorCode,
    'submission_uncertain'
  );
  assert.equal(Object.hasOwn(harness.sentMessages[0], 'history'), false);
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
