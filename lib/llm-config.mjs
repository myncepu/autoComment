export const DEFAULT_LLM_CONFIG = Object.freeze({
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen-plus',
  apiKey: ''
});

export const LLM_SYNC_KEYS = Object.freeze({
  apiBaseUrl: 'llm_api_base_url',
  model: 'llm_model'
});

export const LLM_LOCAL_KEYS = Object.freeze({ apiKey: 'llm_api_key' });

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeLlmConfig(values = {}) {
  return {
    apiBaseUrl: (clean(values.apiBaseUrl) || DEFAULT_LLM_CONFIG.apiBaseUrl).replace(/\/+$/, ''),
    model: clean(values.model) || DEFAULT_LLM_CONFIG.model,
    apiKey: clean(values.apiKey)
  };
}

export function validateLlmConfig(values) {
  const config = normalizeLlmConfig(values);
  let url;
  try {
    url = new URL(config.apiBaseUrl);
  } catch {
    return { valid: false, code: 'INVALID_API_URL', message: 'API Base URL 格式无效。' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, code: 'INVALID_API_URL', message: 'API Base URL 仅支持 HTTP 或 HTTPS。' };
  }
  if (!config.model) return { valid: false, code: 'MISSING_MODEL', message: '请填写模型 ID。' };
  if (!config.apiKey) return { valid: false, code: 'MISSING_API_KEY', message: '请填写 API Key。' };
  return { valid: true, config };
}

export function getHostPermissionPattern(baseUrl) {
  const url = new URL(normalizeLlmConfig({ apiBaseUrl: baseUrl }).apiBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVALID_API_URL');
  return `${url.protocol}//${url.hostname}/*`;
}

export async function loadLlmConfig(storage) {
  const [syncValues, localValues] = await Promise.all([
    storage.sync.get(Object.values(LLM_SYNC_KEYS)),
    storage.local.get(Object.values(LLM_LOCAL_KEYS))
  ]);
  return normalizeLlmConfig({
    apiBaseUrl: syncValues[LLM_SYNC_KEYS.apiBaseUrl],
    model: syncValues[LLM_SYNC_KEYS.model],
    apiKey: localValues[LLM_LOCAL_KEYS.apiKey]
  });
}

export async function saveLlmConfig(storage, values) {
  const validation = validateLlmConfig(values);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = validation.code;
    throw error;
  }
  const config = validation.config;
  await Promise.all([
    storage.sync.set({
      [LLM_SYNC_KEYS.apiBaseUrl]: config.apiBaseUrl,
      [LLM_SYNC_KEYS.model]: config.model
    }),
    storage.local.set({ [LLM_LOCAL_KEYS.apiKey]: config.apiKey })
  ]);
  return config;
}

export function toExportableLlmSettings(values) {
  const config = normalizeLlmConfig(values);
  return {
    [LLM_SYNC_KEYS.apiBaseUrl]: config.apiBaseUrl,
    [LLM_SYNC_KEYS.model]: config.model
  };
}
