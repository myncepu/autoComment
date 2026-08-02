import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  createAutoSubmitLoadPlan
} from '../tests/helpers/auto-submit-load-plan.mjs';
import {
  closeBrowserContextWithin,
  finalizeAcceptanceResult
} from '../tests/helpers/browser-cleanup.mjs';
import {
  withServerPool
} from '../tests/helpers/fixture-server-pool.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const { createFixtureServer } = require('./serve-extension-fixture.js');
const productionScripts = [
  'lib/content-runtime-bootstrap.js',
  'illegal-site-filter.js',
  'lib/llm-content-bridge.js',
  'lib/batch-task-config.js',
  'lib/batch-handle-dispatch.js',
  'lib/batch-submit-context-client.js',
  'lib/comment-history-capture.js',
  'lib/batch-phase-reporter.js',
  'content.js'
];

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
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function readSubmissions(origins) {
  const recordsByBlog = await Promise.all(origins.map(
    (origin) => fetch(`${origin}/__fixture/submissions`)
      .then((response) => response.json())
  ));
  return {
    recordsByBlog,
    records: recordsByBlog.flat()
  };
}

async function waitForSubmissions(origins, expected, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readSubmissions(origins);
    if (result.records.length >= expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture_submission_timeout:${expected}`);
}

function countBy(values) {
  return Object.fromEntries(
    [...new Set(values)].map((value) => [
      value,
      values.filter((candidate) => candidate === value).length
    ])
  );
}

async function main() {
  const chromePath = chromeExecutable();
  if (!chromePath) throw new Error('installed_chrome_not_found');
  const { chromium } = loadPlaywright();
  return withServerPool({
    count: 6,
    createServer: createFixtureServer,
    listen,
    closeServer
  }, async ({ ports }) => {
    const origins = ports.map((port) => `http://127.0.0.1:${port}`);
    const plan = createAutoSubmitLoadPlan(origins);
    let temporaryProfile;
    const requestedUrls = [];
    const pageErrors = [];
    const outcomes = [];
    let context;
    let active = 0;
    let maxActive = 0;
    let result;
    let browserCleanup = 'not_started';

    try {
      temporaryProfile = await fs.mkdtemp(
        path.join(os.tmpdir(), 'autocomment-auto-submit-30-')
      );
      context = await chromium.launchPersistentContext(temporaryProfile, {
        executablePath: chromePath,
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-background-networking']
      });
      const adapterSource = await fs.readFile(
        path.join(projectRoot, 'tests/fixtures/fake-chrome-adapter.js'),
        'utf8'
      );
      const productionSource = (
        await Promise.all(productionScripts.map((relativePath) => (
          fs.readFile(path.join(projectRoot, relativePath), 'utf8')
        )))
      ).join(';\n');
      const pageInitSource = `${adapterSource};\n${productionSource}`;
      context.on('request', (request) => requestedUrls.push(request.url()));

    async function runTask(task) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.addInitScript({ content: pageInitSource });
        await page.goto(task.url, { waitUntil: 'domcontentloaded' });
        await page.evaluate((passwordsByProfileId) => {
          globalThis.LocalFixtureChrome.configurePasswords(
            passwordsByProfileId
          );
        }, plan.passwordsByProfileId);
        const response = await page.evaluate(
          (handle) => globalThis.LocalFixtureChrome.dispatchHandle(handle),
          task.handle
        );
        assert.equal(response?.ok, true);
        assert.equal(response?.accepted, true);
        await page.waitForFunction((taskId) => (
          globalThis.LocalFixtureChrome.safeState().confirmations.some(
            (message) => message.taskId === taskId
          )
        ), task.handle.taskId, { timeout: 30_000 });
        const state = await page.evaluate(
          () => globalThis.LocalFixtureChrome.safeState()
        );
        outcomes[task.targetId - 1] = {
          targetId: task.targetId,
          profileId: task.profileId,
          promotionSiteId: task.promotionSiteId,
          state
        };
      } finally {
        await page.close();
        active -= 1;
      }
    }

    const queue = [...plan.tasks];
    await Promise.all(Array.from(
      { length: plan.concurrency },
      async () => {
        while (queue.length > 0) {
          const task = queue.shift();
          await runTask(task);
        }
      }
    ));

    const { records, recordsByBlog } = await waitForSubmissions(
      origins,
      plan.tasks.length
    );
    assert.equal(records.length, 30);
    assert.deepEqual(
      recordsByBlog.map((blogRecords) => blogRecords.length),
      [5, 5, 5, 5, 5, 5]
    );
    assert.equal(maxActive, plan.concurrency);
    assert.equal(
      new Set(records.map(({ targetId }) => targetId)).size,
      30
    );

    const sortedRecords = [...records].sort(
      (left, right) => left.targetId - right.targetId
    );
    sortedRecords.forEach((record) => {
      const task = plan.tasks[record.targetId - 1];
      const profile = plan.profiles[task.profileId];
      const promotionSite = plan.promotionSites[task.promotionSiteId];
      assert.equal(record.taskId, task.handle.taskId);
      assert.equal(record.profileId, task.profileId);
      assert.equal(record.promotionSiteId, task.promotionSiteId);
      assert.equal(record.name, profile.name);
      assert.equal(record.email, profile.email);
      assert.equal(record.passwordPresent, true);
      assert.equal(record.passwordMatchesProfile, true);
      assert.equal(record.websiteUrl, promotionSite.url);
      assert.equal(
        record.comment,
        `LOCAL_COMMENT ${task.profileId} ${task.promotionSiteId}`
      );
    });

    outcomes.forEach((outcome, index) => {
      const task = plan.tasks[index];
      assert.equal(outcome.targetId, task.targetId);
      assert.equal(outcome.state.modelRequests.length, 1);
      assert.match(
        outcome.state.modelRequests[0].systemPrompt,
        new RegExp(task.handle.promotionSite.content)
      );
      assert.equal(
        outcome.state.confirmations.some((confirmation) => (
          confirmation.taskId === task.handle.taskId &&
          confirmation.profileId === task.profileId &&
          confirmation.promotionSiteId === task.promotionSiteId
        )),
        true
      );
    });

    for (const requestedUrl of requestedUrls) {
      const parsed = new URL(requestedUrl);
      assert.equal(
        parsed.hostname === '127.0.0.1' ||
          parsed.protocol === 'data:',
        true,
        `non-loopback request: ${requestedUrl}`
      );
    }
    assert.deepEqual(pageErrors, []);
    assert.doesNotMatch(
      JSON.stringify({ records, outcomes }),
      /fixture-secret/
    );

      result = {
        chromeVersion: await context.browser()?.version(),
        submitted: records.length,
        targetBlogs: origins.length,
        maxConcurrency: maxActive,
        autoGenerate: true,
        autoSubmit: true,
        commentsPerTargetBlog: recordsByBlog.map(
          (blogRecords) => blogRecords.length
        ),
        commentsPerProfile: countBy(
          sortedRecords.map(({ profileId }) => profileId)
        ),
        commentsPerPromotionSite: countBy(
          sortedRecords.map(({ promotionSiteId }) => promotionSiteId)
        ),
        confirmations: outcomes.reduce(
          (total, { state }) => total + state.confirmations.length,
          0
        ),
        pageErrors,
        thirdPartyRequests: 0,
        thirdPartySubmissions: 0
      };
    } finally {
      browserCleanup = await closeBrowserContextWithin(context);
      if (temporaryProfile) {
        await fs.rm(temporaryProfile, { recursive: true, force: true });
      }
    }
    return finalizeAcceptanceResult(result, browserCleanup);
  });
}

const result = await main();
await new Promise((resolve) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, resolve);
});
if (!result.ok) process.exit(1);
