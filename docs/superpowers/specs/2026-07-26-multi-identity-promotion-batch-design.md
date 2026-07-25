# 多身份、多推广网站并发批次设计

## 背景

AutoComment 当前已支持一个批次同时打开 1–10 个独立 Chrome 窗口，并通过
`batchId + urlIndex + tabId` 隔离结果、提交恢复上下文和窗口生命周期。但所有任务仍从
全局设置读取同一个姓名、邮箱、密码、推广网站 URL 和网站描述，导致多个窗口无法安全
使用不同身份和推广网站。

现有批次 checkpoint v1 保存完整目标 URL、原始 CSV 行和运行设置，但不保存每条任务的
身份或推广网站归属。`content.js` 在任务执行时读取全局设置，因此批次运行期间修改设置
会污染尚未执行的任务。旧版还曾把表单密码保存到 `chrome.storage.sync` 并包含在配置
导出中；正在收尾的 Cloudflare 同步分支已把旧全局密码迁移到
`chrome.storage.local`，本设计在该安全边界上继续扩展。

同时有另一个任务重构批处理和设置页面为桌面作业控制台。本功能先提供领域模型、存储
迁移、CSV 导入与分配协议、运行时隔离、checkpoint、历史和测试契约，不在第一阶段重做
`batch.html` 或 `options.html` 的视觉结构。UI 集成必须建立在该任务产出的契约和页面上。

## 目标

- 管理多个 Profile，每个 Profile 包含显示名、姓名、邮箱和可选密码。
- 管理多个 Promotion Site，每个网站包含名称、URL、描述和启用状态。
- 一个批次中，每个目标 URL 都冻结绑定一个 `profileId + promotionSiteId` 原子组合。
- 支持默认组合、确定性加权轮询、CSV 显式分配和任意 CSV 列映射。
- 启动前生成完整分配预览；预览、checkpoint 和实际执行使用同一个不可变计划。
- 支持批次总量、每 Profile、每 Promotion Site、每目标域名的硬配额。
- 阻止批次内重复 URL，并默认阻止最近 24 小时已成功评论的相同 URL。
- 多窗口并发、暂停、断电恢复和一次安全重试都保持原始任务组合。
- 密码仅保存在 `chrome.storage.local` 的独立密钥库中，不进入普通配置、checkpoint、
  URL 队列、`BATCH_HANDLE`、结果、历史、导出、日志、D1 或
  `chrome.storage.sync`。
- 结果和成功评论历史记录可按 Profile 和 Promotion Site 筛选。
- 非敏感领域配置通过 Cloudflare/D1 的版本化实体协议安全同步。
- 旧单身份、单推广网站配置和旧 CSV 自动兼容。
- 用本地 fixture 在真实 Chrome 中验证至少 3 个并发窗口、2 个 Profile、2 个
  Promotion Site 和 5 个目标 URL，不向第三方网站发送测试评论。

## 非目标

- 不允许一个 Chrome 配置文件同时运行多个独立批次。
- 不把完整批次调度迁移到 Manifest V3 Service Worker。
- 不同步、导出或记录密码、AI API Key、Cookie、页面令牌或 Cloudflare 同步密钥。
- 不把失败、配额跳过、重复拦截或非法网站任务上传为长期云评论历史。
- 不提供 Profile 自身的启用开关；Profile 是否参与自动分配由组合是否启用决定。
- 不让运行时根据并发完成顺序重新选择身份或推广网站。
- 不在 UI 重构分支不可用时创建一套临时、重复的身份和分配界面。

## 已批准的产品规则

### 分配

- 自动分配单位是原子的 Profile/Promotion Site 组合，不生成未配置的交叉组合。
- 默认使用“默认组合 + 确定性加权轮询 + CSV 显式覆盖”。
- CSV 中 Profile 和 Promotion Site 两列必须同时有值或同时为空。
- 显式组合必须对应一个存在、启用且完整有效的组合；不得静默替换其中一项。
- 加权分配不随机，按 CSV 行顺序使用平滑加权轮询。
- 手动单页模式始终使用明确的默认组合，不消耗批次轮询状态。

### 默认配额

- 每批最多 100 条可发送任务。
- 每个 Profile 每批最多 50 条。
- 每个 Promotion Site 每批最多 50 条。
- 每个规范化目标域名每批最多 3 条。
- 用户可调整配额；高于默认值时启动前必须再次明确确认。
- 任务因配额超限被跳过时只结束该任务，不暂停整个批次。

### 重复与重试

- 同一批次内，规范化后相同的目标 URL 只允许第一条，不提供解除入口。
- 最近 24 小时已有本地成功记录的相同目标 URL 默认跳过。
- 用户可在预览中逐条解除 24 小时历史重复拦截，但启动前必须二次确认。
- 每条任务最多自动重试一次，只适用于明确发生在点击提交前的瞬时故障。
- 窗口创建、内容脚本就绪、AI 或网络瞬时故障可重试。
- 用户关闭窗口、非法网站、配额或重复拦截、人工验证、进入 `submitting` 后中断以及
  任何结果不明确的状态都不自动重试。
