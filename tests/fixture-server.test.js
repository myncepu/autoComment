const test = require('node:test');
const assert = require('node:assert/strict');

const { createFixtureServer } = require('../scripts/serve-extension-fixture.js');

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

test('fixture submission stays in the page and contains no external target', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const html = await (await fetch(`${origin}/comment-page.html`)).text();

    assert.match(html, /event\.preventDefault\(\)/);
    assert.match(html, /submit-result[\s\S]*LOCAL_SUBMIT_OK/);
    assert.doesNotMatch(html, /<form[^>]+\saction=/i);
    assert.doesNotMatch(html, /https?:\/\//i);
  });
});
