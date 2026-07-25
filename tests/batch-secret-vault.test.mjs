import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_SECRET_VAULTS_KEY,
  createBatchSecretAwareRuntimeController,
  createBatchSecretVaultStore,
  installBatchSecretVaultListener
} from '../lib/batch-secret-vault.mjs';

function storageArea(initial = {}) {
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
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
}

function profileSecrets(values) {
  const reads = [];
  const passwords = { ...values };
  return {
    reads,
    passwords,
    async getPasswordForBackground(profileId) {
      reads.push(profileId);
      return passwords[profileId];
    }
  };
}

function request(overrides = {}) {
  return {
    type: 'BATCH_GET_TASK_PASSWORD',
    batchId: 'batch-a',
    taskId: 'task-1',
    urlIndex: 0,
    profileId: 'profile-a',
    ...overrides
  };
}

function activeCheckpoint(overrides = {}) {
  const task = {
    taskId: 'task-1',
    urlIndex: 0,
    state: 'active',
    tabId: 41,
    profileId: 'profile-a',
    ...overrides.task
  };
  return {
    version: 3,
    batchId: 'batch-a',
    status: 'running',
    tasks: { '0': task },
    ...overrides,
    tasks: { '0': task, ...(overrides.tasks || {}) }
  };
}

async function storedVault({
  passwords = { 'profile-a': 'original-a', 'profile-b': 'original-b' }
} = {}) {
  const area = storageArea();
  const vault = createBatchSecretVaultStore(area, { now: () => 100 });
  const secrets = profileSecrets(passwords);
  const entry = await vault.buildPreparedEntry(
    'batch-a',
    ['profile-a', 'profile-b'],
    secrets
  );
  await area.set(await vault.buildStoragePatch('batch-a', entry));
  return { area, vault, secrets, entry };
}

test('freezes only referenced Profile passwords and preserves later Profile edits', async () => {
  const area = storageArea();
  const vault = createBatchSecretVaultStore(area, { now: () => 100 });
  const secrets = profileSecrets({
    'profile-a': 'original-a',
    'profile-b': 'original-b',
    'profile-c': 'must-not-read'
  });

  const entry = await vault.buildPreparedEntry(
    'batch-a',
    ['profile-a', 'profile-b'],
    secrets
  );
  await area.set(await vault.buildStoragePatch('batch-a', entry));
  secrets.passwords['profile-a'] = 'changed-after-start';

  assert.deepEqual(secrets.reads, ['profile-a', 'profile-b']);
  assert.equal((await vault.getAuthorizedPassword({
    request: request(),
    senderTabId: 41,
    checkpoint: activeCheckpoint()
  })).password, 'original-a');
  assert.equal(JSON.stringify(activeCheckpoint()).includes('original-a'), false);
});

test('omits missing or empty passwords while preserving non-empty bytes exactly', async () => {
  const area = storageArea();
  const vault = createBatchSecretVaultStore(area, { now: () => 100 });
  const entry = await vault.buildPreparedEntry('batch-a', [
    'profile-a',
    'profile-b',
    'profile-c'
  ], profileSecrets({
    'profile-a': ' pass \n',
    'profile-b': ''
  }));

  assert.deepEqual(entry, {
    version: 1,
    createdAt: 100,
    passwordsByProfileId: {
      'profile-a': ' pass \n'
    }
  });
});

test('builds an atomic storage patch without overwriting unrelated vaults', async () => {
  const existing = {
    version: 1,
    createdAt: 10,
    passwordsByProfileId: { 'profile-x': 'secret-x' }
  };
  const area = storageArea({
    [BATCH_SECRET_VAULTS_KEY]: { 'batch-x': existing }
  });
  const vault = createBatchSecretVaultStore(area);
  const entry = {
    version: 1,
    createdAt: 20,
    passwordsByProfileId: { 'profile-a': 'secret-a' }
  };

  assert.deepEqual(await vault.buildStoragePatch('batch-a', entry), {
    [BATCH_SECRET_VAULTS_KEY]: {
      'batch-x': existing,
      'batch-a': entry
    }
  });
});

test('authorizes only the exact running task, tab, URL index, and Profile', async () => {
  const { vault } = await storedVault();
  assert.equal((await vault.getAuthorizedPassword({
    request: request(),
    senderTabId: 41,
    checkpoint: activeCheckpoint()
  })).password, 'original-a');

  const attempts = [
    { request: request({ batchId: 'batch-b' }), checkpoint: activeCheckpoint() },
    { request: request({ taskId: 'task-2' }), checkpoint: activeCheckpoint() },
    { request: request({ urlIndex: 1 }), checkpoint: activeCheckpoint() },
    { request: request({ profileId: 'profile-b' }), checkpoint: activeCheckpoint() },
    { request: request(), senderTabId: 42, checkpoint: activeCheckpoint() },
    { request: request(), checkpoint: activeCheckpoint({ status: 'paused_recovery' }) },
    { request: request(), checkpoint: activeCheckpoint({ task: { state: 'queued' } }) },
    { request: request(), checkpoint: activeCheckpoint({ task: { tabId: 42 } }) }
  ];
  for (const attempt of attempts) {
    await assert.rejects(() => vault.getAuthorizedPassword({
      senderTabId: 41,
      ...attempt
    }), (error) => (
      error.code === 'forbidden_task_secret'
      && error.message === 'forbidden_task_secret'
    ));
  }
});

