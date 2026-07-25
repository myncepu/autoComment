import test from 'node:test';
import assert from 'node:assert/strict';

import { createCloudSyncService } from '../lib/cloud-sync-service.mjs';
import { CloudSyncError } from '../lib/cloud-sync-transport.mjs';

const VALID_SYNC_KEY =
  'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, structuredClone(data[key])])
      );
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function createCredentialStorage(overrides = {}) {
  return createStorage({
    cloud_sync_enabled: true,
    cloud_sync_vault_id: 'AAAAAAAAAAAAAAAAAAAAAA',
    cloud_sync_secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    cloud_sync_device_id: 'device-a',
    ...overrides
  });
}

function makeSettingMutation(
  mutationId,
  entityId = 'batch_concurrency',
  value = 3,
  overrides = {}
) {
  return {
    mutationId,
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    entityType: 'setting',
    entityId,
    operation: 'upsert',
    payload: { value },
    createdAt: 100,
    attemptCount: 0,
    nextAttemptAt: 100,
    lastErrorCode: null,
    state: 'pending',
    ...overrides
  };
}

function createSyncRepository({ due = [], applyError } = {}) {
  const meta = new Map();
  const outbox = due.map((mutation) => structuredClone(mutation));
  const completed = [];
  const attempts = [];
  const appliedPages = [];
  const bootstrapPages = [];
  const enqueued = [];
  const cloudDeletions = [];
  return {
    outbox,
    completed,
    attempts,
    appliedPages,
    bootstrapPages,
    enqueued,
    cloudDeletions,
    meta,
    async listDueSyncMutations({ vaultId, now, limit }) {
      return outbox
        .filter((mutation) => (
          mutation.vaultId === vaultId
          && mutation.state === 'pending'
          && mutation.nextAttemptAt <= now
        ))
        .slice(0, limit)
        .map((mutation) => structuredClone(mutation));
    },
    async completeSyncMutations(receipts) {
      completed.push(...structuredClone(receipts));
      for (const receipt of receipts) {
        const index = outbox.findIndex(
          ({ mutationId }) => mutationId === receipt.mutationId
        );
        if (index >= 0) outbox.splice(index, 1);
      }
    },
    async markSyncMutationAttempt(update) {
      attempts.push(structuredClone(update));
      const mutation = outbox.find(
        ({ mutationId }) => mutationId === update.mutationId
      );
      if (mutation) Object.assign(mutation, structuredClone(update));
    },
    async getSyncMeta(key) {
      return structuredClone(meta.get(key));
    },
    async setSyncMeta(key, value) {
      meta.set(key, structuredClone(value));
    },
    async clearSyncMetaIfEqual({ key, expected }) {
      if (JSON.stringify(meta.get(key)) === JSON.stringify(expected)) {
        meta.delete(key);
        return true;
      }
      return false;
    },
    async applyRemoteChangesAtomic(page) {
      if (applyError) throw applyError;
      appliedPages.push(structuredClone(page));
      if (Object.keys(page.pendingInboundSettings || {}).length > 0) {
        const key = `pendingInboundSettings:${page.vaultId}`;
        meta.set(key, {
          ...(meta.get(key) || {}),
          ...structuredClone(page.pendingInboundSettings)
        });
      }
      meta.set(`serverCursor:${page.vaultId}`, page.nextCursor);
    },
    async applyBootstrapPageAtomic(page) {
      bootstrapPages.push(structuredClone(page));
      if (Object.keys(page.pendingInboundSettings || {}).length > 0) {
        const key = `pendingInboundSettings:${page.vaultId}`;
        meta.set(key, {
          ...(meta.get(key) || {}),
          ...structuredClone(page.pendingInboundSettings)
        });
      }
      meta.set(`bootstrapState:${page.vaultId}`, {
        cursor: page.nextCursor,
        serverCursor: page.serverCursor,
        serverNow: page.serverNow,
        phase: page.phase,
        done: !page.hasMore
      });
      if (!page.hasMore) {
        meta.set(`serverCursor:${page.vaultId}`, page.serverCursor);
      }
    },
    async clearPendingInboundSettings({ vaultId, expected }) {
      const key = `pendingInboundSettings:${vaultId}`;
      if (JSON.stringify(meta.get(key)) === JSON.stringify(expected)) {
        meta.set(key, null);
      }
    },
    async enqueueSyncMutation(mutation) {
      if (enqueued.some(({ mutationId }) => mutationId === mutation.mutationId)) {
        const error = new Error('duplicate mutation');
        error.name = 'ConstraintError';
        throw error;
      }
      enqueued.push(structuredClone(mutation));
      outbox.push(structuredClone(mutation));
    },
    async applyCloudHistoryDeletion(deletion) {
      cloudDeletions.push(structuredClone(deletion));
    }
  };
}

function createSettingsFixture() {
  const remoteWrites = [];
  return {
    remoteWrites,
    async load() {
      return {};
    },
    async saveRemote(values) {
      remoteWrites.push(structuredClone(values));
    },
    createMutations() {
      return [];
    }
  };
}

