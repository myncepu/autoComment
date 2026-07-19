import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleActionClick,
  installActionClickHandler
} from '../lib/action-click-handler.mjs';

test('sends one promotion-panel toggle to a valid web tab without opening settings', async () => {
  const sentMessages = [];
  const createdTabs = [];
  const chromeApi = {
    tabs: {
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
      },
      async create(details) {
        createdTabs.push(details);
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      }
    }
  };

  await handleActionClick({ id: 42, url: 'https://example.test/comment' }, chromeApi);

  assert.deepEqual(sentMessages, [{
    tabId: 42,
    message: { type: 'TOGGLE_PROMOTE_PANEL' }
  }]);
  assert.deepEqual(createdTabs, []);
});

test('opens settings after the only promotion-panel message has no receiver', async () => {
  let sendAttempts = 0;
  const createdTabs = [];
  const chromeApi = {
    tabs: {
      async sendMessage() {
        sendAttempts += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async create(details) {
        createdTabs.push(details);
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      }
    }
  };

  await handleActionClick({ id: 42 }, chromeApi);

  assert.equal(sendAttempts, 1);
  assert.deepEqual(createdTabs, [{ url: 'chrome-extension://test/options.html' }]);
});

test('opens settings without sending a message when the clicked tab has no integer id', async () => {
  let sendAttempts = 0;
  const createdTabs = [];
  const chromeApi = {
    tabs: {
      async sendMessage() {
        sendAttempts += 1;
      },
      async create(details) {
        createdTabs.push(details);
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      }
    }
  };

  await handleActionClick({}, chromeApi);

  assert.equal(sendAttempts, 0);
  assert.deepEqual(createdTabs, [{ url: 'chrome-extension://test/options.html' }]);
});

test('installs the action click listener through the supplied Chrome API', () => {
  let registeredListener;
  const chromeApi = {
    action: {
      onClicked: {
        addListener(listener) {
          registeredListener = listener;
        }
      }
    },
    tabs: {},
    runtime: {}
  };

  installActionClickHandler(chromeApi);

  assert.equal(typeof registeredListener, 'function');
});
