import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createFixtureServer } = require('./serve-extension-fixture.js');
const productionScripts = [
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
    const bundled = path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      'playwright'
    );
    return require(bundled);
  }
}

function chromeExecutable() {
  const explicit = process.env.AUTOCOMMENT_CHROME_PATH;
  const candidates = [
    explicit,
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

function profiles() {
  return {
    'profile-a': {
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice Fixture',
      email: 'alice@fixture.test',
      password: 'fixture-password-a'
    },
    'profile-b': {
      id: 'profile-b',
      displayName: '作者 B',
      name: 'Bob Fixture',
      email: 'bob@fixture.test',
      password: 'fixture-password-b'
    }
  };
}

function sites(origin) {
  return {
    'site-a': {
      id: 'site-a',
      name: '产品 A',
      url: `${origin}/promotion/a`,
      content: '本地产品 A 的安全说明'
    },
    'site-b': {
      id: 'site-b',
      name: '产品 B',
      url: `${origin}/promotion/b`,
      content: '本地产品 B 的安全说明'
    }
  };
}

function assignments() {
  return [
    ['profile-b', 'site-b', 'explicit'],
    ['profile-a', 'site-a', 'weighted'],
    ['profile-b', 'site-b', 'weighted'],
    ['profile-a', 'site-a', 'explicit'],
    ['profile-a', 'site-a', 'weighted']
  ];
}

function handleFor(origin, index, profileId, promotionSiteId, source) {
  const profile = profiles()[profileId];
  const promotionSite = sites(origin)[promotionSiteId];
  return {
    type: 'BATCH_HANDLE',
    batchId: 'chrome-multi-plan',
    taskId: `chrome-multi-plan:${index + 2}`,
    urlIndex: index,
    attempt: 1,
    url: `${origin}/multi/${index + 1}`,
    profileId,
    promotionSiteId,
    assignmentPairId: profileId === 'profile-a' ? 'pair-a' : 'pair-b',
    assignmentSource: source,
    configRevision: 12,
    automation: {
      autoGenerate: true,
      autoSubmit: true
    },
    profile: {
      id: profile.id,
      displayName: profile.displayName,
      name: profile.name,
      email: profile.email
    },
    promotionSite
  };
}

async function injectProduction(page) {
  for (const relativePath of productionScripts) {
    await page.addScriptTag({ path: path.join(projectRoot, relativePath) });
  }
}

async function waitForSubmissions(origin, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await fetch(`${origin}/__fixture/submissions`)
      .then((response) => response.json());
    if (records.length >= expected) return records;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture_submission_timeout:${expected}`);
}

async function main() {
  const chromePath = chromeExecutable();
  if (!chromePath) throw new Error('installed_chrome_not_found');
  const { chromium } = loadPlaywright();
  const server = createFixtureServer();
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const temporaryProfile = await fs.mkdtemp(
    path.join(os.tmpdir(), 'autocomment-multi-')
  );
  let context;
  const requestedUrls = [];
  const pageErrors = [];
  const outcomes = [];
  let chromeVersion = '';
  let extensionAutomationVersion = '';
  let extensionSmoke = '';
  let interruptionRetry = '';
  let submittingInterruption = '';
  let active = 0;
  let maxActive = 0;

  try {
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
    await context.addInitScript({ content: adapterSource });
    context.on('request', (request) => requestedUrls.push(request.url()));

    async function runTarget(index) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(`${origin}/multi/${index + 1}`, {
          waitUntil: 'domcontentloaded'
        });
        await page.evaluate((values) => {
          globalThis.LocalFixtureChrome.configurePasswords(values);
        }, Object.fromEntries(Object.entries(profiles()).map(
          ([id, profile]) => [id, profile.password]
        )));
        await injectProduction(page);
        const assignment = assignments()[index];
        const handle = handleFor(origin, index, ...assignment);
        const response = await page.evaluate(
          (message) => globalThis.LocalFixtureChrome.dispatchHandle(message),
          handle
        );
        assert.equal(response?.ok, true);
        assert.equal(response?.accepted, true);
        await page.waitForFunction((taskId) => (
          globalThis.LocalFixtureChrome.safeState().confirmations.some(
            (message) => message.taskId === taskId
          )
        ), handle.taskId);
        const state = await page.evaluate(
          () => globalThis.LocalFixtureChrome.safeState()
        );
        outcomes[index] = { handle, state };
      } finally {
        await page.close();
        active -= 1;
      }
    }

    const queue = [0, 1, 2, 3, 4];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const index = queue.shift();
        await runTarget(index);
      }
    }));

    const records = await waitForSubmissions(origin, 5);
    const sorted = [...records].sort((left, right) => left.targetId - right.targetId);
    assert.equal(maxActive, 3);
    assert.deepEqual(
      sorted.map((record) => [record.profileId, record.promotionSiteId]),
      assignments().map(([profileId, siteId]) => [profileId, siteId])
    );
    sorted.forEach((record, index) => {
      const [profileId, siteId] = assignments()[index];
      const profile = profiles()[profileId];
      const site = sites(origin)[siteId];
      assert.equal(record.name, profile.name);
      assert.equal(record.email, profile.email);
      assert.equal(record.passwordPresent, true);
      assert.equal(record.websiteUrl, site.url);
      assert.equal(record.taskId, `chrome-multi-plan:${index + 2}`);
      assert.equal(record.comment, `LOCAL_COMMENT ${profileId} ${siteId}`);
    });
    outcomes.forEach(({ handle, state }) => {
      assert.equal(state.modelRequests.length, 1);
      assert.match(
        state.modelRequests[0].systemPrompt,
        new RegExp(handle.promotionSite.content)
      );
      assert.equal(
        state.confirmations.some((message) => (
          message.taskId === handle.taskId
          && message.profileId === handle.profileId
          && message.promotionSiteId === handle.promotionSiteId
        )),
        true
      );
    });

    const failurePage = await context.newPage();
    await failurePage.goto(`${origin}/multi/1`, { waitUntil: 'domcontentloaded' });
    await injectProduction(failurePage);
    const invalid = handleFor(origin, 0, ...assignments()[0]);
    delete invalid.profileId;
    const rejected = await failurePage.evaluate(
      (message) => globalThis.LocalFixtureChrome.dispatchHandle(message),
      invalid
    );
    assert.equal(rejected?.ok, false);
    assert.equal(rejected?.error, 'invalid_task_config');
    await failurePage.close();

    const timeoutPage = await context.newPage();
    await timeoutPage.goto(`${origin}/multi/1`, { waitUntil: 'domcontentloaded' });
    await timeoutPage.evaluate(() => {
      globalThis.LocalFixtureChrome.configurePasswords({
        'profile-b': 'fixture-password-b'
      });
      globalThis.LocalFixtureChrome.configureFaults({ llmDelayMs: 5_000 });
    });
    await injectProduction(timeoutPage);
    const timeoutHandle = {
      ...handleFor(origin, 0, ...assignments()[0]),
      batchId: 'timeout-plan',
      taskId: 'timeout-plan:2'
    };
    const handleAcknowledgement = await Promise.race([
      timeoutPage.evaluate(
        (message) => globalThis.LocalFixtureChrome.dispatchHandle(message),
        timeoutHandle
      ).then((response) => response?.accepted === true ? 'accepted' : 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))
    ]);
    assert.equal(handleAcknowledgement, 'accepted');
    await timeoutPage.waitForFunction(() => (
      globalThis.LocalFixtureChrome.safeState().phases.some(
        ({ phase }) => phase === 'generating'
      )
    ));
    await timeoutPage.close();

    const retryPage = await context.newPage();
    await retryPage.goto(`${origin}/multi/1?retry=1`, {
      waitUntil: 'domcontentloaded'
    });
    await retryPage.evaluate(() => {
      globalThis.LocalFixtureChrome.configurePasswords({
        'profile-b': 'fixture-password-b'
      });
    });
    await injectProduction(retryPage);
    const retryHandle = {
      ...timeoutHandle,
      attempt: 2
    };
    const retryResponse = await retryPage.evaluate(
      (message) => globalThis.LocalFixtureChrome.dispatchHandle(message),
      retryHandle
    );
    assert.equal(retryResponse?.ok, true);
    assert.equal(retryResponse?.accepted, true);
    await retryPage.waitForFunction((taskId) => (
      globalThis.LocalFixtureChrome.safeState().confirmations.some(
        (message) => message.taskId === taskId
      )
    ), retryHandle.taskId);
    await retryPage.close();
    const retriedRecords = await waitForSubmissions(origin, 6);
    const retryRecord = retriedRecords.at(-1);
    assert.equal(retryRecord.profileId, timeoutHandle.profileId);
    assert.equal(retryRecord.promotionSiteId, timeoutHandle.promotionSiteId);
    interruptionRetry = 'same-assignment-success';

    const interruptionPage = await context.newPage();
    await interruptionPage.goto(`${origin}/multi/2?interrupt=1`, {
      waitUntil: 'domcontentloaded'
    });
    await interruptionPage.evaluate(() => {
      globalThis.LocalFixtureChrome.configurePasswords({
        'profile-a': 'fixture-password-a'
      });
      globalThis.LocalFixtureChrome.configureFaults({ submitDelayMs: 5_000 });
    });
    await injectProduction(interruptionPage);
    const interruptionHandle = {
      ...handleFor(origin, 1, ...assignments()[1]),
      batchId: 'interruption-plan',
      taskId: 'interruption-plan:3'
    };
    const interruptedDispatch = interruptionPage.evaluate(
      (message) => globalThis.LocalFixtureChrome.dispatchHandle(message),
      interruptionHandle
    ).catch(() => null);
    await interruptionPage.waitForFunction(() => (
      globalThis.LocalFixtureChrome.safeState().submitContextPresent === true
    ));
    const interruptedState = await interruptionPage.evaluate(
      () => globalThis.LocalFixtureChrome.safeState()
    );
    assert.equal(
      interruptedState.phases.some(({ phase }) => phase === 'submitting'),
      true
    );
    await interruptionPage.close();
    await interruptedDispatch;
    submittingInterruption = 'context-preserved-before-close';

    const recoveryPage = await context.newPage();
    await recoveryPage.goto(`${origin}/multi/5`, { waitUntil: 'domcontentloaded' });
    const recoveryHandle = handleFor(origin, 4, ...assignments()[4]);
    await recoveryPage.evaluate(async ({ handle }) => {
      await globalThis.LocalFixtureChrome.seedSubmitContext({
        batchId: handle.batchId,
        taskId: handle.taskId,
        urlIndex: handle.urlIndex,
        profileId: handle.profileId,
        promotionSiteId: handle.promotionSiteId,
        attempt: handle.attempt,
        url: handle.url,
        result: 'success',
        aiContent: 'RESTORED_LOCAL_COMMENT',
        history: {
          submittedAt: Date.now(),
          targetPageUrl: handle.url,
          promotedWebsiteUrl: handle.promotionSite.url,
          commentHtml: 'RESTORED_LOCAL_COMMENT',
          commentText: 'RESTORED_LOCAL_COMMENT',
          anchors: []
        }
      });
    }, { handle: recoveryHandle });
    await recoveryPage.reload({ waitUntil: 'domcontentloaded' });
    await injectProduction(recoveryPage);
    await recoveryPage.waitForFunction(() => (
      globalThis.LocalFixtureChrome.safeState().confirmations.length === 1
    ));
    const recoveryState = await recoveryPage.evaluate(
      () => globalThis.LocalFixtureChrome.safeState()
    );
    assert.equal(recoveryState.confirmations[0].taskId, recoveryHandle.taskId);
    assert.equal(
      recoveryState.confirmations[0].promotionSiteId,
      recoveryHandle.promotionSiteId
    );
    await recoveryPage.close();
    chromeVersion = await context.browser()?.version();

    for (const requestedUrl of requestedUrls) {
      const parsed = new URL(requestedUrl);
      assert.equal(
        ['127.0.0.1', 'localhost'].includes(parsed.hostname)
          || parsed.protocol === 'data:',
        true,
        `non-loopback request: ${requestedUrl}`
      );
    }
    assert.deepEqual(pageErrors, []);
    assert.doesNotMatch(JSON.stringify({ records, outcomes }), /fixture-password/);

    await context.close();
    context = null;
    context = await chromium.launchPersistentContext(
      path.join(temporaryProfile, 'extension-smoke'),
      {
      executablePath: chromium.executablePath(),
      headless: true,
      args: [
        `--disable-extensions-except=${projectRoot}`,
        `--load-extension=${projectRoot}`,
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
    assert.match(serviceWorker.url(), /\/background\.js$/);
    extensionAutomationVersion = await context.browser()?.version();
    const extensionId = new URL(serviceWorker.url()).hostname;
    const smokePage = await context.newPage();
    await smokePage.goto(`chrome-extension://${extensionId}/batch.html`, {
      waitUntil: 'domcontentloaded'
    });
    assert.equal(
      await smokePage.locator('[data-batch-console]').count(),
      1
    );
    assert.equal(
      await smokePage.locator('[data-batch-wizard]').count(),
      1
    );
    await smokePage.close();
    extensionSmoke = 'automation-chromium-service-worker-and-batch-page';

    const result = {
      ok: true,
      chromeVersion,
      extensionAutomationVersion,
      fixtureOrigin: origin,
      maxConcurrency: maxActive,
      assignments: sorted.map((record) => ({
        targetId: record.targetId,
        profileId: record.profileId,
        promotionSiteId: record.promotionSiteId
      })),
      handleAcknowledgement,
      interruptionRetry,
      submittingInterruption,
      refreshRecovery: 'confirmed',
      extensionSmoke,
      thirdPartySubmissions: 0
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await context?.close().catch(() => {});
    await closeServer(server);
    await fs.rm(temporaryProfile, { recursive: true, force: true });
  }
}

await main();
