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
    'Content-Type': 'application/json; charset=utf-8'
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
  const pathMatch = prompt.match(/\/target\/([1-5])\b/i);
  if (pathMatch) return Number(pathMatch[1]);
  const textMatch = prompt.match(/\btarget\s+([1-5])\b/i);
  return textMatch ? Number(textMatch[1]) : 1;
}

function getClampedDelay(prompt) {
  const match = prompt.match(/[?&]delay=(-?\d+)/i);
  if (!match) return 0;
  return Math.max(0, Math.min(5000, Number(match[1])));
}

function createFixtureServer(options = {}) {
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');

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
    const isBasicFixture = requestUrl.pathname === '/' || requestUrl.pathname === '/comment-page.html';
    if (!targetMatch && !isBasicFixture) {
      response.writeHead(404).end('Not Found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderFixturePage({
      requestedPath: `${requestUrl.pathname}${requestUrl.search}`,
      targetId: targetMatch?.[1] || '',
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
