import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  createAutoSubmitLoadPlan
} from './helpers/auto-submit-load-plan.mjs';
import {
  closeBrowserContextWithin,
  finalizeAcceptanceResult
} from './helpers/browser-cleanup.mjs';
import {
  withServerPool
} from './helpers/fixture-server-pool.mjs';

function counts(values) {
  return Object.fromEntries(
    [...new Set(values)].map((value) => [
      value,
      values.filter((candidate) => candidate === value).length
    ])
  );
}

test('plans thirty automatic submissions across six blogs and multiple assignments', () => {
  const origins = Array.from(
    { length: 6 },
    (_, index) => `http://127.0.0.1:${4100 + index}`
  );
  const plan = createAutoSubmitLoadPlan(origins);

  assert.equal(plan.concurrency, 5);
  assert.equal(plan.tasks.length, 30);
  assert.equal(new Set(plan.tasks.map(({ targetId }) => targetId)).size, 30);
  assert.deepEqual(
    counts(plan.tasks.map(({ blogIndex }) => blogIndex)),
    { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5 }
  );
  assert.deepEqual(
    counts(plan.tasks.map(({ profileId }) => profileId)),
    {
      'profile-a': 10,
      'profile-b': 10,
      'profile-c': 10
    }
  );
  assert.deepEqual(
    counts(plan.tasks.map(({ promotionSiteId }) => promotionSiteId)),
    {
      'site-a': 8,
      'site-b': 8,
      'site-c': 7,
      'site-d': 7
    }
  );
  plan.tasks.forEach((task, index) => {
    assert.equal(task.targetId, index + 1);
    assert.equal(task.url, `${origins[task.blogIndex]}/stress/${index + 1}`);
    assert.equal(task.handle.url, task.url);
    assert.equal(task.handle.profileId, task.profileId);
    assert.equal(task.handle.promotionSiteId, task.promotionSiteId);
    assert.deepEqual(task.handle.automation, {
      autoGenerate: true,
      autoSubmit: true
    });
  });
  assert.deepEqual(
    Object.keys(plan.passwordsByProfileId).sort(),
    ['profile-a', 'profile-b', 'profile-c']
  );
  assert.doesNotMatch(
    JSON.stringify(plan.tasks),
    /password|fixture-secret/i
  );
});

test('rejects a topology that does not provide exactly six blog origins', () => {
  assert.throws(
    () => createAutoSubmitLoadPlan(['http://127.0.0.1:4100']),
    /six_blog_origins_required/
  );
});

test('exposes a local-only Chrome runner for thirty automatic submissions', async () => {
  const runnerUrl = new URL(
    '../scripts/run-auto-submit-load-chrome-acceptance.mjs',
    import.meta.url
  );
  const packageUrl = new URL('../package.json', import.meta.url);
  const [runner, packageDocument] = await Promise.all([
    fs.readFile(runnerUrl, 'utf8'),
    fs.readFile(packageUrl, 'utf8').then(JSON.parse)
  ]);

  assert.equal(
    packageDocument.scripts['test:chrome:auto-submit-30'],
    'node scripts/run-auto-submit-load-chrome-acceptance.mjs'
  );
  assert.match(runner, /createAutoSubmitLoadPlan/);
  assert.match(runner, /createFixtureServer/);
  assert.match(runner, /content\.js/);
  assert.match(runner, /withServerPool/);
  assert.match(runner, /finalizeAcceptanceResult/);
  assert.match(runner, /passwordMatchesProfile/);
  assert.match(runner, /process\.exit\(1\)/);
  assert.match(runner, /thirdPartyRequests:\s*0/);
  assert.match(runner, /thirdPartySubmissions:\s*0/);
  assert.doesNotMatch(runner, /https:\/\/(?!example\.invalid)/);
});

test('browser cleanup remains live when context.close never settles', async () => {
  const never = new Promise(() => {});
  const forcedClosed = await closeBrowserContextWithin(
    {
      close: () => never,
      browser: () => ({ close: async () => {} })
    },
    { contextTimeoutMs: 1, browserTimeoutMs: 100 }
  );
  const timedOut = await closeBrowserContextWithin(
    {
      close: () => never,
      browser: () => ({ close: () => never })
    },
    { contextTimeoutMs: 1, browserTimeoutMs: 1 }
  );
  const closed = await closeBrowserContextWithin(
    { close: async () => {} },
    { contextTimeoutMs: 100, browserTimeoutMs: 100 }
  );

  assert.equal(forcedClosed, 'forced_closed');
  assert.equal(timedOut, 'timeout');
  assert.equal(closed, 'closed');
  assert.deepEqual(
    finalizeAcceptanceResult({ submitted: 30 }, timedOut),
    {
      ok: false,
      submitted: 30,
      browserCleanup: 'timeout',
      error: 'browser_cleanup_timeout'
    }
  );
});

test('server pool closes every started server after partial startup failure', async () => {
  let nextId = 0;
  const closed = [];
  const createServer = () => ({ id: ++nextId });
  const listen = async (server) => {
    if (server.id === 3) throw new Error('listen_failure');
    return 5000 + server.id;
  };
  const closeServer = async (server) => {
    closed.push(server.id);
  };

  await assert.rejects(
    withServerPool({
      count: 6,
      createServer,
      listen,
      closeServer
    }, async () => {}),
    /listen_failure/
  );
  assert.deepEqual(closed.sort(), [1, 2]);
});
