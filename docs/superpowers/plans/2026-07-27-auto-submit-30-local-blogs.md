# 30 条多站点自动提交验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复的 30 条、多博客、多身份、多推广网站自动提交浏览器验收。

**Architecture:** 保留现有 5 条故障恢复验收，新增独立负载验收脚本。纯数据 helper 生成确定性分配，fixture server 提供 30 个目标，浏览器 runner 只编排 production content scripts 和本地 adapter。

**Tech Stack:** Node.js test runner、HTTP fixture server、Chrome/Chromium、现有 Manifest V3 production content scripts。

## Global Constraints

- 只允许 loopback HTTP、`chrome-extension:` 与 `data:` 请求。
- 禁止向第三方网站提交评论。
- 自动生成和自动提交必须同时开启。
- 使用 6 个本地博客、30 个目标、并发度 5、3 个身份、4 个推广网站。
- canonical assignment 字段是 `profileId` 与 `promotionSiteId`。
- 密码不得进入 handle、checkpoint、history、提交报告或 QA 文档。

---

### Task 1: 30 目标 fixture 契约

**Files:**
- Modify: `scripts/serve-extension-fixture.js`
- Test: `tests/fixture-server.test.js`

**Interfaces:**
- Produces: `GET /stress/:targetId`，其中 `targetId` 为 1–30。
- Preserves: `GET /target/1..5`、`GET /multi/1..5` 和提交记录 API。

- [ ] **Step 1: 写失败测试**

增加测试循环请求 `/stress/1` 到 `/stress/30`，断言页面的
`data-fixture-target` 与请求 ID 一致，并断言 `/stress/0`、
`/stress/31` 返回 404。

- [ ] **Step 2: 运行失败测试**

Run: `node --test --test-name-pattern="thirty stress targets" tests/fixture-server.test.js`

Expected: FAIL，因为 `/stress/:targetId` 尚不存在。

- [ ] **Step 3: 实现最小路由**

将模型 prompt 的 target ID 解析范围扩展到 1–30，并新增严格的
`/^\/stress\/([1-9]|[12]\d|30)$/` 页面路由。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/fixture-server.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/serve-extension-fixture.js tests/fixture-server.test.js
git commit -m "test: add thirty local blog targets"
```

### Task 2: 确定性身份与推广网站分配

**Files:**
- Create: `tests/helpers/auto-submit-load-plan.mjs`
- Create: `tests/auto-submit-load-plan.test.mjs`

**Interfaces:**
- Produces: `createAutoSubmitLoadPlan(origins)`。
- Returns: `{ concurrency, profiles, passwordsByProfileId, promotionSites, tasks, expected }`。

- [ ] **Step 1: 写失败测试**

断言 6 个 origin 生成 30 个唯一任务；每个 origin 5 条；3 个 profile 各
10 条；4 个 promotion site 分布 8、8、7、7；每个 handle 均开启
`autoGenerate` 和 `autoSubmit`，且序列化后不包含 password。

- [ ] **Step 2: 运行失败测试**

Run: `node --test tests/auto-submit-load-plan.test.mjs`

Expected: FAIL，因为 helper 尚不存在。

- [ ] **Step 3: 实现规划器**

按 target index 对 profile 使用 `% 3`、对 promotion site 使用 `% 4`、
对 blog origin 使用 `Math.floor(index / 5)`，生成稳定 task ID、
assignment pair ID 与冻结的安全 profile/site snapshot。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/auto-submit-load-plan.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/helpers/auto-submit-load-plan.mjs tests/auto-submit-load-plan.test.mjs
git commit -m "test: plan thirty automatic submissions"
```

### Task 3: Chrome 30 条自动提交 runner

**Files:**
- Create: `scripts/run-auto-submit-load-chrome-acceptance.mjs`
- Modify: `package.json`
- Create: `docs/qa/2026-07-27-auto-submit-30-chrome.md`

**Interfaces:**
- Consumes: `createFixtureServer()` 与 `createAutoSubmitLoadPlan(origins)`。
- Produces: `npm run test:chrome:auto-submit-30` 的 JSON 验收报告。

- [ ] **Step 1: 写 runner 的静态失败测试**

在 `tests/auto-submit-load-plan.test.mjs` 中读取 runner 与 package script，
断言 runner 只引用本地 fixture、production scripts 和规划器，并且 npm
script 名为 `test:chrome:auto-submit-30`。

- [ ] **Step 2: 运行失败测试**

Run: `node --test tests/auto-submit-load-plan.test.mjs`

Expected: FAIL，因为 runner 与 npm script 尚不存在。

- [ ] **Step 3: 实现浏览器编排**

启动 6 个 server；创建一个临时浏览器 profile；以共享 queue 和 5 个
worker 打开 30 个页面；配置内存密码；注入 production scripts；派发
handle；等待 confirmation；聚合 6 个 server 的提交记录；验证分配、
字段、并发和网络审计；在 `finally` 清理全部资源。

- [ ] **Step 4: 运行 30 条浏览器验收**

Run: `npm run test:chrome:auto-submit-30`

Expected: JSON 中 `submitted: 30`、`maxConcurrency: 5`、
`commentsPerTargetBlog: [5,5,5,5,5,5]`、
`commentsPerPromotionSite: [8,8,7,7]`、
`thirdPartyRequests: 0`、`thirdPartySubmissions: 0`。

- [ ] **Step 5: 运行完整回归**

Run: `npm test`

Expected: 全部 PASS。

Run: `npm run test:sync-worker`

Expected: 99/99 PASS。

Run: `npm run test:chrome:multi-assignment`

Expected: 现有 5 条恢复验收 PASS。

- [ ] **Step 6: 记录 QA 并提交**

QA 文档记录 Chrome 版本、30 条结果、每个博客/身份/推广网站分布、并发
峰值、page error 和网络审计，不记录密码。

```bash
git add package.json scripts/run-auto-submit-load-chrome-acceptance.mjs \
  tests/auto-submit-load-plan.test.mjs \
  docs/qa/2026-07-27-auto-submit-30-chrome.md
git commit -m "test: verify thirty automatic blog submissions"
```

