import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { bootBatchConsoleFixture } from './fixtures/batch-console-app.mjs';
import { createBatchConsoleFixtureAdapter } from './fixtures/batch-console-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `missing element: ${selector}`);
  element.dispatchEvent(new document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0
  }));
}

async function until(assertion, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      return assertion();
    } catch (error) {
      if (index === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

test('batch fixture is a CSP-safe local module page with a responsive wizard mount', () => {
  const html = read('tests/fixtures/batch-console-page.html');
  const document = new JSDOM(html, {
    url: 'http://127.0.0.1:4173/tests/fixtures/batch-console-page.html'
  }).window.document;

  assert.equal(document.querySelector('meta[name="viewport"]').content, 'width=device-width, initial-scale=1');
  assert.match(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /default-src 'self'/);
  assert.ok(document.querySelector('[data-app-shell]'));
  assert.ok(document.querySelector('main[data-batch-console]'));
  assert.ok(document.querySelector('select[data-fixture-scenario]'));
  assert.ok(document.querySelector('dialog[data-batch-wizard]'));
  assert.ok(document.querySelector(
    'link[href="../../lib/vendor/tabulator/tabulator.min.css"]'
  ));
  assert.ok(document.querySelector('link[href="../../styles/batch-console.css"]'));
  assert.ok(document.querySelector(
    'script[src="../../lib/vendor/tabulator/tabulator.min.js"]'
  ));
  assert.ok(document.querySelector('script[type="module"][src="./batch-console-app.mjs"]'));
  assert.equal(document.querySelector('[onclick],[onchange],[onsubmit],[onkeydown]'), null);
  assert.equal(document.querySelector('script:not([src])'), null);
  assert.equal([...document.querySelectorAll('[src],[href]')].some((element) => {
    const value = element.getAttribute('src') || element.getAttribute('href');
    return /^https?:\/\//i.test(value);
  }), false);
});

test('batch console CSS keeps the queue full-width across responsive modes', () => {
  const document = new JSDOM('<!doctype html><style></style>').window.document;
  document.querySelector('style').textContent = read('styles/batch-console.css');
  const mediaRules = [...document.styleSheets[0].cssRules]
    .filter((rule) => rule.constructor.name === 'CSSMediaRule');
  const conditions = mediaRules.map((rule) => rule.conditionText);

  assert.equal(conditions.includes('(min-width: 1280px)'), false);
  assert.equal(
    conditions.includes('(min-width: 900px) and (max-width: 1279px)'),
    false
  );
  assert.ok(conditions.includes('(max-width: 899px)'));
  assert.ok(conditions.includes('(max-width: 639px)'));
  assert.ok(conditions.includes('(max-width: 1024px)'));
  assert.ok(conditions.includes('(max-width: 640px)'));
  assert.match(
    mediaRules.find((rule) => rule.conditionText === '(max-width: 639px)').cssText,
    /grid-template-columns:\s*repeat\(2/
  );
  assert.ok(conditions.includes('(prefers-reduced-motion: reduce)'));
  const rowActionRule = [...document.styleSheets[0].cssRules].find((rule) => (
    rule.selectorText === '.batch-console__row-actions .batch-console__button'
  ));
  assert.equal(rowActionRule.style.getPropertyValue('min-height'), '40px');
  assert.equal(rowActionRule.style.getPropertyValue('min-width'), '40px');
  const layoutChildRule = [...document.styleSheets[0].cssRules].find((rule) => (
    rule.selectorText === '.batch-console__layout > *'
  ));
  assert.equal(layoutChildRule.style.getPropertyValue('min-width'), '0');
  const layoutRule = [...document.styleSheets[0].cssRules].find((rule) => (
    rule.selectorText === '.batch-console__layout'
  ));
  assert.equal(
    layoutRule.style.getPropertyValue('grid-template-columns'),
    'minmax(0, 1fr)'
  );
  const summariesRule = [...document.styleSheets[0].cssRules].find((rule) => (
    rule.selectorText === '.batch-console__overview-summaries'
  ));
  assert.equal(
    summariesRule.style.getPropertyValue('grid-template-columns'),
    'repeat(2, minmax(0, 1fr))'
  );
  const slotsRule = [...document.styleSheets[0].cssRules].find((rule) => (
    rule.selectorText === '.batch-console__slots'
  ));
  assert.equal(
    slotsRule.style.getPropertyValue('grid-template-columns'),
    'repeat(auto-fit, minmax(210px, 1fr))'
  );
  assert.match(
    mediaRules.find((rule) => rule.conditionText === '(max-width: 899px)').cssText,
    /\.batch-console__overview-summaries\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
  );
});

test('fixture adapter runs real CSV preflight and returns deterministic command results', async () => {
  const adapter = createBatchConsoleFixtureAdapter();
  const parsed = await adapter.application.parseFile({
    name: 'fixture.csv',
    async text() {
      return [
        '原URL,URL对应域名',
        'https://good.test/post,good.test',
        'https://good.test/post,good.test',
        'https://blocked.test/post,blocked.test',
        'not a url,'
      ].join('\n');
    }
  });

  assert.deepEqual(parsed.preflight.summary, {
    raw: 4,
    eligible: 1,
    duplicate: 1,
    blocked: 1,
    invalid: 1,
    included: 1
  });
  assert.deepEqual(parsed.preflight.rows.map((row) => row.status), [
    'eligible',
    'duplicate',
    'blocked',
    'invalid'
  ]);

  const result = await adapter.controller.start({
    ...adapter.application.loadDraft(),
    preflight: parsed.preflight
  });
  assert.deepEqual(result, {
    command: 'start',
    batchId: 'fixture-batch-001',
    status: 'completed',
    counts: {
      total: 1,
      success: 1,
      failed: 0
    }
  });
});

test('fixture adapter exposes safe comment, anchor and promotion previews', () => {
  const adapter = createBatchConsoleFixtureAdapter();
  const snapshot = adapter.application.getSnapshot();
  const failed = snapshot.rows.find((row) => row.urlIndex === 18);
  const manual = snapshot.rows.find((row) => row.urlIndex === 17);

  assert.deepEqual(
    {
      commentText: failed.commentText,
      anchorTexts: failed.anchorTexts,
      promotedWebsiteUrl: failed.promotedWebsiteUrl
    },
    {
      commentText: 'Fixture safe retry draft.',
      anchorTexts: ['Old Blog Guide', 'Promotion Home'],
      promotedWebsiteUrl: 'https://fixture-promo.test/old-blog'
    }
  );
  assert.equal(manual.commentText, 'Fixture uncertain draft.');
  assert.deepEqual(manual.anchorTexts, ['Manual Review']);
  assert.equal(
    manual.promotedWebsiteUrl,
    'https://fixture-promo.test/manual-review'
  );
});

test('fixture adapter drives deterministic console commands, filters and recovery states', async () => {
  const adapter = createBatchConsoleFixtureAdapter();
  const observed = [];
  const unsubscribe = adapter.application.subscribe((snapshot) => {
    observed.push(snapshot.status);
  });

  assert.equal(adapter.application.getSnapshot().status, 'running');
  await adapter.controller.pause();
  assert.equal(adapter.application.getSnapshot().status, 'paused_recovery');
  await adapter.controller.resume();
  assert.equal(adapter.application.getSnapshot().status, 'running');

  await adapter.controller.retry({ urlIndex: 18, attempt: 1 }, false);
  let snapshot = adapter.application.getSnapshot();
  assert.equal(
    snapshot.rows.find((row) => row.urlIndex === 18).attempt,
    2
  );
  const manualHandle = await adapter.controller.openManual({
    urlIndex: 17,
    attempt: 1
  });
  assert.deepEqual(manualHandle, {
    id: 901,
    type: 'normal',
    automation: false
  });
  await adapter.controller.manualUpdate(
    { urlIndex: 17, attempt: 1 },
    'resolved'
  );
  snapshot = adapter.application.getSnapshot();
  assert.equal(
    snapshot.rows.find((row) => row.urlIndex === 17).manualResolution.status,
    'resolved'
  );
  await assert.rejects(
    adapter.controller.retry({ urlIndex: 17, attempt: 1 }, false),
    /retry_confirmation_required/
  );
  await adapter.controller.retry({ urlIndex: 17, attempt: 1 }, true);

  adapter.application.setFilters({
    status: 'running',
    domain: 'target.test',
    timeRange: 'all',
    keyword: '/1'
  });
  assert.deepEqual(
    adapter.application.getSnapshot().filteredRows.map((row) => row.urlIndex),
    [1]
  );
  for (const [scenario, expected] of [
    ['offline', 'paused_recovery'],
    ['recovery', 'paused_recovery'],
    ['persistence', 'paused_recovery'],
    ['error', 'paused_recovery'],
    ['empty', 'empty'],
    ['running', 'running']
  ]) {
    adapter.application.selectScenario(scenario);
    assert.equal(adapter.application.getSnapshot().status, expected);
  }

  await adapter.controller.stop(true);
  assert.equal(adapter.application.getSnapshot().status, 'terminated');
  assert.deepEqual(
    adapter.application.getCommandLog().filter((entry) => (
      ['pause', 'resume', 'retry', 'manual-open', 'manual-update', 'stop']
        .includes(entry.command)
    )).map((entry) => [entry.command, entry.confirmedRisk ?? null]),
    [
      ['pause', null],
      ['resume', null],
      ['retry', false],
      ['manual-open', null],
      ['manual-update', null],
      ['retry', false],
      ['retry', true],
      ['stop', true]
    ]
  );
  assert.ok(observed.includes('paused_recovery'));
  unsubscribe();
});

test('fixture pause and resume preserve explicit manual outcomes', async () => {
  const adapter = createBatchConsoleFixtureAdapter();

  await adapter.controller.openManual({ urlIndex: 17, attempt: 1 });
  await adapter.controller.manualUpdate(
    { urlIndex: 17, attempt: 1 },
    'unresolved'
  );
  await adapter.controller.pause();
  await adapter.controller.resume();

  const row = adapter.application.getSnapshot().rows.find(
    (candidate) => candidate.urlIndex === 17
  );
  assert.equal(row.manualResolution.status, 'unresolved');
});

test('fixture app boots shell and completes the wizard in an ordinary HTTP document', async () => {
  const dom = new JSDOM(read('tests/fixtures/batch-console-page.html'), {
    url: 'http://127.0.0.1:4173/tests/fixtures/batch-console-page.html',
    pretendToBeVisual: true
  });
  const { document } = dom.window;
  const adapter = createBatchConsoleFixtureAdapter();
  const app = bootBatchConsoleFixture(document, adapter);

  assert.ok(app);
  assert.equal(document.querySelector('[aria-current="page"]').textContent, '批次');
  assert.equal(document.querySelectorAll('[data-summary-count]').length, 7);
  assert.equal(document.querySelectorAll('[data-worker-slot]').length, 3);
  assert.equal(document.querySelectorAll('[data-task-row]').length, 5);
  const failedRow = document.querySelector('[data-task-row="18"]');
  const previews = failedRow.querySelectorAll('[data-preview-value]');
  assert.equal(previews.length, 3);
  assert.equal(previews[0].title, 'Fixture safe retry draft.');
  assert.equal(previews[1].title, 'Old Blog Guide · Promotion Home');
  assert.equal(
    previews[2].title,
    'https://fixture-promo.test/old-blog'
  );
  click(document, '[data-action="new-batch"]');
  assert.equal(document.querySelector('[data-batch-wizard]').hasAttribute('open'), true);

  click(document, '[data-action="wizard-next"]');
  const fileInput = document.querySelector('input[type="file"]');
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{
      name: 'fixture.csv',
      async text() {
        return [
          '原URL,URL对应域名',
          'https://good.test/a,good.test',
          'https://good.test/b,good.test'
        ].join('\n');
      }
    }]
  });
  fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await until(() => assert.match(
    document.querySelector('[data-preflight-summary]').textContent,
    /将处理 2/
  ));

  click(document, '[data-action="wizard-next"]');
  click(document, '[data-action="wizard-next"]');
  click(document, '[data-action="wizard-start"]');
  await until(() => assert.equal(
    document.querySelector('[data-fixture-command-status]').textContent,
    'fixture-batch-001 · completed · 成功 2/2'
  ));
  assert.equal(document.querySelector('[data-batch-wizard]').hasAttribute('open'), false);
});

