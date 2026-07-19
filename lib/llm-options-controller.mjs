import { getHostPermissionPattern, saveLlmConfig } from './llm-config.mjs';

async function ensurePermission(permissions, apiBaseUrl) {
  const origins = [getHostPermissionPattern(apiBaseUrl)];
  if (await permissions.contains({ origins })) return;
  if (!await permissions.request({ origins })) {
    const error = new Error('未授予模型 API 域名访问权限。');
    error.code = 'PERMISSION_DENIED';
    throw error;
  }
}

function getSafeErrorMessage(message, apiKey) {
  const safeMessage = String(message || '连接测试失败。');
  if (!apiKey || !safeMessage.includes(apiKey)) return safeMessage;
  return safeMessage.replaceAll(apiKey, '[redacted]');
}

export async function saveOptionsModelConfig({ storage, permissions }, values) {
  await ensurePermission(permissions, values.apiBaseUrl);
  return saveLlmConfig(storage, values);
}

export async function testOptionsModelConfig(dependencies, values) {
  await saveOptionsModelConfig(dependencies, values);
  let response;
  try {
    response = await dependencies.runtime.sendMessage({ type: 'LLM_TEST_CONNECTION' });
  } catch (cause) {
    const error = new Error(getSafeErrorMessage(cause?.message, values.apiKey));
    error.code = 'UNKNOWN_ERROR';
    throw error;
  }
  if (!response?.success) {
    const error = new Error(getSafeErrorMessage(response?.error?.message, values.apiKey));
    error.code = response?.error?.code || 'UNKNOWN_ERROR';
    throw error;
  }
  return String(response.text || '').trim();
}
