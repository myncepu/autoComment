import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloudSyncOptionsController
} from '../lib/cloud-sync-options-controller.mjs';

const VALID_SYNC_KEY =
  'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createButton() {
  const listeners = new Map();
  return {
    disabled: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      return listeners.get('click')?.({
        preventDefault() {}
      });
    }
  };
}

function createElements() {
  return {
    cloudSyncCreateBtn: createButton(),
    cloudSyncImportInput: {
      value: '',
      disabled: false,
      addEventListener() {}
    },
    cloudSyncImportBtn: createButton(),
    cloudSyncCopyBtn: createButton(),
    cloudSyncRunBtn: createButton(),
    cloudSyncDisconnectBtn: createButton(),
    cloudSyncDeleteBtn: createButton(),
    cloudSyncStatus: { textContent: '' },
    cloudSyncLastSuccess: { textContent: '' },
    cloudSyncPendingCount: { textContent: '' },
    cloudSyncDeviceId: { textContent: '' }
  };
}

function success(data) {
  return { ok: true, data };
}

function allButtons(elements) {
  return [
    elements.cloudSyncCreateBtn,
    elements.cloudSyncImportBtn,
    elements.cloudSyncCopyBtn,
    elements.cloudSyncRunBtn,
    elements.cloudSyncDisconnectBtn,
    elements.cloudSyncDeleteBtn
  ];
}

test('refresh renders status metadata without rendering a sync key', async () => {
  const elements = createElements();
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      assert.deepEqual(message, { type: 'CLOUD_SYNC_STATUS' });
      return success({
        enabled: true,
        state: 'idle',
        vaultId: 'vault-visible',
        deviceId: 'device-a',
        pendingCount: 2,
        lastSuccessfulSyncAt: 1721000000000,
        syncKey: 'acsync_must-not-render'
      });
    },
    formatTime: () => '2024-07-15 12:00',
    clipboard: { writeText: async () => undefined }
  });

  await controller.refresh();

  assert.equal(elements.cloudSyncStatus.textContent, '已连接（保险库：vault-visible）');
  assert.equal(elements.cloudSyncPendingCount.textContent, '2');
  assert.equal(elements.cloudSyncDeviceId.textContent, 'device-a');
  assert.equal(elements.cloudSyncLastSuccess.textContent, '2024-07-15 12:00');
  assert.equal(
    Object.values(elements).some(
      (element) => element.textContent?.includes('acsync_must-not-render')
    ),
    false
  );
});

test('create copies its returned key only inside the explicit action and restores controls', async () => {
  const elements = createElements();
  const copyGate = deferred();
  const copied = [];
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      if (message.type === 'CLOUD_SYNC_CREATE') {
        return success({
          connected: true,
          syncKey: VALID_SYNC_KEY,
          vaultId: 'vault-created'
        });
      }
      if (message.type === 'CLOUD_SYNC_STATUS') {
        return success({
          enabled: true,
          state: 'idle',
          vaultId: 'vault-created',
          deviceId: 'device-created',
          pendingCount: 0,
          lastSuccessfulSyncAt: null
        });
      }
      throw new Error(`unexpected:${message.type}`);
    },
    clipboard: {
      async writeText(value) {
        copied.push(value);
        return copyGate.promise;
      }
    }
  });

  const operation = controller.create();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(copied, [VALID_SYNC_KEY]);
  assert.equal(allButtons(elements).every((button) => button.disabled), true);
  assert.equal(elements.cloudSyncImportInput.disabled, true);
  assert.equal(elements.cloudSyncStatus.textContent.includes(VALID_SYNC_KEY), false);

  copyGate.resolve();
  await operation;

  assert.equal(allButtons(elements).every((button) => !button.disabled), true);
  assert.equal(elements.cloudSyncImportInput.disabled, false);
  assert.equal(elements.cloudSyncImportInput.value, '');
  assert.equal(elements.cloudSyncStatus.textContent, '已创建并复制同步密钥。');
});

test('invalid import is rejected locally with a safe Chinese error', async () => {
  const elements = createElements();
  const sent = [];
  elements.cloudSyncImportInput.value = 'not-a-sync-key';
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      sent.push(message);
      return success({});
    },
    clipboard: { writeText: async () => undefined }
  });

  await controller.importKey();

  assert.deepEqual(sent, []);
  assert.equal(elements.cloudSyncStatus.textContent, '同步密钥格式无效。');
  assert.equal(elements.cloudSyncImportInput.value, '');
  assert.equal(allButtons(elements).every((button) => !button.disabled), true);
});

