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
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createFixtureServer } = require('./serve-extension-fixture.js');
const productionManifest = JSON.parse(await fs.readFile(
  path.join(projectRoot, 'manifest.json'),
  'utf8'
));
const productionScripts = productionManifest.content_scripts.flatMap(
  ({ js = [] }) => js
);
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

async function observeRecoveryWorkerOwnership(smokePage, context, origin) {
  const observed = await smokePage.evaluate(async () => {
    const [response, tabs, consoleTab] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'BATCH_SESSION_GET' }),
      chrome.tabs.query({}),
      chrome.tabs.getCurrent()
    ]);
    return {
      response: response || null,
      checkpoint: response?.checkpoint || null,
      tabs,
      consoleTab
    };
  });
  const errors = [];
  const targetPages = context.pages().flatMap((page) => {
    const urlIndex = recoveryTargetIndex(page.url(), origin);
    return urlIndex === null ? [] : [{ page, urlIndex, url: page.url() }];
  });
  const targetTabs = observed.tabs.flatMap((tab) => {
    const rawUrl = tab.url || tab.pendingUrl || '';
    const urlIndex = recoveryTargetIndex(rawUrl, origin);
    return urlIndex === null ? [] : [{ ...tab, urlIndex, rawUrl }];
  });
  const activeTasks = Object.values(observed.checkpoint?.tasks || {})
    .filter((task) => ['active', 'submitting'].includes(task?.state));
  const workers = [];
  if (!Number.isInteger(observed.consoleTab?.windowId)) {
    errors.push('console_window_unobserved');
  }
  for (const target of targetPages) {
    const matchingTabs = targetTabs.filter((tab) => (
      tab.urlIndex === target.urlIndex && tab.rawUrl === target.url
    ));
    if (matchingTabs.length !== 1) {
      errors.push(`ambiguous_page_tab:${target.urlIndex}:${matchingTabs.length}`);
      continue;
    }
    const tab = matchingTabs[0];
    const task = observed.checkpoint?.tasks?.[String(target.urlIndex)];
    if (!['active', 'submitting'].includes(task?.state)) {
      errors.push(`unowned_target_page:${target.urlIndex}`);
      continue;
    }
    if (task.tabId !== tab.id || task.windowId !== tab.windowId) {
      errors.push(`durable_tab_mismatch:${target.urlIndex}`);
      continue;
    }
    if (tab.windowId !== observed.consoleTab?.windowId) {
      errors.push(`worker_wrong_window:${target.urlIndex}`);
      continue;
    }
    workers.push({
      page: target.page,
      urlIndex: target.urlIndex,
      tabId: tab.id,
      windowId: tab.windowId,
      batchId: observed.checkpoint.batchId,
      attempt: task.attempt,
      taskId: task.taskId || null
    });
  }
  for (const task of activeTasks) {
    if (!workers.some((worker) => (
      worker.urlIndex === task.urlIndex &&
      worker.tabId === task.tabId &&
      worker.windowId === task.windowId &&
      worker.attempt === task.attempt
    ))) {
      errors.push(`durable_worker_unobserved:${task.urlIndex}`);
    }
  }
  for (const tab of targetTabs) {
    if (!workers.some((worker) => worker.tabId === tab.id)) {
      errors.push(`unrelated_matching_tab:${tab.id}`);
    }
  }
  return {
    response: observed.response,
    checkpoint: observed.checkpoint,
    consoleTab: observed.consoleTab,
    errors,
    workers
  };
}

