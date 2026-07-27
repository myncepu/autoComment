# Task 4 Report: Runtime Commands and Migration-on-Read

## 实现摘要

- `readCheckpoint()` 在串行读取路径内调用
  `migrateBatchRuntimeCheckpoint()`；version 1 checkpoint 首次读取时写回
  version 2，后续读取不重复写入，迁移/校验错误原样返回且不清空存储。
- runtime controller 新增并安装消息白名单：
  `BATCH_TASK_PHASE`、`BATCH_TASK_RETRY`、
  `BATCH_TASK_MANUAL_UPDATE`。每条已接受命令均返回事件层更新后的
  checkpoint。
- `BATCH_TASK_ACTIVE`、`BATCH_TASK_SUBMITTING`、
  `BATCH_TASK_TERMINAL` 以及 background `markTerminal()` 全部透传
  `attempt`；`BATCH_CONFIRMED` 保留原始 `attempt`。
- 中断恢复只读取 `normalizeInterruptedBatch()` 返回的
  `orphanTabIds`，逐个调用 `tabs.remove(tabId)`；不再读取
  `orphanWindowIds`，controller 不再依赖或调用 `windows.remove()`。
- 人工处理窗口语义未修改；本任务只增加人工状态持久化命令。

## 修改文件

- `lib/batch-runtime-controller.mjs`
- `tests/batch-runtime-controller.test.mjs`
- `background.js`
- `tests/comment-history-message-listener.test.mjs`
- `.superpowers/sdd/2026-07-26-batch-operations-console/task-4-report.md`

`tests/comment-history-message-listener.test.mjs` 是 brief 允许的最小
background listener fixture 修改：为现有真实 background 集成流程补
`attempt: 1`，并断言 `BATCH_CONFIRMED.attempt === 1`。
`tests/batch-multi-window-integration.test.js` 未需修改，但已包含在 affected
suite 中完整运行。

## RED / GREEN 证据

1. Tab-only 恢复
   - RED：
     `node --test --test-name-pattern='loading a stale running batch closes only worker tabs' tests/batch-runtime-controller.test.mjs`
   - 首次预期失败：
     `TypeError: Cannot read properties of undefined (reading 'map')`，
     位置为旧 `closeOrphanWindows(normalized.orphanWindowIds)`。
   - attempt 透传前的下一次预期失败：任务仍为 `queued`，证明旧
     ACTIVE/SUBMITTING 路径丢失 attempt。
   - GREEN：同命令 1/1 pass。

2. Migration-on-read
   - RED：
     `node --test --test-name-pattern='migrates version 1 exactly once' tests/batch-runtime-controller.test.mjs`
   - 预期失败：GET 返回 `unsupported_version`，测试读取不到
     `checkpoint.version`。
   - GREEN：同命令 1/1 pass；两次读取只产生一次 version 2 set。

3. Phase command
   - RED：
     `node --test --test-name-pattern='returns the checkpoint updated by a task phase command' tests/batch-runtime-controller.test.mjs`
   - 预期失败：响应 `ok` 为 false（unsupported message）。
   - GREEN：同命令 1/1 pass。

4. Retry command 与 terminal attempt
   - RED：
     `node --test --test-name-pattern='returns the checkpoint advanced by a task retry command' tests/batch-runtime-controller.test.mjs`
   - 首次预期失败：terminal event 丢失 attempt；补透传后再次按预期在
     unsupported retry message 处失败。
   - GREEN：同命令 1/1 pass，任务 attempt 从 1 增至 2 并回到 queued。

5. Manual update command
   - RED：
     `node --test --test-name-pattern='returns the checkpoint updated by a task manual status command' tests/batch-runtime-controller.test.mjs`
   - 预期失败：响应 `ok` 为 false（unsupported message）。
   - GREEN：同命令 1/1 pass。

6. Background attempt-aware terminal / confirmation
   - RED：
     `node --test --test-name-pattern='background migrates an old record' tests/comment-history-message-listener.test.mjs`
   - 预期失败：
     `checkpoint_write_failed:stale_attempt`。
   - GREEN：同命令 1/1 pass，并验证 broadcast attempt 为 1。

