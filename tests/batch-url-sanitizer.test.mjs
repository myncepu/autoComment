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

test('redacts auth schemes, JSON secrets, and hash-router tokens', () => {
  const sentinels = [
    'bearer-secret',
    'basic-secret',
    'json-secret',
    'client-secret',
    'id-secret',
    'hash-secret'
  ];
  const sanitized = sanitizeDiagnosticText([
    'Authorization: Bearer bearer-secret',
    'authorization=Basic basic-secret',
    '{"authorization":"Bearer json-secret",',
    '"client_secret":"client-secret",',
    '"id_token":"id-secret"}',
    'https://example.test/post?view=full#route?access_token=hash-secret&panel=comments'
  ].join('; '));

  for (const sentinel of sentinels) {
    assert.doesNotMatch(sanitized, new RegExp(sentinel));
  }
  assert.match(sanitized, /Authorization:\s*REDACTED/);
  assert.match(sanitized, /client_secret":"REDACTED"/);
  assert.match(sanitized, /id_token":"REDACTED"/);
  assert.match(sanitized, /view=full/);
  assert.match(sanitized, /route\?access_token=REDACTED/);
  assert.match(sanitized, /panel=comments/);
});

test('redacts standalone authorization schemes in restored diagnostic text', () => {
  const sanitized = sanitizeDiagnosticText(
    'Provider rejected Bearer standalone-bearer-sentinel; '
      + 'retry used Basic standalone-basic-sentinel; ordinary detail stays'
  );

  assert.equal(
    sanitized,
    'Provider rejected Bearer REDACTED; retry used Basic REDACTED; ordinary detail stays'
  );
});

test('redacts escaped JSON auth strings without changing ordinary JSON text', () => {
  const sensitive = JSON.stringify({
    authorization: 'Bearer abc\\"stillsecret',
    note: 'keep "quoted" text'
  });
  const ordinary = JSON.stringify({
    message: 'keep "quoted" text',
    status: 'ordinary'
  });

  const sanitized = sanitizeDiagnosticText(sensitive);

  assert.deepEqual(JSON.parse(sanitized), {
    authorization: 'REDACTED',
    note: 'keep "quoted" text'
  });
  assert.doesNotMatch(sanitized, /abc|stillsecret/);
  assert.equal(sanitizeDiagnosticText(ordinary), ordinary);
});