test('single-flights push receipts and atomically applies each pull page', async () => {
  const gate = deferred();
  const due = [
    makeSettingMutation('m-applied'),
    makeSettingMutation('m-duplicate'),
    makeSettingMutation('m-stale'),
    makeSettingMutation('m-rejected')
  ];
  const repository = createSyncRepository({ due });
  const settings = createSettingsFixture();
  const pushBodies = [];
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings,
    transportFactory: ({ syncKey }) => {
      assert.equal(syncKey, VALID_SYNC_KEY);
      return {
        async push(body) {
          pushBodies.push(structuredClone(body));
          await gate.promise;
          return {
            results: [
              { mutationId: 'm-applied', status: 'applied', serverSeq: 1 },
              { mutationId: 'm-duplicate', status: 'duplicate', serverSeq: 2 },
              { mutationId: 'm-stale', status: 'stale', serverSeq: 3 },
              {
                mutationId: 'm-rejected',
                status: 'rejected',
                errorCode: 'SETTING_NOT_SYNCABLE'
              }
            ]
          };
        },
        async pull(query) {
          assert.deepEqual(query, {
            cursor: 0,
            limit: 100,
            deviceId: 'device-a'
          });
          return {
            changes: [
              {
                serverSeq: 3,
                entityType: 'setting',
                entityId: 'batch_timeout_seconds',
                operation: 'upsert',
                value: 90
              },
              {
                serverSeq: 4,
                entityType: 'comment',
                entityId: 'remote:1',
                operation: 'upsert',
                record: {
                  comment: { id: 'remote:1' },
                  anchors: []
                }
              }
            ],
            nextCursor: 4,
            hasMore: false,
            highWatermark: 4
          };
        }
      };
    },
    now: () => 1_000,
    random: () => 0.5
  });

  const first = service.runOnce('manual');
  const second = service.runOnce('alarm');
  assert.strictEqual(first, second);
  gate.resolve();

  assert.deepEqual(await first, {
    pushed: 4,
    pulled: 2,
    cursor: 4
  });
  assert.equal(pushBodies.length, 1);
  assert.deepEqual(Object.keys(pushBodies[0].mutations[0]).sort(), [
    'createdAt',
    'entityId',
    'entityType',
    'mutationId',
    'operation',
    'payload'
  ]);
  assert.deepEqual(
    repository.completed.map(({ mutationId }) => mutationId),
    ['m-applied', 'm-duplicate', 'm-stale']
  );
  assert.deepEqual(repository.attempts, [{
    mutationId: 'm-rejected',
    attemptCount: 1,
    nextAttemptAt: 1_000,
    lastErrorCode: 'SETTING_NOT_SYNCABLE',
    state: 'needs_attention'
  }]);
  assert.deepEqual(settings.remoteWrites, [{
    batch_timeout_seconds: 90
  }]);
  assert.deepEqual(repository.appliedPages, [{
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    changes: [
      {
        serverSeq: 3,
        entityType: 'setting',
        entityId: 'batch_timeout_seconds',
        operation: 'upsert',
        value: 90
      },
      {
        serverSeq: 4,
        entityType: 'comment',
        entityId: 'remote:1',
        operation: 'upsert',
        record: {
          comment: { id: 'remote:1' },
          anchors: []
        }
      }
    ],
    pendingInboundSettings: { batch_timeout_seconds: 90 },
    nextCursor: 4
  }]);
});

test('never sends more than 100 due mutations in one push', async () => {
  const due = Array.from(
    { length: 101 },
    (_, index) => makeSettingMutation(`m-${index}`)
  );
  const repository = createSyncRepository({ due });
  let pushedCount = 0;
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async push({ mutations }) {
        pushedCount = mutations.length;
        return {
          results: mutations.map(({ mutationId }, index) => ({
            mutationId,
            status: 'applied',
            serverSeq: index + 1
          }))
        };
      },
      async pull() {
        return {
          changes: [],
          nextCursor: 0,
          hasMore: false,
          highWatermark: 100
        };
      }
    }),
    now: () => 1_000
  });

  assert.deepEqual(await service.runOnce('alarm'), {
    pushed: 100,
    pulled: 0,
    cursor: 0
  });
  assert.equal(pushedCount, 100);
  assert.equal(repository.outbox.length, 1);
});

test('rejects malformed push receipts before any item is completed or made terminal', async () => {
  const malformedResponses = [
    { name: 'missing results array', value: {} },
    {
      name: 'wrong receipt count',
      value: {
        results: [{ mutationId: 'm-strict-1', status: 'applied', serverSeq: 1 }]
      }
    },
    {
      name: 'duplicate mutation id',
      value: {
        results: [
          { mutationId: 'm-strict-1', status: 'applied', serverSeq: 1 },
          { mutationId: 'm-strict-1', status: 'duplicate', serverSeq: 1 }
        ]
      }
    },
    {
      name: 'unknown mutation id',
      value: {
        results: [
          { mutationId: 'm-strict-1', status: 'applied', serverSeq: 1 },
          { mutationId: 'unknown', status: 'stale', serverSeq: 2 }
        ]
      }
    },
    {
      name: 'unknown status',
      value: {
        results: [
          { mutationId: 'm-strict-1', status: 'accepted', serverSeq: 1 },
          { mutationId: 'm-strict-2', status: 'applied', serverSeq: 2 }
        ]
      }
    },
    {
      name: 'terminal receipt without safe server sequence',
      value: {
        results: [
          { mutationId: 'm-strict-1', status: 'stale', serverSeq: null },
          { mutationId: 'm-strict-2', status: 'applied', serverSeq: 2 }
        ]
      }
    },
    {
      name: 'terminal receipt with an error code',
      value: {
        results: [
          {
            mutationId: 'm-strict-1',
            status: 'applied',
            serverSeq: 1,
            errorCode: 'SHOULD_NOT_EXIST'
          },
          { mutationId: 'm-strict-2', status: 'duplicate', serverSeq: 2 }
        ]
      }
    },
    {
      name: 'rejection without a stable error code',
      value: {
        results: [
          { mutationId: 'm-strict-1', status: 'rejected', errorCode: 'bad code' },
          { mutationId: 'm-strict-2', status: 'applied', serverSeq: 2 }
        ]
      }
    },
    {
      name: 'rejection carrying a server sequence',
      value: {
        results: [
          {
            mutationId: 'm-strict-1',
            status: 'rejected',
            errorCode: 'INVALID_MUTATION',
            serverSeq: 1
          },
          { mutationId: 'm-strict-2', status: 'applied', serverSeq: 2 }
        ]
      }
    }
  ];

  for (const malformed of malformedResponses) {
    const due = [
      makeSettingMutation('m-strict-1'),
      makeSettingMutation('m-strict-2')
    ];
    const repository = createSyncRepository({ due });
    let pullCalls = 0;
    const service = createCloudSyncService({
      repository,
      storageLocal: createCredentialStorage(),
      settings: createSettingsFixture(),
      transportFactory: () => ({
        async push() {
          return structuredClone(malformed.value);
        },
        async pull() {
          pullCalls += 1;
          return {
            changes: [],
            nextCursor: 0,
            hasMore: false,
            highWatermark: 0
          };
        }
      }),
      now: () => 1_000,
      random: () => 0.5
    });

    await assert.rejects(
      service.runOnce('alarm'),
      (error) => (
        error.code === 'INVALID_SYNC_RESPONSE'
        || assert.fail(`${malformed.name}: wrong error ${error.code}`)
      )
    );
    assert.deepEqual(
      repository.completed,
      [],
      `${malformed.name}: no mutation may complete`
    );
    assert.deepEqual(
      repository.attempts,
      due.map((mutation) => ({
        mutationId: mutation.mutationId,
        attemptCount: 1,
        nextAttemptAt: 3_500,
        lastErrorCode: 'INVALID_SYNC_RESPONSE',
        state: 'pending'
      })),
      `${malformed.name}: every mutation remains pending`
    );
    assert.equal(repository.outbox.length, 2);
    assert.equal(pullCalls, 0);
  }
});

