import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const screenshotDirectory = path.join(projectRoot, 'docs', 'qa', 'screenshots');

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
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
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

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

function createStaticServer() {
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const requestedPath = decodeURIComponent(requestUrl.pathname);
      const absolutePath = path.resolve(projectRoot, `.${requestedPath}`);
      if (
        request.method !== 'GET'
        || !absolutePath.startsWith(`${projectRoot}${path.sep}`)
      ) {
        response.writeHead(404).end('Not Found');
        return;
      }
      const body = await fs.readFile(absolutePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': MIME_TYPES[path.extname(absolutePath)]
          || 'application/octet-stream'
      });
      response.end(body);
    } catch (_) {
      response.writeHead(404).end('Not Found');
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

async function layoutState(page) {
  return page.evaluate(() => {
    const contentRect = document.querySelector(
      '[data-console-content]'
    ).getBoundingClientRect();
    const overviewRect = document.querySelector(
      '[data-console-overview]'
    ).getBoundingClientRect();
    const queueRect = document.querySelector(
      '.batch-console__queue'
    ).getBoundingClientRect();
    const slotGrid = document.querySelector('.batch-console__slots');
    const slotGridColumns = getComputedStyle(slotGrid)
      .gridTemplateColumns
      .split(/\s+/)
      .filter((column) => Number.parseFloat(column) > 0);
    return {
      cards: document.querySelectorAll('[data-task-card]').length,
      cardsDisplay: getComputedStyle(
        document.querySelector('.batch-console__cards')
      ).display,
      clientWidth: document.documentElement.clientWidth,
      contentLeft: contentRect.left,
      contentRight: contentRect.right,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: (
        document.documentElement.scrollWidth
        > document.documentElement.clientWidth
      ),
      overviewBottom: overviewRect.bottom,
      overviewRect: {
        top: overviewRect.top,
        right: overviewRect.right,
        bottom: overviewRect.bottom,
        left: overviewRect.left,
        width: overviewRect.width,
        height: overviewRect.height
      },
      previewTitles: Array.from(document.querySelectorAll(
        '[data-task-row="18"] [data-preview-value]'
      )).map((node) => node.title),
      queueLeft: queueRect.left,
      queueRight: queueRect.right,
      queueRect: {
        top: queueRect.top,
        right: queueRect.right,
        bottom: queueRect.bottom,
        left: queueRect.left,
        width: queueRect.width,
        height: queueRect.height
      },
      queueTop: queueRect.top,
      slotGridColumns,
      slots: document.querySelectorAll('[data-worker-slot]').length,
      tableDisplay: getComputedStyle(
        document.querySelector('.batch-console__table-wrap')
      ).display
    };
  });
}

async function main() {
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error('installed_chrome_not_found');
  const { chromium } = loadPlaywright();
  const server = createStaticServer();
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const fixtureUrl = `${origin}/tests/fixtures/batch-console-page.html`;
  const requestedUrls = [];
  const pageErrors = [];
  let browser;

  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--disable-background-networking']
    });
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => requestedUrls.push(request.url()));
    await fs.mkdir(screenshotDirectory, { recursive: true });

    const layouts = {};
    for (const [width, expectedMode] of [
      [1440, 'table'],
      [1024, 'table'],
      [640, 'cards']
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
      await page.locator('[data-batch-status]').waitFor();
      const state = await layoutState(page);
      assert.equal(state.clientWidth, width);
      assert.equal(state.documentWidth, width);
      assert.equal(state.horizontalOverflow, false);
      assert.ok(state.overviewBottom <= state.queueTop);
      assert.ok(Math.abs(state.queueLeft - state.contentLeft) <= 1);
      assert.ok(Math.abs(state.queueRight - state.contentRight) <= 1);
      assert.ok(state.slotGridColumns.length >= 1);
      assert.equal(state.slots, 3);
      assert.equal(
        expectedMode === 'table' ? state.tableDisplay : state.cardsDisplay,
        expectedMode === 'table' ? 'block' : 'grid'
      );
      if (expectedMode === 'table') {
        assert.equal(state.cardsDisplay, 'none');
      } else {
        assert.equal(state.tableDisplay, 'none');
        assert.equal(state.cards, 5);
      }
      if (width === 1440) {
        assert.deepEqual(state.previewTitles, [
          'Fixture safe retry draft.',
          'Old Blog Guide · Promotion Home',
          'https://fixture-promo.test/old-blog'
        ]);
      }
      await page.screenshot({
        fullPage: true,
        path: path.join(
          screenshotDirectory,
          `batch-console-${width}.png`
        )
      });
      layouts[width] = state;
    }

    await page.getByLabel('状态', { exact: true }).selectOption('failed');
    assert.equal(
      await page.locator('.batch-console__cards [data-task-card]').count(),
      1
    );
    const failedCard = page.locator(
      '.batch-console__cards [data-task-card="18"]'
    );
    await failedCard.locator('[data-action="details"]').click();
    const drawer = page.locator('[data-task-drawer]');
    await drawer.waitFor();
    const drawerText = await drawer.textContent();
    assert.match(drawerText, /Fixture safe retry draft\./);
    assert.match(drawerText, /Old Blog Guide · Promotion Home/);
    assert.match(drawerText, /https:\/\/fixture-promo\.test\/old-blog/);
    await drawer.locator('[data-drawer-close]').click();
    assert.equal(
      await failedCard.locator('[data-action="details"]').evaluate(
        (element) => document.activeElement === element
      ),
      true
    );

    await page.getByLabel('状态', { exact: true }).selectOption('all');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', {
      name: '安全暂停',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: '继续处理',
      exact: true
    }).waitFor();
    assert.equal(
      await page.locator('[data-batch-status]').textContent(),
      '已暂停，可恢复'
    );
    await page.getByRole('button', {
      name: '继续处理',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: '暂停',
      exact: true
    }).waitFor();
    assert.equal(
      await page.locator('[data-batch-status]').textContent(),
      '运行中'
    );
    await page.getByRole('button', {
      name: '停止批次…',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: '停止并保留结果',
      exact: true
    }).click();
    assert.equal(
      await page.locator('[data-batch-status]').textContent(),
      '已永久停止'
    );

    for (const requestedUrl of requestedUrls) {
      const requested = new URL(requestedUrl);
      assert.equal(requested.origin, origin);
    }
    assert.deepEqual(pageErrors, []);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      chromeVersion: await browser.version(),
      fixtureOrigin: origin,
      layouts: Object.fromEntries(Object.entries(layouts).map(
        ([width, state]) => [width, {
          mode: state.tableDisplay === 'block' ? 'table' : 'cards',
          horizontalOverflow: state.horizontalOverflow,
          overviewRect: state.overviewRect,
          queueRect: state.queueRect,
          slotGridColumns: state.slotGridColumns,
          slots: state.slots
        }]
      )),
      interactions: [
        'filter',
        'details',
        'preview',
        'focus-restore',
        'pause',
        'resume',
        'stop'
      ],
      pageErrors,
      thirdPartyRequests: 0
    }, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await closeServer(server);
  }
}

await main();
