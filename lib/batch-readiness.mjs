import { validateLlmConfig } from './llm-config.mjs';

export function getBatchStartError(config, urlCount) {
  if (!validateLlmConfig(config).valid) {
    return '请先在设置页面中保存完整的模型 API 配置';
  }
  if (!Number.isInteger(urlCount) || urlCount <= 0) {
    return '请先上传有效的 CSV 文件';
  }
  return '';
}
