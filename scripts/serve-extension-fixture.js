const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page.html');

function createFixtureServer() {
  return http.createServer((request, response) => {
    if (request.url !== '/' && request.url !== '/comment-page.html') {
      response.writeHead(404).end('Not Found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fixturePath).pipe(response);
  });
}

if (require.main === module) {
  createFixtureServer().listen(4173, '127.0.0.1', () => {
    console.log('Fixture: http://127.0.0.1:4173/comment-page.html');
  });
}

module.exports = { createFixtureServer };
