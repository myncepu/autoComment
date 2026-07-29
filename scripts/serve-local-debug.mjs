import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 4376;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'debug');
const ROUTES = new Map([
  ['/', ['local-debug.html', 'text/html; charset=utf-8']],
  ['/local-debug.js', ['local-debug.js', 'text/javascript; charset=utf-8']],
  ['/local-debug.css', ['local-debug.css', 'text/css; charset=utf-8']]
]);

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'none'",
    "img-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  const pathname = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname;
  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, host: HOST, port: PORT }));
    return;
  }
  const route = ROUTES.get(pathname);
  if (!route || !['GET', 'HEAD'].includes(request.method || 'GET')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  const [fileName, contentType] = route;
  const filePath = join(ROOT, fileName);
  try {
    const file = await stat(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': file.size
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      createReadStream(filePath).pipe(response);
    }
  } catch (_) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Debug asset unavailable');
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Auto Comment local debug: http://${HOST}:${PORT}/\n`);
});
