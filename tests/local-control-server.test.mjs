import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXTENSION_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BRIDGE_TOKEN_A = 'bridge-token-a-1234567890-abcdefghijklmnop';
const BRIDGE_TOKEN_B = 'bridge-token-b-1234567890-abcdefghijklmnop';
const execFileAsync = promisify(execFile);

async function startControlServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'autocomment-control-'));
  const configPath = join(directory, 'control.json');
  const child = spawn(
    process.execPath,
    ['scripts/serve-local-debug.mjs'],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AUTOCOMMENT_CONTROL_CONFIG: configPath,
        AUTOCOMMENT_CONTROL_PORT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`local_control_server_start_timeout:${stderr}`));
    }, 5000);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(
        /Auto Comment local control: (http:\/\/127\.0\.0\.1:\d+)\//
      );
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`local_control_server_exited:${code}:${stderr}`));
    });
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { origin, configPath };
}

async function request(origin, pathname, {
  token,
  extensionId,
  method = 'POST',
  body
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (extensionId) {
    headers.Origin = `chrome-extension://${extensionId}`;
  }
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json()
  };
}

function pair(origin, extensionId, token) {
  return request(origin, '/api/v1/pair', {
    token,
    extensionId,
    body: { extensionId, token }
  });
}

async function runCli(origin, configPath, args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/autocommentctl.mjs', ...args],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AUTOCOMMENT_CONTROL_CONFIG: configPath,
        AUTOCOMMENT_CONTROL_URL: origin
      }
    }
  );
  return JSON.parse(stdout);
}

test('local control requires CLI-approved pairing and supports explicit replacement and reset', async (t) => {
  const { origin, configPath } = await startControlServer(t);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const mode = (await stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(config.version, 2);

  const unapproved = await pair(origin, EXTENSION_A, BRIDGE_TOKEN_A);
  assert.equal(unapproved.status, 409);
  assert.equal(
    unapproved.body.error,
    'local_control_pairing_approval_required'
  );

  const approved = await runCli(origin, configPath, [
    'pair',
    '--extension-id',
    EXTENSION_A
  ]);
  assert.deepEqual(approved, {
    ok: true,
    approved: true,
    extensionId: EXTENSION_A,
    replacing: false
  });
  assert.equal((await pair(origin, EXTENSION_A, BRIDGE_TOKEN_A)).status, 200);

  const hijack = await pair(origin, EXTENSION_B, BRIDGE_TOKEN_B);
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.error, 'local_control_pairing_approval_required');

  const unsafeReplacement = await request(origin, '/api/v1/pair/approve', {
    token: config.cliToken,
    body: { extensionId: EXTENSION_B }
  });
  assert.equal(unsafeReplacement.status, 409);
  assert.equal(
    unsafeReplacement.body.error,
    'local_control_pairing_replacement_confirmation_required'
  );

  const replacement = await runCli(origin, configPath, [
    'pair',
    '--extension-id',
    EXTENSION_B,
    '--replace'
  ]);
  assert.equal(replacement.replacing, true);
  assert.equal((await pair(origin, EXTENSION_B, BRIDGE_TOKEN_B)).status, 200);

  const queued = await request(origin, '/api/v1/commands', {
    token: config.cliToken,
    body: { command: 'pause', payload: {} }
  });
  assert.equal(queued.status, 202);
  const commandId = queued.body.command.id;
  const claimed = await request(origin, '/api/v1/commands/next', {
    token: BRIDGE_TOKEN_B,
    extensionId: EXTENSION_B,
    method: 'GET'
  });
  assert.equal(claimed.body.command.id, commandId);
  const completed = await request(
    origin,
    `/api/v1/commands/${encodeURIComponent(commandId)}/result`,
    {
      token: BRIDGE_TOKEN_B,
      extensionId: EXTENSION_B,
      body: { result: { ok: true } }
    }
  );
  assert.equal(completed.body.command.state, 'completed');

  const unsafeReset = await request(origin, '/api/v1/pair/reset', {
    token: config.cliToken,
    body: { confirm: false }
  });
  assert.equal(unsafeReset.status, 409);
  assert.equal(
    unsafeReset.body.error,
    'local_control_pairing_reset_confirmation_required'
  );
  const reset = await runCli(origin, configPath, [
    'unpair',
    '--confirm-pairing-reset'
  ]);
  assert.deepEqual(reset, { ok: true, paired: false });
  assert.equal(
    (await request(origin, '/api/v1/commands/next', {
      token: BRIDGE_TOKEN_B,
      extensionId: EXTENSION_B,
      method: 'GET'
    })).status,
    401
  );
});