function createRecoveryLifecycleLedger(context, origin) {
  const events = [];
  const openCounts = new Map();
  const activeWorkerByPage = new Map();
  const ownershipByPage = new Map();
  const trackedPages = new Map();
  const pageIds = new WeakMap();
  let nextPageId = 0;
  let sequence = 0;
  let maxConcurrentWorkerTabs = 0;
  let disposed = false;

  const pageId = (page) => {
    if (!pageIds.has(page)) pageIds.set(page, ++nextPageId);
    return pageIds.get(page);
  };
  const closeWorker = (page, source) => {
    if (!activeWorkerByPage.has(page)) return;
    const urlIndex = activeWorkerByPage.get(page);
    activeWorkerByPage.delete(page);
    const ownership = ownershipByPage.get(page);
    events.push({
      sequence: ++sequence,
      type: 'close',
      urlIndex,
      pageId: pageId(page),
      source,
      activeWorkerTabs: activeWorkerByPage.size,
      ...(ownership || {})
    });
  };
  const openWorker = (page, rawUrl) => {
    const urlIndex = recoveryTargetIndex(rawUrl, origin);
    if (urlIndex === null) return;
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
      source: 'main-frame-navigation',
      activeWorkerTabs: activeWorkerByPage.size,
      ...(ownershipByPage.get(page) || {})
    });
  };
  const trackPage = (page) => {
    if (disposed || trackedPages.has(page)) return;
    pageId(page);
    const onFrameNavigated = (frame) => {
      if (frame === page.mainFrame()) {
        closeWorker(page, 'main-frame-navigation');
        openWorker(page, frame.url());
      }
    };
    const onClose = () => closeWorker(page, 'page-close');
    trackedPages.set(page, { onFrameNavigated, onClose });
    page.on('framenavigated', onFrameNavigated);
    page.on('close', onClose);
  };

  context.pages().forEach(trackPage);
  context.on('page', trackPage);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      context.off('page', trackPage);
      for (const [page, handlers] of trackedPages) {
        page.off('framenavigated', handlers.onFrameNavigated);
        page.off('close', handlers.onClose);
      }
      trackedPages.clear();
      activeWorkerByPage.clear();
      ownershipByPage.clear();
    },
    bindOwnedWorkers(workers) {
      for (const worker of workers) {
        const ownership = {
          batchId: worker.batchId,
          attempt: worker.attempt,
          taskId: worker.taskId,
          tabId: worker.tabId,
          windowId: worker.windowId
        };
        ownershipByPage.set(worker.page, ownership);
        const expectedPageId = pageId(worker.page);
        const event = events.findLast((candidate) => (
          candidate.type === 'open' &&
          candidate.pageId === expectedPageId &&
          candidate.urlIndex === worker.urlIndex
        ));
        if (event) Object.assign(event, ownership);
      }
    },
    snapshot() {
      return {
        events: events.map((event) => ({ ...event })),
        openedUrlIndices: events.flatMap((event) => (
          event.type === 'open' ? [event.urlIndex] : []
        )),
        openedUrlIndexCounts: Object.fromEntries(
          [...openCounts.entries()].sort(([left], [right]) => left - right)
        ),
        closedUrlIndexCounts: Object.fromEntries(
          events.reduce((counts, event) => {
            if (event.type === 'close') {
              counts.set(
                event.urlIndex,
                (counts.get(event.urlIndex) || 0) + 1
              );
            }
            return counts;
          }, new Map())
        ),
        maxConcurrentWorkerTabs,
        activeWorkerTabs: activeWorkerByPage.size
      };
    }
  };
}

