import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasUrlCredentials,
  sanitizeBatchUrl,
  sanitizeDiagnosticText
} from '../lib/batch-url-sanitizer.mjs';

test('detects URL userinfo credentials before batch ingestion', () => {
  assert.equal(
    hasUrlCredentials('https://alice:hunter2@example.test/post'),
    true
  );
  assert.equal(
    hasUrlCredentials('https://example.test/post?author=alice'),
    false
  );
});

test('redacts only sensitive query values and URL userinfo', () => {
  const sanitized = sanitizeBatchUrl(
    'https://alice:hunter2@example.test/post?normal=keep&token=abc&api_key=def&foo=bar#comments'
  );

  assert.equal(
    sanitized,
    'https://example.test/post?normal=keep&token=REDACTED&api_key=REDACTED&foo=bar#comments'
  );
  assert.doesNotMatch(sanitized, /alice|hunter2|abc|def/);
});

test('redacts embedded URLs and raw sensitive assignments in Chrome errors', () => {
  const sanitized = sanitizeDiagnosticText(
    'Cannot access https://user:pass@example.test/a?normal=yes&auth=secret-auth; token=raw-token'
  );

  assert.match(sanitized, /normal=yes/);
  assert.match(sanitized, /auth=REDACTED/);
  assert.match(sanitized, /token=REDACTED/);
  assert.doesNotMatch(sanitized, /user|pass|secret-auth|raw-token/);
});
