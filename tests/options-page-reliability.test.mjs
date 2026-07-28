import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  bindStoredBooleanToggle,
  installOptionsPageBoot
} from '../lib/options-page-reliability.mjs';

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('options boot contains rejection, reports load failure, and disables writes', async () => {
  const document = new JSDOM(`
    <span id="settingsStatus">设置加载中…</span>
    <button id="saveProfileBtn">保存</button>
    <button id="openHistoryBtn">历史</button>
  `).window.document;
  const errors = [];
  installOptionsPageBoot({
    document,
    boot: async () => {
      throw new Error('secret repository diagnostics');
    },
    writableControlIds: ['saveProfileBtn'],
    reportError: (error) => errors.push(error)
  });

  document.dispatchEvent(new document.defaultView.Event('DOMContentLoaded'));
  await nextTurn();

  assert.equal(document.getElementById('saveProfileBtn').disabled, true);
  assert.equal(document.getElementById('openHistoryBtn').disabled, false);
  assert.match(document.getElementById('settingsStatus').textContent, /加载失败/);
  assert.doesNotMatch(
    document.getElementById('settingsStatus').textContent,
    /secret|repository|diagnostics/
  );
  assert.equal(errors.length, 1);
});

test('stored boolean toggle commits only successful writes and remains retryable', async () => {
  const document = new JSDOM('<button id="toggle">加载中…</button>')
    .window.document;
  const button = document.getElementById('toggle');
  const writes = [];
  const rendered = [];
  const failures = [];
  let attempt = 0;
  const controller = bindStoredBooleanToggle({
    button,
    initialValue: true,
    write: async (value) => {
      writes.push(value);
      attempt += 1;
      if (attempt === 1) throw new Error('storage backend details');
    },
    render: (value) => {
      rendered.push(value);
      button.textContent = value ? '隐藏' : '显示';
    },
    onError: (error) => failures.push(error)
  });

  button.click();
  await nextTurn();
  assert.equal(controller.value, true);
  assert.equal(button.textContent, '隐藏');
  assert.equal(button.disabled, false);
  assert.equal(failures.length, 1);

  button.click();
  await nextTurn();
  assert.equal(controller.value, false);
  assert.equal(button.textContent, '显示');
  assert.equal(button.disabled, false);
  assert.deepEqual(writes, [false, false]);
  assert.deepEqual(rendered, [true, false]);
});
