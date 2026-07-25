# Cloudflare 评论历史与设置同步设计

## 背景

当前扩展把成功评论历史保存在扩展 Origin 下的 IndexedDB：

- `comment_records` 保存评论正文、页面、推广网站、提交时间和批次信息。
- `comment_anchors` 保存从正文解析出的锚文本和链接。
- `chrome.storage.local` 中的独立待重试项负责本地 IndexedDB 写入失败后的恢复。
- 设置主要保存在 `chrome.storage.sync`，AI API Key 保存在
  `chrome.storage.local`。

这套实现可以离线工作，但评论历史只存在于当前浏览器。更换电脑、浏览器配置或
卸载扩展后，另一台设备无法读取这些记录。

此外，现有 `options.js` 把自动填表密码写入 `chrome.storage.sync`，配置导出也会
包含该密码。云同步改造必须同时收紧这条敏感数据路径。

## 目标

- 使用 Cloudflare Worker 和 D1 保存成功评论历史与明确允许的非敏感设置。
- 使用一段可复制的同步密钥配对不同电脑，不引入邮箱或账号注册系统。
- 保持本地优先：发表评论和本地历史写入不依赖云端可用性。
- 支持离线积压、自动增量同步、幂等重试、冲突合并和跨设备永久删除。
- 云端长期保留评论；本地 IndexedDB 只需缓存最近 90 天。
- 支持从历史页面分页查询超过 90 天的云端记录。
- 从所有云请求、配置导出和 Chrome 同步区排除 API Key、密码、Cookie 和临时任务数据。
- 未启用云同步的用户继续使用现有纯本地流程。

## 非目标

- 第一阶段不使用 R2，不保存附件、页面快照、CSV 归档或完整页面 HTML。
- 不建立邮箱验证码、OAuth、订阅或多用户组织系统。
- 不同步 AI API Key、自动填表密码、Cookie、站点令牌、当前批次任务队列或恢复检查点。
- 不让扩展直接访问 D1；所有云端访问都经过 Worker。
- 不改变“提交成功”语义，不判断评论是否已审核或公开。
- 不提供多人同时编辑同一套设置的协作界面。

## 方案选择

采用 Cloudflare Worker + D1，继续使用 IndexedDB 作为本地缓存。

D1 适合当前结构化数据、筛选、增量游标和关系查询。R2 更适合大对象与归档文件；
使用 R2 JSON 对象会增加单条更新、查询、冲突和删除的复杂度。未来需要保存 CSV、
附件或年度压缩归档时，可以在不改变同步协议的前提下增加 R2。

参考：

- [D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/)

## 总体架构

### 浏览器扩展

IndexedDB 仍是最近历史的本地读取源。数据库版本升级后新增：

- `sync_outbox`：尚未获得云端确认的 mutation。
- `sync_meta`：设备 ID、远端游标、迁移进度、最后同步时间和错误状态。

后台 Service Worker 是唯一的云同步协调者。内容脚本、批处理页、历史页和设置页只能
通过扩展消息调用同步服务，不能持有同步密钥或直接请求 Worker。

同步配置保存在 `chrome.storage.local`：

- Worker API 固定地址。
- `vaultId`。
- 同步 secret。
- 本机 `deviceId`。
- 启用状态。

secret 不写入 `chrome.storage.sync`，不进入普通配置导出，也不写入日志。

### Cloudflare Worker

Worker 负责：

- 创建或验证保险库。
- 校验 Bearer 同步密钥。
- 校验请求大小、批量数量、字段类型和允许的设置键。
- 批量应用 mutation 并返回逐条结果。
- 按服务器游标提供增量变化。
- 提供云端历史分页查询。
- 执行单条评论和整库永久删除。
- 使用 D1 binding 和预处理语句访问数据库。

Worker 使用 `wrangler.jsonc` 声明 D1 binding、兼容日期、非敏感配置和可观测性。
生产 secret 或 Cloudflare 凭据不进入源代码或配置文件。

### D1

