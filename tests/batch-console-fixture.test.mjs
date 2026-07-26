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
  assert.ok(document.querySelector('[data-action="new-batch"]'));
  assert.ok(document.querySelector('dialog[data-batch-wizard]'));
  assert.ok(document.querySelector('link[href="../../styles/batch-console.css"]'));
  assert.ok(document.querySelector('script[type="module"][src="./batch-console-app.mjs"]'));
  assert.equal(document.querySelector('[onclick],[onchange],[onsubmit],[onkeydown]'), null);
  assert.equal(document.querySelector('script:not([src])'), null);
  assert.equal([...document.querySelectorAll('[src],[href]')].some((element) => {
    const value = element.getAttribute('src') || element.getAttribute('href');
    return /^https?:\/\//i.test(value);
  }), false);
});

test('batch console CSS exposes safe 1024 and 640 layout modes', () => {
  const document = new JSDOM('<!doctype html><style></style>').window.document;
  document.querySelector('style').textContent = read('styles/batch-console.css');
  const mediaRules = [...document.styleSheets[0].cssRules]
    .filter((rule) => rule.constructor.name === 'CSSMediaRule');
  const conditions = mediaRules.map((rule) => rule.conditionText);

  assert.ok(conditions.includes('(max-width: 1024px)'));
  assert.ok(conditions.includes('(max-width: 640px)'));
  assert.match(
    mediaRules.find((rule) => rule.conditionText === '(max-width: 640px)').cssText,
    /overflow-x:\s*auto/
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

test('options page declares a mobile viewport', () => {
  const document = new JSDOM(read('options.html')).window.document;
  assert.equal(
    document.querySelector('meta[name="viewport"]').content,
    'width=device-width, initial-scale=1'
  );
});
