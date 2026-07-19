const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('English policy accurately distinguishes static page access and model API data flow', () => {
  assert.match(policy, /Static content scripts match <code>&lt;all_urls&gt;<\/code> and run on matching pages after they load, including tabs opened for batch processing\./);
  assert.match(policy, /OpenRouter has default model API host permission; saving or testing another HTTP\(S\) API Base URL requests optional permission only for that provider host\./);
  assert.match(policy, /The API key is sent as authorization only to your configured provider when you generate text or actively test the connection; only generation sends the limited page context listed above\./);
  assert.doesNotMatch(policy, /<code>activeTab<\/code><\/strong>: Used to access and modify the current active tab's DOM/i);
});

test('Chinese policy accurately distinguishes static page access and model API data flow', () => {
  assert.match(policy, /静态内容脚本通过 <code>&lt;all_urls&gt;<\/code> 在匹配的已加载页面运行，包括用户发起的批量处理标签页。/);
  assert.match(policy, /OpenRouter 默认拥有模型 API 主机权限；保存或测试其他 HTTP\(S\) API Base URL 时，只会为该服务商主机请求可选权限。/);
  assert.match(policy, /API Key 只会在你请求生成文案或主动测试连接时作为授权信息发送给你配置的服务商；只有生成请求会发送上述有限的页面上下文。/);
  assert.doesNotMatch(policy, /仅在当前激活标签页上工作/);
});