D1 是云端长期主副本，保存评论、锚文本、允许的设置、设备、幂等回执、变化序号和
删除标记。数据库结构通过顺序编号的 SQL migration 管理。

## 同步身份与密钥

同步密钥格式由两部分组成：

```text
acsync_<vaultId>.<secret>
```

- `vaultId` 使用 128 位以上的 Web Crypto 随机值。
- `secret` 使用 256 位 Web Crypto 随机值。
- 第一台设备在本地生成二者，通过 HTTPS 调用 `PUT /v1/vault`。
- Worker 对 secret 做 SHA-256 哈希，只把哈希写入 D1。
- 后续请求在 `Authorization: Bearer <sync-key>` 中发送密钥。
- 第二台设备通过用户粘贴或导入同一密钥加入保险库，并生成自己的 `deviceId`。

现有 `auto_comment_user_id` 只是业务标识，可以作为普通设置同步，但不参与鉴权。

密钥只在创建后或用户主动点击“显示/复制密钥”时展示。断开当前设备只清除本地密钥；
不会删除云端或影响其他设备。

## 本地数据模型

### `sync_outbox`

| 字段 | 说明 |
| --- | --- |
| `mutationId` | 主键，Web Crypto UUID |
| `entityType` | `comment`、`setting` 或 `comment_delete` |
| `entityId` | 评论 ID 或设置键 |
| `operation` | `upsert` 或 `delete` |
| `payload` | 已经过白名单过滤的完整 mutation |
| `createdAt` | 本地创建时间 |
| `attemptCount` | 已尝试次数 |
| `nextAttemptAt` | 下次允许重试时间 |
| `lastErrorCode` | 最近一次安全错误码 |
| `state` | `pending`、`blocked` 或 `needs_attention` |

索引至少包括 `by_state_next_attempt`。同一条评论可以存在多个 mutation；云端用修订
比较决定是否接受，不能在本地通过覆盖旧 outbox 项来假设新项一定已经持久化。

### `sync_meta`

使用键值记录保存：

- `deviceId`。
- `serverCursor`。
- `lastSuccessfulSyncAt`。
- `lastSyncError`。
- `initialUploadState` 和续传游标。
- `passwordStorageMigrationVersion`。
- `localCacheCleanupCursor`。

只有完整应用一页远端变化后才能推进 `serverCursor`。

## D1 数据模型

### `sync_vaults`

| 字段 | 说明 |
| --- | --- |
| `vault_id` | 主键 |
| `secret_hash` | secret 的 SHA-256 哈希 |
| `created_at` | 创建时间 |
| `deleted_at` | 整库删除时间；正常状态为空 |

### `sync_devices`

主键为 `(vault_id, device_id)`，保存设备显示名、创建时间、最后成功同步时间和最后已报告
游标。设备记录不授予额外权限；持有同步密钥才有访问权。

### `comment_records`

主键为 `(vault_id, record_id)`。业务字段与本地 `comment_records` 对齐，并额外保存：

- `revision_source_rank`。
- `revision_captured_at`。
- `revision_recorded_at`。
- `revision_sequence`。
- `revision_id`。
- `accepted_mutation_id`。
- `cloud_created_at` 和 `cloud_updated_at`。

修订字段用于复现现有 `compareCommentFreshness` 的确定性顺序。更新使用条件 UPSERT；
较旧修订不能覆盖较新记录。

### `comment_anchors`

主键为 `(vault_id, comment_id, position)`，字段与本地锚点结构对齐。评论更新被接受时，
该评论的正文和全部锚点作为同一个逻辑写入更新，不能留下旧锚点。

### `synced_settings`

主键为 `(vault_id, setting_key)`，保存 JSON 值、最后 mutation ID、服务器更新时间和
变化序号。设置冲突采用“最后成功到达 Worker 的新 mutation 获胜”；相同 mutation
重放不改变结果。

### `sync_mutations`

主键为 `(vault_id, mutation_id)`，保存 mutation 类型、处理结果、对应变化序号和
处理时间。它提供永久幂等回执，使超时后的重复请求能够返回原结果。

