import { handleLlmMessage, isAllowedLlmSender, LLM_MESSAGE_TYPES } from './llm-service.mjs';

const LLM_MESSAGE_TYPE_SET = new Set(Object.values(LLM_MESSAGE_TYPES));

export function installLlmMessageListener(chromeApi, { handleMessage = handleLlmMessage } = {}) {
  const listener = (message, sender, sendResponse) => {
    if (!LLM_MESSAGE_TYPE_SET.has(message?.type)) return false;
    if (!isAllowedLlmSender(sender, chromeApi.runtime.id)) {
      sendResponse({ success: false, error: { code: 'FORBIDDEN_SENDER', message: '拒绝外部模型请求。' } });
      return false;
    }
    handleMessage(message, { storage: chromeApi.storage })
      .then(sendResponse)
      .catch(() => sendResponse({ success: false, error: { code: 'UNKNOWN_ERROR', message: '模型请求失败。' } }));
    return true;
  };

  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
