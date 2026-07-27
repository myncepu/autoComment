const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadCaptureHelper(window) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'lib', 'comment-history-capture.js'),
    'utf8'
  );
  vm.runInContext(source, window);
  return window.AutoCommentHistoryCapture;
}

function createCapture() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://host.test/post',
    runScripts: 'outside-only'
  });
  return { dom, capture: loadCaptureHelper(dom.getInternalVMContext()) };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('captures textarea HTML as normalized text and resolved anchors', () => {
  const { dom, capture } = createCapture();
  const { document } = dom.window;
  const editor = document.createElement('textarea');
  editor.value = 'Hello <a href="/go">First</a> <a href="bad url">Second</a>';

  const result = capture.captureSubmission({
    editor,
    pageUrl: 'https://host.test/post',
    promotedWebsiteUrl: 'https://promo.test/',
    now: 1721000000000
  });

  assert.equal(result.submittedAt, 1721000000000);
  assert.equal(result.targetPageUrl, 'https://host.test/post');
  assert.equal(result.promotedWebsiteUrl, 'https://promo.test/');
  assert.equal(result.commentHtml, editor.value);
  assert.equal(result.commentText, 'Hello First Second');
  assert.deepEqual(plain(result.anchors).map(({ anchorText, hrefRaw, hrefResolved }) => ({
    anchorText,
    hrefRaw,
    hrefResolved
  })), [
    { anchorText: 'First', hrefRaw: '/go', hrefResolved: 'https://host.test/go' },
    { anchorText: 'Second', hrefRaw: 'bad url', hrefResolved: 'https://host.test/bad%20url' }
  ]);
});

test('captures contenteditable and wpDiscuz editor HTML without attaching it to the page', () => {
  const { dom, capture } = createCapture();
  const { document } = dom.window;
  const contenteditable = document.createElement('div');
  contenteditable.setAttribute('contenteditable', 'true');
  contenteditable.innerHTML = '  Plain <strong>rich</strong> text ';

  const richResult = capture.captureSubmission({
    editor: contenteditable,
    pageUrl: 'https://host.test/post'
  });
  assert.equal(richResult.commentHtml, '  Plain <strong>rich</strong> text ');
  assert.equal(richResult.commentText, 'Plain rich text');
  assert.deepEqual(plain(richResult.anchors), []);

  const realElement = document.createElement('div');
  realElement.innerHTML = '<a href="/wrapped">Wrapped</a>';
  const wrappedResult = capture.captureSubmission({
    editor: { _realElement: realElement },
    pageUrl: 'https://host.test/post'
  });
  assert.equal(wrappedResult.commentHtml, '<a href="/wrapped">Wrapped</a>');
  assert.equal(wrappedResult.commentText, 'Wrapped');
});

test('preserves raw anchor values while handling newlines, invalid URLs, and empty text', () => {
  const { dom, capture } = createCapture();
  const editor = dom.window.document.createElement('textarea');
  editor.value = [
    '<a href="/relative"> Relative </a>',
    '<a href="https://other.test/a\nb">Multiline</a>',
    '<a href="http://[">Broken</a>',
    '<a href="/empty">   </a>',
    'plain text'
  ].join(' ');

  const result = capture.captureSubmission({
    editor,
    pageUrl: 'https://host.test/post'
  });

  assert.equal(result.commentText, 'Relative Multiline Broken plain text');
  assert.deepEqual(plain(result.anchors), [
    {
      position: 0,
      anchorText: 'Relative',
      hrefRaw: '/relative',
      hrefResolved: 'https://host.test/relative',
      hrefDomain: 'host.test'
    },
    {
      position: 1,
      anchorText: 'Multiline',
      hrefRaw: 'https://other.test/a\nb',
      hrefResolved: 'https://other.test/ab',
      hrefDomain: 'other.test'
    },
    {
      position: 2,
      anchorText: 'Broken',
      hrefRaw: 'http://[',
      hrefResolved: '',
      hrefDomain: ''
    },
    {
      position: 3,
      anchorText: '',
      hrefRaw: '/empty',
      hrefResolved: 'https://host.test/empty',
      hrefDomain: 'host.test'
    }
  ]);
});

test('loads the capture helper before content code', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts[0].js;

  assert.ok(
    scripts.indexOf('lib/comment-history-capture.js') <
      scripts.indexOf('content.js')
  );
});
