import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function walk(root, base = root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? walk(absolute, base)
      : [path.relative(base, absolute)];
  });
}

test('builds a loadable extension package without development dependencies or private keys', (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auto-comment-extension-package-')
  );
  const outputRoot = path.join(temporaryRoot, 'extension');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build:extension', '--', '--output', outputRoot],
    {
      cwd: projectRoot,
      encoding: 'utf8'
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = walk(outputRoot);
  assert.equal(files.includes('manifest.json'), true);
  assert.equal(files.includes('background.js'), true);
  assert.equal(files.includes('batch.html'), true);
  assert.equal(files.includes('history.html'), true);
  assert.equal(files.includes('options.html'), true);
  assert.equal(
    files.some((file) => (
      file.split(path.sep).includes('node_modules')
      || /\.(?:pem|key)$/i.test(file)
      || file.split(path.sep).includes('.git')
    )),
    false
  );
});

test('builds the package into a repository dist subdirectory', (t) => {
  const outputRoot = path.join(
    projectRoot,
    'dist',
    `extension-package-test-${process.pid}`
  );
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build:extension', '--', '--output', outputRoot],
    {
      cwd: projectRoot,
      encoding: 'utf8'
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(path.join(outputRoot, 'manifest.json')),
    true
  );
});