- 重试使用同一个 Profile、Promotion Site、目标 URL 和批次安全快照。

### 缺少密码

Profile 密码可为空。如果目标页面存在必填密码字段，而当前 Profile 的批次密码快照为
空或不可恢复，则该任务记录为 `manual_required`，释放窗口和并发槽位并继续下一项。
不得回退到默认 Profile、其他 Profile 或迁移前的全局密码。

## 领域模型

### Profile

```js
{
  id: 'stable-id',
  displayName: '运营身份 A',
  name: 'Alice',
  email: 'alice@example.test',
  createdAt: 0,
  updatedAt: 0
}
```

规则：

- `id` 创建后不可变。
- `displayName` 在 Profile 集合中唯一，供 UI、CSV 和历史显示。
- `name` 和合法邮箱必填。
- Profile 领域对象没有 `password`、`hasPassword` 或密码摘要字段。
- 删除 Profile 不修改已经启动批次的快照；配置仓库拒绝生成引用不存在 Profile 的
  新组合。

### Promotion Site

```js
{
  id: 'stable-id',
  name: '产品官网 A',
  url: 'https://product.example/',
  content: '面向……的网站描述',
  enabled: true,
  createdAt: 0,
  updatedAt: 0
}
```

规则：

- `id` 创建后不可变。
- `name` 在 Promotion Site 集合中唯一。
- URL 必须使用 `http:` 或 `https:`，保存时使用 URL 标准化结果。
- 描述不能为空。
- 禁用网站不参与自动轮询，CSV 也不能显式引用。
- 网站在批次启动后被禁用或修改，不影响已冻结批次。

### Assignment Pair 与 Policy

```js
{
  defaultPairId: 'pair-default',
  pairs: [{
    id: 'pair-a',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    weight: 3,
    enabled: true
  }],
  quotas: {
    batch: 100,
    perProfile: 50,
    perPromotionSite: 50,
    perTargetDomain: 3
  }
}
```

- 相同 `profileId + promotionSiteId` 只能出现一次。
- `weight` 是 1–100 的整数。
- 默认组合必须存在、启用并引用有效 Profile 和已启用 Promotion Site。
- 手动模式使用默认组合；批次自动分配使用所有有效且启用的组合。
- 删除或禁用被设为默认的组合前，用户必须先选择新的默认组合。

## 本地存储与迁移

### 权威配置

完整非敏感领域配置保存到 `chrome.storage.local`：

```js
{
  autoCommentDomainConfig: {
    version: 2,
    revision: 0,
    profiles: [],
    promotionSites: [],
    assignmentPolicy: {}
  }
}
```

普通仓库 API 只读写和返回上述非敏感文档。它不接受额外属性，保存前执行严格 schema
校验和深拷贝，避免调用者把密码混入领域对象。每次成功写入把 `revision` 精确增加 1；
批次计划用该值判断预览确认后配置是否发生变化。

### Profile 密钥库

密码保存到独立 local-only 键：

```js
{
  autoCommentProfileSecrets: {
    version: 1,
    passwordsByProfileId: {
      "profile-a": "..."
    }
  }
}
```

只有后台 Profile secret repository 和批次 secret vault controller 可以读取此键。
设置页面保存密码时调用独立消息接口；领域配置控制器永远不读取或回传密码。设置页面
重新打开时可以通过受限后台接口查询当前 Profile 的 `configured: true | false`，该接口
不返回密码值。这个状态不写入领域对象、导出或 D1，持久化领域对象也不包含
`hasPassword`。

### 旧设置迁移

迁移以 local 中的版本标记串行、幂等执行：

1. 读取旧 `promotion_website_url`、`promotion_website_content`、
   `auto_fill_user_name` 和 `auto_fill_user_email`。
2. 使用固定迁移 ID 创建默认 Profile、默认 Promotion Site 和默认组合，使同一旧配置
   在不同设备上启用 D1 后不会产生随机重复实体。
3. 优先读取 Cloudflare 分支已迁移到 local 的 `auto_fill_user_password`。如果密码仍只
   存在于 sync，则把它纳入同一次迁移。
4. 先写入 Profile secret map 并回读验证；验证成功后才删除 local 和 sync 中的旧全局
   密码键。删除任一旧副本失败时不写完成版本标记，下次启动继续收敛。
5. 迁移失败时保留仍可恢复的旧密码原值和未完成版本标记，下次启动重试。
6. 非敏感旧 sync 键暂时保留用于版本回滚，但新运行时不再读取或写入这些键。
7. 写入 `domainConfigMigrationVersion: 2`。

如果新领域配置已存在，迁移不得覆盖用户实体。旧值只可补建尚未完成的固定迁移实体。

### 配置导入和导出

新导出格式包含：

- Profile 的非敏感字段。
- Promotion Site。
- Assignment Pair、默认组合和配额。
- 格式版本和导出时间。

导出递归拒绝 `password`、`secret`、`apiKey`、Cookie、token、批次 URL 队列、
checkpoint 和 submit context。导出文件不包含密码是否存在的标记。

导入先生成预览，再按稳定 ID 合并：

