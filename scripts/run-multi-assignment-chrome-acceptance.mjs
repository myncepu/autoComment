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

function recoveryDomainConfig(origin) {
  return {
    version: 2,
    revision: 12,
    profiles: [{
      id: 'recovery-profile',
      displayName: '本地恢复测试身份',
      name: 'Local Recovery Fixture',
      email: 'recovery@fixture.test',
      createdAt: 1,
      updatedAt: 1
    }],
    promotionSites: [{
      id: 'recovery-site',
      name: '本地恢复测试推广站',
      url: `${origin}/promotion/recovery`,
      content: '仅用于本地 worker 恢复验收',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }],
    assignmentPolicy: {
      defaultPairId: 'recovery-pair',
      pairs: [{
        id: 'recovery-pair',
        profileId: 'recovery-profile',
        promotionSiteId: 'recovery-site',
        weight: 1,
        enabled: true
      }],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 5
      }
    }
  };
}

function recoveryTargetUrls(origin) {
  return Array.from(
    { length: 5 },
    (_, index) => `${origin}/multi/${index + 1}?delay=5000`
  );
}

function recoveryTargetIndex(rawUrl, origin) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== origin) return null;
    const match = url.pathname.match(/^\/multi\/([1-5])$/);
    return match ? Number(match[1]) - 1 : null;
  } catch (_) {
    return null;
  }
}

function currentRecoveryWorkerTabs(context, origin) {
  return context.pages().flatMap((page) => {
    const urlIndex = recoveryTargetIndex(page.url(), origin);
    return urlIndex === null ? [] : [{ page, urlIndex }];
  });
}

async function waitForValue(load, accepts, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('acceptance_wait_timeout');
}

