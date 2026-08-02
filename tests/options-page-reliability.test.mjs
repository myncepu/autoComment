import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  bindSafeTabNavigation,
  bindStoredBooleanToggle,
  installOptionsPageBoot,
  optionsErrorMessage,
  stableOptionsErrorCode
} from '../lib/options-page-reliability.mjs';

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('options boot contains rejection, disables writes, and succeeds from an in-page retry', async () => {
  const document = new JSDOM(`
    <span id="settingsStatus" role="status" aria-live="polite">设置加载中…</span>
    <button id="retryOptionsLoadBtn" type="button" hidden>重试加载</button>
    <button id="saveProfileBtn">保存</button>
    <button id="openHistoryBtn">历史</button>
  `).window.document;
  const errors = [];
  let attempts = 0;
  installOptionsPageBoot({
    document,
    boot: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('secret repository diagnostics');
      }
    },
    writableControlIds: ['saveProfileBtn'],
    reportError: (error) => errors.push(error)
  });

  document.dispatchEvent(new document.defaultView.Event('DOMContentLoaded'));
  await nextTurn();

  assert.equal(document.getElementById('saveProfileBtn').disabled, true);
  assert.equal(document.getElementById('openHistoryBtn').disabled, false);
  assert.match(document.getElementById('settingsStatus').textContent, /加载失败/);
  assert.equal(document.getElementById('retryOptionsLoadBtn').hidden, false);
  assert.doesNotMatch(
    document.getElementById('settingsStatus').textContent,
    /secret|repository|diagnostics/
  );
  assert.deepEqual(errors, ['options_boot_failed']);

  document.getElementById('retryOptionsLoadBtn').click();
  await nextTurn();

  assert.equal(attempts, 2);
  assert.equal(document.getElementById('saveProfileBtn').disabled, false);
  assert.equal(document.getElementById('retryOptionsLoadBtn').hidden, true);
  assert.match(document.getElementById('settingsStatus').textContent, /已加载/);
});

test('stable domain and config failures have Chinese user messages while diagnostics keep only codes', () => {
  const domainError = new Error('profile_in_use');
  domainError.code = 'profile_in_use';
  assert.match(optionsErrorMessage(domainError), /身份.*使用/);
  assert.doesNotMatch(optionsErrorMessage(domainError), /profile_in_use/);
  assert.equal(stableOptionsErrorCode(domainError), 'profile_in_use');

  const applyError = new Error('internal rollback details');
  applyError.code = 'config_bundle_apply_failed';
  assert.match(optionsErrorMessage(applyError), /配置.*应用失败/);
  assert.doesNotMatch(
    optionsErrorMessage(applyError),
    /config_bundle_apply_failed|rollback details/
  );

  const unknown = new Error('api_key=sk-unknown-secret');
  assert.equal(
    stableOptionsErrorCode(unknown, 'domain_config_command_failed'),
    'domain_config_command_failed'
  );
  assert.doesNotMatch(
    optionsErrorMessage(unknown, '保存失败，请稍后重试。'),
    /api_key|sk-unknown-secret/
  );

  const secretLikeCode = new Error('hidden');
  secretLikeCode.code = 'sk-secret-shaped-like-a-code';
  assert.equal(
    stableOptionsErrorCode(secretLikeCode, 'domain_config_command_failed'),
    'domain_config_command_failed'
  );
});

test('tab navigation contains rejected promises, reports a safe code, and remains retryable', async () => {
  const document = new JSDOM(`
    <button id="open">打开历史</button>
    <span id="status" role="status" aria-live="polite"></span>
  `).window.document;
  const button = document.getElementById('open');
  const status = document.getElementById('status');
  const diagnostics = [];
  let attempts = 0;
  bindSafeTabNavigation({
    button,
    open: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Chrome tab failure with sk-navigation-secret');
      }
    },
    onError: () => {
      status.textContent = '评论历史页面打开失败，请稍后重试。';
    },
    reportError: (code) => diagnostics.push(code)
  });

  button.click();
  await nextTurn();

  assert.equal(button.disabled, false);
  assert.match(status.textContent, /打开失败.*重试/);
  assert.doesNotMatch(status.textContent, /Chrome|secret/);
  assert.deepEqual(diagnostics, ['options_tab_navigation_failed']);

  button.click();
  await nextTurn();
  assert.equal(attempts, 2);
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