- 同 ID 更新允许的非敏感字段。
- 新 ID 创建新实体。
- 名称冲突、悬空组合、非法 URL 或非法权重阻止保存。
- 本机已有密码始终保留，导入不能清空或覆盖。
- 旧格式中的全局密码只允许进入默认 Profile 的 local secret map，绝不进入通用
  `toSave` 对象、sync 或新导出。

## CSV 导入、列映射与模板

### 解析

CSV 解析从 `batch.js` 抽离到独立 adapter，并使用仓库已有的 Papa Parse 能力正确处理
引号、逗号、CRLF、BOM 和带换行字段。解析结果保留：

```js
{
  rowNumber,
  originalRow,
  targetUrlRaw,
  sourceDomainRaw,
  profileRefRaw,
  promotionSiteRefRaw
}
```

### 列角色

标准角色为：

- `targetUrl`，必填。
- `sourceDomain`，可选。
- `profileRef`，可选但必须与 `promotionSiteRef` 同时映射和填写。
- `promotionSiteRef`，可选但必须与 `profileRef` 同时映射和填写。

旧表头“原URL”“URL”“url”“URL对应域名”“来源域名”“sourceDomain”继续自动识别。
新模板使用 `profileId` 和 `promotionSiteId` 作为稳定列名，并附带只供人阅读的显示名
说明列。UI 允许用户把任意 CSV 表头映射到四个标准角色。

### 引用解析

Profile 引用按以下顺序解析：

1. 稳定 Profile ID。
2. 唯一、精确的 Profile 显示名。

Promotion Site 引用按以下顺序解析：

1. 稳定 Promotion Site ID。
2. 唯一、精确的网站名称。
3. 唯一、规范化后相等的网站 URL。

重名、歧义、只填一列、找不到实体、网站被禁用或显式组合未配置为有效 Assignment Pair
都属于阻止启动的映射错误，不能静默使用默认组合。

### CSV 模板

模板包含：

```text
原URL,来源域名,profileId,promotionSiteId
```

模板旁生成当前可用 ID、Profile 显示名、Promotion Site 名称/URL 的映射说明。模板不
包含姓名、邮箱、密码或网站描述。旧 CSV 没有分配列时继续进入加权轮询。

## 批次计划编译与分配预览

### 编译输入与输出

纯函数 `compileBatchPlan` 接收：

- 已验证的领域配置快照。
- 已映射 CSV 行。
- 24 小时成功 URL 集合。
- 用户逐条解除的历史重复阻止集合。
- 当前时间和非法网站规则版本。

返回不可变、安全的 `BatchPlan`：

```js
{
  version: 2,
  planId: 'uuid',
  planFingerprint: 'deterministic-hash',
  configRevision: 'revision',
  createdAt: 0,
  quotas: {},
  profiles: {},
  promotionSites: {},
  tasks: [{
    taskId: 'planId:rowNumber',
    urlIndex: 0,
    targetUrl,
    canonicalTargetUrl,
    targetDomain,
    sourceDomain,
    profileId,
    promotionSiteId,
    assignmentPairId,
    assignmentSource: 'explicit' | 'weighted' | 'default_blocked',
    state: 'eligible' | 'blocked',
    blockReason: null | '...'
  }],
  warnings: [],
  confirmationRequirements: []
}
```

`profiles` 只包含该计划引用的 `id/displayName/name/email` 快照；
`promotionSites` 只包含引用的 `id/name/url/content` 快照。计划不含密码。

`planFingerprint` 覆盖规范化 CSV 数据、领域配置修订、配额、解除项和计划任务。如果 CSV、
映射、配置、配额或解除项发生变化，旧确认失效并必须重新生成预览。

### URL 与安全检查顺序

1. 先解析并校验 CSV 显式引用；引用错误属于计划级错误，即使该 URL 随后会被安全规则
   拦截也不能静默忽略。
2. 规范化 URL：只接受 `http:`/`https:`，小写主机、移除 fragment、规范化默认端口；
   保留 path 和 query 的语义顺序。
3. 验证来源域名和静态黑名单。
4. 使用非法网站过滤器做 URL 级预检查。过滤器不可用属于配置错误，批次不能启动。
5. 同批次规范化 URL 去重，只保留第一条可发送行。
6. 检查最近 24 小时本地成功历史。历史读取失败时不允许跳过安全检查并启动。
7. 对仍可发送的行按 CSV 顺序应用批次总量和目标域名配额。
8. 为剩余行解析显式组合或执行加权轮询，同时应用 Profile 和 Promotion Site 配额。

每个进入计划和批次结果的有效目标行都必须有一个非敏感 Assignment 快照：

- 已显式分配但被安全或总量规则阻止的行保留其显式组合。
- 未显式分配且在进入加权轮询前已经被阻止的行绑定默认组合，并使用
  `assignmentSource: 'default_blocked'`。
- 自动行因所有组合的 Profile/Site 配额耗尽时，绑定忽略容量后本应选择的确定性组合，
  记录稳定 quota reason，但不推进平滑权重。

非法、重复、历史阻止、批次总量和目标域名阻止的行不消耗平滑权重或 Profile/Site
配额。它们仍进入计划和批次结果，以便预览、统计和结果 CSV 给出稳定归属与原因。

