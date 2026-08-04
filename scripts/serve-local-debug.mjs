import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLocalControlCommandStore
} from '../lib/local-control-command-store.mjs';

const HOST = '127.0.0.1';
const PORT = 4376;
const ORIGIN = `http://${HOST}:${PORT}`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'debug');
const CONFIG_PATH = process.env.AUTOCOMMENT_CONTROL_CONFIG || join(
  homedir(),
  'Library',
  'Application Support',
  'AutoComment',
  'control.json'
);
const ROUTES = new Map([
  ['/', ['local-debug.html', 'text/html; charset=utf-8']],
  ['/local-debug.js', ['local-debug.js', 'text/javascript; charset=utf-8']],
  ['/local-debug.css', ['local-debug.css', 'text/css; charset=utf-8']]
]);
const commandStore = createLocalControlCommandStore();

function token() {
  return randomBytes(32).toString('base64url');
}

async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(temporary, 0o600);
  await rename(temporary, CONFIG_PATH);
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    if (
      typeof parsed?.cliToken === 'string' &&
      parsed.cliToken.length >= 32
    ) {
      return parsed;
    }
  } catch (_) {}
  const created = {
    version: 1,
    cliToken: token(),
    extensionId: null,
    bridgeToken: null,
    updatedAt: Date.now()
  };
  await saveConfig(created);
  return created;
}

let config = await loadConfig();

function safeEqual(expected, supplied) {
  if (
    typeof expected !== 'string' ||
    typeof supplied !== 'string' ||
    expected.length !== supplied.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function bearer(request) {
  const value = String(request.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function extensionOrigin(extensionId) {
  return `chrome-extension://${extensionId}`;
}

function validExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

function writeJson(response, statusCode, body) {
  const data = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(data);
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error('local_control_payload_too_large');
      error.code = 'local_control_payload_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    const error = new Error('local_control_payload_invalid');
    error.code = 'local_control_payload_invalid';
    throw error;
  }
}

function allowExtensionCors(request, response, { pairing = false } = {}) {
  const origin = String(request.headers.origin || '');
  const allowed = pairing
    ? /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
    : (
        validExtensionId(config.extensionId) &&
        origin === extensionOrigin(config.extensionId)
      );
  if (!allowed) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );
  response.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );
  return true;
}

function extensionAuthorized(request) {
  return validExtensionId(config.extensionId) &&
    request.headers.origin === extensionOrigin(config.extensionId) &&
    safeEqual(config.bridgeToken, bearer(request));
}

function cliAuthorized(request) {
  return safeEqual(config.cliToken, bearer(request));
}

async function handlePair(request, response) {
  if (!allowExtensionCors(request, response, { pairing: true })) {
    writeJson(response, 403, { ok: false, error: 'local_control_origin_forbidden' });
    return;
  }
  const body = await readJsonBody(request);
  if (
    !validExtensionId(body.extensionId) ||
    request.headers.origin !== extensionOrigin(body.extensionId) ||
    typeof body.token !== 'string' ||
    body.token.length < 24 ||
    !safeEqual(body.token, bearer(request))
  ) {
    writeJson(response, 401, { ok: false, error: 'local_control_unauthorized' });
    return;
  }
  if (config.extensionId && config.extensionId !== body.extensionId) {
    writeJson(response, 409, {
      ok: false,
      error: 'local_control_extension_mismatch'
    });
    return;
  }
  if (
    config.extensionId !== body.extensionId ||
    !safeEqual(config.bridgeToken, body.token)
  ) {
    config = {
      ...config,
      extensionId: body.extensionId,
      bridgeToken: body.token,
      updatedAt: Date.now()
    };
    await saveConfig(config);
  }
  writeJson(response, 200, { ok: true, paired: true });
}

async function handleExtensionApi(request, response, pathname) {
  if (!allowExtensionCors(request, response) || !extensionAuthorized(request)) {
    writeJson(response, 401, { ok: false, error: 'local_control_unauthorized' });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/v1/commands/next') {
    const command = commandStore.claimNext();
    if (!command) {
      response.writeHead(204, {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': request.headers.origin,
        Vary: 'Origin'
      });
      response.end();
      return;
    }
    writeJson(response, 200, { ok: true, command });
    return;
  }
  const resultMatch = pathname.match(
    /^\/api\/v1\/commands\/([^/]+)\/result$/
  );
  if (request.method === 'POST' && resultMatch) {
    const body = await readJsonBody(request);
    const completed = commandStore.complete(
      decodeURIComponent(resultMatch[1]),
      body.result
    );
    writeJson(response, 200, {
      ok: true,
      command: completed
    });
    return;
  }
  writeJson(response, 404, { ok: false, error: 'not_found' });
}

async function handleCliApi(request, response, pathname) {
  if (!cliAuthorized(request)) {
    writeJson(response, 401, { ok: false, error: 'local_control_unauthorized' });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/v1/commands') {
    const body = await readJsonBody(request);
    const command = commandStore.enqueue(body.command, body.payload || {});
    writeJson(response, 202, { ok: true, command });
    return;
  }
  const commandMatch = pathname.match(/^\/api\/v1\/commands\/([^/]+)$/);
  if (request.method === 'GET' && commandMatch) {
    const command = commandStore.get(decodeURIComponent(commandMatch[1]));
    if (!command) {
      writeJson(response, 404, {
        ok: false,
        error: 'local_control_command_not_found'
      });
      return;
    }
    writeJson(response, 200, { ok: true, command });
    return;
  }
  writeJson(response, 404, { ok: false, error: 'not_found' });
}

async function serveStatic(request, response, pathname) {
  const route = ROUTES.get(pathname);
  if (!route || !['GET', 'HEAD'].includes(request.method || 'GET')) {
    writeJson(response, 404, { ok: false, error: 'not_found' });
    return;
  }
  const [fileName, contentType] = route;
  const filePath = join(ROOT, fileName);
  const file = await stat(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': file.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', ORIGIN).pathname;
  try {
    if (request.method === 'OPTIONS') {
      const pairing = pathname === '/api/v1/pair';
      if (!allowExtensionCors(request, response, { pairing })) {
        writeJson(response, 403, {
          ok: false,
          error: 'local_control_origin_forbidden'
        });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/health') {
      writeJson(response, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        paired: validExtensionId(config.extensionId)
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/pair') {
      await handlePair(request, response);
      return;
    }
    if (
      pathname === '/api/v1/commands/next' ||
      /\/result$/.test(pathname)
    ) {
      await handleExtensionApi(request, response, pathname);
      return;
    }
    if (
      pathname === '/api/v1/commands' ||
      /^\/api\/v1\/commands\/[^/]+$/.test(pathname)
    ) {
      await handleCliApi(request, response, pathname);
      return;
    }
    await serveStatic(request, response, pathname);
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: error?.code || 'local_control_request_failed'
    });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Auto Comment local control: ${ORIGIN}/\n`
      + `CLI config: ${CONFIG_PATH}\n`
  );
});
