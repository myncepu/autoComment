# AutoComment 统一非敏感配置导入导出设计

日期：2026-07-27
状态：待书面确认

## 背景

设置页已经可以导入、导出 Profile、Promotion Site、Assignment Pair 和配额，
但模型的非敏感字段、批次默认值和显示偏好仍需分别填写。用户希望在本地
重新加载扩展后，通过一个 JSON 文件恢复绝大多数设置，并直接开始安全测试。

现有配置导出格式为 `autocomment-domain-config` v2。它只保存领域配置，并
明确排除 Profile 密码。OpenRouter API Key 保存在 `chrome.storage.local`，
也不会被当前格式导出。

## 目标

1. 一个 JSON 文件备份和恢复全部允许迁移的非敏感设置。
2. 保持现有 Profile、Promotion Site、Pair 和配额导入语义。
3. 保持兼容 v2 与旧版配置文件。
4. 在应用前显示确定性的变更预览，并只要求一次确认。
5. 提供一份可以直接导入的 3 Profile × 3 Promotion Site 本地测试预设。
6. 默认测试模式为自动生成、禁止自动提交，避免误向公网发布评论。

## 非目标

- 不导出、导入或显示 OpenRouter API Key。
- 不导出、导入或显示任何 Profile 密码。
- 不导出云同步密钥、设备凭据或授权状态。
- 不导出评论历史、批次草稿、checkpoint、运行中任务或恢复上下文。
- 不改变多 Profile、多 Promotion Site 的调度算法。
- 不自动填写真实推广网站或真实个人资料。

## 方案比较

### 方案 A：统一非敏感配置包 v3（采用）

扩展当前格式，显式保存领域配置、模型公开设置、批次默认值和界面偏好。
导入层按白名单验证所有字段，并复用现有领域配置预览与合并逻辑。

优点：

- 一次导入即可恢复绝大多数设置。
- 格式稳定、可版本迁移，不依赖 Chrome 内部存储布局。
- 安全边界可测试，未知字段和敏感字段一律拒绝。

代价：

- 需要新增 bundle schema 和跨存储适配器。
- 应用过程涉及领域仓库和同步设置两个写入边界。

### 方案 B：只增加测试预设下载

保留 v2，仅在设置页提供一份示例领域配置。

优点是改动小；缺点是模型、并发、超时和自动化开关仍需手工填写，不能解决
完整备份恢复问题。

### 方案 C：导出 Chrome storage 白名单快照

直接复制若干 storage key。

优点是实现快；缺点是格式与内部存储强耦合，难以迁移，也更容易因新增 key
而意外扩大敏感数据范围，因此不采用。

## v3 文件契约

顶层只允许以下字段：

```json
{
  "format": "autocomment-config-bundle",
  "version": 3,
  "exportedAt": 1785110400000,
  "data": {
    "domainConfig": {},
    "llm": {
      "apiBaseUrl": "https://openrouter.ai/api/v1",
      "model": "qwen/qwen-plus"
    },
    "batchDefaults": {
      "autoOpenPanel": true,
      "autoGenerate": true,
      "autoSubmit": false,
      "concurrency": 3,
      "timeoutSeconds": 120
    },
    "preferences": {
      "showExportOutlinksFloatingButton": true
    }
  }
}
```

### `domainConfig`

沿用当前领域配置 schema，包括：

- Profiles
- Promotion Sites
- Assignment Pairs
- 默认 Pair
- 批次、Profile、Promotion Site 和目标域名配额

### `llm`

只允许：

- `apiBaseUrl`
- `model`

禁止 `apiKey` 以及任何 password、secret、token、authorization 或 credential
变体。

### `batchDefaults`

- `autoOpenPanel`: boolean
- `autoGenerate`: boolean
- `autoSubmit`: boolean
- `concurrency`: 1–10 的整数
- `timeoutSeconds`: 10–600 的整数

若 `autoSubmit` 为 `true`，则 `autoGenerate` 必须为 `true`。测试预设固定
`autoSubmit: false`。

### `preferences`

只保存 `showExportOutlinksFloatingButton` 布尔值。

### 明确排除

bundle 不包含：

- `llm_api_key`
- Profile secret repository
- `cloud_sync_secret`
- `cloud_sync_vault_id`
- `cloud_sync_device_id`
- `batchDraftV1`
- `batchRuntimeCheckpoint`
- 历史、pending submit context 或结果缓存

schema 采用精确 key 校验。未知顶层或嵌套字段均阻止导入，而不是静默忽略。

## 兼容性