### 确定性加权轮询

自动行按 CSV 原始顺序使用平滑加权轮询。选择候选组合时同时检查剩余 Profile 和
Promotion Site 配额：

- 有可用组合时选择当前平滑权重最高者，并更新确定性权重状态。
- 某组合因 Profile 或 Site 配额耗尽时，本行尝试下一个仍可用的已批准组合。
- 所有组合都耗尽时，该行标记为配额阻止。
- CSV 显式组合若超出 Profile 或 Site 配额，直接阻止该行，不自动换组合。
- 目标域名和批次总量按 CSV 行顺序保留前 N 条。

同一输入、配置和历史集合必须生成字节等价的任务归属，与并发数和完成顺序无关。

### 预览确认

预览逐行展示目标 URL、Profile 显示名、Promotion Site 名称/URL、分配来源、是否可发送、
配额或拦截原因。摘要展示每个组合、Profile、Site、目标域名的计划数量。

所有批次都需要一次明确确认。以下任一情况要求第二次高风险确认：

- 使用多个 Profile 或多个 Promotion Site。
- 任意配额高于默认值。
- 解除任意 24 小时历史重复阻止。

确认产生绑定 `planFingerprint` 的短期确认 token。后台启动批次前重新校验 token、
配置修订和 plan fingerprint；不匹配时拒绝启动并要求重新预览。

## 安全批次快照与密码隔离

### 启动事务

后台是批次 checkpoint 和 secret vault 的唯一写入者。启动采用以下顺序：

1. 接收已经确认的安全 `BatchPlan`，重新执行 schema、fingerprint 和确认要求校验。
2. 从 Profile secret repository 读取计划实际引用 Profile 的当前密码。
3. 在一次 `chrome.storage.local.set` 中写入 checkpoint v2 和独立批次 secret vault。
4. 成功后请求 `chrome.power.requestKeepAwake('system')`。
5. 只有上述步骤全部成功，批次才从 `paused_recovery` 进入 `running` 并打开窗口。

Power API 或关键写入失败时不打开任何目标网站，并清理未启动的 secret vault。

### 批次 secret vault

独立存储键按批次保存：

```js
{
  autoCommentBatchSecretVaults: {
    "<batchId>": {
      version: 1,
      createdAt: 0,
      passwordsByProfileId: {
        "profile-a": "..."
      }
    }
  }
}
```

它不属于 checkpoint、URL 队列或普通批次状态。暂停和异常恢复期间保留，以确保运行中
修改 Profile 密码不会改变当前批次。批次 `completed`、`terminated` 或明确清除后，
后台删除对应 vault。后台启动时也清理没有匹配可恢复 checkpoint 的孤立 vault。

### checkpoint v3

并行的桌面作业控制台设计已经把 checkpoint v2 用于
`attempt/phase/manualResolution`。为了避免两个分支产生同号异构 schema，本功能在
集成后使用 checkpoint v3：v3 包含控制台 v2 的全部 attempt/phase 字段，再增加多身份
Assignment 和安全快照字段。Cloudflare 同步协议 v2、领域配置 v2 和 `BATCH_HANDLE`
协议 v2 与 checkpoint 版本相互独立，不受此编号调整影响。

checkpoint v3 在控制台 v2 状态机基础上增加：

- `planFingerprint` 和确认摘要。
- 安全 Profile 与 Promotion Site 快照。
- 每个 task 的 `taskId/profileId/promotionSiteId/assignmentPairId/assignmentSource`。
- `attemptCount`、最近失败阶段和安全错误码。
- 每个结果的归属字段与非敏感显示快照。

checkpoint 明确拒绝 `password`、`secret`、`apiKey`、Cookie 和 token 属性。迁移支持：

- 当前 master 的 v1 直接升级为 v3，同时补齐 attempt/phase 和默认 Assignment。
- 控制台分支的 v2 升级为 v3，保留 attempt/phase/manualResolution，再补齐默认
  Assignment。

升级先进入 `paused_recovery`；旧 checkpoint 用迁移产生的默认组合补齐，这与旧版本原本
只能使用全局默认配置的语义一致。旧 `submitting` 任务仍转换为
`manual_required`，不自动重发。

### 任务消息

每个 `BATCH_HANDLE` 仅携带该任务需要的非敏感快照：

```js
{
  type: 'BATCH_HANDLE',
  protocolVersion: 2,
  batchId,
  taskId,
  urlIndex,
  url,
  profile: { id, displayName, name, email },
  promotionSite: { id, name, url, content },
  assignment: { pairId, source },
  settings: { autoOpenPanel, autoGenerate, autoSubmit }
}
```

它不包含其他 Profile、其他 Site、组合池、配额或密码。`content.js` 的批次流程不再读取
全局 Profile/Site 设置；手动模式通过独立默认组合 adapter 读取当前配置。

### 最小权限密码读取

当且仅当页面实际存在密码字段时，内容脚本发送 `BATCH_GET_TASK_PASSWORD`，消息只包含
`batchId/taskId/urlIndex/profileId`。后台必须同时验证：