test('import sends only the explicit key then clears the password input', async () => {
  const elements = createElements();
  const sent = [];
  elements.cloudSyncImportInput.value = `  ${VALID_SYNC_KEY}  `;
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      sent.push(structuredClone(message));
      if (message.type === 'CLOUD_SYNC_IMPORT') {
        return success({ connected: true, vaultId: 'vault-imported' });
      }
      return success({
        enabled: true,
        state: 'idle',
        vaultId: 'vault-imported',
        deviceId: 'device-imported',
        pendingCount: 0,
        lastSuccessfulSyncAt: null
      });
    },
    clipboard: { writeText: async () => undefined }
  });

  await controller.importKey();

  assert.deepEqual(sent[0], {
    type: 'CLOUD_SYNC_IMPORT',
    syncKey: VALID_SYNC_KEY
  });
  assert.equal(elements.cloudSyncImportInput.value, '');
  assert.equal(elements.cloudSyncStatus.textContent, '同步密钥已导入。');
});

test('copy requests the secret only on click and clears returned/input references', async () => {
  const elements = createElements();
  const sent = [];
  const copied = [];
  elements.cloudSyncImportInput.value = 'stale-value';
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      sent.push(message);
      return success({ syncKey: VALID_SYNC_KEY });
    },
    clipboard: {
      async writeText(value) {
        copied.push(value);
      }
    }
  });

  assert.deepEqual(sent, []);
  await controller.copy();

  assert.deepEqual(sent, [{ type: 'CLOUD_SYNC_SHOW_KEY' }]);
  assert.deepEqual(copied, [VALID_SYNC_KEY]);
  assert.equal(elements.cloudSyncImportInput.value, '');
  assert.equal(elements.cloudSyncStatus.textContent, '同步密钥已复制。');
});

test('run and disconnect use fixed messages and refresh status', async () => {
  const elements = createElements();
  const sent = [];
  let enabled = true;
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      sent.push(message);
      if (message.type === 'CLOUD_SYNC_RUN') return success({ pulled: 0 });
      if (message.type === 'CLOUD_SYNC_DISCONNECT') {
        enabled = false;
        return success({ disconnected: true });
      }
      return success({
        enabled,
        state: enabled ? 'idle' : 'disabled',
        vaultId: enabled ? 'vault-a' : undefined,
        deviceId: enabled ? 'device-a' : undefined,
        pendingCount: 0,
        lastSuccessfulSyncAt: null
      });
    },
    clipboard: { writeText: async () => undefined }
  });

  await controller.run();
  await controller.disconnect();

  assert.deepEqual(sent.map(({ type }) => type), [
    'CLOUD_SYNC_RUN',
    'CLOUD_SYNC_STATUS',
    'CLOUD_SYNC_DISCONNECT',
    'CLOUD_SYNC_STATUS'
  ]);
  assert.equal(elements.cloudSyncStatus.textContent, '未启用');
});

test('vault deletion requires typing the exact visible vault ID', async () => {
  const elements = createElements();
  const sent = [];
  const prompts = ['wrong-vault', 'vault-visible'];
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage(message) {
      sent.push(message);
      if (message.type === 'CLOUD_SYNC_DELETE_VAULT') {
        return success({ deleted: true });
      }
      return success({
        enabled: false,
        state: 'disabled',
        pendingCount: 0,
        lastSuccessfulSyncAt: null
      });
    },
    prompt(message) {
      assert.equal(message.includes('vault-visible'), true);
      return prompts.shift();
    },
    clipboard: { writeText: async () => undefined }
  });
  controller.renderStatus({
    enabled: true,
    state: 'idle',
    vaultId: 'vault-visible',
    deviceId: 'device-a',
    pendingCount: 0,
    lastSuccessfulSyncAt: null
  });

  await controller.deleteVault();
  assert.deepEqual(sent, []);
  assert.equal(elements.cloudSyncStatus.textContent, '输入的保险库 ID 不匹配。');

  await controller.deleteVault();
  assert.deepEqual(sent[0], {
    type: 'CLOUD_SYNC_DELETE_VAULT',
    confirmation: 'vault-visible'
  });
});

test('failed responses and thrown diagnostics render only stable Chinese errors', async () => {
  const elements = createElements();
  const responses = [
    {
      ok: false,
      error: {
        code: 'INVALID_SYNC_KEY',
        message: `server echoed ${VALID_SYNC_KEY}`,
        stack: `stack ${VALID_SYNC_KEY}`
      }
    },
    new Error(`network ${VALID_SYNC_KEY}`)
  ];
  const controller = createCloudSyncOptionsController({
    elements,
    async sendMessage() {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    clipboard: { writeText: async () => undefined }
  });
  elements.cloudSyncImportInput.value = VALID_SYNC_KEY;

  await controller.importKey();
  assert.equal(elements.cloudSyncStatus.textContent, '同步密钥无效。');
  elements.cloudSyncImportInput.value = VALID_SYNC_KEY;
  await controller.importKey();
  assert.equal(elements.cloudSyncStatus.textContent, '云同步操作失败，请稍后重试。');
  assert.equal(
    elements.cloudSyncStatus.textContent.includes(VALID_SYNC_KEY),
    false
  );
  assert.equal(allButtons(elements).every((button) => !button.disabled), true);
});
