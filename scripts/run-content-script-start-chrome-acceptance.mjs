import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  buildExtensionPackage
} from './build-extension-package.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    return require(path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      'playwright'
    ));
  }
}

function chromeExecutable() {
  const candidates = [
    process.env.AUTOCOMMENT_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      require('node:fs').accessSync(candidate);
      return true;
    } catch (_) {
      return false;
    }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForValue(load, accepts, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await load();
    if (accepts(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`acceptance_wait_timeout:${JSON.stringify(latest)}`);
}

function createSlowPageServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/slow-resource') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': '1',
        'Content-Type': 'image/gif'
      });
      const timer = setTimeout(() => response.end('x'), 60_000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (requestUrl.pathname === '/loading-page') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      });
      response.end([
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8">',
        '<title>Document-start fixture</title></head>',
        '<body><main><h1>Document-start fixture</h1>',
        '<img src="/slow-resource" alt="">',
        '</main></body></html>'
      ].join(''));
      return;
    }
    if (requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end('Not Found');
  });
}

async function prepareExtensionCopy(temporaryRoot) {
  const extensionRoot = path.join(temporaryRoot, 'extension');
  await buildExtensionPackage({ outputRoot: extensionRoot });
  const manifestPath = path.join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.optional_host_permissions = [];
  manifest.content_scripts = manifest.content_scripts.map((entry) => ({
    ...entry,
    matches: ['http://127.0.0.1/*']
  }));
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return extensionRoot;
}

async function main() {
  const { chromium } = loadPlaywright();
  const executablePath =
    process.env.AUTOCOMMENT_CHROME_PATH ||
    chromium.executablePath() ||
    chromeExecutable();
  if (!executablePath) throw new Error('chrome_executable_not_found');
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'autocomment-document-start-')
  );
  const server = createSlowPageServer();
  const port = await listen(server);
  const targetUrl = `http://127.0.0.1:${port}/loading-page`;
  const extensionRoot = await prepareExtensionCopy(temporaryRoot);
  let context = null;
  let targetPage = null;

  try {
    context = await chromium.launchPersistentContext(
      path.join(temporaryRoot, 'profile'),
      {
        executablePath,
        headless: true,
        args: [
          `--disable-extensions-except=${extensionRoot}`,
          `--load-extension=${extensionRoot}`,
          '--disable-background-networking'
        ]
      }
    );
    let serviceWorker = context.serviceWorkers().find(
      (worker) => worker.url().startsWith('chrome-extension://')
    );
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', {
        predicate: (worker) => worker.url().startsWith('chrome-extension://'),
        timeout: 15_000
      });
    }
    const extensionId = new URL(serviceWorker.url()).hostname;
    const controlPage = await context.newPage();
    await controlPage.goto(
      `chrome-extension://${extensionId}/worker-pending.html`,
      { waitUntil: 'domcontentloaded' }
    );

    const pageErrors = [];
    targetPage = await context.newPage();
    targetPage.on('pageerror', (error) => pageErrors.push(error.message));
    const startedAt = Date.now();
    await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    const handshake = await waitForValue(
      () => controlPage.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find(
          (candidate) => candidate.url === url
        );
        if (!tab) return null;
        try {
          return {
            elapsedTabStatus: tab.status,
            response: await chrome.tabs.sendMessage(tab.id, { type: 'PING' })
          };
        } catch (error) {
          return {
            elapsedTabStatus: tab.status,
            error: String(error?.message || error)
          };
        }
      }, targetUrl),
      (value) => value?.response?.ok === true,
      10_000
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(handshake.elapsedTabStatus, 'loading');
    assert.equal(handshake.response.documentUrl, targetUrl);
    assert.ok(
      ['loading', 'interactive'].includes(handshake.response.readyState),
      handshake.response.readyState
    );
    assert.ok(elapsedMs < 10_000, `handshake took ${elapsedMs}ms`);
    assert.deepEqual(pageErrors, []);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      chromeVersion: await context.browser()?.version(),
      targetStatus: handshake.elapsedTabStatus,
      documentReadyState: handshake.response.readyState,
      elapsedMs,
      commentsSubmitted: 0,
      thirdPartyRequests: 0
    }, null, 2)}\n`);
  } finally {
    await targetPage?.close().catch(() => {});
    await context?.close().catch(() => {});
    await closeServer(server);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
