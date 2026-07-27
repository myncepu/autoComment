import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_RESULT_ASSIGNMENT_COLUMNS,
  buildBatchResult,
  buildBatchResultCsv
} from '../lib/batch-result-record.mjs';

function taskSnapshot() {
  return {
    urlIndex: 2,
    targetUrl: 'https://target.test/post',
    sourceDomain: 'target.test',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted',
    configRevision: 7,
    profile: {
      id: 'profile-a',
      displayName: 'Operator A',
      name: 'Real Name',
      email: 'alice@example.test'
    },
    promotionSite: {
      id: 'site-a',
      name: 'Promo A',
      url: 'https://promo-a.test/',
      content: 'site description'
    },
    originalRow: ['https://target.test/post', 'target.test']
  };
}

test('records IDs and display snapshots without PII or site description', () => {
  const result = buildBatchResult(taskSnapshot(), {
    result: 'success',
    aiContent: 'Published comment',
    resultPreview: {
      commentText: ' Published comment ',
      anchors: [{ anchorText: 'Promo A' }],
      promotedWebsiteUrl: 'https://promo-a.test/?token=private'
    },
    errorCode: null,
    skipReason: null
  }, {
    timestamp: 1_000,
    elapsed: 3,
    attempt: 2
  });

  assert.deepEqual(result, {
    originalIndex: 2,
    url: 'https://target.test/post',
    sourceDomain: 'target.test',
    result: 'success',
    aiContent: 'Published comment',
    commentText: 'Published comment',
    anchorTexts: ['Promo A'],
    promotedWebsiteUrl: 'https://promo-a.test/?token=REDACTED',
    errorMessage: null,
    timestamp: 1_000,
    elapsed: 3,
    originalRow: ['https://target.test/post', 'target.test'],
    profileId: 'profile-a',
    profileDisplayName: 'Operator A',
    promotionSiteId: 'site-a',
    promotionSiteName: 'Promo A',
    promotionSiteUrl: 'https://promo-a.test/',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted',
    configRevision: 7,
    attemptCount: 1,
    errorCode: null,
    skipReason: null
  });
  assert.doesNotMatch(JSON.stringify(result),
    /alice@example|real name|site description|password/i);
});

test('normalizes failed outcomes and never stores raw error objects', () => {
  const result = buildBatchResult(taskSnapshot(), {
    result: 'fail',
    errorMessage: 'Safe message',
    errorCode: 'content_ready_timeout',
    skipReason: 'retry_exhausted',
    error: { password: 'DO_NOT_STORE' }
  }, {
    timestamp: 2_000,
    elapsed: -1,
    attempt: 0
  });

  assert.equal(result.errorMessage, 'Safe message');
  assert.equal(result.errorCode, 'content_ready_timeout');
  assert.equal(result.skipReason, 'retry_exhausted');
  assert.equal(result.attemptCount, 0);
  assert.equal(JSON.stringify(result).includes('DO_NOT_STORE'), false);
});

test('appends stable assignment CSV columns with formula protection', () => {
  const result = buildBatchResult({
    ...taskSnapshot(),
    profile: { ...taskSnapshot().profile, displayName: '=Operator' }
  }, {
    result: 'success'
  }, {
    timestamp: 1_000,
    elapsed: 1,
    attempt: 1
  });
  const csv = buildBatchResultCsv(['URL', 'source'], [result]);

  assert.deepEqual(BATCH_RESULT_ASSIGNMENT_COLUMNS, [
    'profileId',
    'profileDisplayName',
    'promotionSiteId',
    'promotionSiteName',
    'promotionSiteUrl',
    'assignmentPairId',
    'assignmentSource',
    'configRevision',
    'attemptCount',
    'errorCode',
    'skipReason'
  ]);
  assert.match(csv, /^\ufeffURL,source,profileId,/u);
  assert.match(csv, /profile-a,'=Operator,site-a/);
  assert.doesNotMatch(csv, /alice@example|site description|password/i);
});