### `sync_changes`

`server_seq INTEGER PRIMARY KEY AUTOINCREMENT` 提供单调递增游标。每行保存保险库、
实体类型、实体 ID、操作、mutation ID 和创建时间。索引为
`(vault_id, server_seq)`。

变化日志不重复保存评论正文。拉取时由 Worker 根据变化行读取当前评论、锚点、
设置或 tombstone。新设备通过快照初始化，不重放完整变化日志。

### `comment_tombstones`

主键为 `(vault_id, record_id)`，保存删除 mutation、删除时间和服务器序号，不保存
评论正文。tombstone 长期保留，阻止长期离线设备用旧修订恢复已永久删除的评论。

## 允许同步的设置

Worker 和插件共享同一份显式白名单：

- `promotion_website_url`
- `promotion_website_content`
- `auto_fill_user_name`
- `auto_fill_user_email`
- 模型 API Base URL 和模型 ID
- `show_export_outlinks_floating_button`
- 批处理默认勾选项
- `batch_concurrency`
- `batch_timeout_seconds`
- `auto_comment_user_id`

明确禁止：

- AI API Key。
- `auto_fill_user_password`。
- Cookie、访问令牌和页面认证信息。
- 当前批次设置、URL 队列、结果缓存、提交上下文和恢复检查点。
- 任意不在白名单中的新键。

插件在生成 mutation 前过滤一次，Worker 收到后再次按白名单拒绝。禁止字段不能仅靠
界面隐藏。

## API 契约

### 通用约定

- API 前缀为 `/v1`。
- 除首次创建保险库外，所有请求必须携带 Bearer 同步密钥。
- 响应包含 `requestId`。
- 错误结构包含稳定 `code`、可安全显示的 `message` 和 `retryable`。
- 请求体和响应体使用 JSON。
- 单次 push 最多 100 个 mutation；插件还要限制序列化后的请求体大小。
- Worker 只允许所需方法并处理预检请求，不使用 `Access-Control-Allow-Origin: *`
  作为唯一安全措施。

### 端点

#### `PUT /v1/vault`

幂等创建或验证保险库。相同 vault 和 secret 返回当前状态；相同 vault 配不同 secret
返回 403。

#### `GET /v1/status`

验证密钥，登记或刷新设备最后在线时间，并返回服务器时间、当前最高游标和保险库状态。

#### `POST /v1/sync/push`

请求包含 `deviceId` 和最多 100 个 mutation。响应逐条返回：

- `applied`：已成为当前版本并产生变化序号。
- `duplicate`：mutation 已处理。
- `stale`：评论修订旧于云端当前版本。
- `rejected`：该项格式或设置键非法。

单条 rejected 不回滚其他有效项。每条 mutation 内部的评论、锚点、幂等回执和变化
日志必须原子提交。

#### `GET /v1/sync/pull`

参数包含 `cursor` 和有上限的 `limit`。响应包含：

- `changes`。
- `nextCursor`。
- `hasMore`。
- `highWatermark`。

客户端完整应用 `changes` 后才保存 `nextCursor`。同一页重放必须安全。

#### `GET /v1/sync/bootstrap`

用于新设备初始化，分页返回最近 90 天评论、当前设置、必要 tombstone 和快照对应的
`serverCursor`。快照期间产生的新变化由后续增量拉取补齐。

#### `GET /v1/history`

在线查询云端长期历史，支持提交日期范围、目标域名、推广域名、锚文本和稳定游标分页。
默认限制和最大限制由 Worker 固定，不能一次返回整库。

#### `DELETE /v1/history/:recordId`

请求包含新的 mutation ID。Worker 删除云端正文与锚点、写入 tombstone 和变化日志。
相同删除 mutation 重放返回同一结果。

#### `DELETE /v1/vault`

请求体必须再次携带要删除的 `vaultId` 作为确认值。Worker 原子标记保险库失效并删除
评论正文、锚点和设置。所有设备后续鉴权失败并停止自动重试。界面在调用前还必须二次
确认。