test('does not advance the pull cursor when local page application fails', async () => {
  const applyError = new Error('indexeddb unavailable');
  const repository = createSyncRepository({ applyError });
  repository.meta.set('serverCursor:AAAAAAAAAAAAAAAAAAAAAA', 7);
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async pull() {
        return {
          changes: [{
            serverSeq: 8,
            entityType: 'comment',
            entityId: 'remote:8',
            operation: 'upsert',
            record: { comment: { id: 'remote:8' }, anchors: [] }
          }],
          nextCursor: 8,
          hasMore: false,
          highWatermark: 8
        };
      }
    }),
    now: () => 1_000
  });

  await assert.rejects(service.runOnce('alarm'), applyError);
  assert.equal(
    repository.meta.get('serverCursor:AAAAAAAAAAAAAAAAAAAAAA'),
    7
  );
});

test('rejects malformed pull cursor pages before the repository transaction', async () => {
  const oversizedChanges = Array.from({ length: 101 }, (_, index) => ({
    serverSeq: index + 6,
    entityType: 'comment',
    entityId: `oversized:${index}`,
    operation: 'upsert',
    record: { comment: { id: `oversized:${index}` }, anchors: [] }
  }));
  const malformedPages = [
    {
      name: 'missing high watermark',
      page: { changes: [], nextCursor: 5, hasMore: false }
    },
    {
      name: 'page exceeds requested limit',
      page: {
        changes: oversizedChanges,
        nextCursor: 106,
        hasMore: false,
        highWatermark: 106
      }
    },
    {
      name: 'sequence does not advance past cursor',
      page: {
        changes: [{
          serverSeq: 5,
          entityType: 'comment',
          entityId: 'same:5',
          operation: 'upsert',
          record: { comment: { id: 'same:5' }, anchors: [] }
        }],
        nextCursor: 5,
        hasMore: false,
        highWatermark: 5
      }
    },
    {
      name: 'sequence is not strictly increasing',
      page: {
        changes: [
          {
            serverSeq: 7,
            entityType: 'comment',
            entityId: 'order:7',
            operation: 'upsert',
            record: { comment: { id: 'order:7' }, anchors: [] }
          },
          {
            serverSeq: 6,
            entityType: 'comment',
            entityId: 'order:6',
            operation: 'upsert',
            record: { comment: { id: 'order:6' }, anchors: [] }
          }
        ],
        nextCursor: 6,
        hasMore: false,
        highWatermark: 7
      }
    },
    {
      name: 'sequence exceeds high watermark',
      page: {
        changes: [{
          serverSeq: 7,
          entityType: 'comment',
          entityId: 'beyond:7',
          operation: 'upsert',
          record: { comment: { id: 'beyond:7' }, anchors: [] }
        }],
        nextCursor: 7,
        hasMore: false,
        highWatermark: 6
      }
    },
    {
      name: 'next cursor regresses',
      page: {
        changes: [],
        nextCursor: 4,
        hasMore: false,
        highWatermark: 5
      }
    },
    {
      name: 'next cursor differs from last change',
      page: {
        changes: [{
          serverSeq: 6,
          entityType: 'comment',
          entityId: 'last:6',
          operation: 'upsert',
          record: { comment: { id: 'last:6' }, anchors: [] }
        }],
        nextCursor: 7,
        hasMore: false,
        highWatermark: 7
      }
    },
    {
      name: 'empty page moves cursor',
      page: {
        changes: [],
        nextCursor: 6,
        hasMore: false,
        highWatermark: 6
      }
    }
  ];

  for (const malformed of malformedPages) {
    const repository = createSyncRepository();
    repository.meta.set('serverCursor:AAAAAAAAAAAAAAAAAAAAAA', 5);
    const service = createCloudSyncService({
      repository,
      storageLocal: createCredentialStorage(),
      settings: createSettingsFixture(),
      transportFactory: () => ({
        async pull() {
          return structuredClone(malformed.page);
        }
      })
    });

    await assert.rejects(
      service.runOnce('alarm'),
      (error) => (
        error.code === 'INVALID_SYNC_RESPONSE'
        || assert.fail(`${malformed.name}: wrong error ${error.code}`)
      )
    );
    assert.deepEqual(
      repository.appliedPages,
      [],
      `${malformed.name}: malformed page reached repository`
    );
    assert.equal(
      repository.meta.get('serverCursor:AAAAAAAAAAAAAAAAAAAAAA'),
      5
    );
  }
});