- 新导出一律生成 `autocomment-config-bundle` v3。
- v3 导入走统一 bundle parser。
- `autocomment-domain-config` v2 继续走现有 parser。
- 旧版单身份配置继续走现有 legacy parser。
- v2/legacy 导入只更新它们原本支持的领域配置，不覆盖 LLM 或批次默认值。

## 导入预览与应用

### 预览

选择文件后：

1. 解析 JSON。
2. 拒绝格式错误、未知字段、敏感字段和非法 URL。
3. 计算 Profile、Promotion Site 和 Pair 的新增/更新数量。
4. 列出将变化的非敏感设置名称。
5. 不进行任何 storage 写入。

设置页显示：

- 新增实体数
- 更新实体数
- 设置变化数
- 被拒绝的稳定错误码
- “确认应用导入”按钮

### 应用

应用只接受当前 controller 生成的一次性 preview ID，防止调用者修改预览结果。

写入顺序：

1. 再次确认 preview 尚未使用。
2. 保存应用前的领域配置和同步设置快照。
3. 应用合并后的领域配置。
4. 写入公开 LLM、批次默认值和偏好。
5. 若第 4 步失败，用保存的领域配置恢复内容，并返回稳定错误。
6. 成功后重新读取设置页快照并刷新所有控件。

恢复可能增加领域配置 revision，但不会留下半套配置内容。

## 测试预设

仓库新增：

`examples/autocomment-local-dry-run-config.json`

预设内容：

- Profiles：`test-profile-a`、`test-profile-b`、`test-profile-c`
- Promotion Sites：`test-site-a`、`test-site-b`、`test-site-c`
- URL：`http://127.0.0.1:4173/promotion/a|b|c`
- 三个等权启用 Pair
- 默认 Pair 为 A
- batch quota 80
- per Profile 30
- per Promotion Site 30
- per target domain 1
- OpenRouter Base URL 与默认模型 ID
- 自动生成开启
- 自动提交关闭
- 并发 3
- 单页超时 120 秒

所有姓名、邮箱和推广文案均为明显的本地测试值。文件中不存在 API Key、
密码或真实个人信息。稳定 ID 使重复导入变成更新，不产生重复实体。

## 组件边界

### `lib/config-bundle.mjs`

纯 Web 模块，负责：

- v3 schema 验证
- 敏感字段拒绝
- bundle 构建
- v3 预览数据标准化

它不访问 `chrome.*`。

### `lib/options-config-bundle-controller.mjs`

组合：

- domain config repository
- 现有 domain import/export
- 显式注入的 sync settings adapter

负责一次性 preview、应用和补偿恢复。

### `options.js`

仅负责：

- 文件选择
- 下载 JSON
- 渲染预览摘要
- 调用 controller
- 应用成功后刷新表单

它不解析 bundle schema，也不直接拼接敏感 key。

## 错误处理

使用稳定错误码：

- `invalid_config_bundle_format`
- `unsupported_config_bundle_version`
- `sensitive_config_bundle_field`
- `invalid_config_bundle_llm`
- `invalid_config_bundle_batch_defaults`
- `invalid_config_bundle_preferences`
- `stale_config_bundle_preview`
- `config_bundle_apply_failed`
- `config_bundle_rollback_failed`

UI 显示简短中文说明，不显示原始异常、文件内容、API 响应或潜在 secret。

## 测试策略

按 TDD 实现：

1. bundle schema 接受有效 v3，拒绝未知字段和全部敏感字段变体。
2. 导出结果不包含 API Key、Profile 密码、云同步 secret、历史或 checkpoint。
3. v3 preview 准确报告实体和设置变化，且不会写 storage。
4. apply 使用一次性 preview，重复应用失败。
5. 设置写入失败时恢复领域配置内容。
6. v2 和 legacy 导入行为保持不变。
7. 测试预设通过同一 production parser，包含 3×3 配置和安全批次默认值。
8. 设置页显示统一导入预览并在成功后刷新控件。
9. `npm test`、JS/MJS 语法检查和普通 HTTP 设置页 fixture 通过。
10. 最终在真实 Chrome 中手动加载扩展，导入预设并验证字段；由于自动控制工具
    不允许访问 `chrome-extension://`，该项由用户本地完成。

## 验收标准

- 拉取代码后可以直接选择示例 JSON 并完成一次确认导入。
- 页面显示 3 个测试 Profile、3 个测试 Promotion Site 和 3 个 Pair。
- 批次默认值为自动生成开启、自动提交关闭、并发 3、超时 120 秒。
- OpenRouter Base URL 与模型已填充；API Key 仍为空且只需本机填写一次。
- 重复导入不创建重复实体。
- 导出 v3 后重新导入可恢复全部非敏感设置。
- 任意 secret 或未知字段都会阻止导入且不会产生部分写入。