test('returns an authorized null when the frozen Profile has no password', async () => {
  const { vault } = await storedVault({
    passwords: { 'profile-b': 'secret-b' }
  });

  assert.deepEqual(await vault.getAuthorizedPassword({
    request: request(),
    senderTabId: 41,
    checkpoint: activeCheckpoint()
  }), { password: null });
});

test('explicit clear preserves unrelated vaults and is idempotent', async () => {
  const { area, vault } = await storedVault();
  const otherEntry = {
    version: 1,
    createdAt: 200,
    passwordsByProfileId: { 'profile-x': 'secret-x' }
  };
  area.data[BATCH_SECRET_VAULTS_KEY]['batch-x'] = otherEntry;

  assert.deepEqual(await vault.clear('batch-a'), { removed: true });
  assert.deepEqual(area.data[BATCH_SECRET_VAULTS_KEY], { 'batch-x': otherEntry });
  assert.deepEqual(await vault.clear('batch-a'), { removed: false });
});

test('startup cleanup retains only a matching running or paused-recovery vault', async () => {
  const entries = {
    'batch-a': {
      version: 1,
      createdAt: 1,
      passwordsByProfileId: { 'profile-a': 'a' }
    },
    'batch-b': {
      version: 1,
      createdAt: 2,
      passwordsByProfileId: { 'profile-b': 'b' }
    }
  };
  for (const status of ['running', 'paused_recovery']) {
    const area = storageArea({ [BATCH_SECRET_VAULTS_KEY]: entries });
    const vault = createBatchSecretVaultStore(area);
    assert.deepEqual(await vault.cleanupOrphans({
      version: 3,
      batchId: 'batch-a',
      status
    }), {
      removedBatchIds: ['batch-b'],
      retainedBatchIds: ['batch-a']
    });
    assert.deepEqual(Object.keys(area.data[BATCH_SECRET_VAULTS_KEY]), ['batch-a']);
  }

  const area = storageArea({ [BATCH_SECRET_VAULTS_KEY]: entries });
  const vault = createBatchSecretVaultStore(area);
  await vault.cleanupOrphans({
    version: 3,
    batchId: 'batch-a',
    status: 'completed'
  });
  assert.deepEqual(area.data[BATCH_SECRET_VAULTS_KEY], {});
});

test('runtime wrapper clears completed, terminated, and explicit sessions but retains pauses', async () => {
  for (const [type, status, shouldClear] of [
    ['BATCH_SESSION_COMPLETE', 'completed', true],
    ['BATCH_SESSION_STOP', 'terminated', true],
    ['BATCH_SESSION_CLEAR', null, true],
    ['BATCH_SESSION_PAUSE', 'paused_recovery', false]
  ]) {
    const calls = [];
    const controller = {
      async handleMessage() {
        return { ok: true, checkpoint: status ? { batchId: 'batch-a', status } : null };
      },
      async recoverOnStartup() {
        return { ok: true, checkpoint: { batchId: 'batch-a', status: 'paused_recovery' } };
      }
    };
    const vaultStore = {
      async clear(batchId) {
        calls.push(['clear', batchId]);
      },
      async cleanupOrphans(checkpoint) {
        calls.push(['cleanup', checkpoint?.batchId]);
      }
    };
    const wrapped = createBatchSecretAwareRuntimeController(controller, vaultStore);

    await wrapped.handleMessage({ type, batchId: 'batch-a' });
    assert.deepEqual(calls, shouldClear ? [['clear', 'batch-a']] : []);
    await wrapped.recoverOnStartup();
    assert.deepEqual(calls.at(-1), ['cleanup', 'batch-a']);
  }
});

test('listener rejects external or tabless callers and returns only the authorized password', async () => {
  const { vault } = await storedVault();
  const listeners = [];
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
  installBatchSecretVaultListener(chromeApi, {
    vaultStore: vault,
    checkpointReader: async () => activeCheckpoint()
  });
  const listener = listeners[0];

  for (const sender of [{ id: 'other', tab: { id: 41 } }, { id: 'extension-id' }]) {
    const responses = [];
    assert.equal(listener(request(), sender, (response) => responses.push(response)), false);
    assert.deepEqual(responses, [{ ok: false, error: 'forbidden_task_secret' }]);
  }

  const response = await new Promise((resolve) => {
    assert.equal(listener(request(), {
      id: 'extension-id',
      tab: { id: 41 }
    }, resolve), true);
  });
  assert.deepEqual(response, { ok: true, password: 'original-a' });
});
