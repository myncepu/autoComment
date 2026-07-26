const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('batch submission arms result detection before dispatching the synchronous click', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');
  const performClickStart = content.indexOf('async function performClick(button)');
  const performClickEnd = content.indexOf('\n  // ============================================================', performClickStart);
  const performClick = content.slice(performClickStart, performClickEnd);

  const armIndex = performClick.indexOf('const submitDetection = waitForSubmitOrNavigate(10000);');
  const clickIndex = performClick.indexOf("button.dispatchEvent(new MouseEvent('click'");
  const awaitIndex = performClick.indexOf('await submitDetection');

  assert.notEqual(armIndex, -1, 'submission result detection must be armed');
  assert.notEqual(clickIndex, -1, 'the synthetic click must remain covered');
  assert.ok(armIndex < clickIndex, 'detection must be armed before a synchronous submit can fire');
  assert.ok(awaitIndex > clickIndex, 'the armed detector must be awaited after the click');
});

test('batch confirmation remains blocked until background history is durable', async () => {
  const {
    isDurableBatchConfirmation
  } = await import('../lib/batch-scheduler.mjs');
  const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

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
  assert.match(
    background,
    /createBatchSubmitContextStore\([\s\S]*maxAgeMs:\s*Number\.POSITIVE_INFINITY/,
    'exact pre-submit history must remain restorable until durable acknowledgement'
  );
  assert.match(
    background,
    /if \(isDurableBatchConfirmation\(confirmedMessage\)\) \{[\s\S]*broadcastBatchConfirmed/,
    'background must not release a success window on a failed history save'
  );
});
