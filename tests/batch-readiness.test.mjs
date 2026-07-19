import test from 'node:test';
import assert from 'node:assert/strict';
import { getBatchStartError } from '../lib/batch-readiness.mjs';

test('batch readiness accepts any complete OpenRouter model', () => {
  const config = {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    apiKey: 'sk-test'
  };

  assert.equal(getBatchStartError(config, 1), '');
});

test('batch readiness explains missing model config before URL errors', () => {
  assert.equal(
    getBatchStartError({ apiKey: '' }, 0),
    '请先在设置页面中保存完整的模型 API 配置'
  );
});

test('batch readiness rejects an empty URL list', () => {
  const config = {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen-plus',
    apiKey: 'sk-test'
  };

  assert.equal(getBatchStartError(config, 0), '请先上传有效的 CSV 文件');
});
