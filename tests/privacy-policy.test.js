const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const policyText = policy.replace(/\s+/g, ' ');
const workerReadme = fs.readFileSync(
  path.join(__dirname, '..', 'cloudflare-sync', 'README.md'),
  'utf8'
);

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

test('English policy discloses opt-in Cloudflare synchronization', () => {
  assert.match(policy, /Last updated: <span id="last-updated">2026-07-25<\/span>/);
  assert.match(policyText, /optional cloud synchronization/i);
  assert.match(policyText, /Cloudflare Worker for storage in Cloudflare D1/);
  assert.match(policyText, /successful-comment history and only the following allowlisted, non-sensitive settings/);
  assert.match(policyText, /promotion URL and content, auto-fill name and email, AI API Base URL and model ID, whether to show the outbound-link export control, batch checkbox settings, batch concurrency, batch timeout, and the public comment user ID/);
  assert.match(policyText, /It preserves the exact submitted comment HTML \(the editor value\), plus a whitespace-normalized plain-text representation derived from that HTML, target page URL and domain, promoted website URL and domain, submission time and status, batch\/task identifiers, source, and each anchor's whitespace-normalized text and raw\/resolved URL\./);
  assert.doesNotMatch(policy, /exact submitted comment body \(HTML and text\)/);
  assert.match(policyText, /This history does not separately capture names, email addresses, passwords, API keys, or other form credentials\./);
  assert.match(policyText, /sync key/i);
  assert.match(policyText, /Anyone you share the sync key with can access, change, and delete the synchronized vault/);
  assert.match(policyText, /If you lose the sync key, it cannot be recovered and the vault cannot be reconnected/);
  assert.match(policyText, /Cloud history is retained until you permanently delete individual records from all devices or delete the cloud vault/);
  assert.match(policyText, /90-day local cache/i);
  assert.match(policyText, /only after the cloud has confirmed the exact synchronized revision/);
  assert.match(policyText, /AI API key.*not uploaded/i);
  assert.match(policyText, /password.*not uploaded/i);
  assert.match(policyText, /Uninstalling.*does not delete.*cloud vault/i);
  assert.match(policyText, /<code>unlimitedStorage<\/code>.*prevents the normal extension storage quota from blocking local comment history/);
  assert.match(policyText, /<code>alarms<\/code>.*schedules cloud synchronization, local retention checks, and history reminders/);
  assert.doesNotMatch(policy, /<code>alarms<\/code>.*queued-write retries/);
  assert.match(policy, /<code>notifications<\/code>.*shows local reminders when history approaches or passes the 90-day cleanup threshold/);
});

test('Chinese policy discloses opt-in Cloudflare synchronization', () => {
  assert.match(policyText, /可选的云同步/);
  assert.match(policyText, /Cloudflare Worker.*Cloudflare D1/);
  assert.match(policyText, /成功评论历史以及以下白名单内的非敏感设置/);
  assert.match(policyText, /推广 URL 与文案、自动填表的姓名与邮箱、AI API Base URL 与模型 ID、是否显示外链导出控件、批处理复选框设置、批处理并发数、批处理超时时间，以及公开的评论用户 ID/);
  assert.match(policyText, /它会精确保留实际提交的评论 HTML（即编辑器值），并保存从该 HTML 派生且经过空白规范化的纯文本表示、目标页面 URL 和域名、推广网站 URL 和域名、提交时间与状态、批次\/任务标识、来源，以及每个链接经空白规范化的锚文本和原始\/解析后 URL。/);
  assert.doesNotMatch(policy, /实际提交的评论正文（HTML 和文本）/);
  assert.match(policyText, /该历史不会另行收集姓名、邮箱地址、密码、API Key 或其他表单凭据。/);
  assert.match(policyText, /同步密钥/);
  assert.match(policyText, /任何获得同步密钥的人都能访问、修改和删除该同步仓库中的数据/);
  assert.match(policyText, /同步密钥丢失后无法恢复，也无法重新连接该云端仓库/);
  assert.match(policyText, /从所有设备永久删除单条记录，或删除整个云端仓库/);
  assert.match(policyText, /本地.*90 天.*缓存/);
  assert.match(policyText, /云端已确认完全相同的同步版本后/);
  assert.match(policyText, /API Key.*不会上传/);
  assert.match(policyText, /密码.*不会上传/);
  assert.match(policyText, /卸载.*不会删除云端仓库/);
  assert.match(policyText, /<code>unlimitedStorage<\/code>.*避免常规扩展存储配额阻碍本地评论历史/);
  assert.match(policyText, /<code>alarms<\/code>.*安排云同步、本地保留期限检查和历史提醒/);
  assert.doesNotMatch(policy, /<code>alarms<\/code>.*排队写入重试/);
  assert.match(policy, /<code>notifications<\/code>.*在历史记录接近或超过 90 天清理阈值时显示本地提醒/);
});

test('Worker operations guide requires a Node.js range supported by the locked toolchain', () => {
  assert.match(
    workerReadme,
    /Node\.js 22 LTS, or Node\.js 24 or newer \(supported range: `\^22\.0\.0 \|\| >=24\.0\.0`\)/
  );
  assert.doesNotMatch(workerReadme, /Node\.js 18 or newer/);
});
