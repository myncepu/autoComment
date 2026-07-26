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
  const handlerStart = background.indexOf(
    "if (message && message.type === 'BATCH_HANDLE_CONFIRM')"
  );
  const handlerEnd = background.indexOf(
    '// content.js 已把精确历史写入不可变 pending 队列',
    handlerStart
  );
  const handler = background.slice(handlerStart, handlerEnd);
  const broadcastIndex = handler.indexOf('broadcastBatchConfirmed(message');
  const hookIndex = handler.indexOf('async terminalSideEffect()', broadcastIndex);
  const durabilityIndex = handler.indexOf(
    'isDurableBatchConfirmation(confirmedMessage)',
    hookIndex
  );
  const releaseIndex = handler.indexOf(
    'batchSubmitContextStore.clearIfMatches(',
    durabilityIndex
  );

  assert.notEqual(broadcastIndex, -1, 'confirmation must use the runtime controller');
  assert.notEqual(hookIndex, -1, 'durable work must run as a serialized terminal hook');
  assert.ok(
    durabilityIndex > hookIndex,
    'the terminal hook must reject a failed history save'
  );
  assert.ok(
    releaseIndex > durabilityIndex,
    'submit ownership must remain restorable until history is durable'
  );
});
