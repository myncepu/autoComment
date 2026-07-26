import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProfileSecretClient,
  installProfileSecretMessageListener
} from '../lib/profile-secret-message-listener.mjs';

function dispatch(listener, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

test('options client exposes only set clear and configured-state operations', async () => {
  const sent = [];
  const client = createProfileSecretClient({
    async sendMessage(message) {
      sent.push(structuredClone(message));
      if (message.type === 'PROFILE_SECRET_STATES') {
        return { ok: true, states: { 'profile-a': true } };
      }
      return { ok: true };
    }
  });

  assert.deepEqual(await client.getConfiguredStates(['profile-a']), {
    'profile-a': true
  });
  await client.setPassword('profile-a', 'runtime-secret');
  await client.clearPassword('profile-a');
  assert.equal(Object.hasOwn(client, 'getPasswordForBackground'), false);
  assert.deepEqual(sent, [
    { type: 'PROFILE_SECRET_STATES', profileIds: ['profile-a'] },
    {
      type: 'PROFILE_SECRET_SET',
      profileId: 'profile-a',
      password: 'runtime-secret'
    },
    { type: 'PROFILE_SECRET_CLEAR', profileId: 'profile-a' }
  ]);
});

test('background secret listener rejects content and serves options without returning passwords', async () => {
  const calls = [];
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL(path) {
        return `chrome-extension://extension-id/${path}`;
      },
      onMessage: { addListener() {} }
    }
  };
  const listener = installProfileSecretMessageListener(chromeApi, {
    async setPassword(profileId, password) {
      calls.push(['set', profileId, password]);
    },
    async clearPassword(profileId) {
      calls.push(['clear', profileId]);
    },
    async getConfiguredStates(profileIds) {
      calls.push(['states', profileIds]);
      return Object.fromEntries(profileIds.map((id) => [id, true]));
    }
  });
  const optionsSender = {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/options.html',
    tab: { id: 12 }
  };

  assert.deepEqual(await dispatch(listener, {
    type: 'PROFILE_SECRET_STATES',
    profileIds: ['profile-a']
  }, optionsSender), {
    ok: true,
    states: { 'profile-a': true }
  });
  assert.deepEqual(await dispatch(listener, {
    type: 'PROFILE_SECRET_SET',
    profileId: 'profile-a',
    password: 'runtime-secret'
  }, {
    id: 'extension-id',
    url: 'https://target.test/post',
    tab: { id: 99 }
  }), {
    ok: false,
    error: 'forbidden_sender'
  });
  assert.equal(JSON.stringify(calls).includes('runtime-secret'), false);
});
