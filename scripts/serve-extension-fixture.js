const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page.html');
const submitHandlerPath = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page-submit.js');
const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');
const submitHandler = fs.readFileSync(submitHandlerPath, 'utf8');
const fixtureTemplate = fixtureHtml.replace('<!-- LOCAL_SUBMIT_HANDLER -->', `<script>${submitHandler}</script>`);
const MODEL_PATH = '/v1/chat/completions';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderFixturePage({ requestedPath, targetId = '', delayMs = 0 }) {
  const pageTitle = targetId
    ? `Local fixture target ${targetId}`
    : 'Practical accessibility checks';
  return fixtureTemplate
    .replaceAll('{{PAGE_TITLE}}', escapeHtml(pageTitle))
    .replaceAll('{{REQUESTED_PATH}}', escapeHtml(requestedPath))
    .replaceAll('{{TARGET_ID}}', escapeHtml(targetId))
    .replaceAll('{{DELAY_MS}}', escapeHtml(delayMs));
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function readBoundedJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        const error = new Error('Invalid JSON body');
        error.code = 'INVALID_JSON';
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function getPromptText(body) {
  if (!Array.isArray(body?.messages)) return '';
  return body.messages
    .map((message) => typeof message?.content === 'string' ? message.content : '')
    .join('\n');
}

function getTargetId(prompt) {
  const stressMatch = prompt.match(
    /\/stress\/([1-9]|[12]\d|30)\b/i
  );
  if (stressMatch) return Number(stressMatch[1]);
  const pathMatch = prompt.match(/\/target\/([1-5])\b/i);
  if (pathMatch) return Number(pathMatch[1]);
  const multiMatch = prompt.match(/\/multi\/([1-5])\b/i);
  if (multiMatch) return Number(multiMatch[1]);
  const textMatch = prompt.match(/\btarget\s+([1-5])\b/i);
  return textMatch ? Number(textMatch[1]) : 1;
}

function getClampedDelay(prompt) {
  const match = prompt.match(/[?&]delay=(-?\d+)/i);
  if (!match) return 0;
  return Math.max(0, Math.min(5000, Number(match[1])));
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
    passwordMatchesProfile: input?.passwordMatchesProfile === true,
    websiteUrl: text(input?.websiteUrl, 2_000),
    comment: text(input?.comment, 20_000)
  };
}

function createFixtureServer(options = {}) {
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const submissions = [];

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');

    if (
      request.method === 'GET'
      && requestUrl.pathname === '/__fixture/submissions'
    ) {
      writeJson(response, 200, submissions);
      return;
    }
    if (
      request.method === 'POST'
      && requestUrl.pathname === '/__fixture/reset'
    ) {
      submissions.length = 0;
      writeJson(response, 200, { ok: true });
      return;
    }
    if (
      request.method === 'POST'
      && requestUrl.pathname === '/__fixture/submissions'
    ) {
      try {
        const submission = safeSubmission(await readBoundedJson(request));
        submissions.push(submission);
        writeJson(response, 201, submission);
      } catch (_) {
        writeJson(response, 400, { error: 'invalid_fixture_submission' });
      }
      return;
    }

    if (requestUrl.pathname === MODEL_PATH) {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS_HEADERS).end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, {
          ...CORS_HEADERS,
          Allow: 'POST, OPTIONS'
        }).end('Method Not Allowed');
        return;
      }

      let body;
      try {
        body = await readBoundedJson(request);
      } catch (error) {
        if (error.code === 'BODY_TOO_LARGE') {
          writeJson(response, 413, { error: 'Request body too large' });
          return;
        }
        writeJson(response, 400, { error: 'Invalid JSON body' });
        return;
      }

      const prompt = getPromptText(body);
      const targetId = getTargetId(prompt);
      await wait(getClampedDelay(prompt));
      writeJson(response, 200, {
        choices: [{
          message: {
            content: `Local fixture comment for target ${targetId}`
          }
        }]
      });
      return;
    }

    const targetMatch = requestUrl.pathname.match(/^\/target\/([1-5])$/);
    const multiMatch = requestUrl.pathname.match(/^\/multi\/([1-5])$/);
    const stressMatch = requestUrl.pathname.match(
      /^\/stress\/([1-9]|[12]\d|30)$/
    );
    const isBasicFixture = requestUrl.pathname === '/' || requestUrl.pathname === '/comment-page.html';
    if (
      request.method !== 'GET' ||
      (!targetMatch && !multiMatch && !stressMatch && !isBasicFixture)
    ) {
      response.writeHead(404).end('Not Found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderFixturePage({
      requestedPath: `${requestUrl.pathname}${requestUrl.search}`,
      targetId:
        targetMatch?.[1] ||
        multiMatch?.[1] ||
        stressMatch?.[1] ||
        '',
      delayMs: getClampedDelay(requestUrl.search)
    }));
  });
}

if (require.main === module) {
  createFixtureServer().listen(4173, '127.0.0.1', () => {
    console.log('Fixture: http://127.0.0.1:4173/comment-page.html');
  });
}

module.exports = { createFixtureServer };
