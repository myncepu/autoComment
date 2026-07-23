import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommentHistoryRecord,
  buildLegacyCommentHistoryRecord,
  makeCommentHistoryId,
  normalizeDomain
} from '../lib/comment-history-record.mjs';

const captured = {
  submittedAt: 1721000000000,
  targetPageUrl: 'https://HOST.test/post?q=1',
  promotedWebsiteUrl: 'https://Promo.Test/path',
  commentHtml: 'Hello <a href="/go">First</a>',
  commentText: 'Hello First',
  anchors: [{
    position: 0,
    anchorText: 'First',
    hrefRaw: '/go',
    hrefResolved: 'https://host.test/go',
    hrefDomain: 'host.test'
  }]
};

test('builds stable comment and anchor records with local archive metadata', () => {
  assert.equal(makeCommentHistoryId('batch-a', 7), 'batch-a:7');
  assert.equal(normalizeDomain('https://EXAMPLE.test/path'), 'example.test');
  assert.equal(normalizeDomain('not a URL'), '');

  const record = buildCommentHistoryRecord({
    batchId: 'batch-a',
    urlIndex: 7,
    history: captured
  }, { now: 1721000000100 });

  assert.deepEqual(record.comment, {
    id: 'batch-a:7',
    batchId: 'batch-a',
    urlIndex: 7,
    submittedAt: 1721000000000,
    archiveMonth: '2024-07',
    targetPageUrl: 'https://HOST.test/post?q=1',
    targetDomain: 'host.test',
    promotedWebsiteUrl: 'https://Promo.Test/path',
    promotedDomain: 'promo.test',
    commentHtml: 'Hello <a href="/go">First</a>',
    commentText: 'Hello First',
    submitStatus: 'submitted',
    source: 'live',
    createdAt: 1721000000100,
    updatedAt: 1721000000100
  });
  assert.deepEqual(record.anchors, [{
    id: 'batch-a:7:0',
    commentId: 'batch-a:7',
    position: 0,
    anchorText: 'First',
    anchorTextNormalized: 'first',
    hrefRaw: '/go',
    hrefResolved: 'https://host.test/go',
    hrefDomain: 'host.test'
  }]);
});

test('rejects comments with invalid required fields', () => {
  const cases = [
    [{ batchId: '', urlIndex: 7, history: captured }, /batchId/],
    [{ batchId: 'batch-a', urlIndex: 1.5, history: captured }, /urlIndex/],
    [{ batchId: 'batch-a', urlIndex: 7, history: { ...captured, targetPageUrl: '' } }, /targetPageUrl/],
    [{ batchId: 'batch-a', urlIndex: 7, history: { ...captured, submittedAt: NaN } }, /submittedAt/],
    [{ batchId: 'batch-a', urlIndex: 7, history: { ...captured, commentHtml: null } }, /commentHtml/]
  ];

  for (const [payload, message] of cases) {
    assert.throws(() => buildCommentHistoryRecord(payload), message);
  }
});

test('uses capture order for unique non-negative anchor IDs', () => {
  const record = buildCommentHistoryRecord({
    batchId: 'batch-a',
    urlIndex: 7,
    history: {
      ...captured,
      anchors: [
        { ...captured.anchors[0], position: 0 },
        { ...captured.anchors[0], position: 0 },
        { ...captured.anchors[0], position: -2 }
      ]
    }
  });

  assert.deepEqual(record.anchors.map(({ id, position }) => ({ id, position })), [
    { id: 'batch-a:7:0', position: 0 },
    { id: 'batch-a:7:1', position: 1 },
    { id: 'batch-a:7:2', position: 2 }
  ]);
});

test('converts only successful legacy entries and parses multiline anchors without a DOM', () => {
  assert.equal(buildLegacyCommentHistoryRecord({ result: 'fail' }, 'batch-a'), null);

  const record = buildLegacyCommentHistoryRecord({
    result: 'success',
    urlIndex: 4,
    url: 'https://Host.test/posts/1',
    aiContent: 'Read <a\n href="/go\nnext">First <strong>nested</strong></a> and <a href="http://[">Broken</a> <a data-href="/wrong">Not a link</a> <a title="contains href=\'/not-real\'">Title only</a> <a href="">Empty</a>',
    timestamp: 1721000000000
  }, 'batch-a');

  assert.equal(record.comment.id, 'batch-a:4');
  assert.equal(record.comment.source, 'legacy');
  assert.equal(record.comment.commentText, 'Read First nested and Broken Not a link Title only Empty');
  assert.equal(record.comment.promotedWebsiteUrl, '');
  assert.deepEqual(record.anchors, [
    {
      id: 'batch-a:4:0',
      commentId: 'batch-a:4',
      position: 0,
      anchorText: 'First nested',
      anchorTextNormalized: 'first nested',
      hrefRaw: '/go\nnext',
      hrefResolved: 'https://host.test/gonext',
      hrefDomain: 'host.test'
    },
    {
      id: 'batch-a:4:1',
      commentId: 'batch-a:4',
      position: 1,
      anchorText: 'Broken',
      anchorTextNormalized: 'broken',
      hrefRaw: 'http://[',
      hrefResolved: '',
      hrefDomain: ''
    },
    {
      id: 'batch-a:4:2',
      commentId: 'batch-a:4',
      position: 2,
      anchorText: 'Not a link',
      anchorTextNormalized: 'not a link',
      hrefRaw: '',
      hrefResolved: '',
      hrefDomain: ''
    },
    {
      id: 'batch-a:4:3',
      commentId: 'batch-a:4',
      position: 3,
      anchorText: 'Title only',
      anchorTextNormalized: 'title only',
      hrefRaw: '',
      hrefResolved: '',
      hrefDomain: ''
    },
    {
      id: 'batch-a:4:4',
      commentId: 'batch-a:4',
      position: 4,
      anchorText: 'Empty',
      anchorTextNormalized: 'empty',
      hrefRaw: '',
      hrefResolved: 'https://host.test/posts/1',
      hrefDomain: 'host.test'
    }
  ]);
});

test('parses a legacy href after a quoted attribute containing a greater-than sign', () => {
  const record = buildLegacyCommentHistoryRecord({
    result: 'success',
    urlIndex: 5,
    url: 'https://host.test/posts/1',
    aiContent: '<a title=">" href="/real">Text</a>',
    timestamp: 1721000000000
  }, 'batch-a');

  assert.equal(record.comment.commentText, 'Text');
  assert.deepEqual(record.anchors, [{
    id: 'batch-a:5:0',
    commentId: 'batch-a:5',
    position: 0,
    anchorText: 'Text',
    anchorTextNormalized: 'text',
    hrefRaw: '/real',
    hrefResolved: 'https://host.test/real',
    hrefDomain: 'host.test'
  }]);
});

test('strips nested tags with quoted greater-than signs from legacy anchor text', () => {
  const record = buildLegacyCommentHistoryRecord({
    result: 'success',
    urlIndex: 6,
    url: 'https://host.test/posts/1',
    aiContent: '<a href="/real"><span title=">">Text</span></a>',
    timestamp: 1721000000000
  }, 'batch-a');

  assert.equal(record.anchors[0].anchorText, 'Text');
});