test('fixture app performs console interactions and switches every recovery scenario', async () => {
  const dom = new JSDOM(read('tests/fixtures/batch-console-page.html'), {
    url: 'http://127.0.0.1:4173/tests/fixtures/batch-console-page.html',
    pretendToBeVisual: true
  });
  const { document } = dom.window;
  const adapter = createBatchConsoleFixtureAdapter();
  const app = bootBatchConsoleFixture(document, adapter);

  click(document, '[data-action="details"][data-url-index="17"]');
  assert.match(document.querySelector('[data-task-drawer]').textContent, /submission_uncertain/);
  click(document, '[data-drawer-close]');

  click(document, '[data-action="pause"]');
  click(document, '[data-dialog-confirm]');
  await until(() => assert.equal(
    document.querySelector('[data-batch-status]').textContent,
    '已暂停，可恢复'
  ));
  click(document, '[data-action="resume"]');
  await until(() => assert.equal(
    document.querySelector('[data-batch-status]').textContent,
    '运行中'
  ));

  click(document, '[data-action="retry"][data-url-index="18"]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /已重新排队/
  ));
  click(document, '[data-action="manual"][data-url-index="17"]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /普通人工窗口/
  ));
  click(document, '[data-action="manual-unresolved"][data-url-index="17"]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /仍未解决/
  ));
  click(document, '[data-action="retry"][data-url-index="17"]');
  click(document, '[data-dialog-confirm]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /已确认风险并重新排队/
  ));
  click(document, '[data-action="focus-tab"][data-url-index="0"]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /已聚焦 worker 标签页/
  ));
  click(document, '[data-action="export"]');
  await until(() => assert.match(
    document.querySelector('[data-command-result]').textContent,
    /已导出 5 条/
  ));

  const scenario = document.querySelector('[data-fixture-scenario]');
  for (const [value, expected] of [
    ['offline', /当前离线/],
    ['recovery', /已从检查点安全恢复/],
    ['persistence', /尚未持久化/],
    ['error', /worker_pause_failed/],
    ['empty', /尚无批次/],
    ['running', /运行中/]
  ]) {
    scenario.value = value;
    scenario.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.match(document.querySelector('[data-batch-console]').textContent, expected);
  }

  assert.equal(
    adapter.application.getCommandLog().some((entry) => entry.command === 'focus-tab'),
    true
  );
  app.destroy();
});

test('options page declares a mobile viewport', () => {
  const document = new JSDOM(read('options.html')).window.document;
  assert.equal(
    document.querySelector('meta[name="viewport"]').content,
    'width=device-width, initial-scale=1'
  );
});
