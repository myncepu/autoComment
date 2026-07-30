# Auto Comment 本地控制桥

本地控制桥用于让 Codex、`launchd` 或其他本机脚本在显示器关闭但
Mac 仍保持唤醒时，读取并控制 Auto Comment 批次。

## 安全边界

- 控制服务只监听 `127.0.0.1:4376`。
- 扩展控制令牌保存在 `chrome.storage.local`，不会同步。
- CLI 令牌保存在
  `~/Library/Application Support/AutoComment/control.json`，权限为 `0600`。
- 命令带租约；扩展保存最近命令结果，重复投递不会重复执行。
- 永久停止必须同时提供 `--confirm-permanent` 和当前精确 `batchId`。
- 本地控制桥默认关闭。

## 首次设置

1. 构建并在 Chrome 中重新加载扩展：

   ```bash
   npm run build:extension
   ```

   未打包目录位于 `dist/auto-comment-plugin`。

2. 安装并启动用户级 `LaunchAgent`：

   ```bash
   npm run control:install
   ```

3. 打开扩展设置，启用“本地控制桥”。

扩展后台会立即尝试配对，并通过 30 秒兜底闹钟继续重试。服务与扩展
的先后启动顺序不重要。

`LaunchAgent` 会在当前用户登录时启动控制服务，并在异常退出时重新
启动。可用以下命令检查、重启或卸载：

```bash
npm run control:service-status
npm run control:restart
npm run control:uninstall
```

日志位于
`~/Library/Application Support/AutoComment/logs/control.stdout.log`
和 `control.stderr.log`。需要前台调试时，可先卸载 `LaunchAgent`，再运行
`npm run control:local`。

## 命令

```bash
npm run control -- status
npm run control -- open
npm run control -- start
npm run control -- pause
npm run control -- resume
npm run control -- reconcile
npm run control -- stop --confirm-permanent
```

`start` 的行为：

- 当前批次已经运行：幂等成功；
- 当前批次已暂停：安全继续；
- 当前批处理页中已有经过确认的计划：启动该计划；
- 没有经过确认的计划：拒绝启动，先用 `open` 打开批处理页完成 CSV、
  权限和风险确认。

`stop` 会永久终止当前批次，但保留已有结果。CLI 会先读取权威状态并
取得精确 `batchId`；也可以显式指定：

```bash
npm run control -- stop \
  --batch-id 'batch-id-here' \
  --confirm-permanent
```

所有命令默认等待 90 秒，以覆盖 Manifest V3 后台最慢一次闹钟唤醒。
可以使用 `--timeout` 修改：

```bash
npm run control -- status --timeout 120
```

## 息屏运行条件

- Chrome 必须保持运行；
- 用户必须保持登录；
- Mac 可以关闭显示器，但不能进入整机睡眠；
- `com.autocomment.control` 用户级 `LaunchAgent` 必须保持运行；
- 目标网站不能停在验证码、系统权限提示或需要人工登录的状态。

不要改用系统级 LaunchDaemon，因为 Chrome 扩展运行在已登录用户的
图形会话中。
