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

  const functionSource = sourceBetween(
    'async function captureCurrentCommentHistory',
    '\n  async function persistBatchSubmitContext'
  );
  vm.runInContext(`${functionSource}\nglobalThis.captureCurrentCommentHistory = captureCurrentCommentHistory;`, context);

  const editor = dom.window.document.getElementById('comment');
  editor.value = 'Actual <a href="/submitted">submitted value</a>';
  const history = await context.captureCurrentCommentHistory(editor, 'https://target.test/post');

  assert.equal(history.commentHtml, editor.value);
  assert.equal(history.promotedWebsiteUrl, 'https://promo.test/');
  assert.equal(history.targetPageUrl, 'https://target.test/post');
  assert.equal(history.anchors[0].hrefResolved, 'https://target.test/submitted');
});

test('captures the final editor before pending context persistence and synthetic click', () => {
  const flow = sourceBetween(
    'async function handleBatchTask(batchId, urlIndex, url, originalIndex)',
    '\n  /**\n   * 等待页面关键元素加载'
  );
  const validationIndex = flow.indexOf('const manualCheckBeforeSubmit = detectManualRequiredChallenge(form);');
  const captureIndex = flow.indexOf('captureCurrentCommentHistory');
  const pendingIndex = flow.indexOf('writePendingResult');
  const contextIndex = flow.indexOf('persistBatchSubmitContext');
  const clickIndex = flow.indexOf('clickCommentSubmitButton');

  assert.notEqual(validationIndex, -1, 'final form validation must remain in the flow');
  assert.notEqual(captureIndex, -1, 'actual editor history must be captured');
  assert.notEqual(pendingIndex, -1, 'pending result must remain persisted');
  assert.notEqual(contextIndex, -1, 'reload context must remain persisted');
  assert.notEqual(clickIndex, -1, 'synthetic click must remain dispatched');
  assert.ok(validationIndex < captureIndex, 'capture must happen after final validation');
  assert.ok(captureIndex < pendingIndex, 'capture must happen before pending result persistence');
  assert.ok(pendingIndex < contextIndex, 'pending result must precede submit context');
  assert.ok(contextIndex < clickIndex, 'submit context must be durable before the click');
  assert.match(flow, /const editor = findLikelyCommentTextarea\(\{ allowGenericFallback: true \}\);/);
  assert.match(flow, /persistBatchSubmitContext\([^;]+history\)/);
  assert.match(flow, /history\s*\n\s*\}\)\.then/);
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

  assert.match(persist, /history,\s*\n\s*timestamp:/);
  assert.match(restored, /history:\s*ctx\.history/);
  assert.match(
    restored,
    /historyUnavailableReason:\s*ctx\.history\s*\?\s*undefined\s*:\s*'legacy_context'/
  );
  assert.match(reporter, /async function reportSuccessToBatch\(aiContent, history\)/);
  assert.match(reporter, /history\s*\n\s*\}\)\.then/);
  assert.match(reporter, /if \(response && response\.ok\) \{\s*clearBatchSubmitContext\(\);/);

  const autoCaptureIndex = autoMode.indexOf('captureCurrentCommentHistory');
  const autoWaitIndex = autoMode.indexOf('waitForNavigate');
  const autoReportIndex = autoMode.indexOf('reportSuccessToBatch(promotionText, history)');
  assert.ok(autoCaptureIndex < autoWaitIndex, 'auto-mode capture must precede navigation');
  assert.ok(autoWaitIndex < autoReportIndex, 'auto-mode success must forward the pre-navigation payload');

  const panelCaptureIndex = panel.indexOf('captureCurrentCommentHistory');
  const panelClickIndex = panel.indexOf('clickCommentSubmitButton');
  const panelReportIndex = panel.indexOf('reportSuccessToBatch(text, history)');
  assert.ok(panelCaptureIndex < panelClickIndex, 'panel capture must precede the click');
  assert.ok(panelClickIndex < panelReportIndex, 'panel success must reuse the pre-click payload');
  assert.match(
    panel,
    /else \{\s*if \(_batchCtx\) \{\s*clearBatchSubmitContext\(\);\s*\}/,
    'a non-batch failure must not clear another tab’s shared submit context'
  );
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
