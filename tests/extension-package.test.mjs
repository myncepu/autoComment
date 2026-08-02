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
const expectedTopLevelEntries = [
  'background.js',
  'batch.html',
  'batch.js',
  'content.js',
  'history.html',
  'history.js',
  'icons',
  'illegal-site-filter.js',
  'lib',
  'manifest.json',
  'options.html',
  'options.js',
  'styles',
  'worker-pending.html'
];

function walk(root, base = root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? walk(absolute, base)
      : [path.relative(base, absolute)];
  });
}

function buildPackage(outputRoot) {
  return spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build:extension', '--', '--output', outputRoot],
    {
      cwd: projectRoot,
      encoding: 'utf8'
    }
  );
}

test('builds the audited production whitelist and every manifest resource', (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auto-comment-extension-package-')
  );
  const outputRoot = path.join(temporaryRoot, 'extension');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const result = buildPackage(outputRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = walk(outputRoot);
  assert.deepEqual(
    fs.readdirSync(outputRoot).sort(),
    [...expectedTopLevelEntries].sort()
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8')
  );
  const manifestResources = [
    manifest.background.service_worker,
    manifest.options_page,
    ...manifest.content_scripts.flatMap(({ js = [] }) => js),
    ...manifest.web_accessible_resources.flatMap(
      ({ resources = [] }) => resources
    )
  ];
  manifestResources.forEach((resource) => {
    assert.equal(
      files.includes(resource),
      true,
      `manifest resource missing from package: ${resource}`
    );
  });
  assert.equal(
    files.includes('lib/vendor/tabulator/tabulator.min.js'),
    true
  );
  assert.equal(
    files.includes('lib/vendor/tabulator/tabulator.min.css'),
    true
  );
  assert.equal(files.includes('lib/vendor/tabulator/LICENSE'), true);
  assert.equal(
    files.some((file) => (
      file.split(path.sep).includes('node_modules')
      || /\.(?:pem|key|map)$/i.test(file)
      || file.split(path.sep).some((segment) => segment.startsWith('.'))
    )),
    false
  );
});

test('excludes nested environment, source-map, hidden, and key artifacts', (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auto-comment-extension-sensitive-')
  );
  const outputRoot = path.join(temporaryRoot, 'extension');
  const fixtureNames = [
    `.env.package-audit-${process.pid}`,
    `.hidden-package-audit-${process.pid}`,
    `package-audit-${process.pid}.js.map`,
    `package-audit-${process.pid}.key`,
    `package-audit-${process.pid}.pem`
  ];
  const fixturePaths = fixtureNames.map((name) => (
    path.join(projectRoot, 'lib', name)
  ));
  fixturePaths.forEach((fixturePath) => {
    fs.writeFileSync(fixturePath, 'package audit fixture\n');
  });
  t.after(() => {
    fixturePaths.forEach((fixturePath) => {
      fs.rmSync(fixturePath, { force: true });
    });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const result = buildPackage(outputRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = walk(outputRoot);
  fixtureNames.forEach((fixtureName) => {
    assert.equal(
      files.includes(path.join('lib', fixtureName)),
      false,
      `sensitive artifact copied: ${fixtureName}`
    );
  });
});

test('manifest keeps deliberate early static injection without activeTab', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );

  assert.equal(manifest.permissions.includes('activeTab'), false);
  assert.equal(manifest.permissions.includes('tabs'), true);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, ['<all_urls>']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('real-extension acceptance runners use the production package builder', () => {
  const runnerPaths = [
    'scripts/run-content-script-start-chrome-acceptance.mjs',
    'scripts/run-multi-assignment-chrome-acceptance.mjs'
  ];

  runnerPaths.forEach((relativePath) => {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.match(source, /import\s*\{[^}]*buildExtensionPackage[^}]*\}/);
    assert.match(source, /buildExtensionPackage\(\{\s*outputRoot/);
    assert.doesNotMatch(source, /includedTopLevel|await fs\.cp\(/);
  });

  const multiAssignmentSource = fs.readFileSync(
    path.join(
      projectRoot,
      'scripts/run-multi-assignment-chrome-acceptance.mjs'
    ),
    'utf8'
  );
  assert.match(
    multiAssignmentSource,
    /productionManifest\.content_scripts\.flatMap/
  );
  assert.doesNotMatch(
    multiAssignmentSource,
    /const productionScripts = \[\s*['"]/
  );
});

test('builds the package into a repository dist subdirectory', (t) => {
  const outputRoot = path.join(
    projectRoot,
    'dist',
    `extension-package-test-${process.pid}`
  );
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  const result = buildPackage(outputRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(path.join(outputRoot, 'manifest.json')),
    true
  );
});