test('stages inbound settings with the pull cursor and flushes durable pending values first', async () => {
  const repository = createSyncRepository();
  const events = [];
  let failSettingFlush = true;
  const settings = {
    async load() {
      return {};
    },
    async saveRemote(values) {
      events.push(['saveRemote', structuredClone(values)]);
      if (failSettingFlush) throw new Error('chrome storage unavailable');
    },
    createMutations() {
      return [];
    }
  };
  let firstPull = true;
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings,
    transportFactory: () => ({
      async pull({ cursor }) {
        events.push(['pull', cursor]);
        if (firstPull) {
          firstPull = false;
          return {
            changes: [{
              serverSeq: 1,
              entityType: 'setting',
              entityId: 'batch_concurrency',
              operation: 'upsert',
              value: 4
            }],
            nextCursor: 1,
            hasMore: false,
            highWatermark: 1
          };
        }
        assert.equal(cursor, 1);
        return {
          changes: [],
          nextCursor: 1,
          hasMore: false,
          highWatermark: 1
        };
      }
    }),
    now: () => 1_000
  });

  await assert.rejects(
    service.runOnce('alarm'),
    /chrome storage unavailable/
  );
  assert.equal(
    repository.meta.get('serverCursor:AAAAAAAAAAAAAAAAAAAAAA'),
    1
  );
  assert.deepEqual(
    repository.meta.get(
      'pendingInboundSettings:AAAAAAAAAAAAAAAAAAAAAA'
    ),
    { batch_concurrency: 4 }
  );

  failSettingFlush = false;
  events.length = 0;
  assert.deepEqual(await service.runOnce('alarm'), {
    pushed: 0,
    pulled: 0,
    cursor: 1
  });
  assert.deepEqual(events, [
    ['saveRemote', { batch_concurrency: 4 }],
    ['pull', 1]
  ]);
  assert.equal(
    repository.meta.get(
      'pendingInboundSettings:AAAAAAAAAAAAAAAAAAAAAA'
    ),
    null
  );
});

test('caps one pull run at 500 changes and reports remaining work', async () => {
  const repository = createSyncRepository();
  let page = 0;
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async pull({ cursor, limit }) {
        page += 1;
        assert.equal(limit, 100);
        const changes = Array.from({ length: 100 }, (_, index) => ({
          serverSeq: cursor + index + 1,
          entityType: 'comment',
          entityId: `remote:${cursor + index + 1}`,
          operation: 'upsert',
          record: {
            comment: { id: `remote:${cursor + index + 1}` },
            anchors: []
          }
        }));
        return {
          changes,
          nextCursor: cursor + 100,
          hasMore: true,
          highWatermark: 600
        };
      }
    }),
    now: () => 1_000
  });

  assert.deepEqual(await service.runOnce('alarm'), {
    pushed: 0,
    pulled: 500,
    cursor: 500,
    hasMore: true
  });
  assert.equal(page, 5);
  assert.equal(repository.appliedPages.length, 5);
});

test('401 and 403 failures block later automatic runs without retrying transport', async () => {
  for (const [status, code] of [
    [401, 'INVALID_SYNC_KEY'],
    [403, 'SYNC_ACCESS_DENIED']
  ]) {
    const repository = createSyncRepository({
      due: [makeSettingMutation(`m-auth-${status}`)]
    });
    let transportCalls = 0;
    const service = createCloudSyncService({
      repository,
      storageLocal: createCredentialStorage(),
      settings: createSettingsFixture(),
      transportFactory: () => ({
        async push() {
          transportCalls += 1;
          throw new CloudSyncError(code, status, false);
        }
      }),
      now: () => 1_000
    });

    await assert.rejects(
      service.runOnce('alarm'),
      (error) => error.code === code && error.status === status
    );
    assert.deepEqual(repository.attempts, [{
      mutationId: `m-auth-${status}`,
      attemptCount: 1,
      nextAttemptAt: 1_000,
      lastErrorCode: code,
      state: 'blocked'
    }]);
    assert.deepEqual(
      repository.meta.get('authBlocked:AAAAAAAAAAAAAAAAAAAAAA'),
      { code, status, retryable: false }
    );
    assert.deepEqual(await service.runOnce('alarm'), {
      skipped: 'blocked',
      reason: 'alarm',
      errorCode: code
    });
    assert.equal(transportCalls, 1);
  }
});

test('429 and 5xx failures retain due mutations with bounded retry times', async () => {
  for (const fixture of [
    {
      name: 'rate limit',
      mutation: makeSettingMutation('m-429'),
      error: new CloudSyncError('RATE_LIMITED', 429, true, 120),
      nextAttemptAt: 121_000
    },
    {
      name: 'server error',
      mutation: makeSettingMutation('m-500', 'batch_concurrency', 3, {
        attemptCount: 2
      }),
      error: new CloudSyncError('SYNC_SERVER_ERROR', 500, true),
      nextAttemptAt: 11_000
    }
  ]) {
    const repository = createSyncRepository({ due: [fixture.mutation] });
    const service = createCloudSyncService({
      repository,
      storageLocal: createCredentialStorage(),
      settings: createSettingsFixture(),
      transportFactory: () => ({
        async push() {
          throw fixture.error;
        }
      }),
      now: () => 1_000,
      random: () => 0.5
    });

    await assert.rejects(
      service.runOnce(fixture.name),
      (error) => error.code === fixture.error.code
    );
    assert.deepEqual(repository.attempts, [{
      mutationId: fixture.mutation.mutationId,
      attemptCount: fixture.mutation.attemptCount + 1,
      nextAttemptAt: fixture.nextAttemptAt,
      lastErrorCode: fixture.error.code,
      state: 'pending'
    }]);
    assert.deepEqual(
      repository.meta.get('lastSyncError:AAAAAAAAAAAAAAAAAAAAAA'),
      {
        code: fixture.error.code,
        status: fixture.error.status,
        retryable: true
      }
    );
  }
});

test('creates a vault with local-only credentials and queues only present allowlisted settings', async () => {
  const repository = createSyncRepository();
  const storageLocal = createStorage();
  const createCalls = [];
  const service = createCloudSyncService({
    repository,
    storageLocal,
    settings: {
      async load() {
        return {
          promotion_website_url: 'https://promo.test',
          batch_concurrency: 3,
          auto_fill_user_password: 'must-not-leave',
          llm_api_key: 'sk-must-not-leave'
        };
      },
      async saveRemote() {},
      createMutations() {
        return [];
      }
    },
    transportFactory: ({ syncKey, vaultId, secret, deviceId }) => ({
      async createVault(sentDeviceId) {
        createCalls.push({
          syncKey,
          vaultId,
          secret,
          deviceId,
          sentDeviceId
        });
        return { ok: true, highWatermark: 0 };
      }
    }),
    now: () => 2_000
  });

  const created = await service.createVault();
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].sentDeviceId, createCalls[0].deviceId);
  assert.equal(created.syncKey, createCalls[0].syncKey);
  assert.deepEqual(
    Object.keys(storageLocal.data).sort(),
    [
      'cloud_sync_device_id',
      'cloud_sync_enabled',
      'cloud_sync_secret',
      'cloud_sync_vault_id'
    ]
  );
  assert.equal(Object.hasOwn(storageLocal.data, 'cloud_sync_key'), false);
  assert.deepEqual(
    repository.enqueued.map(({ entityId }) => entityId).sort(),
    ['batch_concurrency', 'promotion_website_url']
  );
  assert.doesNotMatch(
    JSON.stringify(repository.enqueued),
    /must-not-leave|llm_api_key|password|syncKey|secret/iu
  );
});