- `sender.id` 是当前扩展。
- `sender.tab.id` 存在。
- checkpoint 为当前 `running` 批次。
- task 处于 `active` 或 `submitting`。
- checkpoint 中该 task 的 `tabId` 等于 sender tab。
- task 的 `profileId` 与请求一致。

验证成功后，后台只返回该 Profile 在当前批次 secret vault 中的一个密码。调用者不能
枚举 Profile、指定任意 tab 或读取普通 Profile secret repository。响应不记录日志，
错误只返回稳定码。缺少或空密码按“缺少密码”规则处理。

## 内容脚本与窗口隔离

批次执行上下文从 `{batchId, urlIndex, url}` 升级为包含 `taskId` 和安全任务配置的不可变
对象。以下状态必须按 task key 隔离：

- 推广提示模板和生成文案缓存。
- Profile 表单字段。
- Promotion Site URL。
- 提交恢复上下文。
- 历史 capture 元数据。
- 错误阶段和重试资格。

任务缓存键至少包含 `batchId + taskId + promotionSiteId + configRevision`。收到不同
task key 时不得复用 `lastGeneratedPromotionCopy` 或旧网站模板。内容脚本把密码仅保留在
函数局部变量中，填写后不写入任何 storage 或诊断对象。

提交上下文继续按 sender tab 保存，但增加 `taskId/profileId/promotionSiteId` 等
非敏感归属；不得加入密码。刷新后的内容脚本只补发原任务确认，不重新生成或重新选择
组合。

后台和批次页面接受终态消息时同时校验
`batchId + taskId + urlIndex + sourceTabId`。过期、重复或其他窗口消息不修改结果、不
关闭窗口、不释放其他任务槽位。

## 暂停、恢复、竞态和重试

### 状态

现有批次状态保留：

- `running`
- `paused_recovery`
- `terminated`
- `completed`

任务状态保留并扩展元数据：

- `queued`
- `active`
- `submitting`
- `terminal`

### 异常恢复

- `queued` 保持不变。
- `active` 回到 `queued`，保留原 Assignment 和 `attemptCount`。
- `submitting` 转为一次性的 `manual_required`，注明“提交结果不明确”。
- `terminal` 保持不变。
- secret vault 在可恢复 pause 中保留。
- 恢复前校验 checkpoint 安全快照与 secret vault 结构；结构损坏时保持暂停并显示安全
  错误，不用当前全局设置猜测任务归属。

如果某 Profile 在批次启动时密码为空或 vault 中该项缺失，只有遇到页面必填密码字段时
该任务才转 `manual_required`；没有密码字段的页面仍可继续。

### 一次安全自动重试

内容脚本和窗口控制器上报结构化失败：

```js
{
  phase: 'window_create' | 'content_ready' | 'generate' | 'pre_submit' |
    'submitting' | 'post_submit',
  retryable: true | false,
  errorCode: 'safe_code'
}
```

调度器只在 `attemptCount === 0`、阶段明确早于 `submitting`、错误位于允许名单且没有
submit context 时把任务重新排队。重试先关闭旧窗口、增加 `attemptCount`，再开新窗口。
第二次失败记录终态。用户关闭窗口、字段校验失败、人工验证、非法网站以及任何提交不
明确状态不在允许名单。

重试只影响该任务；其他窗口继续运行。

## 结果与历史

### 批次结果

所有批次结果包含：

```js
{
  taskId,
  originalIndex,
  url,
  sourceDomain,
  result,
  skipReason,
  errorCode,
  errorMessage,
  aiContent,
  profileId,
  profileDisplayName,
  promotionSiteId,
  promotionSiteName,
  promotionSiteUrl,
  assignmentPairId,
  assignmentSource,
  attemptCount,
  timestamp,
  elapsed,
  originalRow
}
```

不包含真实姓名、邮箱、密码或网站描述。配额和重复拦截继续使用 `result: 'skipped'`，
通过稳定 `skipReason` 区分：

- `duplicate_in_batch`
- `recent_success`
- `quota_batch`
- `quota_profile`
- `quota_promotion_site`
- `quota_target_domain`

非法网站继续使用 `blocked_illegal`，必填密码缺失和提交不明确继续使用
`manual_required`。

结果 CSV 保留原始列并追加 Profile/Site ID、显示名、Site URL、分配来源、结果、
skip reason 和 attempt count。CSV 输出继续防止 spreadsheet formula injection，不输出
姓名、邮箱、密码或描述。

### 长期评论历史

长期历史仍只保存确认提交成功的评论。现有本地 IndexedDB comment record 增加：

- `profileId`
- `profileDisplayName`
- `promotionSiteId`
- `promotionSiteName`
- `promotionSiteUrl`
- `assignmentPairId`
- `assignmentSource`
- `taskConfigVersion`

旧历史记录把新字段规范化为空或 `legacy`。数据库新增 Profile 和 Promotion Site 的
筛选索引；历史 service、页面和 CSV 导出支持按两者筛选。历史不保存真实姓名、邮箱、
密码或网站描述。

## Cloudflare/D1 同步兼容

