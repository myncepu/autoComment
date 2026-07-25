const MESSAGE_ROUTES = Object.freeze({
  CLOUD_SYNC_STATUS: (message, service) => service.getStatus(),
  CLOUD_SYNC_CREATE: (message, service) => connectAndAdvanceInitialHistory(
    () => service.createVault(),
    service
  ),
  CLOUD_SYNC_IMPORT: (message, service) => connectAndAdvanceInitialHistory(
    () => service.importKey(message.syncKey),
    service
  ),
  CLOUD_SYNC_RUN: (message, service) => service.runOnce('manual'),
  CLOUD_SYNC_SHOW_KEY: (message, service) => service.getCredentialsForDisplay(),
  CLOUD_SYNC_DISCONNECT: (message, service) => service.disconnect(),
  CLOUD_SYNC_DELETE_VAULT: (message, service) => (
    service.deleteVault(message.confirmation)
  ),
  CLOUD_HISTORY_LIST: (message, service) => (
    service.listCloudHistory(message.query)
  ),
  CLOUD_HISTORY_DELETE: (message, service) => (
    service.deleteCloudHistory(message.recordId)
  )
});
const CLOUD_SYNC_MESSAGE_TYPES = new Set(Object.keys(MESSAGE_ROUTES));

async function connectAndAdvanceInitialHistory(connect, service) {
  const result = await connect();
  if (
    result?.connected === true
    && typeof service.enqueueInitialHistory === 'function'
  ) {
    await service.enqueueInitialHistory();
  }
  return result;
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  INVALID_SYNC_KEY: '同步密钥无效。',
  CLOUD_SYNC_DISABLED: '云同步尚未启用。',
  VAULT_CONFIRMATION_MISMATCH: '云端保险库确认内容不匹配。',
  INVALID_RECORD_ID: '云端历史记录无效。',
  RATE_LIMITED: '云同步请求过于频繁，请稍后重试。',
  SYNC_ACCESS_DENIED: '云同步访问被拒绝。',
  VAULT_DELETED: '云端保险库已不存在。'
});

function privilegedSenderError() {
  return {
    ok: false,
    error: {
      code: 'PRIVILEGED_SENDER_REQUIRED',
      message: '该操作只能从扩展页面发起。',
      retryable: false
    }
  };
}

function publicSyncError(error) {
  const code = (
    typeof error?.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) ? error.code : 'CLOUD_SYNC_REQUEST_FAILED';
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code] ?? '云同步操作失败，请稍后重试。',
    retryable: typeof error?.retryable === 'boolean'
      ? error.retryable
      : true
  };
}

function isPrivilegedSender(chromeApi, sender) {
  if (
    sender?.id !== chromeApi.runtime.id
    || typeof sender?.url !== 'string'
  ) {
    return false;
  }
  try {
    const extensionUrl = new URL(chromeApi.runtime.getURL(''));
    const senderUrl = new URL(sender.url);
    return senderUrl.origin === extensionUrl.origin
      && senderUrl.protocol === extensionUrl.protocol
      && senderUrl.hostname === extensionUrl.hostname
      && senderUrl.username === ''
      && senderUrl.password === '';
  } catch {
    return false;
  }
}

export function installCloudSyncMessageListener(chromeApi, service) {
  const listener = (message, sender, sendResponse) => {
    const type = message?.type;
    if (
      typeof type !== 'string'
      || !CLOUD_SYNC_MESSAGE_TYPES.has(type)
      || !Object.hasOwn(MESSAGE_ROUTES, type)
    ) {
      return false;
    }
    const route = MESSAGE_ROUTES[type];

    if (!isPrivilegedSender(chromeApi, sender)) {
      sendResponse(privilegedSenderError());
      return false;
    }

    Promise.resolve()
      .then(() => route(message, service))
      .then(
        (data) => sendResponse({ ok: true, data }),
        (error) => sendResponse({
          ok: false,
          error: publicSyncError(error)
        })
      );
    return true;
  };

  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