test('keeps a created vault connected when post-credential local setup fails', async () => {
  for (const failure of ['meta', 'settings']) {
    const repository = createSyncRepository();
    if (failure === 'meta') {
      repository.setSyncMeta = async () => {
        throw new Error('sync metadata unavailable');
      };
    } else {
      repository.enqueueSyncMutation = async () => {
        throw new Error('sync outbox unavailable');
      };
    }
    const storageLocal = createStorage();
    const service = createCloudSyncService({
      repository,
      storageLocal,
      settings: {
        async load() {
          return { batch_concurrency: 3 };
        },
        async saveRemote() {},
        createMutations() {
          return [];
        }
      },
      transportFactory: () => ({
        async createVault() {
          return { ok: true, highWatermark: 0 };
        }
      })
    });

    const result = await service.createVault();
    assert.equal(result.connected, true);
    assert.equal(result.vaultId, storageLocal.data.cloud_sync_vault_id);
    assert.equal(result.deviceId, storageLocal.data.cloud_sync_device_id);
    assert.equal(storageLocal.data.cloud_sync_enabled, true);
    assert.deepEqual(result.warning, {
      code: failure === 'meta'
        ? 'SYNC_META_WRITE_FAILED'
        : 'SYNC_SETTING_QUEUE_FAILED',
      status: 0,
      retryable: true
    });
  }
});

test('compensates a remote create once when credential persistence fails', async () => {
  const storageLocal = createStorage();
  storageLocal.set = async () => {
    throw new Error('credential storage unavailable');
  };
  const calls = [];
  let createdVaultId;
  const service = createCloudSyncService({
    repository: createSyncRepository(),
    storageLocal,
    settings: createSettingsFixture(),
    transportFactory: ({ vaultId }) => {
      createdVaultId = vaultId;
      return {
        async createVault() {
          calls.push('create');
          return { ok: true, highWatermark: 0 };
        },
        async deleteVault(confirmation) {
          calls.push(['delete', confirmation]);
          throw new Error('best-effort compensation failed');
        }
      };
    }
  });

  await assert.rejects(
    service.createVault(),
    /credential storage unavailable/
  );
  assert.deepEqual(calls, [
    'create',
    ['delete', createdVaultId]
  ]);
});

