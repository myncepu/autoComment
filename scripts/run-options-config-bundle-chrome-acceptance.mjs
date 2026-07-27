import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createFixtureServer } = require('./serve-extension-fixture.js');
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const presetPath = path.join(
  projectRoot,
  'examples',
  'autocomment-local-dry-run-config.json'
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

async function textOf(page, selector) {
  return (await page.locator(selector).textContent())?.trim() || '';
}

async function numericValue(page, selector) {
  return Number(await page.locator(selector).inputValue());
}

async function importPreset(page) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#importConfigBtn').click()
  ]);
  await fileChooser.setFiles(presetPath);
  await page.locator('#applyImportConfigBtn').waitFor({ state: 'visible' });
}

async function main() {
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error('installed_chrome_not_found');
  const { chromium } = loadPlaywright();
  const server = createFixtureServer();
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
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
    await page.goto(`${origin}/options-config-bundle/`, {
      waitUntil: 'networkidle'
    });

    assert.equal(await textOf(page, '#fixtureProfileCount'), '0');
    assert.equal(await textOf(page, '#fixturePromotionSiteCount'), '0');
    assert.equal(await textOf(page, '#fixturePairCount'), '0');
    assert.equal(await textOf(page, '#fixtureDomainWrites'), '0');
    assert.equal(await textOf(page, '#fixtureSettingsWrites'), '0');

    await importPreset(page);
    assert.equal(
      await textOf(page, '#fixturePreviewDetails'),
      '3 Profiles · 3 Sites · 3 Pairs · 3 setting groups'
    );
    assert.match(await textOf(page, '#importPreviewSummary'), /新增 9/);
    assert.match(await textOf(page, '#importPreviewSummary'), /设置变化 3/);
    assert.equal(await textOf(page, '#fixtureProfileCount'), '0');
    assert.equal(await textOf(page, '#fixturePromotionSiteCount'), '0');
    assert.equal(await textOf(page, '#fixturePairCount'), '0');
    assert.equal(await textOf(page, '#fixtureDomainWrites'), '0');
    assert.equal(await textOf(page, '#fixtureSettingsWrites'), '0');

    await page.locator('#applyImportConfigBtn').click();
    await page.locator('#importExportStatus').getByText('导入已应用').waitFor();
    assert.equal(await textOf(page, '#fixtureProfileCount'), '3');
    assert.equal(await textOf(page, '#fixturePromotionSiteCount'), '3');
    assert.equal(await textOf(page, '#fixturePairCount'), '3');
    assert.equal(
      await page.locator('#fixtureAutoGenerate').isChecked(),
      true
    );
    assert.equal(await page.locator('#fixtureAutoSubmit').isChecked(), false);
    assert.equal(await numericValue(page, '#fixtureConcurrency'), 3);
    assert.equal(await numericValue(page, '#fixtureTimeoutSeconds'), 120);

    await page.locator('#exportConfigBtn').click();
    await page.locator('#fixtureExportStatus').getByText(
      /autocomment-config-bundle/
    ).waitFor();
    assert.match(await textOf(page, '#fixtureExportStatus'), /Profiles 3/);

    await importPreset(page);
    assert.match(await textOf(page, '#importPreviewSummary'), /更新 9/);
    await page.locator('#applyImportConfigBtn').click();
    await page.locator('#importExportStatus').getByText('导入已应用').waitFor();
    assert.equal(await textOf(page, '#fixtureProfileCount'), '3');
    assert.equal(await textOf(page, '#fixturePromotionSiteCount'), '3');
    assert.equal(await textOf(page, '#fixturePairCount'), '3');

    await importPreset(page);
    await page.locator('#fixtureFailSettingsSave').check();
    await page.locator('#applyImportConfigBtn').click();
    await page.locator('#importExportStatus').getByText(
      /config_bundle_apply_failed/
    ).waitFor();
    assert.equal(
      await textOf(page, '#fixtureRollbackStatus'),
      '回滚完成：域内容已恢复'
    );
    assert.equal(await textOf(page, '#fixtureProfileCount'), '3');
    assert.equal(await textOf(page, '#fixturePromotionSiteCount'), '3');
    assert.equal(await textOf(page, '#fixturePairCount'), '3');

    for (const requestedUrl of requestedUrls) {
      assert.equal(new URL(requestedUrl).origin, origin);
    }
    assert.deepEqual(pageErrors, []);

    const result = {
      ok: true,
      profiles: 3,
      promotionSites: 3,
      pairs: 3,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 120,
      repeatImport: 'updates_without_duplicates',
      rollback: 'content_restored',
      pageErrors,
      thirdPartyRequests: 0
    };
    process.stderr.write(`Chrome version: ${await browser.version()}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await closeServer(server);
  }
}

await main();
