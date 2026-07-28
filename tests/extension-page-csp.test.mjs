import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('extension page CSP allows approved model endpoints without weakening script policy', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );
  const policy = manifest.content_security_policy.extension_pages;

  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /connect-src https: http:/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
});

test('manifest grants tab metadata access required by worker ownership proof', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );

  assert.equal(manifest.permissions.includes('tabs'), true);
});

test('content scripts establish the worker handshake at document start', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );

  assert.equal(manifest.content_scripts.length, 1);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('options page uses packaged styles so Chrome can enforce the extension CSP', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'options.html'), 'utf8');
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelectorAll('style').length, 0);
  assert.equal(document.querySelectorAll('[style]').length, 0);
  assert.equal(
    document.querySelector('link[rel="stylesheet"][href="styles/options.css"]') !== null,
    true
  );
});

test('history page uses packaged styles so Chrome can enforce the extension CSP', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'history.html'), 'utf8');
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelectorAll('style').length, 0);
  assert.equal(document.querySelectorAll('[style]').length, 0);
  assert.equal(
    document.querySelector(
      'link[rel="stylesheet"][href="styles/history.css"]'
    ) !== null,
    true
  );
});
