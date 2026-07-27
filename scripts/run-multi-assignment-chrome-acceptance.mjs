import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
const recoveryDisabledChromiumFeatures = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'AutofillServerCommunication',
  'AutoDeElevate',
  'BoundaryEventDispatchTracksNodeRemoval',
  'CaptivePortalDetection',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'NetworkTimeServiceQuerying',
  'OptimizationHints',
  'PaintHolding',
  'RenderDocument',
  'ThirdPartyStoragePartitioning',
  'Translate',
  'msEdgeUpdateLaunchServicesPreferredVersion',
  'msForceBrowserSignIn'
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

function createLocalOnlyAuditProxy(allowedOrigin, ledger) {
  let sequence = 0;
  const record = ({ method, url, allowed, transport }) => {
    ledger.push({
      sequence: ++sequence,
      method,
      url,
      allowed,
      transport
    });
  };
  const deny = (response, statusLine = null) => {
    if (typeof response.writeHead === 'function') {
      response.writeHead(502, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end('network_target_not_allowlisted');
      return;
    }
    response.end(
      statusLine || 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'
    );
  };
  const proxy = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch (_) {
      record({
        method: request.method,
        url: request.url,
        allowed: false,
        transport: 'http'
      });
      request.resume();
      deny(response);
      return;
    }
    const allowed = target.origin === allowedOrigin;
    record({
      method: request.method,
      url: target.href,
      allowed,
      transport: 'http'
    });
    if (!allowed) {
      request.resume();
      deny(response);
      return;
    }
    const headers = { ...request.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(target, {
      method: request.method,
      headers
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        upstreamResponse.headers
      );
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => deny(response));
    request.pipe(upstream);
  });
  proxy.on('connect', (request, socket) => {
    socket.on('error', () => {});
    record({
      method: request.method,
      url: `https://${request.url}`,
      allowed: false,
      transport: 'connect'
    });
    deny(socket);
  });
  proxy.on('upgrade', (request, socket) => {
    socket.on('error', () => {});
    record({
      method: request.method,
      url: request.url,
      allowed: false,
      transport: 'upgrade'
    });
    deny(socket);
  });
  return proxy;
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

function createRecoveryLifecycleLedger(context, origin) {
  const events = [];
  const openCounts = new Map();
  const activeWorkerByPage = new Map();
  const trackedPages = new WeakSet();
  const pageIds = new WeakMap();
  let nextPageId = 0;
  let sequence = 0;
  let maxConcurrentWorkerTabs = 0;

  const pageId = (page) => {
    if (!pageIds.has(page)) pageIds.set(page, ++nextPageId);
    return pageIds.get(page);
  };
  const closeWorker = (page, source) => {
    if (!activeWorkerByPage.has(page)) return;
    const urlIndex = activeWorkerByPage.get(page);
    activeWorkerByPage.delete(page);
    events.push({
      sequence: ++sequence,
      type: 'close',
      urlIndex,
      pageId: pageId(page),
      source,
      activeWorkerTabs: activeWorkerByPage.size
    });
  };
  const openWorker = (page, rawUrl, source) => {
    const urlIndex = recoveryTargetIndex(rawUrl, origin);
    if (urlIndex === null) return;
    if (activeWorkerByPage.get(page) === urlIndex) return;
    closeWorker(page, 'navigation-replaced');
    activeWorkerByPage.set(page, urlIndex);
    openCounts.set(urlIndex, (openCounts.get(urlIndex) || 0) + 1);
    maxConcurrentWorkerTabs = Math.max(
      maxConcurrentWorkerTabs,
      activeWorkerByPage.size
    );
    events.push({
      sequence: ++sequence,
      type: 'open',
      urlIndex,
      pageId: pageId(page),
      source,
      activeWorkerTabs: activeWorkerByPage.size
    });
  };
  const trackPage = (page) => {
    if (trackedPages.has(page)) return;
    trackedPages.add(page);
    pageId(page);
    openWorker(page, page.url(), 'existing-page');
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        openWorker(page, frame.url(), 'main-frame-navigation');
      }
    });
    page.on('close', () => closeWorker(page, 'page-close'));
  };

  context.pages().forEach(trackPage);
  context.on('page', trackPage);
  context.on('request', (request) => {
    if (!request.isNavigationRequest()) return;
    let frame;
    try {
      frame = request.frame();
    } catch (_) {
      return;
    }
    if (frame !== frame.page().mainFrame()) return;
    const page = frame.page();
    trackPage(page);
    openWorker(page, request.url(), 'navigation-request');
  });

  return {
    snapshot() {
      return {
        events: events.map((event) => ({ ...event })),
        openedUrlIndices: events.flatMap((event) => (
          event.type === 'open' ? [event.urlIndex] : []
        )),
        openedUrlIndexCounts: Object.fromEntries(
          [...openCounts.entries()].sort(([left], [right]) => left - right)
        ),
        maxConcurrentWorkerTabs,
        activeWorkerTabs: activeWorkerByPage.size
      };
    }
  };
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
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.optional_host_permissions = [];
  manifest.content_scripts = (manifest.content_scripts || []).map(
    (contentScript) => ({
      ...contentScript,
      matches: ['http://127.0.0.1/*']
    })
  );
  manifest.web_accessible_resources = (
    manifest.web_accessible_resources || []
  ).map((resource) => ({
    ...resource,
    matches: ['http://127.0.0.1/*']
  }));
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return extensionRoot;
}