## 评论同步与冲突规则

评论继续使用现有 `historyRevision`：

1. `source` 为 live 的记录优先于 legacy。
2. 再按 `capturedAt`、`recordedAt`、`sequence`、`id` 逐项比较。
3. 云端只接受严格更新的修订。
4. 重复或更旧修订不替换正文和锚点。

D1 写入使用条件 UPSERT 和 mutation 幂等记录。实现必须保证：

- 评论正文、锚点、mutation 回执和变化行作为一个原子逻辑提交。
- 已接受记录保存 `accepted_mutation_id`，后续锚点语句只作用于本次已接受操作。
- 任意语句失败时不能出现正文已更新但锚点或变化日志缺失的状态。

永久删除优先于所有删除之前创建的离线修订。tombstone 存在时，旧设备上传返回
`stale`；只有未来明确设计的恢复功能才能移除 tombstone，本版本不支持恢复。

设置不使用客户端时钟判断跨设备先后，以 Worker 成功接受新 mutation 的顺序为准。
mutation ID 唯一约束避免网络重试把旧设置再次应用。

## 日常数据流

### 成功评论

1. 现有流程先把成功评论原子写入本地 IndexedDB。
2. 同一次本地持久化流程加入 comment mutation 到 `sync_outbox`。
3. 本地写入完成后照常确认批次，不等待云端。
4. 后台同步器异步批量 push。
5. Worker 返回 `applied`、`duplicate` 或 `stale` 后，插件删除对应 outbox 项。
6. `rejected` 项转为 `needs_attention` 并在界面显示，不阻塞其他项。

如果加入云 outbox 失败，评论本地保存仍然成功，但批处理页和同步状态必须显示
“评论已保存，尚未进入云同步队列”，并在后续扫描中根据本地记录补建 mutation。

### 增量拉取

1. 推送完成后使用当前 `serverCursor` 拉取。
2. 逐页把远端评论、设置和删除变化应用到本地。
3. 每页本地事务成功后保存 `nextCursor`。
4. `hasMore` 为真时继续下一页，但每次触发设置工作量上限，避免扩展 Service Worker
   长时间占用。

### 同步触发

- 评论保存成功后。
- 浏览器启动或扩展安装/升级后。
- 历史页或设置页打开时。
- 用户点击“立即同步”时。
- 网络恢复后的下一次可用事件或定时检查。
- `chrome.alarms` 每 5 分钟兜底检查。

所有触发进入同一个进程内同步锁。Service Worker 重启后，以 outbox 和游标恢复，
不能依赖内存中的锁或计时器状态。

## 首次迁移与新设备

### 第一台已有数据的设备

- 扫描现有本地评论并分批建立 mutation。
- 使用记录 ID 和现有 `historyRevision`，迁移可中断和重跑。
- 迁移进度写入 `sync_meta`，不能一次把全部历史读入内存。
- 本地待重试队列先按现有逻辑恢复到 IndexedDB，再参与云迁移。
- 所有历史上传完成前不清理任何本地记录。

### 新设备

- 导入密钥后生成独立 `deviceId`。
- 调用 bootstrap 分页下载最近 90 天评论、设置和必要 tombstone。
- 快照完成后保存快照游标，再增量拉取快照期间的变化。
- 超过 90 天的评论不长期写入本地缓存；历史页按需在线查询。

## 保留、查询与删除

### 云端

- 评论默认长期保留，不执行 90 天自动删除。
- 历史页通过 Worker 对旧记录进行稳定分页查询。
- 只有明确的单条永久删除或整库删除会删除云端正文。

### 本地

- 云同步关闭时，保留当前“达到 90 天后提醒、先导出、再明确确认删除”的流程。
- 云同步开启时，只有已经获得云端确认且超过 90 天的记录才可自动作为缓存清理。
- pending、blocked、needs_attention 或尚未迁移的记录绝不自动清理。
- 本地缓存清理不是同步 mutation，不生成云端 tombstone。
- 最近 90 天记录优先从 IndexedDB 查询；旧日期或本地缺页时从云端查询。
- 历史页面将本地和云端结果渲染为统一列表，并标明当前是否离线以及旧历史是否可用。

