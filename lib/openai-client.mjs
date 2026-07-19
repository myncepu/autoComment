const STATUS_CODES = new Map([
  [401, ['INVALID_API_KEY', 'API Key 无效。']],
  [402, ['INSUFFICIENT_CREDITS', '模型服务余额不足。']],
  [403, ['FORBIDDEN', '模型服务拒绝了请求。']],
  [408, ['TIMEOUT', '模型请求超时。']],
  [429, ['RATE_LIMITED', '模型请求过于频繁，请稍后重试。']],
  [502, ['PROVIDER_UNAVAILABLE', '模型上游暂时不可用。']],
  [503, ['PROVIDER_UNAVAILABLE', '模型或服务商暂时不可用。']]
]);

export class LlmApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'LlmApiError';
    this.code = code;
    this.status = status;
  }
}

export function getChatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

export function buildChatCompletionBody(model, messages, maxTokens) {
  const body = { model, messages, stream: false };
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  return body;
}

export function extractCompletionText(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmApiError('INVALID_RESPONSE', '模型返回了无效或空的生成结果。');
  }
  return text.trim();
}

function providerMessage(payload) {
  const value = payload?.error?.message;
  return typeof value === 'string' ? value.slice(0, 300) : '';
}

export async function requestChatCompletion({ config, messages, maxTokens, fetchImpl = fetch, timeoutMs = 60000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(getChatCompletionsUrl(config.apiBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(buildChatCompletionBody(config.model, messages, maxTokens)),
      signal: controller.signal
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new LlmApiError('INVALID_RESPONSE', '模型服务返回了无法解析的 JSON。', response.status);
    }
    if (!response.ok) {
      const [code, fallback] = STATUS_CODES.get(response.status) || ['API_ERROR', '模型服务请求失败。'];
      const detail = providerMessage(payload);
      throw new LlmApiError(code, detail ? `${fallback} ${detail}` : fallback, response.status);
    }
    return extractCompletionText(payload);
  } catch (error) {
    if (error?.name === 'AbortError') throw new LlmApiError('TIMEOUT', '模型请求超时。');
    if (error instanceof LlmApiError) throw error;
    throw new LlmApiError('NETWORK_ERROR', '无法连接模型服务。');
  } finally {
    clearTimeout(timer);
  }
}

export function toPublicLlmError(error) {
  const known = error instanceof LlmApiError;
  return {
    code: known ? error.code : 'UNKNOWN_ERROR',
    message: known ? error.message : '模型请求失败，请检查配置后重试。',
    status: known ? error.status : null
  };
}