async function prepareNetworkQuietChromiumProfile(profileRoot) {
  const defaultProfile = path.join(profileRoot, 'Default');
  await fs.mkdir(defaultProfile, { recursive: true });
  await fs.writeFile(
    path.join(defaultProfile, 'Preferences'),
    `${JSON.stringify({
      autofill: {
        credit_card_enabled: false,
        profile_enabled: false
      },
      browser: {
        check_default_browser: false,
        has_seen_welcome_page: true
      },
      credentials_enable_service: false,
      distribution: {
        skip_first_run_ui: true
      },
      profile: {
        password_manager_enabled: false
      },
      safebrowsing: {
        enabled: false
      },
      signin: {
        allowed: false
      }
    }, null, 2)}\n`,
    'utf8'
  );
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
  let extensionProxy;
  const requestedUrls = [];
  const extensionRequestedUrls = [];
  const extensionProxyLedger = [];
  const pageErrors = [];
  const extensionPageErrors = [];
  const outcomes = [];
  let chromeVersion = '';
  let extensionAutomationVersion = '';
  let extensionSmoke = '';
  let interruptionRetry = '';
  let submittingInterruption = '';
  let closedUrlIndex = null;
  let replacementUrlIndex = null;
  let configuredConcurrency = 0;
  let extensionLifecycle = null;
  let finalLifecycle = null;
  let workerTabsAfterStop = null;
  let legacyPhaseCommentsSubmitted = null;
  let wholeCommandCommentsSubmitted = null;
  let commentsSubmitted = null;
  let runtimeErrorText = '';
  let batchVisibleText = '';
  let thirdPartyRequests = [];
  let extensionThirdPartyRequests = [];
  let blockedChromiumBackgroundAttempts = [];
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
    legacyPhaseCommentsSubmitted = await fetch(
      `${origin}/__fixture/submissions`
    ).then((response) => response.json()).then((items) => items.length);
    assert.equal(legacyPhaseCommentsSubmitted, 6);

    await context.close();
    context = null;
    const localExtensionRoot = await prepareLocalExtension(
      projectRoot,
      temporaryProfile
    );
    const localExtensionManifest = JSON.parse(await fs.readFile(
      path.join(localExtensionRoot, 'manifest.json'),
      'utf8'
    ));
    assert.deepEqual(
      localExtensionManifest.host_permissions,
      ['http://127.0.0.1/*']
    );
    assert.deepEqual(localExtensionManifest.optional_host_permissions, []);
    assert.equal(
      localExtensionManifest.content_scripts.every((contentScript) => (
        contentScript.matches.length === 1
        && contentScript.matches[0] === 'http://127.0.0.1/*'
      )),
      true
    );
    extensionProxy = createLocalOnlyAuditProxy(origin, extensionProxyLedger);
    const extensionProxyPort = await listen(extensionProxy);
    const extensionProfileRoot = path.join(
      temporaryProfile,
      'extension-smoke'
    );
    await prepareNetworkQuietChromiumProfile(extensionProfileRoot);
    context = await chromium.launchPersistentContext(
      extensionProfileRoot,
      {
      executablePath: chromium.executablePath(),
      headless: true,
      args: [
        `--disable-extensions-except=${localExtensionRoot}`,
        `--load-extension=${localExtensionRoot}`,
        '--disable-background-networking',
        '--disable-domain-reliability',
        '--disable-quic',
        `--disable-features=${recoveryDisabledChromiumFeatures.join(',')}`,
        `--gaia-url=${origin}`,
        `--google-apis-url=${origin}`,
        `--google-base-url=${origin}`,
        `--proxy-server=http://127.0.0.1:${extensionProxyPort}`,
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
      ]
      }
    );
    extensionLifecycle = createRecoveryLifecycleLedger(context, origin);
    context.on(
      'request',
      (request) => extensionRequestedUrls.push(request.url())
    );
    const pageErrorListeners = new WeakSet();
    const trackPageErrors = (page) => {
      if (pageErrorListeners.has(page)) return;
      pageErrorListeners.add(page);
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
        extensionPageErrors.push(error.message);
      });
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
    configuredConcurrency = initialCheckpoint.settings.concurrency;
    assert.equal(configuredConcurrency, 3);
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
    batchVisibleText = await smokePage.locator('body').innerText();
    const recoveryLifecycle = extensionLifecycle.snapshot();
    const closedZeroEvent = recoveryLifecycle.events.find((event) => (
      event.type === 'close' && event.urlIndex === 0
    ));
    const openedThreeEvent = recoveryLifecycle.events.find((event) => (
      event.type === 'open' && event.urlIndex === 3
    ));

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
    assert.equal(
      batchVisibleText.includes('batch_ownership_active'),
      false
    );
    assert.equal(recoveryLifecycle.maxConcurrentWorkerTabs, 3);
    assert.deepEqual(recoveryLifecycle.openedUrlIndices, [0, 1, 2, 3]);
    assert.deepEqual(recoveryLifecycle.openedUrlIndexCounts, {
      0: 1,
      1: 1,
      2: 1,
      3: 1
    });
    assert.ok(closedZeroEvent);
    assert.ok(openedThreeEvent);
    assert.ok(openedThreeEvent.sequence > closedZeroEvent.sequence);

    await smokePage.locator('[data-action="stop"]').click();
    await smokePage.locator('[data-action="confirm-layer"]').click();
    await waitForValue(
      () => smokePage.evaluate(() => (
        chrome.runtime.sendMessage({ type: 'BATCH_SESSION_GET' })
      )).then((response) => response.checkpoint),
      (candidate) => candidate?.status === 'terminated'
    );
    const stoppedWorkerTabs = await waitForValue(
      () => currentRecoveryWorkerTabs(context, origin),
      (tabs) => tabs.length === 0
    );
    workerTabsAfterStop = stoppedWorkerTabs.length;
    assert.equal(workerTabsAfterStop, 0);

    await smokePage.close();
    await context.close();
    context = null;
    finalLifecycle = extensionLifecycle.snapshot();
    assert.equal(finalLifecycle.activeWorkerTabs, 0);
    assert.equal(finalLifecycle.maxConcurrentWorkerTabs, 3);
    await closeServer(extensionProxy);
    extensionProxy = null;

    blockedChromiumBackgroundAttempts = extensionProxyLedger.filter(
      (entry) => entry.allowed === false
    );
    thirdPartyRequests = extensionProxyLedger.filter((entry) => {
      if (entry.allowed === false) return false;
      return new URL(entry.url).origin !== origin;
    });
    extensionThirdPartyRequests = extensionRequestedUrls.filter(
      (requestedUrl) => {
        const parsed = new URL(requestedUrl);
        return ['http:', 'https:'].includes(parsed.protocol)
          && parsed.origin !== origin;
      }
    );
    assert.ok(
      extensionProxyLedger.some((entry) => entry.allowed === true),
      'local recovery traffic did not traverse the pre-launch audit proxy'
    );
    assert.deepEqual(
      [...new Set(blockedChromiumBackgroundAttempts.map((entry) => (
        new URL(entry.url).hostname
      )))],
      ['www.google.com']
    );
    commentsSubmitted = await fetch(`${origin}/__fixture/submissions`)
      .then((response) => response.json())
      .then((records) => records.length);
    wholeCommandCommentsSubmitted =
      legacyPhaseCommentsSubmitted + commentsSubmitted;

    assert.equal(
      thirdPartyRequests.length,
      0,
      JSON.stringify(thirdPartyRequests, null, 2)
    );
    assert.deepEqual(extensionThirdPartyRequests, []);
    assert.equal(commentsSubmitted, 0);
    assert.equal(wholeCommandCommentsSubmitted, 6);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(extensionPageErrors, []);
    extensionSmoke =
      'automation-chromium-service-worker-batch-page-and-worker-refill';

    const result = {
      ok: true,
      chromeVersion,
      extensionAutomationVersion,
      fixtureOrigin: origin,
      closedUrlIndex,
      replacementUrlIndex,
      maxConcurrency: finalLifecycle.maxConcurrentWorkerTabs,
      configuredConcurrency,
      openedUrlIndices: finalLifecycle.openedUrlIndices,
      openedUrlIndexCounts: finalLifecycle.openedUrlIndexCounts,
      workerTabsAfterStop,
      thirdPartyRequests: extensionThirdPartyRequests.length,
      commentsSubmitted,
      commentsSubmittedScope: 'real-extension-recovery',
      pageErrors,
      commentLedger: {
        legacyPhase: legacyPhaseCommentsSubmitted,
        realExtensionRecovery: commentsSubmitted,
        wholeCommand: wholeCommandCommentsSubmitted
      },
      pageErrorLedger: {
        realExtensionRecovery: extensionPageErrors,
        wholeCommand: pageErrors
      },
      workerLifecycle: {
        events: finalLifecycle.events,
        activeWorkerTabsAtFinalization: finalLifecycle.activeWorkerTabs
      },
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
        installedChrome: 'post-launch-page-lifetime',
        extensionChromium:
          'pre-launch-to-context-close-local-only-proxy',
        thirdPartyRequestsScope: 'extension-attributed-http(s)',
        temporaryManifestHostPermissions:
          localExtensionManifest.host_permissions,
        temporaryManifestOptionalHostPermissions:
          localExtensionManifest.optional_host_permissions,
        proxyRequests: extensionProxyLedger.length,
        allowedFixtureRequests: extensionProxyLedger.filter(
          (entry) => entry.allowed === true
        ).length,
        extensionThirdPartyRequests:
          extensionThirdPartyRequests.length,
        forwardedThirdPartyNetworkEgress: thirdPartyRequests.length,
        blockedChromiumBackgroundAttempts:
          blockedChromiumBackgroundAttempts.length,
        blockedChromiumBackgroundDestinations: [
          ...new Set(blockedChromiumBackgroundAttempts.map(
            (entry) => new URL(entry.url).hostname
          ))
        ],
        postLaunchPlaywrightObservations: extensionRequestedUrls.length
      },
      thirdPartySubmissions: 0
    };
    assert.deepEqual(
      {
        closedUrlIndex: result.closedUrlIndex,
        replacementUrlIndex: result.replacementUrlIndex,
        maxConcurrency: result.maxConcurrency,
        configuredConcurrency: result.configuredConcurrency,
        openedUrlIndices: result.openedUrlIndices,
        openedUrlIndexCounts: result.openedUrlIndexCounts,
        workerTabsAfterStop: result.workerTabsAfterStop,
        networkAuditScope: result.requestAudit?.extensionChromium,
        legacyPhaseCommentsSubmitted: result.commentLedger?.legacyPhase,
        recoveryCommentsSubmitted: result.commentLedger?.realExtensionRecovery,
        wholeCommandCommentsSubmitted: result.commentLedger?.wholeCommand,
        commentsSubmittedScope: result.commentsSubmittedScope,
        thirdPartyRequests: result.thirdPartyRequests,
        commentsSubmitted: result.commentsSubmitted,
        pageErrors: result.pageErrors
      },
      {
        closedUrlIndex: 0,
        replacementUrlIndex: 3,
        maxConcurrency: 3,
        configuredConcurrency: 3,
        openedUrlIndices: [0, 1, 2, 3],
        openedUrlIndexCounts: {
          0: 1,
          1: 1,
          2: 1,
          3: 1
        },
        workerTabsAfterStop: 0,
        networkAuditScope: 'pre-launch-to-context-close-local-only-proxy',
        legacyPhaseCommentsSubmitted: 6,
        recoveryCommentsSubmitted: 0,
        wholeCommandCommentsSubmitted: 6,
        commentsSubmittedScope: 'real-extension-recovery',
        thirdPartyRequests: 0,
        commentsSubmitted: 0,
        pageErrors: []
      }
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await context?.close().catch(() => {});
    if (extensionProxy) {
      await closeServer(extensionProxy).catch(() => {});
    }
    await closeServer(server);
    await fs.rm(temporaryProfile, { recursive: true, force: true });
  }
}

await main();