### 集成基线

实现阶段先检查正在收尾的 `codex/cloudflare-comment-sync` 分支或其合并后 master，并以
最新共享协议、outbox、pull/bootstrap 和 D1 migration 为基线。不得复制一套独立同步
实现。插件和 Worker 共享 schema 与敏感字段拒绝规则。

### 协议演进

现有 `/v1` endpoint 保持不变，状态响应增加显式 capability 和协议版本：

```js
{
  protocolVersion: 2,
  capabilities: ['domain_config_entities_v2', 'comment_assignment_fields_v2']
}
```

Worker 先部署兼容扩展：

- 继续接受已有 v1 comment 和 setting mutation。
- 接受 v2 comment 的非敏感 Assignment 字段。
- 接受 `profile`、`promotion_site`、`assignment_pair` 和
  `assignment_policy` mutation。
- pull/bootstrap 对旧客户端仍返回它们可忽略的版本化变化。

pull 和 bootstrap 请求显式携带客户端协议版本。未携带版本的旧客户端按 v1 处理：

- Worker 不向 v1 响应加入 v2 配置 entity 或 v2-only comment 字段。
- v1 增量游标可以越过被过滤的 v2 change，避免旧客户端反复拉取同一页。
- 客户端从 v1 升级到 v2 后，必须先执行一次 v2 domain-config bootstrap，再使用新的
  v2 增量游标，不能沿用已越过配置变化的 v1 游标。

新扩展连接不具备 capability 的旧 Worker 时，不发送 v2 配置实体或 v2-only comment
字段；本地 outbox 保留待同步状态并显示“云端协议待升级”，不能把 v2 payload 降级成
旧全局设置而丢失多身份语义。

### D1 migration

在 Cloudflare 分支的当前最新 migration 之后增加单独编号的 migration：

- Profile 实体表。
- Promotion Site 实体表。
- Assignment Pair 实体表。
- Assignment Policy 单例表。
- 对应 tombstone 或通用配置 tombstone。
- comment records 的 Assignment 非敏感列和筛选索引。
- sync changes 对新实体类型的索引。

migration 必须可从空库和现有 v1 数据库顺序应用，不修改已发布 migration。旧平面设置键
继续可读，但 v2 客户端完成迁移后不再产生其 mutation。

### 冲突规则

- Profile、Site、Pair 和 Policy 使用独立 mutation。
- 同一实体按 Worker 成功接受新 mutation 的顺序覆盖。
- 相同 mutation ID 永久幂等。
- 删除写 tombstone，阻止离线旧设备复活实体。
- pull 应用多个有关联实体时先暂存并整体验证；悬空 Pair 不进入可执行本地配置。
- 远端应用由配置仓库执行并抑制 storage change 回声 mutation。

### 同步白名单与拒绝

允许字段由实体 schema 精确列出。插件在 outbox 入队前过滤，Worker 再验证一次。双方
递归拒绝属性名：

- `password`
- `secret`
- `apiKey` / `llm_api_key`
- `cookie`
- `token`
- `authorization`
- batch checkpoint、URL queue 和 submit context 字段

Profile 的 D1 实体可以包含已批准的显示名、姓名和邮箱；Promotion Site 可以包含名称、
URL、描述和启用状态；Assignment 实体只包含 ID、权重、启用状态和配额。comment 历史
只包含 Profile 显示名和 Promotion Site 显示字段，不包含姓名或邮箱。

## UI 集成契约

### 第一阶段边界

在 UI 重构分支可用前，只新增可测试 controller 和 adapter，不大改
`batch.html/options.html` 的布局。领域层公开：

- `loadDomainConfig`
- `validateDomainConfig`
- `saveProfile` / `deleteProfile`
- `saveProfilePassword` / `clearProfilePassword`
- `savePromotionSite` / `deletePromotionSite`
- `saveAssignmentPolicy`
- `parseBatchCsv`
- `resolveCsvColumnMapping`
- `compileBatchPlan`
- `summarizeBatchPlan`
- `confirmBatchPlan`

UI 层不能直接读取 storage key 或 secret map。

### 集成等待点

进入 UI 集成前必须：

1. 检查并行 UI 任务的分支、提交和 controller 接口。
2. 以其桌面作业控制台结构为准接入上述 adapter。
3. 保留其视觉层和交互组件，不回退或重复实现。
4. 若该分支仍不可用，停止在明确的 UI 集成等待点并报告缺少的分支/契约；不得创建临时
   第二套 Profile/Site 页面绕过依赖。

### UI 必须覆盖的能力

- Profile 列表与非敏感字段编辑，密码单独保存/清除。
- Promotion Site 列表、启用状态和校验。
- 原子组合、权重、默认组合和配额。
- CSV 模板下载、列映射、引用错误。
- 完整分配预览、配额摘要、拦截原因和高风险二次确认。
- 运行结果和长期历史的 Profile/Site 筛选。
- 配置导入预览和安全导出。

## 错误处理与防误发

