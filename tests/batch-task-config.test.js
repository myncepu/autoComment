const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTaskConfig() {
  const context = vm.createContext({
    globalThis: {},
    URL,
    structuredClone
  });
  vm.runInContext(
    fs.readFileSync(
      path.resolve(__dirname, '../lib/batch-task-config.js'),
      'utf8'
    ),
    context
  );
  return context.globalThis.AutoCommentBatchTaskConfig;
}

function validHandle(overrides = {}) {
  return {
    type: 'BATCH_HANDLE',
    batchId: 'batch-a',
    taskId: 'task-a',
    urlIndex: 0,
    attempt: 2,
    url: 'https://target.test/post',
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    assignmentPairId: 'pair-a',
    assignmentSource: 'weighted',
    configRevision: 7,
    automation: {
      autoGenerate: true,
      autoSubmit: false
    },
    profile: {
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice',
      email: 'alice@example.test'
    },
    promotionSite: {
      id: 'site-a',
      name: '站点 A',
      url: 'https://promo-a.test/',
      content: 'Promotion A'
    },
    ...overrides
  };
}

test('accepts exact safe snapshots and rejects secrets in BATCH_HANDLE', () => {
  const taskConfig = loadTaskConfig();
  const context = taskConfig.acceptHandle(validHandle());

  assert.equal(context.profile.name, 'Alice');
  assert.equal(context.promotionSite.url, 'https://promo-a.test/');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.automation)),
    { autoGenerate: true, autoSubmit: false }
  );
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.profile), true);
  assert.throws(() => taskConfig.acceptHandle({
    ...validHandle(),
    profile: {
      ...validHandle().profile,
      password: 'runtime-secret-sentinel'
    }
  }), /sensitive_task_config/);
  assert.doesNotMatch(JSON.stringify(context), /password|secret/i);
});

test('accepts a site-bound email when the identity has no email', () => {
  const taskConfig = loadTaskConfig();
  const context = taskConfig.acceptHandle(validHandle({
    profile: {
      id: 'profile-a',
      displayName: 'Alex Morgan',
      name: 'Alex Morgan',
      email: ''
    },
    promotionSite: {
      id: 'site-a',
      name: 'Product · Inner page',
      url: 'https://promo-a.test/inner-page',
      content: 'Use at most one relevant link to the exact page.',
      email: 'support@promo-a.test'
    },
    assignmentSource: 'round_robin'
  }));

  assert.equal(context.profile.email, '');
  assert.equal(context.promotionSite.email, 'support@promo-a.test');
});

test('rejects unknown fields, mismatched ids, credentials, and stale attempts', () => {
  const taskConfig = loadTaskConfig();
  const invalid = [
    validHandle({ debug: 'unsafe-extra' }),
    validHandle({ profileId: 'profile-b' }),
    validHandle({ promotionSiteId: 'site-b' }),
    validHandle({ url: 'https://user:pass@target.test/' }),
    validHandle({ attempt: 0 }),
    validHandle({
      automation: { autoGenerate: false, autoSubmit: true }
    })
  ];

  for (const handle of invalid) {
    assert.throws(
      () => taskConfig.acceptHandle(handle),
      /invalid_task_config/
    );
  }
});

test('uses task-scoped cache keys and requests one authorized password', async () => {
  const taskConfig = loadTaskConfig();
  const messages = [];
  const runtime = {
    async sendMessage(message) {
      messages.push(structuredClone(message));
      return { ok: true, password: 'one-use-password' };
    }
  };
  taskConfig.acceptHandle(validHandle());

  assert.equal(taskConfig.cacheKey(), 'batch-a:task-a:site-a:2');
  assert.equal(
    await taskConfig.getTaskPassword(runtime),
    'one-use-password'
  );
  assert.deepEqual(messages, [{
    type: 'BATCH_GET_TASK_PASSWORD',
    batchId: 'batch-a',
    taskId: 'task-a',
    urlIndex: 0,
    profileId: 'profile-a'
  }]);
  assert.doesNotMatch(JSON.stringify(taskConfig.getCurrent()), /one-use-password/);
});

test('clears the accepted handle and never returns a mutable live reference', () => {
  const taskConfig = loadTaskConfig();
  const accepted = taskConfig.acceptHandle(validHandle());
  const current = taskConfig.getCurrent();

  assert.notEqual(current, accepted);
  assert.equal(current.taskId, 'task-a');
  taskConfig.clear();
  assert.equal(taskConfig.getCurrent(), null);
  assert.equal(taskConfig.cacheKey(), null);
});

test('cannot replace an accepted tab task with a different assignment', () => {
  const taskConfig = loadTaskConfig();
  taskConfig.acceptHandle(validHandle());

  assert.throws(() => taskConfig.acceptHandle(validHandle({
    taskId: 'task-b',
    urlIndex: 1
  })), /stale_task_config/);
  assert.equal(taskConfig.getCurrent().taskId, 'task-a');
});

test('manual mode resolves the current default pair without advancing weights', async () => {
  const taskConfig = loadTaskConfig();
  let reads = 0;
  const manual = await taskConfig.loadManualDefault({
    async getConfig() {
      reads += 1;
      return {
        profiles: [{
          id: 'profile-a',
          displayName: '作者 A',
          name: 'Alice',
          email: 'alice@example.test',
          createdAt: 100,
          updatedAt: 100
        }],
        promotionSites: [{
          id: 'site-a',
          name: '站点 A',
          url: 'https://promo-a.test/',
          content: 'Promotion A',
          enabled: true,
          createdAt: 100,
          updatedAt: 100
        }],
        assignmentPolicy: {
          pairs: [{
            id: 'pair-a',
            profileId: 'profile-a',
            promotionSiteId: 'site-a',
            enabled: true,
            weight: 2
          }],
          defaultPairId: 'pair-a'
        }
      };
    }
  });

  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify({
    profileId: manual.profile.id,
    promotionSiteId: manual.promotionSite.id
  })), {
    profileId: 'profile-a',
    promotionSiteId: 'site-a'
  });
});
