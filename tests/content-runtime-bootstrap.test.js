const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'lib/content-runtime-bootstrap.js'),
  'utf8'
);

function loadBootstrap() {
  const listeners = [];
  const scope = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          }
        }
      }
    },
    document: { readyState: 'loading' },
    location: { href: 'https://target.test/post' }
  };
  const context = vm.createContext({
    globalThis: scope,
    Object
  });
  vm.runInContext(source, context);
  return { context, listeners, scope };
}

function ping(listener, message = { type: 'PING' }) {
  const responses = [];
  const handled = listener(message, {}, (response) => responses.push(response));
  return {
    handled,
    responses: JSON.parse(JSON.stringify(responses))
  };
}

test('document-start bootstrap answers PING synchronously while runtime initializes', () => {
  const { listeners, scope } = loadBootstrap();

  assert.equal(listeners.length, 1);
  assert.equal(scope.AutoCommentContentRuntimeBootstrap.bootstrapReady, true);
  assert.equal(scope.AutoCommentContentRuntimeBootstrap.runtimeReady, false);
  assert.deepEqual(ping(listeners[0]), {
    handled: false,
    responses: [{
      ok: false,
      error: 'content_runtime_initializing',
      bootstrapReady: true,
      runtimeReady: false,
      documentUrl: 'https://target.test/post',
      readyState: 'loading'
    }]
  });
});

test('markRuntimeReady is idempotent and changes the same PING listener to ready', () => {
  const { listeners, scope } = loadBootstrap();
  const api = scope.AutoCommentContentRuntimeBootstrap;

  const first = api.markRuntimeReady();
  const second = api.markRuntimeReady();

  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    bootstrapReady: true,
    runtimeReady: true,
    documentUrl: 'https://target.test/post',
    readyState: 'loading'
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(second)),
    JSON.parse(JSON.stringify(first))
  );
  assert.equal(api.runtimeReady, true);
  assert.deepEqual(ping(listeners[0]), {
    handled: false,
    responses: [{
      ok: true,
      bootstrapReady: true,
      runtimeReady: true,
      documentUrl: 'https://target.test/post',
      readyState: 'loading'
    }]
  });
});

test('bootstrap ignores unrelated messages and repeated execution adds no listener', () => {
  const { context, listeners, scope } = loadBootstrap();
  const api = scope.AutoCommentContentRuntimeBootstrap;

  assert.deepEqual(ping(listeners[0], { type: 'BATCH_HANDLE' }), {
    handled: false,
    responses: []
  });
  vm.runInContext(source, context);
  assert.equal(listeners.length, 1);
  assert.strictEqual(scope.AutoCommentContentRuntimeBootstrap, api);
});

test('manifest loads only the bootstrap first and content marks it ready once wired', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
  );
  const scripts = manifest.content_scripts[0].js;
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(scripts[0], 'lib/content-runtime-bootstrap.js');
  assert.ok(scripts.indexOf('lib/content-runtime-bootstrap.js') <
    scripts.indexOf('illegal-site-filter.js'));
  assert.match(
    content,
    /AutoCommentContentRuntimeBootstrap\?\.markRuntimeReady\?\.\(\)/
  );
  assert.doesNotMatch(
    content,
    /message\s*&&\s*message\.type\s*===\s*['"]PING['"]/
  );
});