test('imports a validated key through every bootstrap phase before pulling deltas', async () => {
  const repository = createSyncRepository();
  const storageLocal = createStorage();
  const settings = createSettingsFixture();
  const calls = [];
  const service = createCloudSyncService({
    repository,
    storageLocal,
    settings,
    transportFactory: ({ syncKey }) => {
      assert.equal(syncKey, VALID_SYNC_KEY);
      return {
        async status(deviceId) {
          calls.push(['status', deviceId]);
          return { ok: true, highWatermark: 42 };
        },
        async bootstrap(query) {
          calls.push(['bootstrap', structuredClone(query)]);
          if (!query.cursor) {
            return {
              comments: [{
                comment: {
                  id: 'recent:1',
                  historyRevision: {
                    capturedAt: 1,
                    recordedAt: 1,
                    sequence: 0,
                    id: 'recent-revision'
                  }
                },
                anchors: []
              }],
              settings: [{ key: 'batch_concurrency', value: 3 }],
              tombstones: [],
              nextCursor: 'signed-comments-phase',
              hasMore: true,
              serverCursor: 42,
              serverNow: 2_000
            };
          }
          assert.equal(query.cursor, 'signed-comments-phase');
          return {
            comments: [],
            settings: [],
            tombstones: [{ recordId: 'deleted:1', deletedAt: 1_500 }],
            nextCursor: null,
            hasMore: false,
            serverCursor: 42,
            serverNow: 2_000
          };
        },
        async pull(query) {
          calls.push(['pull', structuredClone(query)]);
          assert.equal(query.cursor, 42);
          return {
            changes: [],
            nextCursor: 42,
            hasMore: false,
            highWatermark: 42
          };
        }
      };
    },
    now: () => 2_000
  });

  const imported = await service.importKey(VALID_SYNC_KEY);
  assert.equal(imported.vaultId, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(typeof imported.deviceId, 'string');
  assert.equal(imported.deviceId.length > 0, true);
  assert.deepEqual(
    calls.map(([method]) => method),
    ['status', 'bootstrap', 'bootstrap', 'pull']
  );
  assert.equal(calls[1][1].cursor, undefined);
  assert.equal(calls[2][1].cursor, 'signed-comments-phase');
  assert.deepEqual(settings.remoteWrites, [{ batch_concurrency: 3 }]);
  assert.deepEqual(
    repository.bootstrapPages.map((page) => ({
      comments: page.comments.map(({ comment }) => comment.id),
      tombstones: page.tombstones.map(({ recordId }) => recordId),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    })),
    [
      {
        comments: ['recent:1'],
        tombstones: [],
        nextCursor: 'signed-comments-phase',
        hasMore: true
      },
      {
        comments: [],
        tombstones: ['deleted:1'],
        nextCursor: null,
        hasMore: false
      }
    ]
  );
  assert.equal(
    repository.meta.get('serverCursor:AAAAAAAAAAAAAAAAAAAAAA'),
    42
  );
});

test('keeps a verified import connected when bootstrap fails and runOnce resumes its phase', async () => {
  const repository = createSyncRepository();
  const storageLocal = createStorage();
  const settings = createSettingsFixture();
  const bootstrapQueries = [];
  let failTombstonePhase = true;
  let pullCalls = 0;
  const service = createCloudSyncService({
    repository,
    storageLocal,
    settings,
    transportFactory: () => ({
      async status() {
        return { ok: true, highWatermark: 42 };
      },
      async bootstrap(query) {
        assert.equal(
          storageLocal.data.cloud_sync_enabled,
          true,
          'credentials must be durable before remote data is read'
        );
        bootstrapQueries.push(structuredClone(query));
        if (!query.cursor) {
          return {
            comments: [{
              comment: {
                id: 'resume-comment:1',
                historyRevision: {
                  capturedAt: 1,
                  recordedAt: 1,
                  sequence: 0,
                  id: 'resume-revision'
                }
              },
              anchors: []
            }],
            settings: [{ key: 'batch_concurrency', value: 3 }],
            tombstones: [],
            nextCursor: 'signed-tombstone-phase',
            hasMore: true,
            serverCursor: 42,
            serverNow: 2_000
          };
        }
        assert.equal(query.cursor, 'signed-tombstone-phase');
        if (failTombstonePhase) {
          throw new CloudSyncError('SYNC_SERVER_ERROR', 500, true);
        }
        return {
          comments: [],
          settings: [],
          tombstones: [{ recordId: 'resume-deleted:1', deletedAt: 1_500 }],
          nextCursor: null,
          hasMore: false,
          serverCursor: 42,
          serverNow: 2_000
        };
      },
      async pull({ cursor }) {
        pullCalls += 1;
        assert.equal(cursor, 42);
        return {
          changes: [],
          nextCursor: 42,
          hasMore: false,
          highWatermark: 42
        };
      }
    }),
    now: () => 2_000
  });

  assert.deepEqual(await service.importKey(VALID_SYNC_KEY), {
    connected: true,
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    deviceId: storageLocal.data.cloud_sync_device_id,
    bootstrapPending: true,
    error: {
      code: 'SYNC_SERVER_ERROR',
      status: 500,
      retryable: true
    }
  });
  assert.deepEqual(
    repository.meta.get('bootstrapState:AAAAAAAAAAAAAAAAAAAAAA'),
    {
      cursor: 'signed-tombstone-phase',
      serverCursor: 42,
      serverNow: 2_000,
      phase: 'comments',
      done: false
    }
  );
  assert.equal(pullCalls, 0);

  failTombstonePhase = false;
  assert.deepEqual(await service.runOnce('alarm'), {
    pushed: 0,
    pulled: 0,
    cursor: 42
  });
  assert.deepEqual(
    bootstrapQueries.map(({ cursor }) => cursor ?? null),
    [null, 'signed-tombstone-phase', 'signed-tombstone-phase']
  );
  assert.equal(pullCalls, 1);
  assert.deepEqual(
    repository.bootstrapPages.flatMap(({ tombstones }) => (
      tombstones.map(({ recordId }) => recordId)
    )),
    ['resume-deleted:1']
  );
});

test('rejects bootstrap snapshot or phase changes across signed continuation pages', async () => {
  for (const scenario of ['server cursor changed', 'comments returned after tombstones']) {
    const repository = createSyncRepository();
    const storageLocal = createStorage();
    let page = 0;
    const service = createCloudSyncService({
      repository,
      storageLocal,
      settings: createSettingsFixture(),
      transportFactory: () => ({
        async status() {
          return { ok: true, highWatermark: 50 };
        },
        async bootstrap() {
          page += 1;
          if (page === 1) {
            return {
              comments: [],
              settings: [],
              tombstones: [{ recordId: 'phase-delete:1', deletedAt: 1 }],
              nextCursor: 'signed-tombstones',
              hasMore: true,
              serverCursor: 42,
              serverNow: 2_000
            };
          }
          return {
            comments: scenario === 'comments returned after tombstones'
              ? [{
                  comment: {
                    id: 'illegal-comment:1',
                    historyRevision: {
                      capturedAt: 1,
                      recordedAt: 1,
                      sequence: 0,
                      id: 'illegal-revision'
                    }
                  },
                  anchors: []
                }]
              : [],
            settings: [],
            tombstones: [],
            nextCursor: null,
            hasMore: false,
            serverCursor: scenario === 'server cursor changed' ? 43 : 42,
            serverNow: 2_000
          };
        }
      })
    });

    const result = await service.importKey(VALID_SYNC_KEY);
    assert.equal(result.connected, true);
    assert.equal(result.bootstrapPending, true);
    assert.equal(result.error.code, 'INVALID_SYNC_RESPONSE');
    assert.equal(repository.bootstrapPages.length, 1);
    assert.deepEqual(
      repository.meta.get('bootstrapState:AAAAAAAAAAAAAAAAAAAAAA'),
      {
        cursor: 'signed-tombstones',
        serverCursor: 42,
        serverNow: 2_000,
        phase: 'tombstones',
        done: false
      }
    );
  }
});

test('does not bootstrap or write remote entities when imported credential storage fails', async () => {
  const repository = createSyncRepository();
  const storageLocal = createStorage();
  storageLocal.set = async () => {
    throw new Error('credential storage unavailable');
  };
  let bootstrapCalls = 0;
  const service = createCloudSyncService({
    repository,
    storageLocal,
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async status() {
        return { ok: true, highWatermark: 42 };
      },
      async bootstrap() {
        bootstrapCalls += 1;
        return {
          comments: [],
          settings: [],
          tombstones: [],
          nextCursor: null,
          hasMore: false,
          serverCursor: 42,
          serverNow: 2_000
        };
      }
    })
  });

  await assert.rejects(
    service.importKey(VALID_SYNC_KEY),
    /credential storage unavailable/
  );
  assert.equal(bootstrapCalls, 0);
  assert.deepEqual(repository.bootstrapPages, []);
  assert.deepEqual(repository.meta, new Map());
});

test('rejects an invalid imported key before transport or credential storage', async () => {
  const storageLocal = createStorage();
  let transportCalls = 0;
  const service = createCloudSyncService({
    repository: createSyncRepository(),
    storageLocal,
    settings: createSettingsFixture(),
    transportFactory: () => {
      transportCalls += 1;
      return {};
    }
  });

  await assert.rejects(
    service.importKey('acsync_invalid'),
    (error) => error.code === 'INVALID_SYNC_KEY'
  );
  assert.equal(transportCalls, 0);
  assert.deepEqual(storageLocal.data, {});
});

