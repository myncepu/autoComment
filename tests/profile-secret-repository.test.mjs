import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROFILE_SECRETS_KEY,
  createProfileSecretRepository
} from '../lib/profile-secret-repository.mjs';

function storageArea(initial = {}, { setDelay = 0 } = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) {
      if (setDelay) await new Promise((resolve) => setTimeout(resolve, setDelay));
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
}

test('preserves password bytes exactly while trimming only the Profile ID', async () => {
  const area = storageArea();
  const secrets = createProfileSecretRepository(area);

  await secrets.setPassword(' profile-a ', '  pass phrase \n');

  assert.equal(await secrets.getPasswordForBackground('profile-a'), '  pass phrase \n');
  assert.deepEqual(area.data[PROFILE_SECRETS_KEY], {
    version: 1,
    passwordsByProfileId: {
      'profile-a': '  pass phrase \n'
    }
  });
});

test('returns only configured booleans outside background password reads', async () => {
  const secrets = createProfileSecretRepository(storageArea());
  await secrets.setPassword('profile-a', 'runtime-secret');

  const states = await secrets.getConfiguredStates([' profile-a ', 'profile-b']);
  assert.deepEqual(states, {
    'profile-a': true,
    'profile-b': false
  });
  assert.equal(Object.hasOwn(states, 'password'), false);
  assert.equal(JSON.stringify(states).includes('runtime-secret'), false);
});

test('empty password input and explicit clear remove only the selected Profile secret', async () => {
  const area = storageArea();
  const secrets = createProfileSecretRepository(area);
  await secrets.setPassword('profile-a', 'secret-a');
  await secrets.setPassword('profile-b', 'secret-b');

  await secrets.setPassword('profile-a', '');
  assert.equal(await secrets.getPasswordForBackground('profile-a'), undefined);
  assert.equal(await secrets.getPasswordForBackground('profile-b'), 'secret-b');

  await secrets.clearPassword('profile-b');
  assert.deepEqual(area.data[PROFILE_SECRETS_KEY].passwordsByProfileId, {});
});

test('serializes concurrent password writes without losing entries', async () => {
  const area = storageArea({}, { setDelay: 5 });
  const secrets = createProfileSecretRepository(area);

  await Promise.all([
    secrets.setPassword('profile-a', 'secret-a'),
    secrets.setPassword('profile-b', 'secret-b')
  ]);

  assert.deepEqual(area.data[PROFILE_SECRETS_KEY].passwordsByProfileId, {
    'profile-a': 'secret-a',
    'profile-b': 'secret-b'
  });
});

test('rejects invalid Profile IDs and non-string secrets without leaking values', async () => {
  const secrets = createProfileSecretRepository(storageArea());

  await assert.rejects(() => secrets.setPassword(' ', 'DO_NOT_ECHO'),
    (error) => error.code === 'invalid_profile_id' && !error.message.includes('DO_NOT_ECHO'));
  await assert.rejects(() => secrets.setPassword('profile-a', { secret: 'DO_NOT_ECHO' }),
    (error) => error.code === 'invalid_profile_password' && !error.message.includes('DO_NOT_ECHO'));
});

test('rejects malformed stored secret documents without returning any password', async () => {
  const area = storageArea({
    [PROFILE_SECRETS_KEY]: {
      version: 1,
      passwordsByProfileId: { 'profile-a': 'DO_NOT_ECHO' },
      extra: true
    }
  });
  const secrets = createProfileSecretRepository(area);

  await assert.rejects(() => secrets.getPasswordForBackground('profile-a'), (error) => (
    error.code === 'invalid_profile_secret_store' && !error.message.includes('DO_NOT_ECHO')
  ));
});