| 情况 | 行为 |
| --- | --- |
| 配置或 CSV 引用无效 | 阻止生成可确认计划，不打开窗口 |
| 非法网站规则不可用 | 阻止启动，不能静默跳过检查 |
| URL 命中非法规则 | 记录 `blocked_illegal`，不打开窗口 |
| 批次内重复 URL | 第一条之外记录 `skipped/duplicate_in_batch` |
| 最近 24 小时成功 | 默认 `skipped/recent_success`，可逐条解除并二次确认 |
| 配额耗尽 | 记录对应 quota skip reason，继续其他任务 |
| checkpoint/secret 启动写入失败 | 不请求执行、不打开窗口 |
| Power API 失败 | 保持暂停并清理未启动 secret vault |
| 密码请求身份或 tab 不匹配 | 返回 `forbidden_task_secret`，不泄漏是否存在密码 |
| 页面必填密码缺失 | `manual_required`，释放窗口并继续 |
| 提交前允许名单瞬时错误 | 最多重试一次相同 Assignment |
| 已进入 submitting 后中断 | `manual_required`，绝不自动重试 |
| 迟到或其他窗口的结果 | 忽略，不关闭任何当前窗口 |
| D1 不支持 v2 capability | 本地继续工作，v2 outbox 保留并提示升级 |
| 远端配置形成悬空引用 | 不应用为可执行配置，标记需处理 |

日志只记录 ID、安全错误码、阶段和长度，不记录姓名、邮箱、密码、网站描述、评论正文或
完整云 payload。错误对象进入 UI 或测试快照前经过统一 redaction。

## 模块边界

新增或扩展模块按单一职责拆分，避免继续扩大 `batch.js` 和 `content.js`：

- `lib/domain-config-schema.mjs`：实体 schema、规范化和敏感字段拒绝。
- `lib/domain-config-repository.mjs`：local 权威配置与修订。
- `lib/domain-config-migration.mjs`：旧全局配置和密码迁移。
- `lib/profile-secret-repository.mjs`：Profile local-only 密码。
- `lib/domain-config-import-export.mjs`：安全导入、预览、合并和导出。
- `lib/batch-csv-import.mjs`：CSV 解析、列映射和引用解析。
- `lib/batch-plan-compiler.mjs`：URL 安全检查、去重、加权分配和配额。
- `lib/batch-plan-confirmation.mjs`：fingerprint 与风险确认。
- `lib/batch-secret-vault.mjs`：批次密码快照和最小权限读取。
- `lib/batch-task-config.js`：content script 可测试的任务配置与缓存隔离。
- `lib/batch-result-record.mjs`：结果归属、skip reason 和 CSV 字段。
- `lib/batch-runtime-checkpoint.mjs`：checkpoint v3、v1 直升和控制台 v2 升级。
- Cloudflare 分支现有协议、service 和 Worker 模块：扩展 v2 entity，不另建平行实现。

`batch.js` 只负责把 UI controller、计划、scheduler 和 window manager 连接起来；
`content.js` 只负责页面检测、生成、填充、提交和上报结构化阶段。

## 测试策略

### 领域与迁移

- Profile/Site/Pair/Policy schema 的有效和无效边界。
- Profile 领域对象不能携带密码或敏感额外属性。
- 旧单身份/单网站幂等迁移为固定默认实体。
- local 密码优先；sync 密码必须先成功复制并验证后才删除。
- 迁移失败保留原密码并可重试。
- 旧 v1 和控制台 v2 checkpoint 安全升级且不会自动重发 submitting 任务。

### 导入与导出

- 新格式按 ID 合并并保留本机密码。
- 旧格式密码只写 Profile secret repository。
- 导出递归不包含密码、API Key、secret、Cookie、token、checkpoint 或 URL 队列。
- 导入不能用缺省或空值清除本机密码。
- CSV 输出防止公式注入。
- 测试只使用运行时生成的合成 secret sentinel，不提交真实密码 fixture，也不输出值。

### CSV 与分配

- 旧 CSV 自动映射并使用加权轮询。
- 任意列映射、ID、唯一显示名、网站名称和 URL 引用。
- 两列只填一列、歧义名称、禁用 Site、悬空或未批准组合阻止启动。
- 同一输入生成完全确定的平滑加权结果。
- 并发数和完成顺序不影响 Assignment。
- 默认四类配额及调高确认。
- 自动组合跳过耗尽 Pair，显式组合超额不重映射。
- 批次内 URL 去重和 24 小时成功阻止。
- 解除历史阻止必须产生二次确认要求。
- illegal/duplicate/recent-success 行不消耗权重和配额。

### secret 与消息安全

- 批次开始冻结引用 Profile 的密码，之后修改普通 Profile 密码不影响运行批次。
- checkpoint、URL queue、`BATCH_HANDLE`、submit context、结果和历史不含密码。
- 正确 tab/task/Profile 只能读取自己的一项批次密码。
- 伪造 tab、旧 task、错误 Profile、已终态 task 和外部 sender 被拒绝。
- 清除一个批次 vault 不影响其他本地 Profile 密码。
- completed、terminated、clear 和孤立 vault 清理。
- 日志和公开错误响应不含 secret sentinel。

### checkpoint、调度与竞态

