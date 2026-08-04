import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  renderBatchBootFailure
} from '../lib/batch-entry-error-view.mjs';

test('renders an actionable localized boot failure without exposing its code', () => {
  const dom = new JSDOM(`<!doctype html>
    <main data-batch-console></main>
    <dialog data-batch-wizard></dialog>`);
  let retries = 0;

  renderBatchBootFailure(dom.window.document, {
    code: 'batch_ownership_unverified',
    onRetry() {
      retries += 1;
    }
  });

  const alert = dom.window.document.querySelector(
    '[data-batch-boot-failure][role="alert"]'
  );
  assert.ok(alert);
  assert.match(alert.textContent, /无法启动|重新加载/);
  assert.doesNotMatch(alert.textContent, /batch_ownership_unverified/);
  assert.equal(
    alert.dataset.diagnosticCode,
    'batch_ownership_unverified'
  );
  alert.querySelector('[data-action="retry-batch-boot"]').click();
  assert.equal(retries, 1);
  assert.equal(
    dom.window.document.querySelector('[data-batch-wizard]').open,
    false
  );
});

test('replaces a prior boot failure instead of duplicating controls', () => {
  const dom = new JSDOM('<main data-batch-console></main>');

  renderBatchBootFailure(dom.window.document, {
    code: 'batch_runtime_failed'
  });
  renderBatchBootFailure(dom.window.document, {
    code: 'domain_config_unavailable'
  });

  assert.equal(
    dom.window.document.querySelectorAll('[data-batch-boot-failure]').length,
    1
  );
});
