import { loadLlmConfig, validateLlmConfig } from './llm-config.mjs';
import { LlmApiError, requestChatCompletion, toPublicLlmError } from './openai-client.mjs';

export const LLM_MESSAGE_TYPES = Object.freeze({
  test: 'LLM_TEST_CONNECTION',
  generate: 'LLM_GENERATE_COPY'
});

export function isAllowedLlmSender(sender, extensionId) {
  return Boolean(sender && sender.id && sender.id === extensionId);
}

export async function handleLlmMessage(message, { storage, fetchImpl = fetch }) {
  try {
    const config = await loadLlmConfig(storage);
    const validation = validateLlmConfig(config);
    if (!validation.valid) throw new LlmApiError(validation.code, validation.message);

    if (message?.type === LLM_MESSAGE_TYPES.test) {
      const text = await requestChatCompletion({
        config,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 16,
        fetchImpl
      });
      return { success: true, text };
    }

    if (message?.type !== LLM_MESSAGE_TYPES.generate) {
      throw new LlmApiError('INVALID_REQUEST', '未知的模型请求类型。');
    }

    const systemPrompt = typeof message.payload?.systemPrompt === 'string' ? message.payload.systemPrompt.trim() : '';
    const userPrompt = typeof message.payload?.userPrompt === 'string' ? message.payload.userPrompt.trim() : '';
    if (!systemPrompt || !userPrompt || systemPrompt.length > 12000 || userPrompt.length > 24000) {
      throw new LlmApiError('INVALID_REQUEST', '模型提示词为空或超出长度限制。');
    }

    const text = await requestChatCompletion({
      config,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      fetchImpl
    });
    return { success: true, text };
  } catch (error) {
    return { success: false, error: toPublicLlmError(error) };
  }
}
