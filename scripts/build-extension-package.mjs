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
const includedTopLevel = new Set([
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
]);
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
  return !/\.(?:key|pem)$/i.test(relative);
}

async function build(outputRoot) {
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
  for (const entry of includedTopLevel) {
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

const outputRoot = parseOutput(process.argv.slice(2));
const built = await build(outputRoot);
console.log(JSON.stringify({
  ok: true,
  output: built
}));
