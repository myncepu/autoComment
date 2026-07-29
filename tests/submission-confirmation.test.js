const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const content = fs.readFileSync(
  path.resolve(__dirname, '..', 'content.js'),
  'utf8'
);

function sourceBetween(startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = content.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return content.slice(start, end);
}

class FakeXMLHttpRequest {
  constructor() {
    this.status = 0;
    this.listeners = new Map();
  }

  open() {}

  send() {}

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  finish(status) {
    this.status = status;
    this.listeners.get('loadend')?.();
  }
}

function createDetectorHarness(fetchImpl) {
  const listeners = new Map();
  let reloadCalls = 0;
  const windowObject = {
    fetch: fetchImpl,
    XMLHttpRequest: FakeXMLHttpRequest,
    location: {
      reload() {
        reloadCalls += 1;
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };
  const context = vm.createContext({
    window: windowObject,
    PerformanceObserver: undefined,
    setTimeout,
    clearTimeout,
    Promise,
    inspectSubmissionDocument: () => ({
      status: 'success',
      reason: 'fixture success'
    })
  });
  const detectorSource = sourceBetween(
    'const SUBMISSION_NAVIGATION_RESULTS',
    '\n  // 执行点击操作'
  );
  vm.runInContext(
    `${detectorSource}
globalThis.waitForSubmitOrNavigate = waitForSubmitOrNavigate;
globalThis.confirmDispatchedSubmissionResult = confirmDispatchedSubmissionResult;`,
    context
  );
  return {
    context,
    windowObject,
    listeners,
    detectorSource,
    get reloadCalls() {
      return reloadCalls;
    }
  };
}

test('a submit event alone is never treated as server confirmation', () => {
  const harness = createDetectorHarness(() => Promise.resolve({ ok: true }));
  assert.doesNotMatch(
    harness.detectorSource,
    /document\.addEventListener\(['"]submit['"]/,
    'raw submit events happen before native POST and must not resolve success'
  );
});

test('fetch submission resolves only after a successful response completes', async () => {
  let resolveRequest;
  const responsePromise = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const harness = createDetectorHarness(() => responsePromise);
  const detection = harness.context.waitForSubmitOrNavigate(200);

  harness.windowObject.fetch('/comments', { method: 'POST' });
  const beforeResponse = await Promise.race([
    detection.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 20))
  ]);
  assert.equal(beforeResponse, 'pending');

  resolveRequest({ ok: true, status: 201 });
  assert.equal(await detection, 'ajax-success');
});

test('failed fetch and XHR responses cannot be reported as success', async () => {
  const fetchHarness = createDetectorHarness(
    () => Promise.resolve({ ok: false, status: 422 })
  );
  const fetchDetection =
    fetchHarness.context.waitForSubmitOrNavigate(200);
  fetchHarness.windowObject.fetch('/comments', { method: 'POST' });
  assert.equal(await fetchDetection, 'ajax-failure');

  const xhrHarness = createDetectorHarness(() => Promise.resolve({ ok: true }));
  const xhrDetection = xhrHarness.context.waitForSubmitOrNavigate(200);
  const xhr = new xhrHarness.windowObject.XMLHttpRequest();
  xhr.open('POST', '/comments');
  xhr.send('comment=fixture');
  xhr.finish(500);
  assert.equal(await xhrDetection, 'ajax-failure');
});

test('an unrelated completed API request cannot confirm a comment', async () => {
  const harness = createDetectorHarness(
    () => Promise.resolve({ ok: true, status: 200 })
  );
  const detection = harness.context.waitForSubmitOrNavigate(30);
  harness.windowObject.fetch('/api/profile', { method: 'POST' });
  assert.equal(await detection, 'timeout');
});

test('native navigation is deferred to the restored document', async () => {
  const harness = createDetectorHarness(() => Promise.resolve({ ok: true }));
  const detection = harness.context.waitForSubmitOrNavigate(200);
  harness.listeners.get('beforeunload')();

  assert.equal(await detection, 'navigating');
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await harness.context.confirmDispatchedSubmissionResult('navigating')
    )),
    {
      confirmed: false,
      navigationPending: true,
      reason: '原生表单导航已开始，等待新页面确认',
      status: 'verification-navigation'
    }
  );
});

test('a completed AJAX request reloads before final confirmation', async () => {
  const harness = createDetectorHarness(() => Promise.resolve({
    ok: true,
    status: 200
  }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await harness.context.confirmDispatchedSubmissionResult('ajax-success')
    )),
    {
      confirmed: false,
      navigationPending: true,
      reason: '提交请求已完成，正在刷新页面验证评论状态',
      status: 'verification-reload'
    }
  );
  assert.equal(harness.reloadCalls, 1);
});

function inspectRestoredPage(html, url, ctx = {}) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only'
  });
  const context = dom.getInternalVMContext();
  context.detectManualRequiredChallenge = () => ({ found: false });
  context.findLikelyCommentTextarea = () => null;
  context.performance = {
    getEntriesByType() {
      return [{ responseStatus: 200 }];
    }
  };
  const inspectionSource = sourceBetween(
    'function getNavigationResponseStatus',
    '\n\n  async function confirmRestoredBatchSubmit'
  );
  vm.runInContext(
    `${inspectionSource}
globalThis.inspectRestoredSubmissionDocument =
  inspectRestoredSubmissionDocument;`,
    context
  );
  return JSON.parse(JSON.stringify(
    context.inspectRestoredSubmissionDocument(ctx)
  ));
}

test('restored WordPress error pages are not converted into success', () => {
  const outcome = inspectRestoredPage(
    '<main id="error-page"><p class="wp-die-message">Duplicate comment detected</p></main>',
    'https://target.test/wp-comments-post.php'
  );
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.reason, /Duplicate comment detected/);
});

test('a completed native redirect without an error is confirmed', () => {
  assert.deepEqual(
    inspectRestoredPage(
      '<main><article>Post</article><form id="commentform"></form></main>',
      'https://target.test/post#comment-42'
    ),
    {
      status: 'success',
      reason: '已导航到新评论锚点'
    }
  );
});

test('a refreshed page confirms the exact submitted comment', () => {
  assert.deepEqual(
    inspectRestoredPage(
      '<section id="comments"><article id="comment-7">'
        + '<div class="comment-content">Exact submitted body</div>'
        + '</article></section>',
      'https://target.test/post',
      { history: { commentText: 'Exact submitted body' } }
    ),
    {
      status: 'success',
      reason: '刷新后已在评论列表中找到本次评论'
    }
  );
});

test('a moderation notice confirms server acceptance', () => {
  const outcome = inspectRestoredPage(
    '<p class="comment-awaiting-moderation">'
      + 'Your comment is awaiting moderation.'
      + '</p>',
    'https://target.test/post'
  );
  assert.equal(outcome.status, 'success');
  assert.match(outcome.reason, /awaiting moderation/i);
});

test('a refreshed page without success or failure evidence stays uncertain', () => {
  assert.deepEqual(
    inspectRestoredPage(
      '<main><article>Post body only</article></main>',
      'https://target.test/post',
      { history: { commentText: 'Exact submitted body' } }
    ),
    {
      status: 'uncertain',
      reason: '页面已刷新，但未找到本次评论、审核提示或明确错误'
    }
  );
});
