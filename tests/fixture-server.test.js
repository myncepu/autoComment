const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { createFixtureServer } = require('../scripts/serve-extension-fixture.js');
const { installLocalSubmitHandler } = require('./fixtures/comment-page-submit.js');

async function withFixtureServer(t, callback) {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return callback(`http://127.0.0.1:${port}`);
}

test('serves a local comment form on a dynamic localhost port', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const response = await fetch(`${origin}/comment-page.html`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(html, /id="comment"/);
    assert.match(html, /id="author"/);
    assert.match(html, /id="email"/);
    assert.match(html, /id="url"/);
    assert.match(html, /id="submit"/);
    assert.match(html, /id="submit-result"/);
  });
});

test('serves the same fixture from the root path and rejects unknown paths', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const [rootResponse, missingResponse] = await Promise.all([
      fetch(`${origin}/`),
      fetch(`${origin}/missing`)
    ]);

    assert.equal(rootResponse.status, 200);
    assert.equal(missingResponse.status, 404);
  });
});

test('local submit handler prevents navigation and writes only the success state', () => {
  let submitHandler;
  const result = { textContent: '' };
  const form = {
    addEventListener(type, handler) {
      assert.equal(type, 'submit');
      submitHandler = handler;
    }
  };
  const document = {
    getElementById(id) {
      return { commentform: form, 'submit-result': result }[id];
    }
  };
  let prevented = false;

  installLocalSubmitHandler(document);
  submitHandler({ preventDefault() { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(result.textContent, 'LOCAL_SUBMIT_OK');
});

test('fixture scripts register and execute a local-only form submission', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const html = await (await fetch(`${origin}/comment-page.html`)).text();
    const handlers = new Map();
    const result = { textContent: '' };
    const form = {
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
      dispatchEvent(event) {
        handlers.get(event.type)(event);
      }
    };
    const document = {
      getElementById(id) {
        return { commentform: form, 'submit-result': result }[id];
      }
    };
    let networkCalls = 0;
    const context = vm.createContext({
      document,
      fetch() {
        networkCalls += 1;
        throw new Error('network access is forbidden');
      }
    });

    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      vm.runInContext(script, context);
    }

    let prevented = false;
    form.dispatchEvent({ type: 'submit', preventDefault() { prevented = true; } });

    assert.equal(prevented, true);
    assert.equal(result.textContent, 'LOCAL_SUBMIT_OK');
    assert.equal(networkCalls, 0);
    assert.doesNotMatch(html, /<form[^>]+\saction=/i);
    assert.doesNotMatch(html, /https?:\/\//i);
  });
});