永久删除流程：

1. 用户选择“从所有设备永久删除”并二次确认。
2. 插件调用 Worker，不能先删除本地正文。
3. Worker 删除云端正文与锚点并写入 tombstone 和变化日志。
4. 收到云端成功响应后，当前设备删除本地副本。
5. 其他设备通过增量拉取删除本地副本。

## 设置同步与密码迁移

设置页保存白名单字段时，同时写入本地 Chrome storage 并加入 setting mutation。
远端设置到达后，后台写入对应本地 storage 区域，并避免 `storage.onChanged` 再生成
回声 mutation。

密码迁移只执行一次：

1. 从 `chrome.storage.sync` 读取 `auto_fill_user_password`。
2. 如果 `chrome.storage.local` 尚无值，则先写入 local。
3. 验证 local 写入成功。
4. 从 sync 删除密码键。
5. 写入迁移版本标记。

任一步失败都保留原值并重试，不能先删除。配置导入可以接受旧文件中的密码以兼容
历史，但必须只写入 local；新的配置导出完全排除密码和 AI API Key。

## 安全与隐私

- 同步密钥使用 Web Crypto 生成。
- 所有通信使用 HTTPS。
- Worker 不记录 Authorization header、secret、评论正文或个人设置值。
- D1 只保存 secret 哈希。
- 请求使用严格 JSON schema、字段长度和批量数量校验。
- SQL 使用绑定参数，不拼接用户输入。
- Worker API 地址固定在扩展构建配置中；普通界面不接受任意同步服务器地址。
- manifest 只增加固定 Worker Origin 所需的主机权限。
- 内容脚本不能接触 secret，网络调用只由后台 Service Worker 发起。
- 历史页面继续使用安全文本渲染，不执行保存的评论 HTML。
- 隐私政策同时更新中英文版本，说明上传字段、Cloudflare 存储、同步密钥、保留期、
  永久删除和用户选择。

## 错误处理

| 情况 | 行为 |
| --- | --- |
| 无网络、超时、5xx | 保留 outbox，指数退避并加入随机抖动 |
| 429 | 服从 `Retry-After`；无该头时使用退避 |
| 401/403 | 停止自动重试，显示密钥无效或保险库失效 |
| 单条 4xx 校验失败 | 标为 `needs_attention`，继续处理同批其他项 |
| 本地 outbox 写入失败 | 保留本地评论，显示警告并由后续扫描补建 |
| 拉取页应用失败 | 不推进游标，下次重放整页 |
| 云端永久删除失败 | 保留本地正文，不显示已删除 |
| D1 migration 或 Worker 配置失败 | 阻止部署，不影响现有扩展版本 |

退避次数只影响等待时间，不自动丢弃数据。状态页显示最后成功时间、待上传数、
需处理数和最近安全错误信息。

## 用户界面

设置页新增“Cloudflare 云同步”区域：

- 启用并创建同步密钥。
- 导入已有同步密钥。
- 显示/复制密钥。
- 立即同步。
- 显示已同步、等待上传、正在同步、同步失败或密钥失效。
- 显示最后成功同步时间、待上传数量和设备 ID。
- 断开当前设备。
- 二次确认删除整个云端保险库。

历史页新增：

- 本地/云端统一查询。
- 离线和云端不可用提示。
- 单条“从所有设备永久删除”操作。
- 云同步启用后，将现有本地归档提示改为“本地缓存清理”语义；云端历史不受影响。

同步密钥属于高价值凭据。界面必须说明任何持有者都能读取和删除该保险库数据，并建议
使用密码管理器保存。

## 测试策略

### 插件单元测试

继续使用 `node:test` 和 `fake-indexeddb`，按测试驱动开发覆盖：

