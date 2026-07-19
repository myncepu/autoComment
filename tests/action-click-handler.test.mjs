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

test('opens settings without sending a message when Chrome supplies TAB_ID_NONE', async () => {
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

  await handleActionClick({ id: -1 }, chromeApi);

  assert.equal(sendAttempts, 0);
  assert.deepEqual(createdTabs, [{ url: 'chrome-extension://test/options.html' }]);
});

test('installs an action listener that routes a valid tab without returning its promise', async () => {
  let registeredListener;
  const sentMessages = [];
  const chromeApi = {
    action: {
      onClicked: {
        addListener(listener) {
          registeredListener = listener;
        }
      }
    },
    tabs: {
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
      },
      async create() {
        throw new Error('settings should not open for a valid tab');
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      }
    }
  };

  installActionClickHandler(chromeApi);

  assert.equal(typeof registeredListener, 'function');
  const listenerResult = registeredListener({ id: 42 });

  assert.equal(listenerResult, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sentMessages, [{
    tabId: 42,
    message: { type: 'TOGGLE_PROMOTE_PANEL' }
  }]);
});

test('installed listener absorbs routing failures without returning a rejected promise', async () => {
  let registeredListener;
  let createAttempts = 0;
  let unhandledRejection;
  const warnings = [];
  const chromeApi = {
    action: {
      onClicked: {
        addListener(listener) {
          registeredListener = listener;
        }
      }
    },
    tabs: {
      async sendMessage() {
        throw new Error('no receiver at https://private.example/?api_key=secret-key');
      },
      async create() {
        createAttempts += 1;
        throw new Error('settings page failed with provider response details');
      }
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      }
    }
  };
  const onUnhandledRejection = (reason) => {
    unhandledRejection = reason;
  };
  const originalConsoleWarn = console.warn;

  installActionClickHandler(chromeApi);
  process.once('unhandledRejection', onUnhandledRejection);
  console.warn = (...args) => warnings.push(args);
  try {
    const listenerResult = registeredListener({ id: 42 });
    listenerResult?.catch(() => {});

    assert.equal(listenerResult, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createAttempts, 1);
    assert.equal(unhandledRejection, undefined);
    assert.deepEqual(warnings, [['[action] Promotion panel unavailable']]);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    console.warn = originalConsoleWarn;
  }
});
