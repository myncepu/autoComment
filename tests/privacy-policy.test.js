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

test('English policy discloses local successful-comment history, retention, deletion, and permissions', () => {
  assert.match(policy, /Last updated: <span id="last-updated">2026-07-23<\/span>/);
  assert.match(policy, /Successful-comment history stays on this device in IndexedDB and is not sent to the AutoComment backend\./);
  assert.match(policy, /It preserves the exact submitted comment HTML \(the editor value\), plus a whitespace-normalized plain-text representation derived from that HTML, target page URL and domain, promoted website URL and domain, submission time and status, batch\/task identifiers, source, and each anchor's whitespace-normalized text and raw\/resolved URL\./);
  assert.doesNotMatch(policy, /exact submitted comment body \(HTML and text\)/);
  assert.match(policy, /This history does not separately capture names, email addresses, passwords, API keys, or other form credentials\./);
  assert.match(policy, /History becomes eligible for cleanup after 90 days on a rolling basis, but the reminder alarm never deletes it\./);
  assert.match(policy, /Deletion is available only after export and your explicit confirmation; canceling leaves the records untouched\./);
  assert.match(policy, /Uninstalling the extension deletes its IndexedDB history with the rest of the extension's local data\./);
  assert.match(policy, /<code>unlimitedStorage<\/code>.*prevents the normal extension storage quota from blocking local comment history/);
  assert.match(policy, /<code>alarms<\/code>.*schedules local retention checks and history reminders; an alarm never deletes history/);
  assert.doesNotMatch(policy, /<code>alarms<\/code>.*queued-write retries/);
  assert.match(policy, /<code>notifications<\/code>.*shows local reminders when history approaches or passes the 90-day cleanup threshold/);
});

test('Chinese policy discloses local successful-comment history, retention, deletion, and permissions', () => {
  assert.match(policy, /成功评论历史仅保留在本设备的 IndexedDB 中，不会发送到 AutoComment 后端。/);
  assert.match(policy, /它会精确保留实际提交的评论 HTML（即编辑器值），并保存从该 HTML 派生且经过空白规范化的纯文本表示、目标页面 URL 和域名、推广网站 URL 和域名、提交时间与状态、批次\/任务标识、来源，以及每个链接经空白规范化的锚文本和原始\/解析后 URL。/);
  assert.doesNotMatch(policy, /实际提交的评论正文（HTML 和文本）/);
  assert.match(policy, /该历史不会另行收集姓名、邮箱地址、密码、API Key 或其他表单凭据。/);
  assert.match(policy, /历史记录按滚动周期在满 90 天后才具备清理资格，但提醒闹钟绝不会删除记录。/);
  assert.match(policy, /只有先导出并由你明确确认后才会删除；取消操作会保留全部记录。/);
  assert.match(policy, /卸载扩展会随扩展的其他本地数据一并删除其 IndexedDB 历史。/);
  assert.match(policy, /<code>unlimitedStorage<\/code>.*避免常规扩展存储配额阻碍本地评论历史/);
  assert.match(policy, /<code>alarms<\/code>.*安排本地保留期限检查和历史提醒；闹钟绝不会删除历史/);
  assert.doesNotMatch(policy, /<code>alarms<\/code>.*排队写入重试/);
  assert.match(policy, /<code>notifications<\/code>.*在历史记录接近或超过 90 天清理阈值时显示本地提醒/);
});