- 同步密钥生成、解析和非法格式。
- 设置白名单和所有敏感字段排除。
- outbox 入队、独立 mutation、重试和状态转换。
- 每页成功后才推进游标。
- 评论修订比较和较旧记录拒绝。
- tombstone 阻止旧记录复活。
- 多个触发只运行一个同步实例。
- 退避、429 `Retry-After`、401/403 停止策略。
- 本地 90 天缓存只清理已云端确认记录。
- 现有历史分批迁移可暂停和续传。
- 密码先复制到 local、再从 sync 删除。
- 新配置导出不包含密码和 API Key。

### Worker 单元与集成测试

使用 Cloudflare Workers Vitest integration 和本地 D1 migrations：

- Bearer 密钥创建、验证、错误密钥和已删除保险库。
- SQL migration 可从空库完整应用。
- push 逐条结果和永久 mutation 幂等。
- 评论与锚点的原子更新。
- 并发或交错提交时旧修订不能覆盖新修订。
- pull 稳定游标、分页、重放和 high watermark。
- bootstrap 快照与快照期间新增变化衔接。
- 历史筛选、分页和 vault 数据隔离。
- 单条删除移除正文、保留 tombstone。
- 整库删除后所有设备失效。
- 校验错误不会泄漏密钥或敏感载荷。

参考：

- [Workers testing](https://developers.cloudflare.com/workers/testing/)
- [Workers Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)
- [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)

### 双设备验收

使用两个隔离浏览器配置验证：

1. A 创建密钥，B 导入后可看到 A 的最近评论。
2. A 断网发表评论，恢复网络后 B 自动出现该记录。
3. 重复请求不产生重复评论或锚点。
4. 较旧修订不覆盖较新正文。
5. A 永久删除后，长期离线的 B 上线也不能恢复该评论。
6. B 只缓存 90 天，但在线能查询更早历史。
7. Worker 故障期间现有发表评论和本地历史继续工作。
8. 云请求中没有 API Key、密码、Cookie 或批次 URL 队列。

## 工程结构与部署

新增独立目录：

```text
cloudflare-sync/
  src/
  migrations/
  test/
  wrangler.jsonc
  vitest.config.ts
  package.json
```

插件共享协议、白名单和纯函数放在浏览器与 Worker 都能安全引用的独立模块中，避免两端
复制规则。Worker 平台绑定类型通过 Wrangler 生成，不手写漂移的 `Env`。

部署步骤：

1. 本地应用 D1 migrations。
2. 运行插件和 Worker 全部测试。
3. 运行 TypeScript 类型检查。
4. 运行 Wrangler dry-run。
5. 创建生产 D1 数据库并填入实际 binding ID。
6. 应用远端 migrations。
7. 部署 Worker。
8. 把固定 Worker Origin 写入扩展构建配置和 manifest 权限。
9. 用测试保险库执行双设备冒烟验证。
10. 发布更新后的隐私政策和扩展包。

首次上线分阶段启用：

- 默认不为现有用户自动创建云保险库。
- 用户在设置页明确启用后才上传数据。
- 本地初始迁移显示进度并可暂停。
- 云同步出现严重错误时可以关闭同步而不影响本地历史。

## 验收标准

- 两台电脑使用同一同步密钥可以同步评论历史和白名单设置。
- 评论提交路径不等待 Worker 或 D1。
- 离线 mutation 不丢失，网络恢复后自动补传。
- 重试、Service Worker 重启和重复消息不会制造重复数据。
- 冲突结果确定，较旧评论修订不能覆盖较新修订。
- 永久删除跨设备传播，旧设备不能恢复被删记录。
- 云端长期保留，本地只自动清理已确认同步且超过 90 天的缓存。
- 新设备不需要下载全部历史，也能在线分页查询旧记录。
- AI API Key、密码、Cookie 和临时批次数据不会进入云端。
- 现有同步区密码安全迁移到 local，新配置导出不再包含密码。
- 未启用云同步时，现有评论、历史、导出和保留流程无回归。
- 所有自动化测试、类型检查、本地 migration 和部署 dry-run 通过。
