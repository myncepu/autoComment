import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDomainConfigRepositoryClient,
  installDomainConfigRepositoryMessageListener
} from '../lib/domain-config-repository-message.mjs';
import {
  createDomainConfigRepository
} from '../lib/domain-config-repository.mjs';

function storageArea({ setDelay = 0 } = {}) {
  const data = {};
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.flatMap((key) => (
        Object.hasOwn(data, key)
          ? [[key, structuredClone(data[key])]]
          : []
      )));
    },
    async set(values) {
      if (setDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, setDelay));
      }
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
}

function profile(id) {
  return {
    id,
    displayName: `Profile ${id}`,
    name: `Name ${id}`,
    email: `${id}@example.test`
  };
}

function dispatch(listener, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

function createMessageHarness({ setDelay = 0 } = {}) {
  const area = storageArea({ setDelay });
  const repository = createDomainConfigRepository(area, { now: () => 100 });
  let listener;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL(path) {
        return `chrome-extension://extension-id/${path}`;
      },
      onMessage: {
        addListener(value) { listener = value; }
      }
    }
  };
  installDomainConfigRepositoryMessageListener(chromeApi, repository);
  const optionsSender = {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/options.html',
    tab: { id: 12 }
  };
  const createClient = () => createDomainConfigRepositoryClient({
    sendMessage(message) {
      return dispatch(listener, message, optionsSender);
    }
  });
  return { area, repository, listener, createClient };
}

test('serializes conditional writes from two logical options callers', async () => {
  const harness = createMessageHarness({ setDelay: 5 });
  const first = harness.createClient();
  const second = harness.createClient();
  const before = await first.load();
  const firstCandidate = structuredClone(before);
  firstCandidate.profiles.push({
    ...profile('profile-a'),
    createdAt: 100,
    updatedAt: 100
  });
  const secondCandidate = structuredClone(before);
  secondCandidate.profiles.push({
    ...profile('profile-b'),
    createdAt: 100,
    updatedAt: 100
  });

  const results = await Promise.allSettled([
    first.replaceIfRevision(0, firstCandidate),
    second.replaceIfRevision(0, secondCandidate)
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.deepEqual(
    results.filter(({ status }) => status === 'rejected')
      .map(({ reason }) => reason.code),
    ['stale_domain_config_revision']
  );
  assert.equal((await harness.repository.load()).profiles.length, 1);
  assert.equal(harness.area.writes.length, 1);
});

test('conditional rollback cannot overwrite a later background write', async () => {
  const harness = createMessageHarness();
  const optionsClient = harness.createClient();
  const before = await optionsClient.load();
  const imported = structuredClone(before);
  imported.profiles.push({
    ...profile('profile-imported'),
    createdAt: 100,
    updatedAt: 100
  });

  const applied = await optionsClient.replaceIfRevision(0, imported);
  await harness.repository.saveProfile(profile('profile-cloud'));

  await assert.rejects(
    optionsClient.replaceIfRevision(applied.revision, before),
    (error) => error.code === 'stale_domain_config_revision'
  );
  assert.deepEqual(
    (await harness.repository.load()).profiles.map(({ id }) => id),
    ['profile-imported', 'profile-cloud']
  );
});

test('routes the complete options repository write interface through background', async () => {
  const harness = createMessageHarness();
  const client = harness.createClient();
  await client.saveProfile(profile('profile-a'));
  await client.savePromotionSite({
    id: 'site-a',
    name: 'Site A',
    url: 'https://site-a.example/',
    content: 'Site A description',
    enabled: true
  });
  await client.saveAssignmentPolicy({
    defaultPairId: 'pair-a',
    pairs: [{
      id: 'pair-a',
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      weight: 1,
      enabled: true
    }],
    quotas: {
      batch: 100,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3
    }
  });
  const replaced = await client.replace(await client.load());
  assert.equal(replaced.revision, 4);
  await client.saveAssignmentPolicy({
    ...replaced.assignmentPolicy,
    defaultPairId: null,
    pairs: []
  });
  await client.deleteProfile('profile-a');
  const final = await client.deletePromotionSite('site-a');

  assert.equal(final.revision, 7);
  assert.deepEqual(final.profiles, []);
  assert.deepEqual(final.promotionSites, []);
  assert.equal(harness.area.writes.length, 7);
});

test('rejects non-options callers before invoking the background repository', async () => {
  const harness = createMessageHarness();
  const response = await dispatch(harness.listener, {
    type: 'DOMAIN_CONFIG_REPOSITORY_REQUEST',
    operation: 'load',
    args: []
  }, {
    id: 'extension-id',
    url: 'https://target.example/post',
    tab: { id: 99 }
  });

  assert.deepEqual(response, { ok: false, error: 'forbidden_sender' });
  assert.equal(harness.area.writes.length, 0);
});

test('waits for retryable initialization and returns a structured migration error', async () => {
  const area = storageArea();
  const repository = createDomainConfigRepository(area, { now: () => 100 });
  let listener;
  let readinessAttempts = 0;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      onMessage: {
        addListener(value) { listener = value; }
      }
    }
  };
  installDomainConfigRepositoryMessageListener(chromeApi, repository, {
    ready: async () => {
      readinessAttempts += 1;
      if (readinessAttempts === 1) {
        const error = new Error('private migration details');
        error.code = 'domain_config_migration_deferred';
        throw error;
      }
    }
  });
  const sender = {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/options.html',
    tab: { id: 12 }
  };

  assert.deepEqual(await dispatch(listener, {
    type: 'DOMAIN_CONFIG_REPOSITORY_REQUEST',
    operation: 'load',
    args: []
  }, sender), {
    ok: false,
    error: 'domain_config_migration_deferred'
  });
  assert.equal(readinessAttempts, 1);

  const recovered = await dispatch(listener, {
    type: 'DOMAIN_CONFIG_REPOSITORY_REQUEST',
    operation: 'load',
    args: []
  }, sender);
  assert.equal(recovered.ok, true);
  assert.equal(readinessAttempts, 2);
});
