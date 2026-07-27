import { getHostPermissionPattern, saveLlmConfig } from './llm-config.mjs';

function permissionUnavailable() {
  const error = new Error('模型 API 权限服务不可用。');
  error.code = 'PERMISSION_UNAVAILABLE';
  return error;
}

export async function ensureLlmApiPermission(permissions, apiBaseUrl) {
  if (typeof permissions?.contains !== 'function'
      || typeof permissions?.request !== 'function') {
    throw permissionUnavailable();
  }
  const origins = [getHostPermissionPattern(apiBaseUrl)];
  let alreadyGranted;
  try {
    alreadyGranted = await permissions.contains({ origins });
  } catch {
    throw permissionUnavailable();
  }
  if (alreadyGranted) return;
  let granted;
  try {
    granted = await permissions.request({ origins });
  } catch {
    throw permissionUnavailable();
  }
  if (!granted) {
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
  await ensureLlmApiPermission(permissions, values.apiBaseUrl);
  return saveLlmConfig(storage, values);
}

export async function testOptionsModelConfig(dependencies, values) {
  const savedConfig = await saveOptionsModelConfig(dependencies, values);
  let response;
  try {
    response = await dependencies.runtime.sendMessage({ type: 'LLM_TEST_CONNECTION' });
  } catch (cause) {
    const error = new Error(getSafeErrorMessage(cause?.message, savedConfig.apiKey));
    error.code = 'UNKNOWN_ERROR';
    throw error;
  }
  if (!response?.success) {
    const error = new Error(getSafeErrorMessage(response?.error?.message, savedConfig.apiKey));
    error.code = response?.error?.code || 'UNKNOWN_ERROR';
    throw error;
  }
  return String(response.text || '').trim();
}
