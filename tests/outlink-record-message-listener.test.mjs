import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installOutlinkRecordMessageListener,
  OUTLINK_RECORDS_PAGE,
  OUTLINK_MESSAGE_TYPES
} from '../lib/outlink-record-message-listener.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function createHarness() {
  const createdTabs = [];
  let listener;
  const chromeApi = {
    runtime: {
      id: 'extension-test',
      getURL(relativePath) {
        return `chrome-extension://extension-test/${relativePath}`;
      },
      onMessage: {
        addListener(nextListener) {
          listener = nextListener;
        }
      }
    },
    tabs: {
      async create(details) {
        createdTabs.push(details);
      }
    }
  };
  installOutlinkRecordMessageListener(
    chromeApi,
    new Promise(() => {})
  );
  return { chromeApi, createdTabs, get listener() { return listener; } };
}

function dispatch(listener, message, sender) {
  return new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), true);
  });
}

test('opens the private outlink page from the extension service worker', async () => {
  const harness = createHarness();

  const response = await dispatch(
    harness.listener,
    { type: OUTLINK_MESSAGE_TYPES.OPEN_PAGE },
    { id: harness.chromeApi.runtime.id, tab: { id: 42 } }
  );

  assert.deepEqual(response, { ok: true, data: { opened: true } });
  assert.deepEqual(harness.createdTabs, [{
    url: 'chrome-extension://extension-test/records.html'
  }]);
});

test('rejects an external request before opening an extension page', () => {
  const harness = createHarness();
  let response;

  const keepChannelOpen = harness.listener(
    { type: OUTLINK_MESSAGE_TYPES.OPEN_PAGE },
    { id: 'another-extension' },
    (value) => { response = value; }
  );

  assert.equal(keepChannelOpen, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'FORBIDDEN_SENDER');
  assert.deepEqual(harness.createdTabs, []);
});

test('content navigation delegates to the service worker without exposing the page', () => {
  const content = fs.readFileSync(path.join(projectRoot, 'content.js'), 'utf8');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );
  const webResources = manifest.web_accessible_resources.flatMap(
    ({ resources = [] }) => resources
  );

  assert.match(content, /sendOutlinkMessage\(\{ type: 'OUTLINKS_OPEN_PAGE' \}\)/u);
  assert.doesNotMatch(
    content,
    /window\.open\(chrome\.runtime\.getURL\(/u
  );
  assert.equal(OUTLINK_RECORDS_PAGE, 'records.html');
  assert.equal(webResources.includes(OUTLINK_RECORDS_PAGE), false);
});
