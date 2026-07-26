const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page.html');
const submitHandlerPath = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page-submit.js');
const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');
const submitHandler = fs.readFileSync(submitHandlerPath, 'utf8');
const renderedFixtureHtml = fixtureHtml.replace('<!-- LOCAL_SUBMIT_HANDLER -->', `<script>${submitHandler}</script>`);

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error('fixture_payload_too_large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function safeSubmission(input) {
  const text = (value, maximum = 10_000) => (
    typeof value === 'string' ? value.slice(0, maximum) : ''
  );
  return {
    targetId: Number.isInteger(input?.targetId) ? input.targetId : null,
    taskId: text(input?.taskId, 200),
    profileId: text(input?.profileId, 200),
    promotionSiteId: text(input?.promotionSiteId, 200),
    name: text(input?.name, 500),
    email: text(input?.email, 500),
    passwordPresent: input?.passwordPresent === true,
    websiteUrl: text(input?.websiteUrl, 2_000),
    comment: text(input?.comment, 20_000)
  };
}

function createFixtureServer() {
  const submissions = [];
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/__fixture/submissions') {
      json(response, 200, submissions);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__fixture/reset') {
      submissions.length = 0;
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__fixture/submissions') {
      try {
        const submission = safeSubmission(await readJson(request));
        submissions.push(submission);
        json(response, 201, submission);
      } catch (_) {
        json(response, 400, { error: 'invalid_fixture_submission' });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        const payload = await readJson(request);
        const prompt = Array.isArray(payload?.messages)
          ? payload.messages.map(({ content }) => String(content || '')).join(' ')
          : '';
        json(response, 200, {
          id: 'local-fixture-model',
          choices: [{
            message: {
              role: 'assistant',
              content: `LOCAL_MODEL_COMMENT ${prompt.slice(0, 120)}`.trim()
            }
          }]
        });
      } catch (_) {
        json(response, 400, { error: 'invalid_model_request' });
      }
      return;
    }

    const multiMatch = /^\/multi\/([1-5])$/u.exec(url.pathname);
    if (
      request.method !== 'GET'
      || (!multiMatch && url.pathname !== '/' && url.pathname !== '/comment-page.html')
    ) {
      response.writeHead(404).end('Not Found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderedFixtureHtml.replace(
      '<!-- FIXTURE_TARGET_ID -->',
      multiMatch ? multiMatch[1] : ''
    ));
  });
}

if (require.main === module) {
  createFixtureServer().listen(4173, '127.0.0.1', () => {
    console.log('Fixture: http://127.0.0.1:4173/comment-page.html');
  });
}

module.exports = { createFixtureServer };
