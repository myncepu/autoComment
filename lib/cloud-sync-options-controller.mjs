import { parseSyncKey } from './cloud-sync-credentials.mjs';

const ERROR_MESSAGES = Object.freeze({
  INVALID_SYNC_KEY: '同步密钥无效。',
  INVALID_SYNC_KEY_FORMAT: '同步密钥格式无效。',
  CLOUD_SYNC_DISABLED: '云同步尚未启用。',
  VAULT_CONFIRMATION_MISMATCH: '输入的保险库 ID 不匹配。',
  PRIVILEGED_SENDER_REQUIRED: '该操作只能从扩展页面发起。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  SYNC_ACCESS_DENIED: '云同步访问被拒绝。',
  VAULT_DELETED: '云端保险库已不存在。'
});

function defaultFormatTime(value) {
  if (!Number.isFinite(value)) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch {
    return '—';
  }
}

function stableErrorCode(error) {
  return (
    typeof error?.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) ? error.code : 'UNKNOWN_ERROR';
}

export function createCloudSyncOptionsController({
  elements,
  sendMessage,
  clipboard,
  prompt = globalThis.prompt?.bind(globalThis),
  formatTime = defaultFormatTime
}) {
  const buttons = [
    elements.cloudSyncCreateBtn,
    elements.cloudSyncImportBtn,
    elements.cloudSyncCopyBtn,
    elements.cloudSyncRunBtn,
    elements.cloudSyncDisconnectBtn,
    elements.cloudSyncDeleteBtn
  ];
  let currentVaultId = null;
  let inFlight = false;

  function renderError(error) {
    const code = stableErrorCode(error);
    elements.cloudSyncStatus.textContent = ERROR_MESSAGES[code]
      ?? '云同步操作失败，请稍后重试。';
  }

  async function request(message) {
    const response = await sendMessage(message);
    if (!response?.ok) {
      const error = new Error(stableErrorCode(response?.error));
      error.code = stableErrorCode(response?.error);
      throw error;
    }
    return response.data;
  }

  function renderStatus(status = {}) {
    currentVaultId = (
      status.enabled === true
      && typeof status.vaultId === 'string'
      && status.vaultId
    ) ? status.vaultId : null;
    if (!status.enabled || status.state === 'disabled') {
      elements.cloudSyncStatus.textContent = '未启用';
    } else if (status.state === 'blocked') {
      elements.cloudSyncStatus.textContent = currentVaultId
        ? `认证失败（保险库：${currentVaultId}）`
        : '认证失败';
    } else if (status.state === 'failed') {
      elements.cloudSyncStatus.textContent = currentVaultId
        ? `同步失败（保险库：${currentVaultId}）`
        : '同步失败';
    } else {
      elements.cloudSyncStatus.textContent = currentVaultId
        ? `已连接（保险库：${currentVaultId}）`
        : '已连接';
    }
    elements.cloudSyncPendingCount.textContent = Number.isInteger(
      status.pendingCount
    ) ? String(status.pendingCount) : '0';
    elements.cloudSyncDeviceId.textContent = (
      typeof status.deviceId === 'string' && status.deviceId
    ) ? status.deviceId : '—';
    elements.cloudSyncLastSuccess.textContent = Number.isFinite(
      status.lastSuccessfulSyncAt
    ) ? formatTime(status.lastSuccessfulSyncAt) : '—';
  }

  async function refreshStatus() {
    const status = await request({ type: 'CLOUD_SYNC_STATUS' });
    renderStatus(status);
    return status;
  }

  async function perform(operation) {
    if (inFlight) return undefined;
    inFlight = true;
    const priorButtonStates = buttons.map((button) => button.disabled);
    const priorInputState = elements.cloudSyncImportInput.disabled;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    elements.cloudSyncImportInput.disabled = true;
    try {
      return await operation();
    } catch (error) {
      renderError(error);
      return undefined;
    } finally {
      buttons.forEach((button, index) => {
        button.disabled = priorButtonStates[index];
      });
      elements.cloudSyncImportInput.disabled = priorInputState;
      inFlight = false;
    }
  }

  function refresh() {
    return perform(() => refreshStatus());
  }

  function create() {
    return perform(async () => {
      let syncKey;
      try {
        const data = await request({ type: 'CLOUD_SYNC_CREATE' });
        syncKey = data?.syncKey;
        if (typeof syncKey !== 'string') {
          const error = new Error('INVALID_SYNC_RESPONSE');
          error.code = 'INVALID_SYNC_RESPONSE';
          throw error;
        }
        await clipboard.writeText(syncKey);
      } finally {
        syncKey = null;
        elements.cloudSyncImportInput.value = '';
      }
      await refreshStatus();
      elements.cloudSyncStatus.textContent = '已创建并复制同步密钥。';
    });
  }

  function importKey() {
    return perform(async () => {
      let syncKey = elements.cloudSyncImportInput.value.trim();
      try {
        try {
          parseSyncKey(syncKey);
        } catch {
          const error = new Error('INVALID_SYNC_KEY_FORMAT');
          error.code = 'INVALID_SYNC_KEY_FORMAT';
          throw error;
        }
        await request({
          type: 'CLOUD_SYNC_IMPORT',
          syncKey
        });
        await refreshStatus();
        elements.cloudSyncStatus.textContent = '同步密钥已导入。';
      } finally {
        syncKey = null;
        elements.cloudSyncImportInput.value = '';
      }
    });
  }

  function copy() {
    return perform(async () => {
      let syncKey;
      try {
        const data = await request({ type: 'CLOUD_SYNC_SHOW_KEY' });
        syncKey = data?.syncKey;
        if (typeof syncKey !== 'string') {
          const error = new Error('INVALID_SYNC_RESPONSE');
          error.code = 'INVALID_SYNC_RESPONSE';
          throw error;
        }
        await clipboard.writeText(syncKey);
        elements.cloudSyncStatus.textContent = '同步密钥已复制。';
      } finally {
        syncKey = null;
        elements.cloudSyncImportInput.value = '';
      }
    });
  }

  function run() {
    return perform(async () => {
      await request({ type: 'CLOUD_SYNC_RUN' });
      await refreshStatus();
    });
  }

  function disconnect() {
    return perform(async () => {
      await request({ type: 'CLOUD_SYNC_DISCONNECT' });
      await refreshStatus();
    });
  }

  function deleteVault() {
    return perform(async () => {
      if (!currentVaultId) {
        const error = new Error('CLOUD_SYNC_DISABLED');
        error.code = 'CLOUD_SYNC_DISABLED';
        throw error;
      }
      const confirmation = prompt?.(
        `请输入保险库 ID “${currentVaultId}” 以确认永久删除全部云端数据：`
      );
      if (confirmation !== currentVaultId) {
        const error = new Error('VAULT_CONFIRMATION_MISMATCH');
        error.code = 'VAULT_CONFIRMATION_MISMATCH';
        throw error;
      }
      await request({
        type: 'CLOUD_SYNC_DELETE_VAULT',
        confirmation
      });
      await refreshStatus();
    });
  }

  function bind() {
    elements.cloudSyncCreateBtn.addEventListener('click', () => void create());
    elements.cloudSyncImportBtn.addEventListener('click', () => void importKey());
    elements.cloudSyncCopyBtn.addEventListener('click', () => void copy());
    elements.cloudSyncRunBtn.addEventListener('click', () => void run());
    elements.cloudSyncDisconnectBtn.addEventListener('click', () => void disconnect());
    elements.cloudSyncDeleteBtn.addEventListener('click', () => void deleteVault());
  }

  return Object.freeze({
    bind,
    refresh,
    renderStatus,
    create,
    importKey,
    copy,
    run,
    disconnect,
    deleteVault
  });
}
