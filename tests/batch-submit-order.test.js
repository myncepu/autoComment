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

function performClickSource() {
  const start = content.indexOf('async function performClick(button)');
  const end = content.indexOf(
    '\n\n  function tryFillCommentTextareaWithPromotion',
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return content.slice(start, end);
}

function createPerformClickHarness({ clickable }) {
  const dom = new JSDOM(`<!doctype html><form method="post">
    <textarea name="comment">Generated comment</textarea>
    <button type="submit">Post</button>
  </form>`);
  const document = dom.window.document;
  const form = document.querySelector('form');
  const button = document.querySelector('button');
  const diagnostics = [];
  let requestSubmitCalls = 0;
  let animationFrameCalls = 0;
  let recordedSubmits = 0;

  button.scrollIntoView = () => {};
  button.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    width: 80,
    height: 30
  });
  button.addEventListener('click', (event) => event.preventDefault());
  form.requestSubmit = (submitter) => {
    assert.equal(submitter, button);
    requestSubmitCalls += 1;
  };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    window: dom.window,
    MouseEvent: dom.window.MouseEvent,
    setTimeout,
    clearTimeout,
    _batchCtx: { batchId: 'batch-1', urlIndex: 1, attempt: 1 },
    findLikelyCommentTextarea: () => document.querySelector('textarea'),
    isButtonClickable: () => clickable,
    waitForSubmitOrNavigate: () => Promise.resolve('navigating'),
    recordFormSubmit: () => {
      recordedSubmits += 1;
    },
    requestAnimationFrame() {
      animationFrameCalls += 1;
      return 1;
    },
    AutoCommentReportBatchDiagnostic: async (_context, event, details) => {
      diagnostics.push({ event, details });
      return { ok: true };
    }
  });
  vm.runInContext(
    `${performClickSource()}
globalThis.performClick = performClick;`,
    context
  );
  return {
    button,
    diagnostics,
    performClick: context.performClick,
    stats() {
      return {
        animationFrameCalls,
        recordedSubmits,
        requestSubmitCalls
      };
    }
  };
}

test('batch submission arms result detection before dispatching the synchronous click', () => {
  const performClickStart = content.indexOf('async function performClick(button)');
  const performClickEnd = content.indexOf('\n  // ============================================================', performClickStart);
  const performClick = content.slice(performClickStart, performClickEnd);

  const clickIndex = performClick.indexOf("button.dispatchEvent(new MouseEvent('click'");
  const armIndex = performClick.lastIndexOf(
    'const submitDetection = waitForSubmitOrNavigate(',
    clickIndex
  );
  const awaitIndex = performClick.indexOf('await submitDetection', clickIndex);

  assert.notEqual(armIndex, -1, 'submission result detection must be armed');
  assert.notEqual(clickIndex, -1, 'the synthetic click must remain covered');
  assert.ok(armIndex < clickIndex, 'detection must be armed before a synchronous submit can fire');
  assert.ok(awaitIndex > clickIndex, 'the armed detector must be awaited after the click');
});

test('background worker submission does not wait for animation frames', async () => {
  const harness = createPerformClickHarness({ clickable: true });

  const result = await Promise.race([
    harness.performClick(harness.button),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('perform_click_stalled')),
      500
    ))
  ]);

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'synthetic-pointer');
  assert.deepEqual(harness.stats(), {
    animationFrameCalls: 0,
    recordedSubmits: 1,
    requestSubmitCalls: 0
  });
  assert.equal(
    harness.diagnostics.some(({ event, details }) => (
      event === 'submission_strategy_selected' &&
      details.strategy === 'synthetic-pointer'
    )),
    true
  );
});

test('an unusable submit control falls back to form.requestSubmit', async () => {
  const harness = createPerformClickHarness({ clickable: false });

  const result = await harness.performClick(harness.button);

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'request-submit');
  assert.deepEqual(harness.stats(), {
    animationFrameCalls: 0,
    recordedSubmits: 1,
    requestSubmitCalls: 1
  });
  assert.equal(
    harness.diagnostics.some(({ event, details }) => (
      event === 'submit_control_unusable' &&
      details.buttonClickable === false
    )),
    true
  );
  assert.equal(
    harness.diagnostics.some(({ event, details }) => (
      event === 'submission_strategy_selected' &&
      details.strategy === 'request-submit'
    )),
    true
  );
});

test('batch confirmation remains blocked until background history is durable', async () => {
  const {
    isDurableBatchConfirmation
  } = await import('../lib/batch-scheduler.mjs');

  assert.equal(isDurableBatchConfirmation({
    result: 'success',
    historySaveStatus: 'failed'
  }), false);
  assert.equal(isDurableBatchConfirmation({
    result: 'success',
    historySaveStatus: 'saved'
  }), true);
  assert.equal(isDurableBatchConfirmation({
    result: 'success',
    historySaveStatus: 'queued'
  }), true);
});
