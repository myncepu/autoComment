import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAUNCH_AGENT_LABEL = 'com.autocomment.control';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(SCRIPT_PATH), '..');
const SERVER_PATH = join(PROJECT_ROOT, 'scripts', 'serve-local-debug.mjs');
const SUPPORT_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'AutoComment'
);
const LOG_DIR = join(SUPPORT_DIR, 'logs');
const PLIST_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCH_AGENT_LABEL}.plist`
);
const DOMAIN = `gui/${process.getuid()}`;
const SERVICE_TARGET = `${DOMAIN}/${LAUNCH_AGENT_LABEL}`;

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildLaunchAgentPlist({
  nodePath = process.execPath,
  serverPath = SERVER_PATH,
  workingDirectory = PROJECT_ROOT,
  stdoutPath = join(LOG_DIR, 'control.stdout.log'),
  stderrPath = join(LOG_DIR, 'control.stderr.log')
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

async function launchctl(args, { allowFailure = false } = {}) {
  try {
    return await execFileAsync('/bin/launchctl', args, {
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    if (allowFailure) return null;
    const detail = String(error?.stderr || error?.message || '').trim();
    throw new Error(detail || 'launchctl_failed');
  }
}

async function serviceStatus() {
  const result = await launchctl(['print', SERVICE_TARGET], {
    allowFailure: true
  });
  return {
    installed: result !== null,
    label: LAUNCH_AGENT_LABEL,
    plistPath: PLIST_PATH,
    serviceTarget: SERVICE_TARGET,
    detail: result?.stdout || ''
  };
}

async function install() {
  await mkdir(dirname(PLIST_PATH), { recursive: true, mode: 0o755 });
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });

  const temporary = `${PLIST_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, buildLaunchAgentPlist(), { mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, PLIST_PATH);

  await launchctl(['bootout', SERVICE_TARGET], { allowFailure: true });
  await launchctl(['bootstrap', DOMAIN, PLIST_PATH]);
  await launchctl(['enable', SERVICE_TARGET]);
  await launchctl(['kickstart', '-k', SERVICE_TARGET]);

  const status = await serviceStatus();
  if (!status.installed) throw new Error('launch_agent_not_loaded');
  return status;
}

async function uninstall() {
  await launchctl(['bootout', SERVICE_TARGET], { allowFailure: true });
  try {
    await unlink(PLIST_PATH);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return serviceStatus();
}

function usage() {
  return [
    'Usage:',
    '  node scripts/manage-local-control-launch-agent.mjs install',
    '  node scripts/manage-local-control-launch-agent.mjs status',
    '  node scripts/manage-local-control-launch-agent.mjs restart',
    '  node scripts/manage-local-control-launch-agent.mjs uninstall'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'install') {
    const status = await install();
    console.log(JSON.stringify({ ok: true, ...status }, null, 2));
    return;
  }
  if (command === 'status') {
    const status = await serviceStatus();
    console.log(JSON.stringify({ ok: status.installed, ...status }, null, 2));
    if (!status.installed) process.exitCode = 1;
    return;
  }
  if (command === 'restart') {
    const current = await serviceStatus();
    if (!current.installed) throw new Error('launch_agent_not_installed');
    await launchctl(['kickstart', '-k', SERVICE_TARGET]);
    console.log(JSON.stringify({ ok: true, ...(await serviceStatus()) }, null, 2));
    return;
  }
  if (command === 'uninstall') {
    const status = await uninstall();
    console.log(JSON.stringify({ ok: !status.installed, ...status }, null, 2));
    return;
  }
  console.error(usage());
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`AutoComment LaunchAgent 操作失败：${error.message}`);
    process.exitCode = 1;
  });
}