async function prepareLocalExtension(sourceRoot, temporaryProfile) {
  const extensionRoot = path.join(temporaryProfile, 'extension-under-test');
  const includedTopLevel = new Set([
    'background.js',
    'batch.html',
    'batch.js',
    'content.js',
    'history.html',
    'history.js',
    'icons',
    'illegal-site-filter.js',
    'index.html',
    'lib',
    'manifest.json',
    'options.html',
    'options.js',
    'payment.html',
    'payment.js',
    'styles',
    'worker-pending.html'
  ]);
  await fs.cp(sourceRoot, extensionRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (relative === '') return true;
      return includedTopLevel.has(relative.split(path.sep)[0]);
    }
  });
  const manifestPath = path.join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [
    ...new Set([
      ...(manifest.host_permissions || []),
      'http://127.0.0.1/*'
    ])
  ];
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return extensionRoot;
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
  const extensionRequestedUrls = [];
  const pageErrors = [];
  const outcomes = [];
  let chromeVersion = '';
  let extensionAutomationVersion = '';
  let extensionSmoke = '';
  let interruptionRetry = '';
  let submittingInterruption = '';
  let closedUrlIndex = null;
  let replacementUrlIndex = null;
  let extensionMaxConcurrency = 0;
  let commentsSubmitted = null;
  let runtimeErrorText = '';
  let thirdPartyRequests = [];
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
    const localExtensionRoot = await prepareLocalExtension(
      projectRoot,
      temporaryProfile
    );
    context = await chromium.launchPersistentContext(
      path.join(temporaryProfile, 'extension-smoke'),
      {
      executablePath: chromium.executablePath(),
      headless: true,
      args: [
        `--disable-extensions-except=${localExtensionRoot}`,
        `--load-extension=${localExtensionRoot}`,
        '--disable-background-networking'
      ]
      }
    );
    context.on(
      'request',
      (request) => extensionRequestedUrls.push(request.url())
    );
    const pageErrorListeners = new WeakSet();
    const trackPageErrors = (page) => {
      if (pageErrorListeners.has(page)) return;
      pageErrorListeners.add(page);
      page.on('pageerror', (error) => pageErrors.push(error.message));
    };
    context.pages().forEach(trackPageErrors);
    context.on('page', trackPageErrors);
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
    await waitForValue(
      () => smokePage.evaluate(async () => {
        try {
          return await chrome.runtime.sendMessage({
            type: 'BATCH_SESSION_GET'
          });
        } catch (_) {
          return null;
        }
      }),
      (response) => response?.ok === true
    );
    await smokePage.evaluate(async ({
      config,
      fixtureOrigin
    }) => {
      await chrome.storage.local.set({
        autoCommentDomainConfig: config,
        autoCommentProfileSecrets: {
          version: 1,
          passwordsByProfileId: {
            'recovery-profile': 'local-recovery-password'
          }
        },
        llm_api_key: 'local-fixture-key'
      });
      await chrome.storage.sync.set({
        llm_api_base_url: `${fixtureOrigin}/v1`,
        llm_model: 'local-fixture-model',
        batch_checkbox_settings: {
          autoOpenPanel: false,
          autoGenerate: true,
          autoSubmit: false
        },
        batch_concurrency: 3,
        batch_timeout_seconds: 60
      });
    }, {
      config: recoveryDomainConfig(origin),
      fixtureOrigin: origin
    });

    await fetch(`${origin}/__fixture/reset`, { method: 'POST' });
    await smokePage.reload({ waitUntil: 'domcontentloaded' });
    await smokePage.locator('[data-action="new-batch"]').click();
    await smokePage.locator('[data-action="wizard-next"]').click();

    const targetUrls = recoveryTargetUrls(origin);
    await smokePage.locator('input[name="batchFile"]').setInputFiles({
      name: 'local-recovery-targets.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from([
        'URL,来源域名',
        ...targetUrls.map((url) => `${url},127.0.0.1`)
      ].join('\n'))
    });
    const planOutcome = await waitForValue(
      () => smokePage.evaluate(() => ({
        error: document.querySelector('[data-parse-error]')?.textContent || '',
        summary: document.querySelector('[data-plan-summary]')?.textContent || ''
      })),
      ({ error, summary }) => Boolean(error || summary)
    );
    assert.match(
      planOutcome.summary,
      /可执行 5/,
      planOutcome.error || 'local recovery plan did not include five targets'
    );
    await smokePage.locator('[data-action="wizard-next"]').click();
    await smokePage.locator('[name="concurrency"]').evaluate((input) => {
      input.value = '3';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await smokePage.locator('[name="autoGenerate"]').check();
    await smokePage.locator('[name="autoSubmit"]').uncheck();
    await smokePage.locator('[data-action="wizard-next"]').click();
    await smokePage.locator('[name="normalConfirmed"]').check();
    await smokePage.locator('[name="highRiskConfirmed"]').check();
    await smokePage.locator('[data-readiness-ready]').waitFor();
    await smokePage.locator('[data-action="wizard-start"]').click();

    await smokePage.waitForFunction(async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_SESSION_GET'
      });
      return response?.ok
        && [0, 1, 2].every((urlIndex) => (
          response.checkpoint?.tasks?.[String(urlIndex)]?.state === 'active'
        ));
    });
    const initialWorkerTabs = await waitForValue(
      () => currentRecoveryWorkerTabs(context, origin),
      (tabs) => (
        tabs.length === 3
        && tabs.map(({ urlIndex }) => urlIndex).sort().join(',') === '0,1,2'
      )
    );
    const initialCheckpoint = await smokePage.evaluate(() => (
      chrome.runtime.sendMessage({ type: 'BATCH_SESSION_GET' })
    )).then((response) => response.checkpoint);
    extensionMaxConcurrency = initialCheckpoint.settings.concurrency;
    assert.equal(extensionMaxConcurrency, 3);
    assert.equal(initialWorkerTabs.length, 3);

    closedUrlIndex = 0;
    await initialWorkerTabs.find(
      ({ urlIndex }) => urlIndex === closedUrlIndex
    ).page.close();
    replacementUrlIndex = 3;
    await smokePage.waitForFunction(async ({
      closedIndex,
      replacementIndex
    }) => {
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_SESSION_GET'
      });
      const checkpoint = response?.checkpoint;
      return response?.ok
        && checkpoint?.tasks?.[String(closedIndex)]?.state === 'terminal'
        && checkpoint.results?.find(
          ({ originalIndex }) => originalIndex === closedIndex
        )?.errorCode === 'task_failed'
        && checkpoint.tasks?.[String(replacementIndex)]?.state === 'active';
    }, {
      closedIndex: closedUrlIndex,
      replacementIndex: replacementUrlIndex
    });
    const checkpoint = await smokePage.evaluate(() => (
      chrome.runtime.sendMessage({ type: 'BATCH_SESSION_GET' })
    )).then((response) => response.checkpoint);
    const activeWorkerTabs = await waitForValue(
      () => currentRecoveryWorkerTabs(context, origin),
      (tabs) => (
        tabs.length === 3
        && tabs.map(({ urlIndex }) => urlIndex).sort().join(',') === '1,2,3'
      )
    );
    runtimeErrorText = await smokePage.locator(
      '[data-banner-kind="error"]'
    ).allTextContents().then((items) => items.join('\n'));
    thirdPartyRequests = extensionRequestedUrls.filter((requestedUrl) => {
      const parsed = new URL(requestedUrl);
      return !(
        ['127.0.0.1', 'localhost'].includes(parsed.hostname)
        || ['chrome-extension:', 'data:'].includes(parsed.protocol)
      );
    });
    commentsSubmitted = await fetch(`${origin}/__fixture/submissions`)
      .then((response) => response.json())
      .then((records) => records.length);

    assert.equal(checkpoint.tasks['0'].state, 'terminal');
    assert.equal(checkpoint.results.find(
      ({ originalIndex }) => originalIndex === 0
    ).errorCode, 'task_failed');
    assert.equal(checkpoint.tasks['3'].state, 'active');
    assert.equal(activeWorkerTabs.length, 3);
    assert.equal(
      runtimeErrorText.includes('batch_ownership_active'),
      false
    );
    assert.equal(thirdPartyRequests.length, 0);
    assert.equal(commentsSubmitted, 0);
    assert.deepEqual(pageErrors, []);
    extensionSmoke =
      'automation-chromium-service-worker-batch-page-and-worker-refill';

    const result = {
      ok: true,
      chromeVersion,
      extensionAutomationVersion,
      fixtureOrigin: origin,
      closedUrlIndex,
      replacementUrlIndex,
      maxConcurrency: extensionMaxConcurrency,
      thirdPartyRequests: thirdPartyRequests.length,
      commentsSubmitted,
      pageErrors,
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
      requestAudit: {
        installedChrome: 'context-lifetime',
        extensionChromium: 'post-launch-page-lifetime',
        observedThirdPartyRequests: thirdPartyRequests.length
      },
      thirdPartySubmissions: 0
    };
    assert.deepEqual(
      {
        closedUrlIndex: result.closedUrlIndex,
        replacementUrlIndex: result.replacementUrlIndex,
        maxConcurrency: result.maxConcurrency,
        thirdPartyRequests: result.thirdPartyRequests,
        commentsSubmitted: result.commentsSubmitted,
        pageErrors: result.pageErrors
      },
      {
        closedUrlIndex: 0,
        replacementUrlIndex: 3,
        maxConcurrency: 3,
        thirdPartyRequests: 0,
        commentsSubmitted: 0,
        pageErrors: []
      }
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await context?.close().catch(() => {});
    await closeServer(server);
    await fs.rm(temporaryProfile, { recursive: true, force: true });
  }
}

await main();
