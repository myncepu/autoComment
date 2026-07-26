import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDomainConfigOptionsController
} from '../lib/domain-config-options-controller.mjs';
import {
  createDomainConfigRepository
} from '../lib/domain-config-repository.mjs';
import {
  createProfileSecretRepository
} from '../lib/profile-secret-repository.mjs';

function createStorageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.flatMap((key) => (
        Object.hasOwn(data, key)
          ? [[key, structuredClone(data[key])]]
          : []
      )));
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    }
  };
}

function createHarness() {
  const storage = createStorageArea();
  let now = 100;
  const configRepository = createDomainConfigRepository(storage, {
    now: () => ++now
  });
  const secretRepository = createProfileSecretRepository(storage);
  return {
    storage,
    controller: createDomainConfigOptionsController({
      configRepository,
      secretRepository,
      now: () => ++now
    })
  };
}

test('edits Profiles, Sites, Pairs, default Pair, and quotas through repositories', async () => {
  const { controller } = createHarness();
  await controller.saveProfile({
    id: 'profile-a',
    displayName: '作者 A',
    name: 'Alice',
    email: 'alice@example.test'
  });
  await controller.savePromotionSite({
    id: 'site-a',
    name: '站点 A',
    url: 'https://promo-a.test/',
    content: 'Promotion A',
    enabled: true
  });
  await controller.savePair({
    id: 'pair-a',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    weight: 2,
    enabled: true
  });
  await controller.savePolicy({
    defaultPairId: 'pair-a',
    quotas: {
      batch: 20,
      perProfile: 10,
      perPromotionSite: 10,
      perTargetDomain: 2
    }
  });

  const snapshot = await controller.snapshot();
  assert.equal(snapshot.defaultPairId, 'pair-a');
  assert.equal(snapshot.pairs[0].weight, 2);
  assert.equal(snapshot.quotas.batch, 20);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.profiles), true);
});

test('password save and clear expose booleans but never enter snapshots or exports', async () => {
  const { controller, storage } = createHarness();
  const secret = `runtime-secret-${crypto.randomUUID()}`;
  await controller.saveProfile({
    id: 'profile-a',
    displayName: '作者 A',
    name: 'Alice',
    email: 'alice@example.test'
  });

  assert.deepEqual(await controller.savePassword('profile-a', secret), {
    profileId: 'profile-a',
    configured: true
  });
  const snapshot = await controller.snapshot();
  const exported = structuredClone(await controller.exportConfig());

  assert.equal(snapshot.passwordConfigured['profile-a'], true);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(exported), /password|secret/i);
  assert.match(JSON.stringify(storage.data), new RegExp(secret));

  assert.deepEqual(await controller.clearPassword('profile-a'), {
    profileId: 'profile-a',
    configured: false
  });
  assert.equal(
    (await controller.snapshot()).passwordConfigured['profile-a'],
    false
  );
});

test('previews and explicitly applies safe imports without leaking local passwords', async () => {
  const { controller } = createHarness();
  await controller.saveProfile({
    id: 'profile-local',
    displayName: '本地作者',
    name: 'Local',
    email: 'local@example.test'
  });
  await controller.savePassword('profile-local', 'local-only-password');
  const exported = structuredClone(await controller.exportConfig());
  exported.data.profiles.push({
    id: 'profile-imported',
    displayName: '导入作者',
    name: 'Imported',
    email: 'imported@example.test',
    createdAt: 200,
    updatedAt: 200
  });

  const preview = await controller.previewImport(exported);
  assert.equal(preview.conflicts.length, 0);
  assert.deepEqual(preview.creates, [{
    entityType: 'profile',
    id: 'profile-imported'
  }]);
  assert.equal(
    (await controller.snapshot()).profiles.some(
      ({ id }) => id === 'profile-imported'
    ),
    false
  );

  await controller.applyImport(preview);
  const snapshot = await controller.snapshot();
  assert.equal(
    snapshot.profiles.some(({ id }) => id === 'profile-imported'),
    true
  );
  assert.equal(snapshot.passwordConfigured['profile-local'], true);
  assert.doesNotMatch(JSON.stringify(snapshot), /local-only-password/);
});
