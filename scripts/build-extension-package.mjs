import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const defaultOutput = path.join(
  projectRoot,
  'dist',
  'auto-comment-plugin'
);
export const extensionPackageTopLevelEntries = Object.freeze([
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
  'records.html',
  'records.js',
  'styles',
  'worker-pending.html'
]);
const includedTopLevel = new Set(extensionPackageTopLevelEntries);
const blockedSegments = new Set([
  '.git',
  '.superpowers',
  'node_modules'
]);

function parseOutput(args) {
  if (args.length === 0) return defaultOutput;
  if (
    args.length !== 2
    || args[0] !== '--output'
    || typeof args[1] !== 'string'
    || args[1].trim() === ''
  ) {
    throw new Error('usage: build-extension-package [--output <directory>]');
  }
  return path.resolve(projectRoot, args[1]);
}

function packageFilter(source) {
  const relative = path.relative(projectRoot, source);
  if (relative === '') return true;
  const segments = relative.split(path.sep);
  if (!includedTopLevel.has(segments[0])) return false;
  if (segments.some((segment) => blockedSegments.has(segment))) return false;
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  return !/\.(?:key|map|pem)$/i.test(relative);
}

export async function buildExtensionPackage({
  outputRoot = defaultOutput
} = {}) {
  outputRoot = path.resolve(outputRoot);
  if (
    outputRoot === projectRoot
    || outputRoot === path.parse(outputRoot).root
  ) {
    throw new Error('unsafe_extension_output');
  }
  const outputExists = await fs.stat(outputRoot)
    .then(() => true)
    .catch(() => false);
  if (outputExists) {
    if (outputRoot !== defaultOutput) {
      throw new Error('extension_output_exists');
    }
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
  await fs.mkdir(outputRoot, { recursive: true });
  for (const entry of extensionPackageTopLevelEntries) {
    await fs.cp(
      path.join(projectRoot, entry),
      path.join(outputRoot, entry),
      {
        recursive: true,
        filter: packageFilter
      }
    );
  }
  return outputRoot;
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputRoot = parseOutput(process.argv.slice(2));
  const built = await buildExtensionPackage({ outputRoot });
  console.log(JSON.stringify({
    ok: true,
    output: built
  }));
}
