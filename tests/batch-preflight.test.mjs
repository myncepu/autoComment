import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preflightBatchRows,
  withDuplicateIncluded
} from '../lib/batch-preflight.mjs';

const parsed = {
  headers: ['页面AS', '原URL', 'URL对应域名'],
  rows: [
    ['1', 'https://good.test/post', 'good.test'],
    ['2', 'https://good.test/post', 'good.test'],
    ['3', 'https://blocked.test/post', 'blocked.test'],
    ['4', 'not a url', ''],
    ['5', 'https://next.test/post', 'next.test']
  ]
};

test('preflights eligible, duplicate, blocked, and invalid rows', () => {
  const result = preflightBatchRows(parsed, {
    evaluateUrl(url) {
      return url.includes('blocked.test')
        ? { blocked: true, code: 'illegal_site', reason: 'blocked fixture' }
        : { blocked: false };
    }
  });
  assert.deepEqual(result.summary, {
    raw: 5,
    eligible: 2,
    duplicate: 1,
    blocked: 1,
    invalid: 1,
    included: 2
  });
  assert.deepEqual(result.rows.map(({ status, included }) => ({
    status,
    included
  })), [
    { status: 'eligible', included: true },
    { status: 'duplicate', included: false },
    { status: 'blocked', included: false },
    { status: 'invalid', included: false },
    { status: 'eligible', included: true }
  ]);
});

test('allows only duplicate rows to be explicitly included', () => {
  const result = preflightBatchRows(parsed, {
    evaluateUrl() {
      return { blocked: false };
    }
  });
  const included = withDuplicateIncluded(result, 3, true);
  assert.equal(included.rows[1].included, true);
  assert.equal(included.summary.included, 4);
  assert.throws(
    () => withDuplicateIncluded(result, 4, true),
    /preflight_row_not_overridable/
  );
});

test('rejects URL userinfo credentials during preflight', () => {
  const result = preflightBatchRows({
    headers: ['原URL'],
    rows: [['https://alice:hunter2@example.test/post']]
  }, {
    evaluateUrl() {
      return { blocked: false };
    }
  });

  assert.equal(result.rows[0].status, 'invalid');
  assert.equal(result.rows[0].included, false);
  assert.match(result.rows[0].reason, /凭证/);
  assert.doesNotMatch(JSON.stringify(result), /alice|hunter2/);
});

test('redacts sensitive query values while preserving ordinary preflight query params', () => {
  const result = preflightBatchRows({
    headers: ['原URL'],
    rows: [[
      'https://example.test/post?view=thread&token=secret-token&page=2'
    ]]
  }, {
    evaluateUrl() {
      return { blocked: false };
    }
  });

  assert.equal(
    result.rows[0].url,
    'https://example.test/post?view=thread&token=REDACTED&page=2'
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});