## 测试结果

- Controller suite：
  `node --test tests/batch-runtime-controller.test.mjs`
  - 13 tests，13 pass，0 fail。
- Affected suites：
  `node --test tests/batch-runtime-controller.test.mjs tests/batch-multi-window-integration.test.js`
  - 41 tests，41 pass，0 fail。
- Full suite：
  `npm test`
  - 259 tests，259 pass，0 fail。

## `windows.remove` 已消除的证据

- 行为证据：恢复测试让两个 worker 使用相同 `windowId: 11`、不同
  `tabId: 1/2`；恢复后 `removedTabs` 严格为 `[1, 2]`，
  `removedWindows` 严格为空。共享浏览器窗口及其中的控制台 tab 不受影响。
- 静态证据：
  `rg -n "orphanWindowIds|windows\\.remove|closeOrphanWindows" lib/batch-runtime-controller.mjs background.js tests/batch-runtime-controller.test.mjs`
  无匹配；controller 恢复路径只匹配 `tabs.remove(tabId)` 与
  `normalized.orphanTabIds`。

## Commit

- 计划提交主题：
  `feat: expose batch phase retry and manual commands`
- 本报告与实现纳入同一个小提交；最终 SHA 记录在任务完成回复中。

## 自检

- [x] 仅 background 写 `batchRuntimeCheckpoint`。
- [x] 当前 task 消息缺失/陈旧 attempt 时由事件层拒绝。
- [x] 未增加自动重试；retry 仍由显式命令和既有风险策略控制。
- [x] 恢复只关闭 worker tabs，不关闭共享自动窗口或控制台 tab。
- [x] 未改变人工处理窗口的独立窗口、非自动化语义。
- [x] 未引入远程资源、inline handler 或 MV3/CSP 不兼容代码。
- [x] 未发现 Task 4 范围外的新回归。

## Important 审查修复：untracked confirmation attempt 校验

独立审查发现 `markTerminal()` 先执行 no-checkpoint、stale-batch 和
missing-task 三个 `untracked: true` 早退，导致缺失 attempt 的当前
confirmation 被接受，background 随后可能广播
`BATCH_CONFIRMED.attempt: undefined`。

修复内容：

- `markTerminal()` 在 storage 读取及所有 untracked 早退之前，要求
  `message.attempt` 为大于等于 1 的整数。
- 缺失或无效 attempt 返回 `{ ok: false, error: 'stale_attempt' }`，
  与既有 checkpoint 事件层错误保持一致。
- 有效 attempt 的 untracked 兼容行为保持不变。
- background listener 集成 fixture 中会成功进入 confirmation 广播的
  `BATCH_HISTORY_FALLBACK_DURABLE` 和 `BATCH_REPORT_RESULT` 均显式补
  `attempt: 1`；不会再期待 undefined attempt 广播。

### 审查修复 RED / GREEN

- 聚焦 RED：
  `node --test --test-name-pattern='rejects a missing attempt before every untracked terminal return' tests/batch-runtime-controller.test.mjs`
  - 预期失败：no-checkpoint 路径实际返回
    `{ ok: true, error: undefined }`，而期望为
    `{ ok: false, error: 'stale_attempt' }`。
  - 同一测试以三个独立 controller harness 覆盖 no checkpoint、旧
    batchId、不存在 urlIndex 三种 untracked 早退。
- 聚焦 GREEN：同命令 1/1 pass。
- background fixture RED：
  `node --test --test-name-pattern='background migrates an old record' tests/comment-history-message-listener.test.mjs`
  - 预期失败：缺 attempt 的 fallback confirmation 返回
    `checkpoint_write_failed`，不再错误广播。
- background fixture GREEN：同命令 1/1 pass。

### 审查修复测试结果

- Affected suites：
  `node --test tests/batch-runtime-controller.test.mjs tests/comment-history-message-listener.test.mjs tests/batch-multi-window-integration.test.js`
  - 52 tests，52 pass，0 fail。
- Full suite：
  `npm test`
  - 260 tests，260 pass，0 fail。
- Fix commit：本段与修复纳入一个后续小提交；最终 SHA 记录在任务完成回复中。
