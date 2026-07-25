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

test('batch confirmation stores and renders the background history save status', () => {
  const batch = fs.readFileSync(path.resolve(__dirname, '..', 'batch.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'batch.html'), 'utf8');
  const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

  assert.match(
    batch,
    /handleTaskConfirmed\([\s\S]*message\.historySaveStatus,\s*message\.historyPendingCount\s*\)/
  );
  assert.match(
    batch,
    /async function handleTaskConfirmed\([\s\S]*historySaveStatus,\s*confirmedHistoryPendingCount\s*\)/
  );
  assert.match(batch, /historySaveStatus:\s*historySaveStatus\s*\|\|\s*null/);
  assert.match(batch, /type:\s*'HISTORY_RETRY_PENDING'/);
  assert.match(batch, /historyPendingCount\s*=\s*response\.data\.pending/);
  assert.match(
    batch,
    /else if \(value === null \|\| saveStatus === 'queued'\) \{\s*historyPendingCount = null;/
  );
  assert.match(batch, /historyPendingCountUnavailable = true;/);
  assert.match(
    batch,
    /updateHistoryPendingCount\(confirmedHistoryPendingCount,\s*historySaveStatus\)/
  );
  assert.match(batch, /saved:\s*'历史已保存'/);
  assert.match(batch, /queued:\s*'历史待重试'/);
  assert.match(batch, /failed:\s*'历史保存失败'/);
  assert.match(batch, /historyPendingCount\s*>\s*0/);

  assert.match(html, /id="historySaveWarning"/);
  assert.match(html, /<th>历史保存<\/th>/);
  assert.match(
    background,
    /createBatchSubmitContextStore\([\s\S]*maxAgeMs:\s*Number\.POSITIVE_INFINITY/,
    'exact pre-submit history must remain restorable until durable acknowledgement'
  );
});
