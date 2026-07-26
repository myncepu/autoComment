# 30 条多站点自动提交 Chrome 验收

日期：2026-07-27  
分支：`codex/batch-operations-console`  
命令：`npm run test:chrome:auto-submit-30`

## 范围

本次验收使用 6 个独立 loopback HTTP origin 模拟 6 个客座博客，每个博客
提供 5 个目标页面，共 30 个目标。浏览器加载实际 production content
scripts；测试 adapter 只替代 Chrome runtime/storage 和模型服务边界。

所有任务均启用：

- `autoGenerate: true`
- `autoSubmit: true`
- 并发度 5

测试没有读取桌面 OpenRouter key，也没有请求或提交到公网网站。

## Chrome 结果

Chrome 版本：`150.0.7871.184`

```json
{
  "submitted": 30,
  "targetBlogs": 6,
  "maxConcurrency": 5,
  "autoGenerate": true,
  "autoSubmit": true,
  "commentsPerTargetBlog": [5, 5, 5, 5, 5, 5],
  "commentsPerProfile": {
    "profile-a": 10,
    "profile-b": 10,
    "profile-c": 10
  },
  "commentsPerPromotionSite": {
    "site-a": 8,
    "site-b": 8,
    "site-c": 7,
    "site-d": 7
  },
  "confirmations": 30,
  "pageErrors": [],
  "thirdPartyRequests": 0,
  "thirdPartySubmissions": 0,
  "browserCleanup": "forced_closed"
}
```

30 个页面均实际触发评论表单的 `submit` 事件。每条提交都验证了目标 ID、
task ID、`profileId`、`promotionSiteId`、姓名、邮箱、推广 URL 和生成评论
与冻结 handle 一致。每条提交还验证密码确实匹配该任务的 `profileId`；
密码值没有进入 handle、提交记录、浏览器状态报告或本文档。

## 清理 liveness

首次压力运行在 30 条提交和报告完成后遇到一次 Playwright
`context.close()` 不返回；现场中 Chrome 子进程已经退出，而 6 个 fixture
server 因 `finally` 尚未继续执行而保持监听。runner 现在对浏览器上下文
关闭使用 10 秒有界等待，超时后继续关闭浏览器进程；fixture server 使用
独立资源池，即使只有部分 server 启动成功也会全部清理。

回归测试覆盖了永不 settle 的 `context.close()` 和浏览器级关闭；若两层
关闭都超时，runner 返回失败并以非零状态退出。后续真实 Chrome 运行的
`browserCleanup` 为 `forced_closed`，进程正常以状态 0 退出。

## 完整回归

- `npm test`：873/873 通过。
- `npm run test:sync-worker`：99/99 通过。
- `npm run typecheck:sync-worker`：通过。
- Worker deploy dry-run：通过。
- 全部 JS/MJS `node --check`：通过。
- `npm run test:chrome:multi-assignment`：原有并发 3、5 目标、刷新恢复和
  中断重试验收通过。
- `npm run test:chrome:console`：1440/1024/640 布局和控制台交互通过。

## 结论

在本地授权测试环境中，插件的自动生成、自动提交、多目标博客并发、
多身份和多推广网站分配均按预期工作。该结果不代表对未授权公网博客的
发布许可；本次第三方请求与第三方提交均为 0。
