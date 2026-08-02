import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.AUTOCOMMENT_CONTROL_URL ||
  'http://127.0.0.1:4376';
const CONFIG_PATH = process.env.AUTOCOMMENT_CONTROL_CONFIG || join(
  homedir(),
  'Library',
  'Application Support',
  'AutoComment',
  'control.json'
);
const COMMANDS = new Set([
  'status',
  'open',
  'start',
  'pause',
  'resume',
  'reconcile',
  'stop',
  'pair',
  'unpair'
]);

function usage() {
  return [
    'Usage: autocommentctl <command> [options]',
    '',
    'Commands:',
    '  status                 Show the current authoritative batch state',
    '  open                   Open or reconnect the batch control page',
    '  start                  Start a prepared batch or resume a paused batch',
    '  pause                  Safely pause the current batch',
    '  resume                 Resume the current paused batch',
    '  reconcile              Reconcile the page with the authoritative checkpoint',
    '  stop --confirm-permanent',
    '                         Permanently stop the current batch and retain results',
    '  pair --extension-id <id>',
    '                         Authorize one exact Chrome extension ID',
    '  unpair --confirm-pairing-reset',
    '                         Remove the current extension pairing',
    '',
    'Options:',
    '  --batch-id <id>        Require an exact batch id',
    '  --timeout <seconds>    Wait timeout (default: 90)',
    '  --confirm-permanent    Required for stop',
    '  --replace              Confirm replacement of a different paired ID',
    '  --confirm-pairing-reset',
    '                         Required for unpair'
  ].join('\n');
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function has(name) {
  return process.argv.includes(name);
}

async function loadToken() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    if (
      typeof parsed?.cliToken === 'string' &&
      parsed.cliToken.length >= 32
    ) {
      return parsed.cliToken;
    }
  } catch (_) {}
  throw new Error(
    `控制服务尚未初始化。请先运行 npm run control:local（配置：${CONFIG_PATH}）`
  );
}

async function api(token, pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }).catch((error) => {
    throw new Error(`无法连接本地控制服务：${error.message}`);
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_) {}
  if (!response.ok) {
    throw new Error(body?.error || `local_control_http_${response.status}`);
  }
  return body;
}

async function enqueue(token, command, payload) {
  const response = await api(token, '/api/v1/commands', {
    method: 'POST',
    body: JSON.stringify({ command, payload })
  });
  return response.command;
}

async function waitForResult(token, commandId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(
      token,
      `/api/v1/commands/${encodeURIComponent(commandId)}`
    );
    if (response.command?.state === 'completed') {
      return response.command;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    '等待插件响应超时。请确认 Chrome、AutoComment 和本地控制桥均已启用。'
  );
}

async function execute(token, command, payload, timeoutMs) {
  const queued = await enqueue(token, command, payload);
  return waitForResult(token, queued.id, timeoutMs);
}

async function main() {
  const command = process.argv[2];
  if (!COMMANDS.has(command) || has('--help') || has('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command && !has('--help') && !has('-h') ? 2 : 0;
    return;
  }
  const timeoutSeconds = Number(option('--timeout') || 90);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout 必须是正数');
  }
  const timeoutMs = Math.round(timeoutSeconds * 1000);
  const token = await loadToken();

  if (command === 'pair') {
    const extensionId = option('--extension-id');
    if (!/^[a-p]{32}$/.test(extensionId || '')) {
      throw new Error('--extension-id 必须是 Chrome 显示的 32 位扩展 ID');
    }
    const result = await api(token, '/api/v1/pair/approve', {
      method: 'POST',
      body: JSON.stringify({
        extensionId,
        replace: has('--replace')
      })
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'unpair') {
    if (!has('--confirm-pairing-reset')) {
      throw new Error('解除配对必须显式传入 --confirm-pairing-reset');
    }
    const result = await api(token, '/api/v1/pair/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true })
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const payload = {};
  const explicitBatchId = option('--batch-id');
  if (explicitBatchId) payload.batchId = explicitBatchId;

  if (command === 'stop') {
    if (!has('--confirm-permanent')) {
      throw new Error('永久停止必须显式传入 --confirm-permanent');
    }
    if (!payload.batchId) {
      const status = await execute(token, 'status', {}, timeoutMs);
      payload.batchId = status.result?.background?.batchId;
    }
    if (!payload.batchId) {
      throw new Error('没有可停止的活动批次');
    }
    payload.confirmPermanent = true;
  }

  const completed = await execute(token, command, payload, timeoutMs);
  process.stdout.write(`${JSON.stringify({
    ok: completed.result?.ok === true,
    commandId: completed.id,
    command,
    result: completed.result
  }, null, 2)}\n`);
  if (completed.result?.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
