# 30 条多站点自动提交验收设计

## 目标

验证 AutoComment 在开启自动生成与自动提交后，能够以固定并发处理
30 个目标页面，并把不同身份与不同推广网站的评论提交到多个相互隔离的
本地博客站点。测试不得请求或提交到公网第三方网站。

## 验收拓扑

- 启动 6 个独立 loopback HTTP origin，分别代表 6 个客座博客站点。
- 每个站点提供 5 个独立文章页面，共 30 个目标。
- 并发度固定为 5；30 个目标必须全部进入实际浏览器页面并触发原生表单
  `submit` 事件。
- 使用 3 个测试身份，每个身份承担 10 条任务。
- 使用 4 个测试推广网站，按确定性轮转分配，评论数分布为 8、8、7、7。
- 所有 handle 均设置 `autoGenerate: true` 与 `autoSubmit: true`。
- handle、提交记录和输出报告只包含 `profileId`、`promotionSiteId` 与安全
  预览字段；测试密码只注入 fake Chrome 的内存 password map。

## 组件边界

`scripts/serve-extension-fixture.js` 增加 `/stress/:targetId` 路由，
`targetId` 只接受 1–30。现有 `/target/1..5` 与 `/multi/1..5` 契约保持
不变。

`tests/helpers/auto-submit-load-plan.mjs` 是纯数据规划器。它接收 6 个
origin，输出身份、推广网站、30 个 handle 和预期分布，不依赖 Chrome。

`scripts/run-auto-submit-load-chrome-acceptance.mjs` 负责启动 6 个 fixture
server、以 5 个 worker 并发打开目标页面、注入现有 production content
scripts、派发 handle，并聚合各站点提交记录。它不修改生产代码，也不向
生产包暴露全局测试入口。

## 成功标准

1. 30 个 handle 均被同步确认接受，30 个任务均出现成功 confirmation。
2. 6 个本地博客各收到 5 条评论，且 target ID 唯一，无漏交或重复提交。
3. 3 个身份各提交 10 条；4 个推广网站分别提交 8、8、7、7 条。
4. 最大同时活动页面数恰好为 5。
5. 每条提交的姓名、邮箱、推广 URL、评论内容和 assignment ID 与冻结
   handle 一致，密码字段已填写但密码值不出现在报告中。
6. 浏览器 page error 为 0；观察到的非 loopback 请求为 0；第三方提交为
   0。
7. 现有 5 条恢复验收、仓库单元测试、Worker 测试和语法检查继续通过。

## 失败处理

任何目标超时、重复 target ID、分配漂移、confirmation 缺失、页面异常或
非 loopback 请求都会让验收脚本以非零状态退出。无论成功或失败，浏览器
上下文、临时 profile 与 6 个 HTTP server 都必须在 `finally` 中释放。