test('uploads initial history in pages with deterministic IDs and per-record progress', async () => {
  const repository = createSyncRepository();
  const records = Array.from({ length: 51 }, (_, index) => ({
    comment: {
      id: `history:${index}`,
      submittedAt: index,
      historyRevision: {
        capturedAt: index,
        recordedAt: index,
        sequence: 0,
        id: `rev:${index}`
      }
    },
    anchors: []
  }));
  repository.scanRecordsForInitialSync = async ({ cursor, limit }) => {
    assert.equal(limit, 50);
    const start = cursor == null
      ? 0
      : records.findIndex(({ comment }) => comment.id === cursor) + 1;
    const pageRecords = records.slice(start, start + limit);
    return {
      records: structuredClone(pageRecords),
      cursor: pageRecords.at(-1)?.comment.id ?? cursor ?? null,
      done: start + pageRecords.length >= records.length
    };
  };
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({}),
    now: () => 3_000
  });

  assert.deepEqual(await service.enqueueInitialHistory(), {
    scanned: 50,
    queued: 50,
    done: false
  });
  assert.equal(
    repository.enqueued[0].mutationId,
    '0cefdc2b3c278aa8c9cd6670215fe0fe19d8c88d3e1de743fd6e834d139702f5'
  );
  assert.deepEqual(
    repository.meta.get('initialUploadState:AAAAAAAAAAAAAAAAAAAAAA'),
    { cursor: 'history:49', done: false }
  );
  assert.deepEqual(await service.enqueueInitialHistory(), {
    scanned: 1,
    queued: 1,
    done: true
  });

  repository.meta.set(
    'initialUploadState:AAAAAAAAAAAAAAAAAAAAAA',
    { cursor: null, done: false }
  );
  assert.deepEqual(await service.enqueueInitialHistory(), {
    scanned: 50,
    queued: 0,
    done: false
  });
  assert.equal(new Set(
    repository.enqueued.map(({ mutationId }) => mutationId)
  ).size, 51);
});

test('single-flights initial history scans so durable progress cannot regress', async () => {
  const repository = createSyncRepository();
  const scanStarted = deferred();
  const releaseScan = deferred();
  let scanCalls = 0;
  repository.scanRecordsForInitialSync = async ({ cursor }) => {
    scanCalls += 1;
    assert.equal(cursor, null);
    scanStarted.resolve();
    await releaseScan.promise;
    return {
      records: [{
        comment: {
          id: 'history:single-flight',
          submittedAt: 1,
          historyRevision: {
            capturedAt: 1,
            recordedAt: 1,
            sequence: 0,
            id: 'rev:single-flight'
          }
        },
        anchors: []
      }],
      cursor: 'history:single-flight',
      done: true
    };
  };
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({}),
    now: () => 3_000
  });

  const first = service.enqueueInitialHistory();
  await scanStarted.promise;
  const second = service.enqueueInitialHistory();
  assert.equal(first, second);
  releaseScan.resolve();
  assert.deepEqual(await first, {
    scanned: 1,
    queued: 1,
    done: true
  });
  assert.equal(scanCalls, 1);
  assert.deepEqual(
    repository.meta.get('initialUploadState:AAAAAAAAAAAAAAAAAAAAAA'),
    { cursor: 'history:single-flight', done: true }
  );
});

test('never advances initial history progress past a failed enqueue', async () => {
  const repository = createSyncRepository();
  repository.scanRecordsForInitialSync = async () => ({
    records: [
      {
        comment: {
          id: 'history:1',
          submittedAt: 1,
          historyRevision: {
            capturedAt: 1,
            recordedAt: 1,
            sequence: 0,
            id: 'rev:1'
          }
        },
        anchors: []
      },
      {
        comment: {
          id: 'history:2',
          submittedAt: 2,
          historyRevision: {
            capturedAt: 2,
            recordedAt: 2,
            sequence: 0,
            id: 'rev:2'
          }
        },
        anchors: []
      }
    ],
    cursor: 'history:2',
    done: true
  });
  const enqueue = repository.enqueueSyncMutation;
  repository.enqueueSyncMutation = async (mutation) => {
    if (mutation.entityId === 'history:2') {
      throw new Error('outbox unavailable');
    }
    await enqueue(mutation);
  };
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({}),
    now: () => 3_000
  });

  await assert.rejects(
    service.enqueueInitialHistory(),
    /outbox unavailable/
  );
  assert.deepEqual(
    repository.meta.get('initialUploadState:AAAAAAAAAAAAAAAAAAAAAA'),
    { cursor: 'history:1', done: false }
  );
});

test('a durable repair marker restarts a completed scan and queues a newer comment', async () => {
  const repository = createSyncRepository();
  const vaultId = 'AAAAAAAAAAAAAAAAAAAAAA';
  repository.meta.set(
    `initialUploadState:${vaultId}`,
    { cursor: 'history:old', done: true }
  );
  repository.meta.set(
    `initialUploadRepair:${vaultId}`,
    'repair-new-comment'
  );
  const newer = {
    comment: {
      id: 'history:new',
      submittedAt: 2,
      historyRevision: {
        capturedAt: 2,
        recordedAt: 2,
        sequence: 0,
        id: 'rev:new'
      }
    },
    anchors: []
  };
  const scanCursors = [];
  repository.scanRecordsForInitialSync = async ({ cursor }) => {
    scanCursors.push(cursor);
    return {
      records: [structuredClone(newer)],
      cursor: newer.comment.id,
      done: true
    };
  };
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({}),
    now: () => 3_000
  });

  assert.deepEqual(await service.enqueueInitialHistory(), {
    scanned: 1,
    queued: 1,
    done: true
  });
  assert.deepEqual(scanCursors, [null]);
  assert.equal(repository.enqueued.at(-1).entityId, 'history:new');
  assert.equal(
    repository.meta.has(`initialUploadRepair:${vaultId}`),
    false
  );
  assert.deepEqual(
    repository.meta.get(`initialUploadState:${vaultId}`),
    {
      cursor: 'history:new',
      repairMarker: 'repair-new-comment',
      done: true
    }
  );
  assert.deepEqual(await service.enqueueInitialHistory(), {
    scanned: 0,
    queued: 0,
    done: true
  });
});

