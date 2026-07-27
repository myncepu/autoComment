const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('serves exactly five deterministic local target pages', async (t) => {
  await withFixtureServer(t, async (origin) => {
    for (const id of [1, 2, 3, 4, 5]) {
      const response = await fetch(`${origin}/target/${id}?delay=${4000 - (id * 500)}`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.match(html, new RegExp(`Local fixture target ${id}`));
      assert.match(html, new RegExp(`data-target-id="${id}"`));
      assert.match(html, new RegExp(`/target/${id}\\?delay=${4000 - (id * 500)}`));
      assert.match(html, /id="commentform"/);
    }

    assert.equal((await fetch(`${origin}/target/6`)).status, 404);
  });
});

test('serves thirty stress targets and rejects IDs outside the contract', async (t) => {
  await withFixtureServer(t, async (origin) => {
    for (let id = 1; id <= 30; id += 1) {
      const response = await fetch(`${origin}/stress/${id}`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, new RegExp(`Local fixture target ${id}`));
      assert.match(html, new RegExp(`data-fixture-target="${id}"`));
      assert.match(html, new RegExp(`/stress/${id}`));
    }

    for (const id of [0, 31, '01', '1x']) {
      assert.equal(
        (await fetch(`${origin}/stress/${id}`)).status,
        404
      );
    }
  });
});

test('serves five isolated assignment targets and records only safe task fields locally', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const pages = await Promise.all(
      [1, 2, 3, 4, 5].map(async (id) => {
        const response = await fetch(`${origin}/multi/${id}`);
        assert.equal(response.status, 200);
        return response.text();
      })
    );
    pages.forEach((html, index) => {
      assert.match(html, new RegExp(`data-fixture-target="${index + 1}"`));
      assert.match(html, /type="password"/);
      assert.doesNotMatch(html, /https?:\/\/(?!127\\.0\\.0\\.1)/);
    });
    assert.deepEqual(
      await fetch(`${origin}/__fixture/submissions`).then((response) => response.json()),
      []
    );

    const response = await fetch(`${origin}/__fixture/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetId: 2,
        taskId: 'plan:3',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        name: 'Alice',
        email: 'alice@example.test',
        passwordPresent: true,
        passwordMatchesProfile: true,
        password: 'must-not-store',
        websiteUrl: 'https://promo-a.test/',
        comment: 'Local generated comment'
      })
    });
    assert.equal(response.status, 201);
    const records = await fetch(`${origin}/__fixture/submissions`)
      .then((result) => result.json());
    assert.deepEqual(records, [{
      targetId: 2,
      taskId: 'plan:3',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      name: 'Alice',
      email: 'alice@example.test',
      passwordPresent: true,
      passwordMatchesProfile: true,
      websiteUrl: 'https://promo-a.test/',
      comment: 'Local generated comment'
    }]);
    assert.doesNotMatch(JSON.stringify(records), /must-not-store|password":/);

    await fetch(`${origin}/__fixture/reset`, { method: 'POST' });
    assert.deepEqual(
      await fetch(`${origin}/__fixture/submissions`).then((result) => result.json()),
      []
    );
  });
});

test('returns an OpenAI-compatible deterministic local model response', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local-fixture',
        messages: [{ role: 'user', content: 'target 3' }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), {
      choices: [{
        message: {
          content: 'Local fixture comment for target 3'
        }
      }]
    });
  });
});

test('answers model CORS preflight and rejects non-POST model requests', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const preflight = await fetch(`${origin}/v1/chat/completions`, {
      method: 'OPTIONS'
    });
    const invalidMethod = await fetch(`${origin}/v1/chat/completions`);

    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(
      preflight.headers.get('access-control-allow-headers'),
      'authorization, content-type'
    );
    assert.equal(
      preflight.headers.get('access-control-allow-methods'),
      'POST, OPTIONS'
    );
    assert.equal(invalidMethod.status, 405);
    assert.equal(invalidMethod.headers.get('allow'), 'POST, OPTIONS');
  });
});

test('rejects malformed and oversized model JSON bodies', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const malformed = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    const oversized = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(65 * 1024) }] })
    });

    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid JSON body' });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'Request body too large' });
  });
});

test('clamps the local model delay from a prompt URL to zero through five seconds', async (t) => {
  const waited = [];
  const server = createFixtureServer({
    wait(milliseconds) {
      waited.push(milliseconds);
      return Promise.resolve();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  for (const delay of ['-40', '2500', '9000']) {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `Review http://127.0.0.1:4173/target/4?delay=${delay}`
        }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).choices[0].message.content,
      'Local fixture comment for target 4'
    );
  }

  assert.deepEqual(waited, [0, 2500, 5000]);
});

test('batch target CSV contains exactly five localhost fixture URLs and descending delays', () => {
  const csvPath = path.join(__dirname, 'fixtures', 'batch-targets.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);

  assert.equal(lines[0], '页面AS,原URL,URL对应域名,目标域名,类型,外部链接数量');
  assert.deepEqual(lines.slice(1), [
    '1,http://127.0.0.1:4173/target/1?delay=3500,127.0.0.1,fixture.local,comment,0',
    '2,http://127.0.0.1:4173/target/2?delay=3000,127.0.0.1,fixture.local,comment,0',
    '3,http://127.0.0.1:4173/target/3?delay=2500,127.0.0.1,fixture.local,comment,0',
    '4,http://127.0.0.1:4173/target/4?delay=2000,127.0.0.1,fixture.local,comment,0',
    '5,http://127.0.0.1:4173/target/5?delay=1500,127.0.0.1,fixture.local,comment,0'
  ]);
});