async function waitForValue(load, accepts, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await load();
    if (accepts(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let diagnostic = 'unavailable';
  try {
    diagnostic = JSON.stringify(latest, (key, value) => (
      key === 'page' ? '[Playwright Page]' : value
    ));
  } catch (_) {}
  throw new Error(`acceptance_wait_timeout:${diagnostic}`);
}

async function prepareLocalExtension(temporaryProfile) {
  const extensionRoot = path.join(temporaryProfile, 'extension-under-test');
  await buildExtensionPackage({ outputRoot: extensionRoot });
  const manifestPath = path.join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [
    'http://127.0.0.1/*',
    'https://127.0.0.1/*'
  ];
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
  const monitoredExtensionRequestedUrls = [];
  const extensionProxyLedger = [];
  const pageErrors = [];
  const legacyPageErrors = [];
  const legacyObservedPages = [];
  const extensionPageErrors = [];
  const monitoredExtensionPageErrors = [];
  const monitoredServiceWorkerSignals = [];
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
  let workerOwnershipAudit = null;
  let workerTabsAfterStop = null;
  let legacyPhaseCommentsSubmitted = null;
  let wholeCommandCommentsSubmitted = null;
  let commentsSubmitted = null;
  let runtimeErrorText = '';
  let batchVisibleText = '';
  let thirdPartyRequests = [];
  let monitoredWindowThirdPartyRequests = [];
  let unknownOriginBlockedThirdPartyAttempts = [];
  let monitorExtensionSignals = false;
  let monitoredReloadReady = false;
  let monitoredWorkerClosed = false;
  let monitoredWorkerIdentityVerified = false;
  let restartedTargetIdentityVerified = false;
  let restartedTargetComparisonVerified = false;
  let restartedTargetMode = '';
  let workerErrorAttributionComplete = false;
  let monitoredWorkerObjectMode = '';
  let monitoredWorkerVersionId = null;
  let monitoredWorkerRegistrationId = null;
  let monitoredWorkerTargetId = null;
  let monitorRestartedWorkerErrors = false;
  let monitoredServiceWorkerObjectCount = 0;
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

    async function createLegacyPage(phase) {
      const page = await context.newPage();
      legacyObservedPages.push({
        phase,
        sequence: legacyObservedPages.length + 1
      });
      page.on('pageerror', (error) => {
        const diagnostic = `${phase}:${error.message}`;
        legacyPageErrors.push(diagnostic);
        pageErrors.push(diagnostic);
      });
      return page;
    }

    async function runTarget(index) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const page = await createLegacyPage(`assignment-${index}`);
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

    const failurePage = await createLegacyPage('failure');
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

    const timeoutPage = await createLegacyPage('timeout');
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

    const retryPage = await createLegacyPage('retry');
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

    const interruptionPage = await createLegacyPage('interruption');
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

    const recoveryPage = await createLegacyPage('recovery');
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
    const localExtensionRoot = await prepareLocalExtension(temporaryProfile);
    const localExtensionManifest = JSON.parse(await fs.readFile(
      path.join(localExtensionRoot, 'manifest.json'),
      'utf8'
    ));
    assert.deepEqual(
      localExtensionManifest.host_permissions,
      ['http://127.0.0.1/*', 'https://127.0.0.1/*']
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
    context.on(
      'request',
      (request) => {
        extensionRequestedUrls.push(request.url());
        if (monitorExtensionSignals) {
          monitoredExtensionRequestedUrls.push(request.url());
        }
      }
    );
    const pageErrorListeners = new WeakSet();
    const trackPageErrors = (page) => {
      if (pageErrorListeners.has(page)) return;
      pageErrorListeners.add(page);
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
        extensionPageErrors.push(error.message);
        if (monitorExtensionSignals) {
          monitoredExtensionPageErrors.push(error.message);
        }
      });
    };
    context.pages().forEach(trackPageErrors);
    context.on('page', trackPageErrors);
    const lifecycleMutationLedger = createRecoveryLifecycleLedger(
      context,
      origin
    );
    const lifecycleMutationPage = await context.newPage();
    await lifecycleMutationPage.goto(
      `${origin}/multi/1?lifecycle-mutation=1`,
      { waitUntil: 'domcontentloaded' }
    );
    await lifecycleMutationPage.reload({ waitUntil: 'domcontentloaded' });
    await lifecycleMutationPage.goto('about:blank');
    await lifecycleMutationPage.goto(
      `${origin}/multi/1?lifecycle-mutation=2`,
      { waitUntil: 'domcontentloaded' }
    );
    await lifecycleMutationPage.close();
    const lifecycleMutation = lifecycleMutationLedger.snapshot();
    assert.equal(lifecycleMutation.openedUrlIndexCounts['0'], 3);
    assert.equal(
      lifecycleMutation.events.filter((event) => (
        event.type === 'close' && event.urlIndex === 0
      )).length,
      3
    );
    lifecycleMutationLedger.dispose();
    extensionLifecycle = createRecoveryLifecycleLedger(context, origin);
    let bootstrapServiceWorker = context.serviceWorkers().find(
      (worker) => worker.url().startsWith('chrome-extension://')
    );
    if (!bootstrapServiceWorker) {
      bootstrapServiceWorker = await context.waitForEvent('serviceworker', {
        predicate: (worker) => worker.url().startsWith('chrome-extension://'),
        timeout: 15_000
      });
    }
    assert.match(bootstrapServiceWorker.url(), /\/background\.js$/);
    extensionAutomationVersion = await context.browser()?.version();
    const extensionId = new URL(bootstrapServiceWorker.url()).hostname;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    let monitoredServiceWorker = null;
    let bootstrapWorkerClosed = false;
    const observedServiceWorkers = new Set();
    const workerListeners = new WeakSet();
    const observeServiceWorker = (worker, source) => {
      if (
        workerListeners.has(worker) ||
        !worker.url().startsWith(`${extensionOrigin}/`)
      ) {
        return;
      }
      workerListeners.add(worker);
      observedServiceWorkers.add(worker);
      monitoredServiceWorkerSignals.push({
        kind: 'observed',
        source,
        objectNumber: observedServiceWorkers.size
      });
      worker.on('console', (message) => {
        if (!monitorExtensionSignals) return;
        monitoredServiceWorkerSignals.push({
          kind: 'console',
          level: message.type(),
          text: message.text().slice(0, 500),
          objectNumber: [...observedServiceWorkers].indexOf(worker) + 1
        });
      });
      worker.on('close', () => {
        if (worker === bootstrapServiceWorker) bootstrapWorkerClosed = true;
        if (!monitorExtensionSignals) return;
        monitoredServiceWorkerSignals.push({
          kind: 'close',
          objectNumber: [...observedServiceWorkers].indexOf(worker) + 1
        });
        if (worker === monitoredServiceWorker) monitoredWorkerClosed = true;
      });
    };
    observeServiceWorker(bootstrapServiceWorker, 'bootstrap');
    context.on('serviceworker', (worker) => {
      observeServiceWorker(worker, 'context-event');
    });
    const smokePage = await context.newPage();
    await smokePage.goto(`chrome-extension://${extensionId}/batch.html`, {
      waitUntil: 'domcontentloaded'
    });
    const cdpSession = await context.newCDPSession(smokePage);
    const targetInfos = await cdpSession.send('Target.getTargets');
    const bootstrapTarget = targetInfos.targetInfos.find((target) => (
      target.type === 'service_worker'
      && target.url === bootstrapServiceWorker.url()
    ));
    assert.ok(bootstrapTarget);
    assert.equal(typeof bootstrapTarget.targetId, 'string');
    assert.ok(bootstrapTarget.targetId.length > 0);
    const serviceWorkerVersionSignals = [];
    const serviceWorkerErrorReports = [];
    const observedServiceWorkerVersionIds = new Set();
    const observedServiceWorkerRegistrationIds = new Set();
    cdpSession.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      for (const version of versions) {
        if (
          version.scriptURL
          !== `chrome-extension://${extensionId}/background.js`
        ) {
          continue;
        }
        observedServiceWorkerVersionIds.add(version.versionId);
        observedServiceWorkerRegistrationIds.add(version.registrationId);
        const signal = {
          versionId: version.versionId,
          registrationId: version.registrationId,
          targetId: version.targetId || null,
          scriptURL: version.scriptURL,
          status: version.status,
          runningStatus: version.runningStatus
        };
        const previous = serviceWorkerVersionSignals.at(-1);
        if (
          previous?.versionId !== signal.versionId
          || previous?.status !== signal.status
          || previous?.runningStatus !== signal.runningStatus
        ) {
          serviceWorkerVersionSignals.push(signal);
        }
      }
    });
    cdpSession.on('ServiceWorker.workerErrorReported', ({ errorMessage }) => {
      if (!monitorExtensionSignals) return;
      const sourceURL = String(errorMessage?.sourceURL || '').slice(0, 500);
      let sourceOrigin = null;
      try {
        sourceOrigin = sourceURL
          ? new URL(sourceURL).origin
          : null;
      } catch (_) {}
      serviceWorkerErrorReports.push({
        phase: monitorRestartedWorkerErrors
          ? 'restarted-target-through-context-close'
          : 'restart-transition',
        message: String(errorMessage?.errorMessage || '').slice(0, 500),
        sourceURL,
        sourceOrigin,
        versionId: errorMessage?.versionId || null,
        registrationId: errorMessage?.registrationId || null,
        lineNumber: errorMessage?.lineNumber ?? null,
        columnNumber: errorMessage?.columnNumber ?? null
      });
    });
    monitorExtensionSignals = true;
    await cdpSession.send('ServiceWorker.enable');
    await waitForValue(
      () => serviceWorkerVersionSignals,
      (signals) => signals.some(
        ({ runningStatus }) => runningStatus === 'running'
      )
    );
    await cdpSession.send('ServiceWorker.stopAllWorkers');
    await waitForValue(
      () => serviceWorkerVersionSignals,
      (signals) => signals.some(
        ({ runningStatus }) => runningStatus === 'stopped'
      )
    );
    const stoppedSignalIndex = serviceWorkerVersionSignals.findIndex(
      ({ runningStatus }) => runningStatus === 'stopped'
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
    await waitForValue(
      () => serviceWorkerVersionSignals,
      (signals) => signals.some((signal, index) => (
        index > stoppedSignalIndex
        && signal.runningStatus === 'running'
      ))
    );
    const restartedRunningSignal = serviceWorkerVersionSignals.findLast(
      (signal, index) => (
        index > stoppedSignalIndex &&
        signal.runningStatus === 'running'
      )
    );
    assert.ok(restartedRunningSignal);
    monitoredWorkerVersionId = restartedRunningSignal.versionId;
    monitoredWorkerRegistrationId =
      restartedRunningSignal.registrationId;
    const liveExtensionWorkers = context.serviceWorkers().filter(
      (worker) => worker.url() === `${extensionOrigin}/background.js`
    );
    liveExtensionWorkers.forEach(
      (worker) => observeServiceWorker(worker, 'post-restart-live-set')
    );
    assert.equal(liveExtensionWorkers.length, 1);
    monitoredServiceWorker = liveExtensionWorkers[0];
    if (monitoredServiceWorker === bootstrapServiceWorker) {
      assert.equal(bootstrapWorkerClosed, false);
      monitoredWorkerObjectMode = 'reused-bootstrap-object';
    } else {
      assert.equal(bootstrapWorkerClosed, true);
      assert.equal(observedServiceWorkers.has(monitoredServiceWorker), true);
      monitoredWorkerObjectMode = 'selected-new-worker-object';
    }
    monitoredServiceWorkerObjectCount = observedServiceWorkers.size;
    assert.ok(monitoredServiceWorkerObjectCount >= 1);
    const restartedTargets = await cdpSession.send('Target.getTargets');
    assert.equal(typeof restartedRunningSignal.targetId, 'string');
    assert.ok(restartedRunningSignal.targetId.length > 0);
    const restartedTarget = restartedTargets.targetInfos.find((target) => (
      target.targetId === restartedRunningSignal.targetId &&
      target.type === 'service_worker' &&
      target.url === monitoredServiceWorker.url()
    ));
    assert.ok(restartedTarget);
    monitoredWorkerTargetId = restartedTarget.targetId;
    restartedTargetMode =
      monitoredWorkerTargetId === bootstrapTarget.targetId
        ? 'reused-bootstrap-target'
        : 'new-post-stop-target';
    restartedTargetComparisonVerified = true;
    restartedTargetIdentityVerified = true;
    monitoredWorkerIdentityVerified = true;
    monitorRestartedWorkerErrors = true;
    monitoredServiceWorkerSignals.push({
      kind: 'running',
      source: 'cdp-service-worker-version',
      objectMode: monitoredWorkerObjectMode,
      objectCount: monitoredServiceWorkerObjectCount,
      versionId: monitoredWorkerVersionId,
      registrationId: monitoredWorkerRegistrationId,
      targetId: monitoredWorkerTargetId,
      bootstrapTargetId: bootstrapTarget.targetId
    });
    assert.match(monitoredServiceWorker.url(), /\/background\.js$/);
    await smokePage.reload({ waitUntil: 'domcontentloaded' });
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
    monitoredReloadReady = true;
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

    await waitForValue(
      () => smokePage.evaluate(() => chrome.runtime.sendMessage({
        type: 'BATCH_SESSION_GET'
      })),
      (response) => (
        response?.ok === true
        && [0, 1, 2].every((urlIndex) => (
          response.checkpoint?.tasks?.[String(urlIndex)]?.state === 'active'
        ))
      )
    );
    const initialOwnership = await waitForValue(
      () => observeRecoveryWorkerOwnership(smokePage, context, origin),
      (observation) => (
        observation.errors.length === 0 &&
        observation.workers.length === 3 &&
        observation.workers.map(
          ({ urlIndex }) => urlIndex
        ).sort().join(',') === '0,1,2'
      )
    );
    const initialWorkerTabs = initialOwnership.workers;
    extensionLifecycle.bindOwnedWorkers(initialWorkerTabs);
    const initialCheckpoint = initialOwnership.checkpoint;
    configuredConcurrency = initialCheckpoint.settings.concurrency;
    assert.equal(configuredConcurrency, 3);
    assert.equal(initialWorkerTabs.length, 3);

    closedUrlIndex = 0;
    await initialWorkerTabs.find(
      ({ urlIndex }) => urlIndex === closedUrlIndex
    ).page.close();
    replacementUrlIndex = 3;
    await waitForValue(
      () => smokePage.evaluate(() => chrome.runtime.sendMessage({
        type: 'BATCH_SESSION_GET'
      })),
      (response) => {
        const nextCheckpoint = response?.checkpoint;
        return response?.ok === true
          && nextCheckpoint?.tasks?.[String(closedUrlIndex)]?.state ===
            'terminal'
          && nextCheckpoint.results?.find(
            ({ originalIndex }) => originalIndex === closedUrlIndex
          )?.errorCode === 'task_failed'
          && nextCheckpoint.tasks?.[String(replacementUrlIndex)]?.state ===
            'active';
      }
    );
    const checkpoint = await smokePage.evaluate(() => (
      chrome.runtime.sendMessage({ type: 'BATCH_SESSION_GET' })
    )).then((response) => response.checkpoint);
    const recoveryOwnership = await waitForValue(
      () => observeRecoveryWorkerOwnership(smokePage, context, origin),
      (observation) => (
        observation.errors.length === 0 &&
        observation.workers.length === 3 &&
        observation.workers.map(
          ({ urlIndex }) => urlIndex
        ).sort().join(',') === '1,2,3'
      )
    );
    const activeWorkerTabs = recoveryOwnership.workers;
    extensionLifecycle.bindOwnedWorkers(activeWorkerTabs);
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
    const stoppedOwnership = await waitForValue(
      () => observeRecoveryWorkerOwnership(smokePage, context, origin),
      (observation) => (
        observation.errors.length === 0 &&
        observation.workers.length === 0
      )
    );
    workerTabsAfterStop = stoppedOwnership.workers.length;
    assert.equal(workerTabsAfterStop, 0);

    await context.close();
    context = null;
    monitorExtensionSignals = false;
    finalLifecycle = extensionLifecycle.snapshot();
    assert.equal(finalLifecycle.activeWorkerTabs, 0);
    assert.equal(finalLifecycle.maxConcurrentWorkerTabs, 3);
    const boundLifecycleEvents = finalLifecycle.events.filter((event) => (
      event.type === 'open' || event.type === 'close'
    ));
    assert.equal(boundLifecycleEvents.length, 8);
    assert.equal(boundLifecycleEvents.every((event) => (
      event.batchId === checkpoint.batchId &&
      Number.isInteger(event.attempt) &&
      Number.isInteger(event.tabId) &&
      Number.isInteger(event.windowId) &&
      event.windowId === initialOwnership.consoleTab.windowId
    )), true);
    assert.equal(
      recoveryOwnership.consoleTab.windowId,
      initialOwnership.consoleTab.windowId
    );
    assert.equal(
      stoppedOwnership.consoleTab.windowId,
      initialOwnership.consoleTab.windowId
    );
    workerOwnershipAudit = {
      verified: true,
      consoleWindowId: initialOwnership.consoleTab.windowId,
      workerWindowMatchesConsole: true,
      boundLifecycleEvents: boundLifecycleEvents.length,
      initial: initialWorkerTabs.map((worker) => ({
        urlIndex: worker.urlIndex,
        tabId: worker.tabId,
        windowId: worker.windowId,
        attempt: worker.attempt,
        taskId: worker.taskId
      })),
      afterRemoval: activeWorkerTabs.map((worker) => ({
        urlIndex: worker.urlIndex,
        tabId: worker.tabId,
        windowId: worker.windowId,
        attempt: worker.attempt,
        taskId: worker.taskId
      }))
    };
    await closeServer(extensionProxy);
    extensionProxy = null;

    unknownOriginBlockedThirdPartyAttempts = extensionProxyLedger.filter(
      (entry) => entry.allowed === false
    );
    thirdPartyRequests = extensionProxyLedger.filter((entry) => {
      if (entry.allowed === false) return false;
      return new URL(entry.url).origin !== origin;
    });
    monitoredWindowThirdPartyRequests = monitoredExtensionRequestedUrls.filter(
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
      [...new Set(unknownOriginBlockedThirdPartyAttempts.map((entry) => (
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
    assert.deepEqual(monitoredWindowThirdPartyRequests, []);
    assert.equal(commentsSubmitted, 0);
    assert.equal(wholeCommandCommentsSubmitted, 6);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(extensionPageErrors, []);
    assert.deepEqual(monitoredExtensionPageErrors, []);
    const monitoredServiceWorkerConsoleErrors =
      monitoredServiceWorkerSignals.filter((signal) => (
        signal.kind === 'console' && signal.level === 'error'
      )).map(({ text }) => text);
    const monitoredServiceWorkerErrors = serviceWorkerErrorReports.filter(
      ({ phase }) => phase === 'restarted-target-through-context-close'
    );
    const unattributedMonitoredWorkerErrors =
      monitoredServiceWorkerErrors.filter((error) => (
        error.sourceOrigin !== extensionOrigin ||
        error.versionId !== monitoredWorkerVersionId ||
        error.registrationId !== monitoredWorkerRegistrationId
      ));
    workerErrorAttributionComplete =
      unattributedMonitoredWorkerErrors.length === 0;
    assert.deepEqual(monitoredServiceWorkerConsoleErrors, []);
    assert.deepEqual(serviceWorkerErrorReports, []);
    assert.deepEqual(monitoredServiceWorkerErrors, []);
    assert.equal(monitoredReloadReady, true);
    assert.equal(monitoredWorkerClosed, true);
    assert.equal(monitoredWorkerIdentityVerified, true);
    assert.equal(restartedTargetIdentityVerified, true);
    assert.equal(restartedTargetComparisonVerified, true);
    assert.equal(
      ['reused-bootstrap-target', 'new-post-stop-target'].includes(
        restartedTargetMode
      ),
      true
    );
    assert.equal(workerErrorAttributionComplete, true);
    assert.equal(
      observedServiceWorkerVersionIds.has(monitoredWorkerVersionId),
      true
    );
    assert.equal(
      observedServiceWorkerRegistrationIds.has(
        monitoredWorkerRegistrationId
      ),
      true
    );
    assert.equal(monitoredServiceWorkerObjectCount >= 1, true);
    assert.equal(legacyObservedPages.length, 10);
    assert.deepEqual(legacyPageErrors, []);
    const serviceWorkerRunningStatuses = serviceWorkerVersionSignals.reduce(
      (statuses, { runningStatus }) => {
        if (statuses.at(-1) !== runningStatus) statuses.push(runningStatus);
        return statuses;
      },
      []
    );
    assert.deepEqual(
      serviceWorkerRunningStatuses,
      ['running', 'stopping', 'stopped', 'starting', 'running']
    );
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
      thirdPartyRequests: thirdPartyRequests.length,
      commentsSubmitted,
      commentsSubmittedScope: 'real-extension-recovery',
      pageErrors: monitoredExtensionPageErrors,
      commentLedger: {
        legacyPhase: legacyPhaseCommentsSubmitted,
        realExtensionRecovery: commentsSubmitted,
        wholeCommand: wholeCommandCommentsSubmitted
      },
      pageErrorLedger: {
        bootstrap: 'functional-signals-unobserved',
        legacyScope: 'all-legacy-pages-creation-through-close',
        legacyObservedPageCount: legacyObservedPages.length,
        legacyObservedPages,
        legacyErrors: legacyPageErrors,
        monitoredReloadThroughContextClose: monitoredExtensionPageErrors,
        postBootstrapExtensionObserved: extensionPageErrors,
        wholeCommandObserved: pageErrors
      },
      workerLifecycle: {
        events: finalLifecycle.events,
        activeWorkerTabsAtFinalization: finalLifecycle.activeWorkerTabs,
        mutationProbe: {
          events: lifecycleMutation.events,
          openedUrlIndexCounts:
            lifecycleMutation.openedUrlIndexCounts,
          closedUrlIndexCounts:
            lifecycleMutation.closedUrlIndexCounts
        }
      },
      functionalErrorAudit: {
        bootstrap:
          'network-enforced-functional-signals-unobserved',
        monitoredScope:
          'observer-attached-service-worker-restart-through-context-close',
        monitoredReloadReady,
        monitoredWorkerClosed,
        monitoredWorkerIdentityVerified,
        restartedTargetIdentityVerified,
        restartedTargetComparisonVerified,
        restartedTargetMode,
        workerErrorAttributionComplete,
        monitoredWorkerObjectMode,
        monitoredWorkerObjectCount: monitoredServiceWorkerObjectCount,
        monitoredWorkerVersionId,
        monitoredWorkerRegistrationId,
        monitoredWorkerTargetId,
        monitoredWorkerErrorScope:
          'post-restart-target-window-exact-origin-version-registration',
        monitoredWorkerConsoleErrors:
          monitoredServiceWorkerConsoleErrors,
        monitoredWorkerErrors: monitoredServiceWorkerErrors,
        allWorkerErrorReports: serviceWorkerErrorReports,
        unattributedMonitoredWorkerErrors,
        monitoredPageErrors: monitoredExtensionPageErrors,
        serviceWorkerVersionSignals,
        serviceWorkerRunningStatuses,
        serviceWorkerSignals: monitoredServiceWorkerSignals,
        observedPlaywrightWorkerObjects:
          monitoredServiceWorkerObjectCount
      },
      workerOwnershipAudit,
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
        thirdPartyRequestsScope:
          'forwarded-completed-third-party-egress',
        bootstrapRequestAttribution:
          'unknown-origin-proxy-enforced-only',
        monitoredRequestScope:
          'observer-attached-service-worker-restart-through-context-close',
        temporaryManifestHostPermissions:
          localExtensionManifest.host_permissions,
        temporaryManifestOptionalHostPermissions:
          localExtensionManifest.optional_host_permissions,
        proxyRequests: extensionProxyLedger.length,
        allowedFixtureRequests: extensionProxyLedger.filter(
          (entry) => entry.allowed === true
        ).length,
        monitoredWindowThirdPartyRequests:
          monitoredWindowThirdPartyRequests.length,
        forwardedCompletedThirdPartyEgress: thirdPartyRequests.length,
        unknownOriginBlockedThirdPartyAttempts:
          unknownOriginBlockedThirdPartyAttempts.length,
        unknownOriginBlockedThirdPartyDestinations: [
          ...new Set(unknownOriginBlockedThirdPartyAttempts.map(
            (entry) => new URL(entry.url).hostname
          ))
        ],
        postBootstrapObserverRequests: extensionRequestedUrls.length,
        monitoredReloadThroughCloseRequests:
          monitoredExtensionRequestedUrls.length
      },
      submissionAudit: {
        thirdPartyScope:
          'local-fixture-targets-only-no-third-party-destination',
        configuredThirdPartyDestinations: 0,
        legacyLocalFixtureSubmissions: legacyPhaseCommentsSubmitted,
        realExtensionLocalFixtureSubmissions: commentsSubmitted,
        wholeCommandLocalFixtureSubmissions: wholeCommandCommentsSubmitted
      }
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
        thirdPartyRequestsScope:
          result.requestAudit?.thirdPartyRequestsScope,
        bootstrapFunctionalAttribution:
          result.functionalErrorAudit?.bootstrap,
        monitoredReloadReady:
          result.functionalErrorAudit?.monitoredReloadReady,
        monitoredWorkerClosed:
          result.functionalErrorAudit?.monitoredWorkerClosed,
        monitoredWorkerConsoleErrors:
          result.functionalErrorAudit?.monitoredWorkerConsoleErrors,
        monitoredPageErrors:
          result.functionalErrorAudit?.monitoredPageErrors,
        serviceWorkerRunningStatuses:
          result.functionalErrorAudit?.serviceWorkerRunningStatuses,
        monitoredWorkerIdentityVerified:
          result.functionalErrorAudit?.monitoredWorkerIdentityVerified,
        restartedTargetIdentityVerified:
          result.functionalErrorAudit?.restartedTargetIdentityVerified,
        restartedTargetComparisonVerified:
          result.functionalErrorAudit?.restartedTargetComparisonVerified,
        workerErrorAttributionComplete:
          result.functionalErrorAudit?.workerErrorAttributionComplete,
        monitoredWorkerErrorScope:
          result.functionalErrorAudit?.monitoredWorkerErrorScope,
        workerOwnershipVerified:
          result.workerOwnershipAudit?.verified,
        workerLedgerBoundEvents:
          result.workerOwnershipAudit?.boundLifecycleEvents,
        workerWindowMatchesConsole:
          result.workerOwnershipAudit?.workerWindowMatchesConsole,
        lifecycleMutationOpenedIndexZero:
          result.workerLifecycle?.mutationProbe?.openedUrlIndexCounts?.['0'],
        lifecycleMutationClosedIndexZero:
          result.workerLifecycle?.mutationProbe?.closedUrlIndexCounts?.['0'],
        legacyPhaseCommentsSubmitted: result.commentLedger?.legacyPhase,
        recoveryCommentsSubmitted: result.commentLedger?.realExtensionRecovery,
        wholeCommandCommentsSubmitted: result.commentLedger?.wholeCommand,
        commentsSubmittedScope: result.commentsSubmittedScope,
        legacyObservedPageCount:
          result.pageErrorLedger?.legacyObservedPageCount,
        legacyPageErrorScope:
          result.pageErrorLedger?.legacyScope,
        wholeCommandPageErrors:
          result.pageErrorLedger?.wholeCommandObserved,
        thirdPartySubmissionScope:
          result.submissionAudit?.thirdPartyScope,
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
        thirdPartyRequestsScope:
          'forwarded-completed-third-party-egress',
        bootstrapFunctionalAttribution:
          'network-enforced-functional-signals-unobserved',
        monitoredReloadReady: true,
        monitoredWorkerClosed: true,
        monitoredWorkerConsoleErrors: [],
        monitoredPageErrors: [],
        serviceWorkerRunningStatuses:
          ['running', 'stopping', 'stopped', 'starting', 'running'],
        monitoredWorkerIdentityVerified: true,
        restartedTargetIdentityVerified: true,
        restartedTargetComparisonVerified: true,
        workerErrorAttributionComplete: true,
        monitoredWorkerErrorScope:
          'post-restart-target-window-exact-origin-version-registration',
        workerOwnershipVerified: true,
        workerLedgerBoundEvents: 8,
        workerWindowMatchesConsole: true,
        lifecycleMutationOpenedIndexZero: 3,
        lifecycleMutationClosedIndexZero: 3,
        legacyPhaseCommentsSubmitted: 6,
        recoveryCommentsSubmitted: 0,
        wholeCommandCommentsSubmitted: 6,
        commentsSubmittedScope: 'real-extension-recovery',
        legacyObservedPageCount: 10,
        legacyPageErrorScope:
          'all-legacy-pages-creation-through-close',
        wholeCommandPageErrors: [],
        thirdPartySubmissionScope:
          'local-fixture-targets-only-no-third-party-destination',
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