- 每条 task 快照包含正确 Assignment 且恢复不重算。
- 三个以上窗口乱序完成时结果不串线。
- 迟到消息、重复确认、旧批次消息和错误 source tab 被忽略。
- `active` 恢复为同 Assignment queued。
- `submitting` 恢复为一次性 manual required。
- 允许名单错误只重试一次且使用相同 Assignment。
- manual、illegal、quota、duplicate、用户关闭和 submitting 错误不重试。
- 单任务失败或密码缺失释放槽位，不暂停整批。

### 结果与历史

- 所有批次结果包含 Profile/Site ID 和必要非敏感快照。
- 结果和历史不含姓名、邮箱、密码或网站描述。
- 本地成功历史按 Profile/Site 独立及组合筛选。
- 旧历史归为 legacy 并保持可读。
- 长期历史只写确认成功评论，非成功结果不进入 D1 comment history。
- 历史和批次 CSV 导出字段、筛选和分页稳定。

### Cloudflare/D1

- 新 migration 可从空库和现有 v1 库顺序应用。
- v1 Worker/client 行为继续通过。
- capability 协商阻止新客户端把 v2 配置错误降级。
- Profile/Site/Pair/Policy mutation 独立、幂等并有 tombstone。
- pull/bootstrap 关联实体顺序变化时不会应用悬空 Pair。
- comment Assignment 字段可筛选且不包含姓名、邮箱或描述。
- 插件和 Worker 双重拒绝任何嵌套敏感字段。
- 不上传批次 URL 队列、checkpoint 或 submit context。

### UI 与真实 Chrome fixture

UI 分支集成后使用其 controller 测试覆盖：

- Profile/Site 编辑和密码独立保存。
- 组合、权重、默认配额和 CSV 列映射。
- 分配预览与二次确认。
- 运行结果和历史筛选。
- 安全导入导出。

真实 Chrome 验收使用临时浏览器配置、解压扩展和 loopback fixture server：

1. 创建 2 个 Profile 和 2 个 Promotion Site，密码使用进程内临时生成值。
2. 配置至少 2 个已批准 Assignment Pair 和确定权重。
3. 导入 5 个指向本地 fixture 的不同目标 URL。
4. 并发数设为 3。
5. fixture 页面只把提交字段写入本地测试进程，不访问第三方网络。
6. 断言每条任务的姓名、邮箱、可选密码、推广 URL 和生成上下文与计划一致。
7. 断言任意时刻最多 3 个工作窗口、任务乱序完成不串线、结果含正确 ID。
8. 在一个任务完成、一个 active、一个 submitting 的边界验证暂停/恢复保守行为。
9. 验收后删除临时 Chrome profile、fixture 数据和批次 secret vault。

## 验收标准

- 旧用户升级后自动拥有一个默认 Profile、默认 Promotion Site 和默认组合，旧 CSV 无需
  修改即可运行。
- 一个包含 5 个本地目标的计划可以稳定分配给 2 个 Profile 和 2 个 Promotion Site。
- 3 个并发窗口各自只使用 `BATCH_HANDLE` 中的安全任务配置，并按最小权限取得自己的
  密码。
- 运行中修改 Profile、Site 或密码不改变已启动批次。
- 暂停、Chrome 重启和断电恢复后，每个未完成任务仍使用原 Assignment。
- 提交结果不明确的任务不自动重试；允许名单内的提交前瞬时故障最多重试一次。
- 配额、同批次重复、24 小时成功重复和非法网站在打开第三方窗口前被拦截。
- 单条任务失败、缺少必填密码或被拦截不会暂停其他任务。
- 批次结果和成功历史可按 Profile/Site 筛选，并且没有密码、姓名、邮箱或网站描述泄漏
  到不应出现的结果/历史位置。
- Profile/Site/Assignment 非敏感配置通过 D1 v2 entity 安全同步，旧 v1 同步继续兼容。
- 配置导出、CSV 导出、云 payload、checkpoint、submit context、日志和测试输出均不
  含密码。
- 完整 `npm test`、Cloudflare Worker 测试、类型检查、语法检查和真实 Chrome 本地
  fixture 验收全部通过。
- 分支只包含本任务和经批准 UI 集成的改动，不回退其他任务或用户改动。

## 实施顺序与协作边界

1. 在当前独立 worktree 完成纯领域模型、迁移、CSV、计划编译、secret vault 和自动化
   测试；checkpoint 集成等待控制台 v2 契约可用后升级为 v3。
2. 检查并集成 Cloudflare 分支最新提交，扩展协议、D1 migration 和历史筛选。
3. 检查 UI 重构任务的分支和契约；只有依赖可用后才接入页面。
4. 完成 content/background/batch 的薄适配，删除批次流程对全局 Profile/Site 的读取。
5. 运行 Node、Worker、语法和真实 Chrome fixture 验收。
6. 自审敏感字段、竞态、迁移和向后兼容，提交干净分支。

每一阶段都按 TDD：先写失败测试，确认失败原因正确，再实现最小代码并跑相关回归。UI
依赖和 Cloudflare 基线发生变化时，以其最新已提交契约为准调整 adapter，不回退对方
改动。