test('exposes status and credentials without copying the secret into repository metadata', async () => {
  const repository = createSyncRepository({
    due: [makeSettingMutation('m-status')]
  });
  repository.meta.set(
    'lastSuccessfulSyncAt:AAAAAAAAAAAAAAAAAAAAAA',
    900
  );
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({})
  });

  assert.deepEqual(await service.getStatus(), {
    enabled: true,
    state: 'idle',
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    deviceId: 'device-a',
    pendingCount: 1,
    lastSuccessfulSyncAt: 900,
    lastSyncError: null
  });
  assert.deepEqual(await service.getCredentialsForDisplay(), {
    syncKey: VALID_SYNC_KEY,
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    deviceId: 'device-a'
  });
  assert.doesNotMatch(JSON.stringify([...repository.meta]), /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/u);
});

test('enqueues only local-area allowlisted setting mutations and ignores remote echoes', async () => {
  const repository = createSyncRepository();
  let createCalls = 0;
  const settings = {
    async load() {
      return {};
    },
    async saveRemote() {},
    createMutations(changes, areaName) {
      createCalls += 1;
      assert.equal(areaName, 'local');
      if (!Object.hasOwn(changes, 'batch_concurrency')) return [];
      return [normalizeSettingMutationForTest(
        'setting-local-1',
        'batch_concurrency',
        changes.batch_concurrency.newValue
      )];
    }
  };
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings,
    transportFactory: () => ({}),
    now: () => 4_000
  });

  assert.deepEqual(await service.enqueueSettingChanges({
    batch_concurrency: { newValue: 4 }
  }, 'sync'), { queued: 0 });
  assert.equal(createCalls, 0);
  assert.deepEqual(await service.enqueueSettingChanges({
    auto_fill_user_password: { newValue: 'must-not-leave' },
    llm_api_key: { newValue: 'sk-must-not-leave' }
  }, 'local'), { queued: 0 });
  assert.deepEqual(await service.enqueueSettingChanges({
    batch_concurrency: { newValue: 4 }
  }, 'local'), { queued: 1 });
  assert.equal(repository.enqueued.length, 1);
  assert.equal(repository.enqueued[0].vaultId, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.doesNotMatch(
    JSON.stringify(repository.enqueued),
    /must-not-leave|password|api.?key/iu
  );
});

test('delegates cloud history APIs and deletes locally only after cloud success', async () => {
  const repository = createSyncRepository();
  const transportCalls = [];
  const service = createCloudSyncService({
    repository,
    storageLocal: createCredentialStorage(),
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async history(query) {
        transportCalls.push(['history', structuredClone(query)]);
        return {
          records: [{ comment: { id: 'cloud:1' }, anchors: [] }],
          nextCursor: null,
          hasMore: false
        };
      },
      async deleteHistory(recordId, mutationId) {
        transportCalls.push(['deleteHistory', recordId, mutationId]);
        return {
          mutationId,
          status: 'applied',
          serverSeq: 9
        };
      }
    })
  });

  assert.deepEqual(await service.listCloudHistory({
    targetDomain: 'target.test',
    limit: 50
  }), {
    records: [{ comment: { id: 'cloud:1' }, anchors: [] }],
    nextCursor: null,
    hasMore: false
  });
  const deletion = await service.deleteCloudHistory('cloud:1');
  assert.equal(deletion.status, 'applied');
  assert.equal(transportCalls[1][1], 'cloud:1');
  assert.match(transportCalls[1][2], /^[0-9a-f-]{36}$/u);
  assert.deepEqual(repository.cloudDeletions, [{
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    recordId: 'cloud:1',
    serverSeq: 9
  }]);
});

test('deleteVault requires exact confirmation, preserves local history, and clears only after success', async () => {
  const repository = createSyncRepository();
  let localDeleteCalls = 0;
  repository.deleteConfirmed = async () => {
    localDeleteCalls += 1;
  };
  const storageLocal = createCredentialStorage({ unrelated: 'keep' });
  const confirmations = [];
  const service = createCloudSyncService({
    repository,
    storageLocal,
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async deleteVault(confirmation) {
        confirmations.push(confirmation);
        return { deleted: true };
      }
    })
  });

  await assert.rejects(
    service.deleteVault('wrong-vault'),
    (error) => error.code === 'VAULT_CONFIRMATION_MISMATCH'
  );
  assert.equal(confirmations.length, 0);
  assert.deepEqual(
    await service.deleteVault('AAAAAAAAAAAAAAAAAAAAAA'),
    { deleted: true }
  );
  assert.deepEqual(confirmations, ['AAAAAAAAAAAAAAAAAAAAAA']);
  assert.equal(localDeleteCalls, 0);
  assert.deepEqual(storageLocal.data, { unrelated: 'keep' });
});

test('failed vault deletion keeps credentials while disconnect only removes local credentials', async () => {
  const storageLocal = createCredentialStorage({ unrelated: 'keep' });
  const service = createCloudSyncService({
    repository: createSyncRepository(),
    storageLocal,
    settings: createSettingsFixture(),
    transportFactory: () => ({
      async deleteVault() {
        throw new CloudSyncError('SYNC_SERVER_ERROR', 500, true);
      }
    })
  });

  await assert.rejects(
    service.deleteVault('AAAAAAAAAAAAAAAAAAAAAA'),
    (error) => error.code === 'SYNC_SERVER_ERROR'
  );
  assert.equal(storageLocal.data.cloud_sync_secret.length, 43);
  assert.deepEqual(await service.disconnect(), { disconnected: true });
  assert.deepEqual(storageLocal.data, { unrelated: 'keep' });
});

function normalizeSettingMutationForTest(mutationId, entityId, value) {
  return {
    mutationId,
    entityType: 'setting',
    entityId,
    operation: 'upsert',
    payload: { value },
    createdAt: 4_000
  };
}
