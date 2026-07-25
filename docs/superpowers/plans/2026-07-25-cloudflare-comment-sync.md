# Cloudflare Comment Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, local-first synchronization of successful-comment history and non-sensitive settings across browser installations through a Cloudflare Worker backed by D1.

**Architecture:** The extension keeps IndexedDB as its recent local cache and adds a durable outbox plus server cursor. A Cloudflare Worker authenticates a copyable sync key, applies idempotent mutations to D1, exposes incremental pull/bootstrap/history APIs, and propagates tombstones. Comment submission never waits for the network; the background service worker owns all cloud access.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, IndexedDB, `node:test`, `fake-indexeddb`, Cloudflare Workers TypeScript, D1, Wrangler, Vitest 4, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Use D1 only in this phase; do not add R2.
- Keep the existing `historyRevision` freshness order: live source, `capturedAt`, `recordedAt`, `sequence`, then revision `id`.
- Generate `vaultId` from at least 128 random bits and `secret` from 256 random bits with Web Crypto.
- Store the sync secret only in `chrome.storage.local`; D1 stores only its SHA-256 hash.
- Never sync or export the AI API Key, `auto_fill_user_password`, Cookie values, page credentials, batch URL queues, submit contexts, or recovery checkpoints.
- Permit only the exact setting keys listed in Task 1.
- Limit `/v1/sync/push` to 100 mutations per request.
- Cloud history is long-lived; local automatic cache eviction applies only to cloud-confirmed records older than 90 days.
- When cloud sync is disabled, preserve the existing export-before-delete local retention behavior.
- Comment submission and durable local history confirmation must not wait for Worker or D1 availability.
- Write a failing behavioral test and observe the expected failure before each production change.
- Do not stage or modify the user-owned `.DS_Store` change.

---

## File Structure

### Shared extension/Worker modules

- `lib/cloud-sync-protocol.mjs`: protocol constants, setting allowlist, mutation normalization, and recursive sensitive-field rejection.
- `lib/cloud-sync-credentials.mjs`: sync-key generation, parsing, and SHA-256 hashing.

### Extension modules

- `lib/comment-history-db.mjs`: IndexedDB version 2, sync outbox/meta/entity-state stores, remote-change application, migration scan, and synced-cache eviction.
- `lib/comment-history-service.mjs`: enqueue a comment mutation after durable local history storage without making cloud availability part of batch durability.
- `lib/cloud-sync-settings.mjs`: setting allowlist reads/writes, remote-echo suppression, and password migration from sync to local storage.
- `lib/cloud-sync-transport.mjs`: authenticated Worker HTTP client and retry classification.
- `lib/cloud-sync-service.mjs`: single-flight push, pull, bootstrap, initial history upload, and backoff orchestration.
- `lib/cloud-sync-message-listener.mjs`: background-only message API for options and history pages.
- `lib/cloud-history-data-source.mjs`: deterministic local/cloud history source and pagination selection.
- `background.js`: repository façade, startup synchronization, five-minute alarm, and message-listener wiring.
- `options.html`, `options.js`: cloud-sync controls and password-local-only behavior.
- `history.html`, `history.js`: cloud-aware list, status, and permanent-delete controls.
- `lib/comment-history-retention.mjs`: switch between local archive reminders and cloud-confirmed cache eviction.
- `manifest.json`: fixed Worker origin permission.
- `index.html`: English and Chinese privacy disclosures.

### Worker project

- `cloudflare-sync/package.json`, `package-lock.json`: isolated Worker toolchain.
- `cloudflare-sync/tsconfig.json`: Worker TypeScript settings with shared `.mjs` imports.
- `cloudflare-sync/wrangler.jsonc`: Worker, D1, compatibility, and observability configuration.
- `cloudflare-sync/vitest.config.ts`, `test/apply-migrations.ts`: Workers Vitest and D1 setup.
- `cloudflare-sync/migrations/0001_initial.sql`: complete D1 schema.
- `cloudflare-sync/src/http.ts`: JSON responses, request IDs, CORS, and stable errors.
- `cloudflare-sync/src/auth.ts`: Bearer parsing and vault authentication.
- `cloudflare-sync/src/validation.ts`: bounded request/query validation.
- `cloudflare-sync/src/vault.ts`: vault/status/delete-vault operations.
- `cloudflare-sync/src/push.ts`: comment, setting, and delete mutation application.
- `cloudflare-sync/src/pull.ts`: incremental pull and bootstrap snapshots.
- `cloudflare-sync/src/history.ts`: filtered cloud-history query and single-record delete.
- `cloudflare-sync/src/index.ts`: route dispatch only.
- `cloudflare-sync/test/*.test.ts`: runtime/D1 behavioral tests.
- `cloudflare-sync/README.md`: local test, migration, provisioning, deployment, and smoke-test commands.

---

### Task 1: Shared Protocol, Setting Allowlist, and Sync Credentials

**Files:**
- Create: `lib/cloud-sync-protocol.mjs`
- Create: `lib/cloud-sync-credentials.mjs`
- Create: `tests/cloud-sync-protocol.test.mjs`
- Create: `tests/cloud-sync-credentials.test.mjs`

**Interfaces:**
- Produces: `CLOUD_SYNC_LOCAL_KEYS`, `CLOUD_SYNC_SETTING_KEYS`, `pickCloudSyncSettings(values)`,
  `normalizeCommentRevision(comment)`, `normalizeSyncMutation(input)`,
  `createSyncCredentials(options)`, `parseSyncKey(value)`, and `hashSyncSecret(secret, subtle)`.
- Consumes: Web Crypto `getRandomValues` and `SubtleCrypto.digest`.

- [ ] **Step 1: Write failing allowlist and mutation-sanitization tests**

```js
test('keeps only the approved non-sensitive setting keys', () => {
  assert.deepEqual(pickCloudSyncSettings({
    promotion_website_url: 'https://promo.test',
    promotion_website_content: 'description',
    auto_fill_user_name: 'CloudHu',
    auto_fill_user_email: 'owner@example.test',
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    show_export_outlinks_floating_button: false,
    batch_checkbox_settings: { autoOpenPanel: true },
    batch_concurrency: 3,
    batch_timeout_seconds: 60,
    auto_comment_user_id: 'public-user',
    auto_fill_user_password: 'must-not-leave',
    llm_api_key: 'sk-secret',
    batch_urls: ['https://target.test']
  }), {
    promotion_website_url: 'https://promo.test',
    promotion_website_content: 'description',
    auto_fill_user_name: 'CloudHu',
    auto_fill_user_email: 'owner@example.test',
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    show_export_outlinks_floating_button: false,
    batch_checkbox_settings: { autoOpenPanel: true },
    batch_concurrency: 3,
    batch_timeout_seconds: 60,
    auto_comment_user_id: 'public-user'
  });
});

test('rejects a setting mutation for a non-whitelisted key', () => {
  assert.throws(
    () => normalizeSyncMutation({
      mutationId: 'mutation-a',
      entityType: 'setting',
      entityId: 'auto_fill_user_password',
      operation: 'upsert',
      payload: { value: 'secret' },
      createdAt: 1721000000000
    }),
    /SETTING_NOT_SYNCABLE/
  );
});

test('normalizes a legacy comment revision deterministically', () => {
  assert.deepEqual(normalizeCommentRevision({
    id: 'batch-a:1',
    submittedAt: 1721000000000
  }), {
    capturedAt: 1721000000000,
    recordedAt: 1721000000000,
    sequence: 0,
    id: 'legacy:batch-a:1:1721000000000'
  });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run: `node --test tests/cloud-sync-protocol.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/cloud-sync-protocol.mjs`.

- [ ] **Step 3: Implement the fixed allowlist and normalized mutation union**

```js
export const CLOUD_SYNC_SETTING_KEYS = Object.freeze([
  'promotion_website_url',
  'promotion_website_content',
  'auto_fill_user_name',
  'auto_fill_user_email',
  'llm_api_base_url',
  'llm_model',
  'show_export_outlinks_floating_button',
  'batch_checkbox_settings',
  'batch_concurrency',
  'batch_timeout_seconds',
  'auto_comment_user_id'
]);

export const CLOUD_SYNC_LOCAL_KEYS = Object.freeze({
  enabled: 'cloud_sync_enabled',
  vaultId: 'cloud_sync_vault_id',
  secret: 'cloud_sync_secret',
  deviceId: 'cloud_sync_device_id'
});

export function pickCloudSyncSettings(values = {}) {
  return Object.fromEntries(
    CLOUD_SYNC_SETTING_KEYS
      .filter((key) => Object.hasOwn(values, key))
      .map((key) => [key, structuredClone(values[key])])
  );
}
```

Implement `normalizeSyncMutation` as a discriminated union for `comment`, `setting`, and
`comment_delete`; reject unknown keys, operations, entity types, empty IDs, non-finite timestamps,
and recursively forbidden property names `apiKey`, `llm_api_key`, `password`, `cookie`,
`authorization`, `batch_urls`, and `submit_context`.

Move the existing legacy fallback semantics into `normalizeCommentRevision(comment)` and make
`comment-history-db.mjs` consume that shared function in Task 2 so browser and Worker compare the
same normalized revision.

- [ ] **Step 4: Run the protocol test and verify GREEN**

Run: `node --test tests/cloud-sync-protocol.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing deterministic credential tests**

```js
test('creates and parses the documented sync-key format', () => {
  const getRandomValues = (bytes) => bytes.fill(0);
  const credentials = createSyncCredentials({ getRandomValues });
  assert.equal(
    credentials.syncKey,
    'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  );
  assert.deepEqual(parseSyncKey(credentials.syncKey), {
    vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });
});

test('hashes the secret without returning the cleartext', async () => {
  assert.equal(
    await hashSyncSecret('secret', crypto.subtle),
    '2bb80d537b1da3e38bd30361aa855686bde0ba62cd93a0719d640b2f3a25b'
  );
});
```

- [ ] **Step 6: Run the credential test and verify RED**

Run: `node --test tests/cloud-sync-credentials.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/cloud-sync-credentials.mjs`.

- [ ] **Step 7: Implement credentials with base64url encoding and strict lengths**

`parseSyncKey` must accept exactly 16 decoded vault bytes and 32 decoded secret bytes. It must
reject whitespace inside the key, bad prefixes, invalid base64url, extra separators, and wrong
lengths. `hashSyncSecret` returns lowercase hexadecimal SHA-256.

```js
export function createSyncCredentials({
  getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
} = {}) {
  const vaultBytes = getRandomValues(new Uint8Array(16));
  const secretBytes = getRandomValues(new Uint8Array(32));
  const vaultId = bytesToBase64Url(vaultBytes);
  const secret = bytesToBase64Url(secretBytes);
  return { vaultId, secret, syncKey: `acsync_${vaultId}.${secret}` };
}

export async function hashSyncSecret(secret, subtle = globalThis.crypto.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 8: Run both focused tests and the existing suite**

Run: `node --test tests/cloud-sync-protocol.test.mjs tests/cloud-sync-credentials.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/cloud-sync-protocol.mjs lib/cloud-sync-credentials.mjs tests/cloud-sync-protocol.test.mjs tests/cloud-sync-credentials.test.mjs
git commit -m "feat: add cloud sync protocol and credentials"
```

---

### Task 2: IndexedDB Version 2, Durable Outbox, and Sync Metadata

**Files:**
- Modify: `lib/comment-history-db.mjs:1-66`
- Modify: `lib/comment-history-db.mjs:212-1052`
- Modify: `tests/comment-history-db.test.mjs`

**Interfaces:**
- Produces repository methods:
  - `upsertIfFresher(bundle, { syncMutation } = {}): Promise<boolean>`
  - `enqueueSyncMutation(mutation): Promise<void>`
  - `listDueSyncMutations({ vaultId, now, limit }): Promise<SyncMutation[]>`
  - `markSyncMutationAttempt({ mutationId, attemptCount, nextAttemptAt, lastErrorCode, state }): Promise<void>`
  - `completeSyncMutations(receipts): Promise<void>`
  - `getSyncMeta(key): Promise<unknown>`
  - `setSyncMeta(key, value): Promise<void>`
  - `scanRecordsForInitialSync({ cursor, limit }): Promise<{ records, cursor, done }>`
  - `applyRemoteChangesAtomic({ vaultId, changes, nextCursor }): Promise<void>`
  - `evictSyncedCacheBefore({ vaultId, cutoff }): Promise<number>`
- Preserves all version 1 stores and records.

- [ ] **Step 1: Write a failing version-upgrade preservation test**

Create a version 1 database containing one comment and anchor, close it, open it through
`openCommentHistoryDb`, and assert:

```js
assert.equal(database.version, 2);
assert.deepEqual([...database.objectStoreNames], [
  'archive_events',
  'comment_anchors',
  'comment_records',
  'history_meta',
  'sync_entities',
  'sync_meta',
  'sync_outbox'
]);
assert.equal((await repo.getRecord('batch-upgrade:1')).comment.commentText, 'preserved');
```

- [ ] **Step 2: Run the upgrade test and verify RED**

Run: `node --test --test-name-pattern="upgrades version 1" tests/comment-history-db.test.mjs`

Expected: FAIL because database version remains `1` and sync stores are absent.

- [ ] **Step 3: Upgrade the schema without recreating existing stores**

Set `DATABASE_VERSION = 2`. In `onupgradeneeded`, create version 1 stores only when absent and add:

```js
const outbox = database.createObjectStore('sync_outbox', { keyPath: 'mutationId' });
outbox.createIndex(
  'by_vault_state_next_attempt',
  ['vaultId', 'state', 'nextAttemptAt', 'createdAt']
);
database.createObjectStore('sync_meta', { keyPath: 'key' });
database.createObjectStore('sync_entities', { keyPath: 'entityKey' });
```

Do not delete or rename any version 1 store or index.

- [ ] **Step 4: Run the upgrade test and verify GREEN**

Run: `node --test --test-name-pattern="upgrades version 1" tests/comment-history-db.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing outbox scheduling and completion tests**

```js
await repo.enqueueSyncMutation({
  mutationId: 'm-late',
  vaultId: 'vault-a',
  entityType: 'comment',
  entityId: 'batch-a:1',
  operation: 'upsert',
  payload: { comment: { id: 'batch-a:1' }, anchors: [] },
  createdAt: 100,
  attemptCount: 1,
  nextAttemptAt: 500,
  lastErrorCode: null,
  state: 'pending'
});
await repo.enqueueSyncMutation({
  mutationId: 'm-due',
  vaultId: 'vault-a',
  entityType: 'comment',
  entityId: 'batch-a:2',
  operation: 'upsert',
  payload: { comment: { id: 'batch-a:2' }, anchors: [] },
  createdAt: 101,
  attemptCount: 0,
  nextAttemptAt: 200,
  lastErrorCode: null,
  state: 'pending'
});
assert.deepEqual(
  (await repo.listDueSyncMutations({
    vaultId: 'vault-a',
    now: 300,
    limit: 100
  })).map((item) => item.mutationId),
  ['m-due']
);
await repo.completeSyncMutations([{
  mutationId: 'm-due',
  vaultId: 'vault-a',
  entityKey: 'vault-a:comment:batch-a:2',
  revisionId: 'revision-2',
  serverSeq: 7
}]);
assert.deepEqual(await repo.listDueSyncMutations({
  vaultId: 'vault-a',
  now: 1000,
  limit: 100
}), [
  {
    mutationId: 'm-late',
    vaultId: 'vault-a',
    entityType: 'comment',
    entityId: 'batch-a:1',
    operation: 'upsert',
    payload: { comment: { id: 'batch-a:1' }, anchors: [] },
    createdAt: 100,
    attemptCount: 1,
    nextAttemptAt: 500,
    lastErrorCode: null,
    state: 'pending'
  }
]);
```

- [ ] **Step 6: Run the outbox tests and verify RED**

Run: `node --test --test-name-pattern="sync outbox" tests/comment-history-db.test.mjs`

Expected: FAIL because the repository methods do not exist.

- [ ] **Step 7: Implement outbox, meta, and entity-state transactions**

`completeSyncMutations` must remove acknowledged outbox rows and upsert `sync_entities` in one
transaction. Store entity keys in the literal forms `vaultId:comment:recordId`,
`vaultId:setting:settingKey`, or `vaultId:comment_delete:recordId`, substituting each named segment
with the validated value.
Every outbox row carries its target `vaultId`; disconnecting a device does not retarget pending
mutations, and a newly imported vault can only read its own outbox rows.
When `upsertIfFresher(bundle, { syncMutation })` rolls back because the outbox row cannot be added,
wrap the error with code `SYNC_OUTBOX_WRITE_FAILED`; preserve the original comment-only behavior
when the option is absent.

```js
async function enqueueSyncMutation(mutation) {
  const transaction = database.transaction(stores.syncOutbox, 'readwrite');
  transaction.objectStore(stores.syncOutbox).add(mutation);
  await transactionCompletion(transaction);
}

async function completeSyncMutations(receipts) {
  const transaction = database.transaction(
    [stores.syncOutbox, stores.syncEntities],
    'readwrite'
  );
  for (const receipt of receipts) {
    transaction.objectStore(stores.syncOutbox).delete(receipt.mutationId);
    transaction.objectStore(stores.syncEntities).put({
      entityKey: receipt.entityKey,
      vaultId: receipt.vaultId,
      revisionId: receipt.revisionId ?? null,
      serverSeq: receipt.serverSeq
    });
  }
  await transactionCompletion(transaction);
}
```

- [ ] **Step 8: Write failing remote-page atomicity and cache-eviction tests**

Test that an invalid second remote change aborts both the first change and cursor advancement.
Test that `evictSyncedCacheBefore({ vaultId, cutoff })` deletes only comments whose
`sync_entities.revisionId`
matches the current comment revision and which have no outbox mutation.

```js
await assert.rejects(repo.applyRemoteChangesAtomic({
  vaultId: 'vault-a',
  changes: [
    {
      serverSeq: 8,
      entityType: 'comment',
      operation: 'upsert',
      record: makeBundle({ id: 'remote:1', submittedAt: 100 })
    },
    {
      serverSeq: 9,
      entityType: 'comment',
      operation: 'upsert',
      record: { comment: { id: '' }, anchors: [] }
    }
  ],
  nextCursor: 9
}));
assert.equal(await repo.getRecord('remote:1'), null);
assert.equal(await repo.getSyncMeta('serverCursor:vault-a'), undefined);

await repo.upsertRecord(makeBundle({ id: 'synced:1', submittedAt: 100 }));
await repo.completeSyncMutations([{
  mutationId: 'sync-1',
  vaultId: 'vault-a',
  entityKey: 'vault-a:comment:synced:1',
  revisionId: 'revision-1',
  serverSeq: 10
}]);
assert.equal(await repo.evictSyncedCacheBefore({
  vaultId: 'vault-a',
  cutoff: 200
}), 1);
assert.equal(await repo.getRecord('synced:1'), null);
```

- [ ] **Step 9: Run the remote/cache tests and verify RED**

Run: `node --test --test-name-pattern="remote change|synced cache" tests/comment-history-db.test.mjs`

Expected: FAIL because atomic remote application and eviction are absent.

- [ ] **Step 10: Implement remote apply, migration scan, and guarded eviction**

Remote comment upserts call the same freshness comparison as local writes but never enqueue an
outbox row. A remote delete removes the local comment and anchors and writes a delete entity state.
`applyRemoteChangesAtomic` writes `sync_meta["serverCursor:" + vaultId] = nextCursor` in the same
transaction. Scope initial-upload and bootstrap metadata with the same vault suffix so importing a
different vault never inherits an old cursor.

```js
async function applyRemoteChangesAtomic({ vaultId, changes, nextCursor }) {
  const transaction = database.transaction([
    stores.comments,
    stores.anchors,
    stores.syncEntities,
    stores.syncMeta
  ], 'readwrite');
  for (const change of changes) {
    applyRemoteChangeInTransaction(transaction, change);
  }
  transaction.objectStore(stores.syncMeta).put({
    key: `serverCursor:${vaultId}`,
    value: nextCursor
  });
  await transactionCompletion(transaction);
}
```

- [ ] **Step 11: Run database tests and the full suite**

Run: `node --test tests/comment-history-db.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add lib/comment-history-db.mjs tests/comment-history-db.test.mjs
git commit -m "feat: add durable local sync state"
```

---

### Task 3: Sensitive Setting Isolation and Password Migration

**Files:**
- Create: `lib/cloud-sync-settings.mjs`
- Create: `tests/cloud-sync-settings.test.mjs`
- Modify: `options.js:1-224`
- Modify: `options.js:226-424`
- Modify: `tests/llm-config.test.mjs`

**Interfaces:**
- Produces:
  - `migratePasswordToLocal(storage): Promise<{ status: string }>`
  - `loadSyncableSettings(storage): Promise<Record<string, unknown>>`
  - `saveRemoteSettings(storage, values, echoGuard): Promise<void>`
  - `createStorageChangeMutations(changes, areaName, options): SyncMutation[]`
  - `buildExportableSettings(syncValues, localValues): Record<string, unknown>`
  - `splitImportedSettings(values): { syncValues, localValues }`
  - `createCloudSyncSettings(storage)` returning the setting adapter consumed by
    `createCloudSyncService`.
- Consumes `CLOUD_SYNC_SETTING_KEYS` and `pickCloudSyncSettings`.

- [ ] **Step 1: Write failing password migration tests**

```js
test('copies the password to local before removing it from sync', async () => {
  const storage = createObservedStorage({
    sync: { auto_fill_user_password: 'secret' },
    local: {}
  });
  assert.deepEqual(await migratePasswordToLocal(storage), { status: 'migrated' });
  assert.equal(storage.localData.auto_fill_user_password, 'secret');
  assert.equal(Object.hasOwn(storage.syncData, 'auto_fill_user_password'), false);
  assert.deepEqual(storage.events, [
    ['local.set', { auto_fill_user_password: 'secret' }],
    ['sync.remove', 'auto_fill_user_password'],
    ['local.set', { cloudSyncPasswordMigrationVersion: 1 }]
  ]);
});

test('keeps the sync password when the local write fails', async () => {
  const storage = createObservedStorage({
    sync: { auto_fill_user_password: 'secret' },
    local: {},
    failLocalSet: true
  });
  await assert.rejects(migratePasswordToLocal(storage), /local write failed/);
  assert.equal(storage.syncData.auto_fill_user_password, 'secret');
});
```

- [ ] **Step 2: Run the migration tests and verify RED**

Run: `node --test tests/cloud-sync-settings.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement ordered, idempotent password migration**

If local already has a password, preserve it and remove the sync copy. Record migration version
only after the removal succeeds. A rerun after any partial failure must converge without data loss.

```js
export async function migratePasswordToLocal(storage) {
  const [syncValues, localValues] = await Promise.all([
    storage.sync.get(['auto_fill_user_password']),
    storage.local.get(['auto_fill_user_password', 'cloudSyncPasswordMigrationVersion'])
  ]);
  if (localValues.cloudSyncPasswordMigrationVersion === 1) {
    return { status: 'already_migrated' };
  }
  const password = localValues.auto_fill_user_password
    ?? syncValues.auto_fill_user_password;
  if (password !== undefined) {
    await storage.local.set({ auto_fill_user_password: password });
  }
  await storage.sync.remove('auto_fill_user_password');
  await storage.local.set({ cloudSyncPasswordMigrationVersion: 1 });
  return { status: 'migrated' };
}
```

- [ ] **Step 4: Run the migration tests and verify GREEN**

Run: `node --test tests/cloud-sync-settings.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing import/export and remote-echo tests**

Add behavioral tests proving:

- A new config export omits `auto_fill_user_password` and `llm_api_key`.
- Importing an old config writes the password only to local storage.
- Applying remote settings does not create another setting mutation.
- A local allowed setting change creates exactly one normalized mutation.
- A local password or API-key change creates no mutation.

```js
assert.deepEqual(buildExportableSettings({
  promotion_website_url: 'https://promo.test',
  auto_fill_user_password: 'sync-secret'
}, {
  llm_api_key: 'sk-local',
  auto_fill_user_password: 'local-secret'
}), {
  promotion_website_url: 'https://promo.test'
});

assert.deepEqual(splitImportedSettings({
  promotion_website_url: 'https://promo.test',
  auto_fill_user_password: 'legacy-password',
  llm_api_key: 'legacy-api-key'
}), {
  syncValues: { promotion_website_url: 'https://promo.test' },
  localValues: { auto_fill_user_password: 'legacy-password' }
});

assert.deepEqual(createStorageChangeMutations({
  auto_fill_user_password: { newValue: 'new-password' },
  llm_api_key: { newValue: 'sk-new' }
}, 'local', {
  now: () => 500,
  createMutationId: () => 'unused'
}), []);
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run: `node --test tests/cloud-sync-settings.test.mjs tests/llm-config.test.mjs`

Expected: FAIL on password export/import and missing echo suppression.

- [ ] **Step 7: Refactor options storage through `cloud-sync-settings.mjs`**

Remove `auto_fill_user_password` from `ACTIVE_STORAGE_KEYS`. Load and save that field through
`chrome.storage.local`; keep the remaining current form behavior. Represent echo suppression with a
short-lived in-memory set of exact `(areaName, key, serializedValue)` entries consumed by the next
matching `storage.onChanged` event.

```js
const { syncValues, localValues } = splitImportedSettings(importedData);
await Promise.all([
  chrome.storage.sync.set(syncValues),
  chrome.storage.local.set(localValues)
]);

const exportData = buildExportableSettings(
  await chrome.storage.sync.get(ACTIVE_STORAGE_KEYS),
  await chrome.storage.local.get([])
);
```

- [ ] **Step 8: Run focused and full tests**

Run: `node --test tests/cloud-sync-settings.test.mjs tests/llm-config.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/cloud-sync-settings.mjs tests/cloud-sync-settings.test.mjs options.js tests/llm-config.test.mjs
git commit -m "fix: keep sensitive settings device local"
```

---

### Task 4: Authenticated Worker Transport and Retry Policy

**Files:**
- Create: `lib/cloud-sync-transport.mjs`
- Create: `tests/cloud-sync-transport.test.mjs`

**Interfaces:**
- Produces `createCloudSyncTransport({ baseUrl, syncKey, fetchImpl })` with methods
  `status(deviceId)`, `createVault(deviceId)`, `push(body)`, `pull(query)`, `bootstrap(query)`,
  `history(query)`, `deleteHistory(recordId, mutationId)`, and `deleteVault(confirmation)`.
- Produces `classifySyncFailure(errorOrResponse, now)` and
  `nextRetryAt({ attemptCount, now, retryAfter, random })`.

- [ ] **Step 1: Write failing request-shape and secret-redaction tests**

```js
test('sends the sync key only in Authorization to the fixed origin', async () => {
  const calls = [];
  const transport = createCloudSyncTransport({
    baseUrl: 'https://sync.example.workers.dev',
    syncKey: VALID_SYNC_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, requestId: 'request-1', highWatermark: 0 });
    }
  });
  await transport.status('device-a');
  assert.equal(calls[0].url, 'https://sync.example.workers.dev/v1/status?deviceId=device-a');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_SYNC_KEY}`);
  assert.doesNotMatch(JSON.stringify(calls[0].init.body), /acsync_/);
});
```

Add tests for stable parsing of 401, 403, 429 with `Retry-After`, 500, invalid JSON, network
exceptions, and an origin mismatch.

```js
async function captureTransportError(response) {
  const transport = createCloudSyncTransport({
    baseUrl: 'https://sync.example.workers.dev',
    syncKey: VALID_SYNC_KEY,
    fetchImpl: async () => response
  });
  try {
    await transport.status('device-a');
    assert.fail('status should reject');
  } catch (error) {
    return error;
  }
}

const unauthorized = await captureTransportError(new Response(
  JSON.stringify({ error: { code: 'INVALID_SYNC_KEY', message: '同步密钥无效。' } }),
  { status: 401, headers: { 'Content-Type': 'application/json' } }
));
assert.deepEqual({
  code: unauthorized.code,
  status: unauthorized.status,
  retryable: unauthorized.retryable
}, {
  code: 'INVALID_SYNC_KEY',
  status: 401,
  retryable: false
});

const limited = await captureTransportError(new Response(
  JSON.stringify({ error: { code: 'RATE_LIMITED', message: '请求过于频繁。' } }),
  {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '120' }
  }
));
assert.equal(limited.retryable, true);
assert.equal(limited.retryAfter, 120);
```

- [ ] **Step 2: Run the transport tests and verify RED**

Run: `node --test tests/cloud-sync-transport.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bounded HTTP methods and safe errors**

Define a `CloudSyncError` carrying `code`, `status`, `retryable`, `retryAfter`, and a safe message.
Never include request headers, response bodies containing unknown text, or the sync key in
`message`, `cause`, or serialized properties.

```js
async function request(path, init = {}) {
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl) throw new CloudSyncError('SYNC_ORIGIN_MISMATCH', 0, false);
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${syncKey}`,
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
```

- [ ] **Step 4: Implement exponential backoff with full jitter**

Use base 5 seconds and cap at 30 minutes:

```js
const capMs = Math.min(30 * 60_000, 5_000 * (2 ** Math.min(attemptCount, 12)));
return now + Math.floor(random() * capMs);
```

If a valid `Retry-After` is later, use that time instead.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node --test tests/cloud-sync-transport.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run the full extension suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/cloud-sync-transport.mjs tests/cloud-sync-transport.test.mjs
git commit -m "feat: add cloud sync transport"
```

---

### Task 5: Worker Toolchain and Initial D1 Schema

**Files:**
- Create: `cloudflare-sync/package.json`
- Create: `cloudflare-sync/package-lock.json`
- Create: `cloudflare-sync/tsconfig.json`
- Create: `cloudflare-sync/wrangler.jsonc`
- Create: `cloudflare-sync/vitest.config.ts`
- Create: `cloudflare-sync/test/apply-migrations.ts`
- Create: `cloudflare-sync/test/migrations.test.ts`
- Create: `cloudflare-sync/migrations/0001_initial.sql`
- Create: `cloudflare-sync/src/index.ts`

**Interfaces:**
- Produces D1 binding `DB`.
- Produces generated `cloudflare-sync/worker-configuration.d.ts`.
- Consumes the shared protocol modules through `../../lib/*.mjs`.

- [ ] **Step 1: Retrieve current Workers guidance and types**

Search the official Cloudflare documentation for current Workers best practices, D1 bindings,
Wrangler configuration, and Workers Vitest integration. Then run:

```bash
mkdir -p /tmp/auto-comment-workers-types
npm pack @cloudflare/workers-types --pack-destination /tmp/auto-comment-workers-types
```

Read the packed `index.d.ts` for `D1Database`, `D1PreparedStatement`, `ExecutionContext`, and
`ExportedHandler` before choosing signatures.

- [ ] **Step 2: Initialize the isolated Worker package**

Run:

```bash
mkdir -p cloudflare-sync/src cloudflare-sync/test cloudflare-sync/migrations
cd cloudflare-sync
npm init -y
npm install --save-dev typescript@latest wrangler@latest vitest@^4.1.0 @cloudflare/vitest-pool-workers@latest
```

Then set package scripts to:

```json
{
  "name": "auto-comment-cloudflare-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "types": "wrangler types",
    "dev": "wrangler dev",
    "deploy:dry": "wrangler deploy --dry-run"
  }
}
```

- [ ] **Step 3: Write the failing migration test**

Use `readD1Migrations` in `vitest.config.ts`, apply them in the setup file, and assert:

```ts
const tables = await env.DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all<{ name: string }>();
expect(tables.results.map(({ name }) => name)).toEqual([
  'comment_anchors',
  'comment_records',
  'comment_tombstones',
  'sync_changes',
  'sync_devices',
  'sync_mutations',
  'sync_vaults',
  'synced_settings'
]);
```

- [ ] **Step 4: Run the Worker test and verify RED**

Run: `npm --prefix cloudflare-sync test`

Expected: FAIL because `0001_initial.sql` is absent.

- [ ] **Step 5: Create the complete migration**

The migration must create all eight tables, composite primary keys scoped by `vault_id`, a unique
`(vault_id, mutation_id)` constraint in mutations and changes, and indexes:

```sql
CREATE INDEX idx_changes_vault_seq
  ON sync_changes(vault_id, server_seq);
CREATE INDEX idx_comments_vault_submitted
  ON comment_records(vault_id, submitted_at DESC, record_id DESC);
CREATE INDEX idx_comments_vault_target
  ON comment_records(vault_id, target_domain, submitted_at DESC, record_id DESC);
CREATE INDEX idx_comments_vault_promoted
  ON comment_records(vault_id, promoted_domain, submitted_at DESC, record_id DESC);
CREATE INDEX idx_anchors_vault_text
  ON comment_anchors(vault_id, anchor_text_normalized, comment_id);
CREATE INDEX idx_anchors_vault_href
  ON comment_anchors(vault_id, href_domain, comment_id);
```

Store all timestamps as integer Unix milliseconds and booleans as integer `0`/`1`. Store setting
values as validated JSON text. Include all existing comment and anchor fields plus revision columns
and `accepted_mutation_id`.

- [ ] **Step 6: Configure Worker runtime and test bindings**

Use compatibility date `2026-07-25`, `nodejs_compat`, observability enabled with a documented sample
rate, main `src/index.ts`, and a local/test D1 ID
`11111111-1111-1111-1111-111111111111`. Production provisioning in Task 10 replaces that exact
test ID before deployment. Set the non-secret test variable
`ALLOWED_EXTENSION_ORIGINS = "chrome-extension://allowed-extension"`; Task 14 replaces it with the
actual installed extension origin and redeploys.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "auto-comment-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-25",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "ALLOWED_EXTENSION_ORIGINS": "chrome-extension://allowed-extension"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "auto-comment-sync",
    "database_id": "11111111-1111-1111-1111-111111111111",
    "migrations_dir": "migrations"
  }],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.1
  }
}
```

- [ ] **Step 7: Generate binding types**

Run: `npm --prefix cloudflare-sync run types`

Expected: creates `cloudflare-sync/worker-configuration.d.ts`.

- [ ] **Step 8: Run migration test, typecheck, and dry-run**

Run:

```bash
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
npm --prefix cloudflare-sync run deploy:dry
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add cloudflare-sync
git commit -m "feat: scaffold D1 sync worker"
```

---

### Task 6: Worker HTTP Boundary, Vault Creation, and Authentication

**Files:**
- Create: `cloudflare-sync/src/http.ts`
- Create: `cloudflare-sync/src/auth.ts`
- Create: `cloudflare-sync/src/validation.ts`
- Create: `cloudflare-sync/src/vault.ts`
- Modify: `cloudflare-sync/src/index.ts`
- Create: `cloudflare-sync/test/fixtures.ts`
- Create: `cloudflare-sync/test/vault.test.ts`

**Interfaces:**
- Produces `json(data, init)`, `apiError(code, status, retryable, requestId)`,
  `withCors(request, response, env)`, `requireVault(request, env)`, `putVault(request, env)`,
  `getStatus(request, env)`, and `deleteVault(request, env)`.
- Produces `readBoundedJson(request, maximumBytes)` and bounded string/integer/query validators.
- `requireVault` returns `{ vaultId, secretHash }` and never returns the cleartext secret.
- Test fixtures export `VALID_SYNC_KEY`, `VALID_VAULT_ID`, `authHeaders()`, and `seedVault()`.

- [ ] **Step 1: Write failing vault lifecycle tests against the real Worker**

```ts
const create = await SELF.fetch('https://worker.test/v1/vault', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${VALID_SYNC_KEY}`,
    'Content-Type': 'application/json',
    Origin: 'chrome-extension://allowed-extension'
  },
  body: JSON.stringify({ deviceId: 'device-a' })
});
expect(create.status).toBe(201);
expect(await create.json()).toMatchObject({ ok: true, vaultId: VALID_VAULT_ID });

const wrong = await SELF.fetch('https://worker.test/v1/status?deviceId=device-b', {
  headers: { Authorization: `Bearer ${WRONG_SECRET_KEY}` }
});
expect(wrong.status).toBe(403);
```

Add cases for missing auth, malformed key, idempotent same-key creation, disallowed origin,
OPTIONS, method not allowed, device upsert, and full-vault delete confirmation mismatch.

```ts
expect((await SELF.fetch('https://worker.test/v1/status')).status).toBe(401);
expect((await SELF.fetch('https://worker.test/v1/status', {
  headers: { Authorization: 'Bearer malformed' }
})).status).toBe(401);
expect((await SELF.fetch('https://worker.test/v1/vault', {
  method: 'OPTIONS',
  headers: {
    Origin: 'https://untrusted.example',
    'Access-Control-Request-Method': 'PUT'
  }
})).status).toBe(403);
```

- [ ] **Step 2: Run the vault test and verify RED**

Run: `npm --prefix cloudflare-sync test -- vault.test.ts`

Expected: FAIL with 404 or missing route functions.

- [ ] **Step 3: Implement stable JSON/CORS responses and validation**

Allow only the production extension origin plus a test origin from a non-secret Worker variable.
Set `Vary: Origin`, explicit allowed methods/headers, `Cache-Control: no-store`, and
omit `Access-Control-Allow-Credentials` because no cookies are used. Generate request IDs with
`crypto.randomUUID()`.

```ts
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_EXTENSION_ORIGINS.split(',').map((value) => value.trim());
  return origin && allowed.includes(origin) ? origin : null;
}
```

- [ ] **Step 4: Implement vault creation and authentication**

Hash the parsed secret with Web Crypto. `PUT /v1/vault` inserts a missing vault and device, returns
201, returns 200 for the same hash, and returns 403 for an existing vault with a different hash.
`GET /v1/status` authenticates, updates device `last_seen_at`, and returns `highWatermark`.

```ts
export async function requireVault(request: Request, env: Env): Promise<AuthenticatedVault> {
  const credentials = parseBearerSyncKey(request.headers.get('Authorization'));
  const secretHash = await hashSyncSecret(credentials.secret);
  const vault = await env.DB.prepare(
    'SELECT deleted_at FROM sync_vaults WHERE vault_id = ? AND secret_hash = ?'
  ).bind(credentials.vaultId, secretHash).first<{ deleted_at: number | null }>();
  if (!vault) throw unauthorized('INVALID_SYNC_KEY');
  if (vault.deleted_at !== null) throw forbidden('VAULT_DELETED');
  return { vaultId: credentials.vaultId, secretHash };
}
```

- [ ] **Step 5: Implement destructive vault deletion**

Require body `{ confirmation: vaultId }`. Delete comments, anchors, settings, tombstones, devices,
changes, and mutation receipts in a D1 batch, then mark the vault deleted. Authentication for a
deleted vault returns `VAULT_DELETED`.

```ts
await env.DB.batch([
  env.DB.prepare('DELETE FROM comment_anchors WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM comment_records WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM synced_settings WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM comment_tombstones WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM sync_devices WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM sync_changes WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare('DELETE FROM sync_mutations WHERE vault_id = ?').bind(vaultId),
  env.DB.prepare(
    'UPDATE sync_vaults SET deleted_at = ? WHERE vault_id = ?'
  ).bind(Date.now(), vaultId)
]);
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm --prefix cloudflare-sync test -- vault.test.ts
npm --prefix cloudflare-sync run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare-sync/src cloudflare-sync/test/vault.test.ts
git commit -m "feat: add sync vault authentication"
```

---

### Task 7: Idempotent Comment Push and Tombstone Conflict Handling

**Files:**
- Create: `cloudflare-sync/src/push.ts`
- Modify: `cloudflare-sync/src/index.ts`
- Create: `cloudflare-sync/test/push-comments.test.ts`

**Interfaces:**
- Produces `pushMutations(request, env, vault): Promise<Response>`.
- Produces `applyCommentMutation(env, vaultId, mutation, now): Promise<MutationReceipt>`.
- Consumes normalized comment mutation payloads from Task 1.

- [ ] **Step 1: Write a failing comment push test**

Push one comment with two anchors and assert HTTP receipt `{ status: 'applied', serverSeq: 1 }`,
then query D1 and assert one exact comment plus two exact anchors. Push the identical mutation again
and assert `{ status: 'duplicate', serverSeq: 1 }` with unchanged row counts.

```ts
const mutation = commentMutation({
  mutationId: 'comment-mutation-1',
  recordId: 'batch-a:1',
  revisionId: 'revision-1',
  commentText: 'exact body',
  anchors: [
    { position: 0, anchorText: 'One', hrefDomain: 'one.test' },
    { position: 1, anchorText: 'Two', hrefDomain: 'two.test' }
  ]
});
const first = await push([mutation]);
expect(first.results).toEqual([{
  mutationId: 'comment-mutation-1',
  status: 'applied',
  serverSeq: 1
}]);
const second = await push([mutation]);
expect(second.results).toEqual([{
  mutationId: 'comment-mutation-1',
  status: 'duplicate',
  serverSeq: 1
}]);
expect((await env.DB.prepare(
  'SELECT COUNT(*) AS count FROM comment_anchors WHERE vault_id = ? AND comment_id = ?'
).bind(VALID_VAULT_ID, 'batch-a:1').first<{ count: number }>())?.count).toBe(2);
```

Define `commentMutation` and `push` in `push-comments.test.ts` as literal fixture builders that send
requests through `SELF`; do not import production normalization to compute expected payloads.

- [ ] **Step 2: Run the comment push test and verify RED**

Run: `npm --prefix cloudflare-sync test -- push-comments.test.ts`

Expected: FAIL because `/v1/sync/push` is not routed.

- [ ] **Step 3: Implement bounded push request validation**

Reject an empty mutations array, more than 100 entries, duplicate IDs inside one request, invalid
comment fields, overlong strings, non-finite revision numbers, mismatched anchor IDs, and forbidden
payload properties. Return per-item `rejected` only when the outer request is structurally valid.

```ts
const body = await readBoundedJson(request, 512_000);
if (!Array.isArray(body.mutations) || body.mutations.length < 1 || body.mutations.length > 100) {
  throw badRequest('INVALID_MUTATION_BATCH');
}
const ids = body.mutations.map((mutation) => mutation.mutationId);
if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_MUTATION_ID');
```

- [ ] **Step 4: Implement atomic conditional comment UPSERT**

Use D1 bound statements in one `DB.batch()` per mutation:

1. Conditionally insert/update `comment_records` when no tombstone exists and the incoming revision
   is strictly fresher.
2. Delete old anchors only when `accepted_mutation_id` equals the incoming mutation.
3. Insert every incoming anchor only under the same accepted-mutation condition.
4. Insert one `sync_changes` row only when applied.
5. Insert one `sync_mutations` receipt with `applied` or `stale`.

The freshness `WHERE` clause must spell out the same lexicographic comparison used in the extension.

```sql
ON CONFLICT(vault_id, record_id) DO UPDATE SET
  batch_id = excluded.batch_id,
  url_index = excluded.url_index,
  submitted_at = excluded.submitted_at,
  archive_month = excluded.archive_month,
  target_page_url = excluded.target_page_url,
  target_domain = excluded.target_domain,
  promoted_website_url = excluded.promoted_website_url,
  promoted_domain = excluded.promoted_domain,
  comment_html = excluded.comment_html,
  comment_text = excluded.comment_text,
  submit_status = excluded.submit_status,
  source = excluded.source,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  accepted_mutation_id = excluded.accepted_mutation_id,
  revision_source_rank = excluded.revision_source_rank,
  revision_captured_at = excluded.revision_captured_at,
  revision_recorded_at = excluded.revision_recorded_at,
  revision_sequence = excluded.revision_sequence,
  revision_id = excluded.revision_id,
  cloud_updated_at = excluded.cloud_updated_at
WHERE
  excluded.revision_source_rank > comment_records.revision_source_rank
  OR (
    excluded.revision_source_rank = comment_records.revision_source_rank
    AND excluded.revision_captured_at > comment_records.revision_captured_at
  )
  OR (
    excluded.revision_source_rank = comment_records.revision_source_rank
    AND excluded.revision_captured_at = comment_records.revision_captured_at
    AND excluded.revision_recorded_at > comment_records.revision_recorded_at
  )
  OR (
    excluded.revision_source_rank = comment_records.revision_source_rank
    AND excluded.revision_captured_at = comment_records.revision_captured_at
    AND excluded.revision_recorded_at = comment_records.revision_recorded_at
    AND excluded.revision_sequence > comment_records.revision_sequence
  )
  OR (
    excluded.revision_source_rank = comment_records.revision_source_rank
    AND excluded.revision_captured_at = comment_records.revision_captured_at
    AND excluded.revision_recorded_at = comment_records.revision_recorded_at
    AND excluded.revision_sequence = comment_records.revision_sequence
    AND excluded.revision_id > comment_records.revision_id
  )
```

- [ ] **Step 5: Write failing stale, replacement, rollback, and tombstone tests**

Cover:

- A newer revision replaces body and the complete anchor set.
- An older revision returns `stale`.
- An invalid anchor makes the complete mutation fail with no partial rows.
- A tombstone returns `stale` and leaves no comment.
- Two requests with the same mutation ID produce one change row.
- Two interleaved different revisions leave the freshest body.

```ts
await push([commentMutation({
  mutationId: 'newer',
  recordId: 'batch-a:1',
  revisionId: 'revision-newer',
  capturedAt: 200,
  commentText: 'new body',
  anchors: [{ position: 0, anchorText: 'New', hrefDomain: 'new.test' }]
})]);
const stale = await push([commentMutation({
  mutationId: 'older',
  recordId: 'batch-a:1',
  revisionId: 'revision-older',
  capturedAt: 100,
  commentText: 'old body',
  anchors: [{ position: 0, anchorText: 'Old', hrefDomain: 'old.test' }]
})]);
expect(stale.results[0].status).toBe('stale');
expect((await env.DB.prepare(
  'SELECT comment_text FROM comment_records WHERE vault_id = ? AND record_id = ?'
).bind(VALID_VAULT_ID, 'batch-a:1').first<{ comment_text: string }>())?.comment_text)
  .toBe('new body');
```

- [ ] **Step 6: Run conflict tests and verify RED**

Run: `npm --prefix cloudflare-sync test -- push-comments.test.ts`

Expected: at least the new conflict or rollback cases FAIL.

- [ ] **Step 7: Complete the conditional SQL and receipt lookup**

After the batch, read `sync_mutations` by `(vault_id, mutation_id)` and return its stable stored
result. Process the request array sequentially so response ordering matches request ordering.

```ts
const results: MutationReceipt[] = [];
for (const mutation of body.mutations) {
  results.push(await applyMutation(env, vault.vaultId, mutation, Date.now()));
}
return json({ ok: true, results, requestId });
```

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm --prefix cloudflare-sync test -- push-comments.test.ts
npm --prefix cloudflare-sync run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add cloudflare-sync/src/push.ts cloudflare-sync/src/index.ts cloudflare-sync/test/push-comments.test.ts
git commit -m "feat: sync comment mutations to D1"
```

---

### Task 8: Setting Push, Incremental Pull, and Bootstrap Snapshot

**Files:**
- Modify: `cloudflare-sync/src/push.ts`
- Create: `cloudflare-sync/src/pull.ts`
- Modify: `cloudflare-sync/src/index.ts`
- Create: `cloudflare-sync/test/settings-pull.test.ts`
- Create: `cloudflare-sync/test/bootstrap.test.ts`

**Interfaces:**
- Produces `applySettingMutation`, `pullChanges`, and `bootstrapSnapshot`.
- Pull response is `{ changes, nextCursor, hasMore, highWatermark, requestId }`.
- Bootstrap response pages are stable on `(submitted_at DESC, record_id DESC)`.

- [ ] **Step 1: Write failing setting allowlist and last-arrival tests**

Push two unique mutations for `batch_concurrency` with values `2` then `5`; assert D1 stores `5` and
pull returns both change sequence positions while materializing the current value `5`. Push a
password key and assert `rejected` with no D1 row.

```ts
const result = await push([
  settingMutation('setting-1', 'batch_concurrency', 2),
  settingMutation('setting-2', 'batch_concurrency', 5),
  settingMutation('setting-3', 'auto_fill_user_password', 'secret')
]);
expect(result.results.map(({ status }) => status)).toEqual([
  'applied',
  'applied',
  'rejected'
]);
expect((await env.DB.prepare(
  'SELECT value_json FROM synced_settings WHERE vault_id = ? AND setting_key = ?'
).bind(VALID_VAULT_ID, 'batch_concurrency').first<{ value_json: string }>())?.value_json)
  .toBe('5');
```

- [ ] **Step 2: Run the setting test and verify RED**

Run: `npm --prefix cloudflare-sync test -- settings-pull.test.ts`

Expected: FAIL because setting mutation application is absent.

- [ ] **Step 3: Implement setting mutations**

Use the shared allowlist, canonical JSON serialization, one mutation receipt, and one change row.
The last new mutation processed by D1 wins. Replaying an existing mutation returns its original
receipt and does not update the setting.

```ts
await env.DB.batch([
  env.DB.prepare(`
    INSERT INTO synced_settings (
      vault_id, setting_key, value_json, accepted_mutation_id, server_updated_at
    )
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_mutations WHERE vault_id = ? AND mutation_id = ?
    )
    ON CONFLICT(vault_id, setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      accepted_mutation_id = excluded.accepted_mutation_id,
      server_updated_at = excluded.server_updated_at
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_mutations WHERE vault_id = ? AND mutation_id = ?
    )
  `).bind(
    vaultId,
    mutation.entityId,
    canonicalJson,
    mutation.mutationId,
    now,
    vaultId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  ),
  env.DB.prepare(`
    INSERT INTO sync_changes (
      vault_id, mutation_id, entity_type, entity_id, operation, created_at
    )
    SELECT ?, ?, 'setting', ?, 'upsert', ?
    WHERE EXISTS (
      SELECT 1 FROM synced_settings
      WHERE vault_id = ? AND setting_key = ? AND accepted_mutation_id = ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM sync_mutations WHERE vault_id = ? AND mutation_id = ?
    )
  `).bind(
    vaultId,
    mutation.mutationId,
    mutation.entityId,
    now,
    vaultId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  ),
  env.DB.prepare(`
    INSERT OR IGNORE INTO sync_mutations (
      vault_id, mutation_id, entity_type, entity_id, result_status, server_seq, processed_at
    )
    SELECT ?, ?, 'setting', ?, 'applied', server_seq, ?
    FROM sync_changes
    WHERE vault_id = ? AND mutation_id = ?
  `).bind(
    vaultId,
    mutation.mutationId,
    mutation.entityId,
    now,
    vaultId,
    mutation.mutationId
  )
]);
```

- [ ] **Step 4: Write failing pull pagination tests**

Create three changes, request `cursor=0&limit=2`, and assert exact sequence IDs `[1, 2]`,
`nextCursor: 2`, `hasMore: true`, and a fixed `highWatermark: 3`. Request the next page and assert
only ID `3`. Verify every row is scoped to the authenticated vault.

```ts
const first = await pull({ cursor: 0, limit: 2, deviceId: 'device-a' });
expect(first.changes.map(({ serverSeq }) => serverSeq)).toEqual([1, 2]);
expect(first).toMatchObject({
  nextCursor: 2,
  hasMore: true,
  highWatermark: 3
});
const second = await pull({ cursor: first.nextCursor, limit: 2, deviceId: 'device-a' });
expect(second.changes.map(({ serverSeq }) => serverSeq)).toEqual([3]);
expect(second.hasMore).toBe(false);
expect((await env.DB.prepare(
  'SELECT last_cursor FROM sync_devices WHERE vault_id = ? AND device_id = ?'
).bind(VALID_VAULT_ID, 'device-a').first<{ last_cursor: number }>())?.last_cursor).toBe(3);
```

- [ ] **Step 5: Run pull tests and verify RED**

Run: `npm --prefix cloudflare-sync test -- settings-pull.test.ts`

Expected: FAIL because `/v1/sync/pull` is absent.

- [ ] **Step 6: Implement pull with current-row materialization**

Query changes strictly after cursor, ordered ascending, with a validated limit from 1 through 100.
For upserts, include the current comment plus anchors or current setting. For deletes, include only
the tombstone. Return the query-start high watermark on every page. Require `deviceId` and update
that device's `last_seen_at` and `last_cursor` after a successful page response.

```ts
const rows = await env.DB.prepare(`
  SELECT server_seq, entity_type, entity_id, operation, mutation_id
  FROM sync_changes
  WHERE vault_id = ? AND server_seq > ?
  ORDER BY server_seq ASC
  LIMIT ?
`).bind(vault.vaultId, cursor, limit + 1).all<ChangeRow>();
const pageRows = rows.results.slice(0, limit);
const changes = [];
for (const row of pageRows) {
  changes.push(await materializeChange(env.DB, vault.vaultId, row));
}
```

- [ ] **Step 7: Write failing bootstrap snapshot tests**

Seed comments at 89 and 91 days old, a setting, and a tombstone. Assert bootstrap includes the
89-day comment, setting, tombstone, and snapshot cursor but excludes the 91-day comment. Insert a
new change after page one and prove the saved snapshot cursor plus normal pull retrieves it.

```ts
const page = await bootstrap({
  deviceId: 'device-b',
  limit: 50
});
expect(page.comments.map(({ comment }) => comment.id)).toEqual(['recent:1']);
expect(page.settings).toEqual([{ key: 'batch_concurrency', value: 3 }]);
expect(page.tombstones.map(({ recordId }) => recordId)).toEqual(['deleted:1']);
expect(page.comments.some(({ comment }) => comment.id === 'old:1')).toBe(false);

await push([settingMutation('after-snapshot', 'batch_timeout_seconds', 90)]);
const delta = await pull({
  cursor: page.serverCursor,
  limit: 100,
  deviceId: 'device-b'
});
expect(delta.changes.map(({ entityId }) => entityId))
  .toContain('batch_timeout_seconds');
```

- [ ] **Step 8: Run bootstrap tests and verify RED**

Run: `npm --prefix cloudflare-sync test -- bootstrap.test.ts`

Expected: FAIL because `/v1/sync/bootstrap` is absent.

- [ ] **Step 9: Implement stable bootstrap pages**

Capture `serverCursor` at bootstrap start. Page comments with a composite cursor, return settings
and tombstones on the first page only, and never include a comment older than
`serverNow - 90 * 24 * 60 * 60 * 1000`.

```ts
const serverNow = Date.now();
const cutoff = serverNow - 90 * 24 * 60 * 60 * 1000;
const serverCursor = await currentHighWatermark(env.DB, vault.vaultId);
const comments = await env.DB.prepare(`
  SELECT *
  FROM comment_records
  WHERE vault_id = ? AND submitted_at >= ?
  ORDER BY submitted_at DESC, record_id DESC
  LIMIT ?
`).bind(vault.vaultId, cutoff, limit + 1).all<CommentRow>();
```

- [ ] **Step 10: Run Worker tests and typecheck**

Run:

```bash
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add cloudflare-sync/src/push.ts cloudflare-sync/src/pull.ts cloudflare-sync/src/index.ts cloudflare-sync/test/settings-pull.test.ts cloudflare-sync/test/bootstrap.test.ts
git commit -m "feat: add setting pull and bootstrap sync"
```

---

### Task 9: Cloud History Query and Permanent Deletion

**Files:**
- Create: `cloudflare-sync/src/history.ts`
- Modify: `cloudflare-sync/src/index.ts`
- Create: `cloudflare-sync/test/history.test.ts`

**Interfaces:**
- Produces `queryHistory(request, env, vault)` and `deleteHistory(request, env, vault)`.
- Query cursor is `{ submittedAt: number, id: string }`.
- Delete returns a stored mutation receipt and creates a tombstone.

- [ ] **Step 1: Write failing filtered-history tests**

Seed two vaults and records with different target domains, promoted domains, anchor prefixes, href
domains, and timestamps. Assert exact results for each filter, stable descending pagination, maximum
page size 100, and zero cross-vault leakage.

```ts
const response = await SELF.fetch(
  'https://worker.test/v1/history?targetDomain=target.test&anchorTextPrefix=product&limit=50',
  { headers: authHeaders() }
);
expect(response.status).toBe(200);
const body = await response.json<{
  records: Array<{ comment: { id: string } }>;
  nextCursor: { submittedAt: number; id: string } | null;
}>();
expect(body.records.map(({ comment }) => comment.id)).toEqual([
  'matching-newer',
  'matching-older'
]);
expect(body.records.some(({ comment }) => comment.id === 'other-vault')).toBe(false);
expect(body.nextCursor).toEqual({
  submittedAt: MATCHING_OLDER_TIME,
  id: 'matching-older'
});
```

- [ ] **Step 2: Run query tests and verify RED**

Run: `npm --prefix cloudflare-sync test -- history.test.ts`

Expected: FAIL because `/v1/history` is absent.

- [ ] **Step 3: Implement bound, index-aware history queries**

Build SQL from a fixed set of clauses; only values are dynamic bindings. Use `EXISTS` subqueries for
anchor prefix and href-domain filters. Return full comments and anchors but never secret hashes,
mutation receipts, or other vault metadata.

```ts
const clauses = ['c.vault_id = ?'];
const bindings: unknown[] = [vault.vaultId];
if (query.targetDomain) {
  clauses.push('c.target_domain = ?');
  bindings.push(query.targetDomain);
}
if (query.anchorTextPrefix) {
  clauses.push(`
    EXISTS (
      SELECT 1 FROM comment_anchors a
      WHERE a.vault_id = c.vault_id
        AND a.comment_id = c.record_id
        AND a.anchor_text_normalized >= ?
        AND a.anchor_text_normalized < ?
    )
  `);
  bindings.push(query.anchorTextPrefix, prefixUpperBound(query.anchorTextPrefix));
}
```

- [ ] **Step 4: Write failing permanent-delete tests**

Delete a comment with mutation ID `delete-a`; assert the comment and anchors are gone, one tombstone
and one change exist, repeated `delete-a` is duplicate, and a later upload of the old comment is
stale. Deleting an unknown record still creates an idempotent tombstone so an offline copy cannot
appear later.

```ts
const first = await SELF.fetch('https://worker.test/v1/history/batch-a%3A1', {
  method: 'DELETE',
  headers: { ...authHeaders(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ mutationId: 'delete-a' })
});
expect(first.status).toBe(200);
expect(await first.json()).toMatchObject({ status: 'applied' });
expect((await env.DB.prepare(
  'SELECT COUNT(*) AS count FROM comment_records WHERE vault_id = ? AND record_id = ?'
).bind(VALID_VAULT_ID, 'batch-a:1').first<{ count: number }>())?.count).toBe(0);
expect((await env.DB.prepare(
  'SELECT COUNT(*) AS count FROM comment_tombstones WHERE vault_id = ? AND record_id = ?'
).bind(VALID_VAULT_ID, 'batch-a:1').first<{ count: number }>())?.count).toBe(1);

const repeated = await SELF.fetch('https://worker.test/v1/history/batch-a%3A1', {
  method: 'DELETE',
  headers: { ...authHeaders(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ mutationId: 'delete-a' })
});
expect(await repeated.json()).toMatchObject({ status: 'duplicate' });
```

- [ ] **Step 5: Run delete tests and verify RED**

Run: `npm --prefix cloudflare-sync test -- history.test.ts`

Expected: FAIL because DELETE is absent.

- [ ] **Step 6: Implement atomic delete and tombstone creation**

In one D1 batch delete anchors and comment, upsert the tombstone, insert a delete change, and insert
the mutation receipt. Scope every statement by `vault_id`.

```ts
await env.DB.batch([
  env.DB.prepare(
    'DELETE FROM comment_anchors WHERE vault_id = ? AND comment_id = ?'
  ).bind(vaultId, recordId),
  env.DB.prepare(
    'DELETE FROM comment_records WHERE vault_id = ? AND record_id = ?'
  ).bind(vaultId, recordId),
  env.DB.prepare(`
    INSERT INTO comment_tombstones (
      vault_id, record_id, mutation_id, deleted_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(vault_id, record_id) DO NOTHING
  `).bind(vaultId, recordId, mutationId, now),
  createDeleteChangeStatement(env.DB, vaultId, recordId, mutationId, now),
  createDeleteReceiptStatement(env.DB, vaultId, recordId, mutationId, now)
]);
```

- [ ] **Step 7: Run Worker tests, typecheck, and dry-run**

Run:

```bash
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
npm --prefix cloudflare-sync run deploy:dry
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add cloudflare-sync/src/history.ts cloudflare-sync/src/index.ts cloudflare-sync/test/history.test.ts
git commit -m "feat: add cloud history and tombstones"
```

---

### Task 10: Production D1 Provisioning and Fixed Worker Endpoint

**Files:**
- Create: `lib/cloud-sync-config.mjs`
- Create: `tests/cloud-sync-config.test.mjs`
- Modify: `cloudflare-sync/wrangler.jsonc`
- Modify: `manifest.json`

**Interfaces:**
- Produces `CLOUD_SYNC_API_BASE_URL`, an exact deployed HTTPS origin with no path or trailing slash.
- Replaces the test D1 ID with the production database ID returned by Wrangler.
- Makes the fixed Worker origin available to Task 12 background wiring.

- [ ] **Step 1: Verify Cloudflare authentication**

Run:

```bash
npm --prefix cloudflare-sync exec wrangler -- whoami
```

Expected: Wrangler identifies the Cloudflare account intended to own the production D1 database and
Worker. If no account is authenticated, stop this task without changing repository files and ask
the user to complete `wrangler login`.

- [ ] **Step 2: Provision the production D1 database**

Run:

```bash
npm --prefix cloudflare-sync exec wrangler -- d1 create auto-comment-sync
```

Copy the exact `database_id` printed by Wrangler into `cloudflare-sync/wrangler.jsonc`, replacing
`11111111-1111-1111-1111-111111111111`, then run:

```bash
npm --prefix cloudflare-sync run types
```

- [ ] **Step 3: Apply the remote migration**

Run:

```bash
npm --prefix cloudflare-sync exec wrangler -- d1 migrations apply auto-comment-sync --remote
```

Expected: `0001_initial.sql` is recorded as applied.

- [ ] **Step 4: Deploy the Worker**

Run:

```bash
npm --prefix cloudflare-sync exec wrangler -- deploy
```

Record the exact deployed HTTPS origin printed by Wrangler.

- [ ] **Step 5: Write a failing fixed-origin config test**

```js
test('ships one fixed HTTPS cloud sync origin', () => {
  const url = new URL(CLOUD_SYNC_API_BASE_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, CLOUD_SYNC_API_BASE_URL);
  assert.equal(url.pathname, '/');
  assert.notEqual(url.hostname, 'example.invalid');
});
```

- [ ] **Step 6: Run the config test and verify RED**

Run: `node --test tests/cloud-sync-config.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 7: Add the deployed origin to config and manifest**

Create `lib/cloud-sync-config.mjs` with the exact origin from Step 4. Add that same origin followed
by `/*` to `manifest.json` host permissions; do not add a workers.dev wildcard or reuse
`<all_urls>`.

- [ ] **Step 8: Run config, Worker, and dry-run verification**

Run:

```bash
node --test tests/cloud-sync-config.test.mjs
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
npm --prefix cloudflare-sync run deploy:dry
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/cloud-sync-config.mjs tests/cloud-sync-config.test.mjs cloudflare-sync/wrangler.jsonc cloudflare-sync/worker-configuration.d.ts manifest.json
git commit -m "chore: provision cloud sync worker"
```

---

### Task 11: Extension Sync Coordinator and Local Comment Enqueue

**Files:**
- Create: `lib/cloud-sync-service.mjs`
- Create: `tests/cloud-sync-service.test.mjs`
- Modify: `lib/comment-history-service.mjs:200-320`
- Modify: `tests/comment-history-service.test.mjs`

**Interfaces:**
- Produces `createCloudSyncService({ repository, storageLocal, settings, transportFactory, now, random })`.
- Service methods: `createVault()`, `importKey(syncKey)`, `runOnce(reason)`, `getStatus()`,
  `disconnect()`, `deleteVault(confirmation)`, `enqueueInitialHistory()`,
  `listCloudHistory(query)`, `deleteCloudHistory(recordId)`, and `getCredentialsForDisplay()`.
  Add `enqueueSettingChanges(changes, areaName)` for the background storage listener.
- Comment history service accepts `cloudSync` dependency:
  `isEnabled()` and `buildCommentMutation(bundle)`.

- [ ] **Step 1: Write a failing local-first comment test**

```js
test('confirms durable local history without waiting for cloud transport', async () => {
  const repository = createRepositoryFixture();
  const neverCalledTransport = {
    push() {
      throw new Error('network must not run in comment save');
    }
  };
  const service = createCommentHistoryService({
    repository,
    storageLocal: createStorage(),
    cloudSync: {
      isEnabled: async () => true,
      buildCommentMutation: (bundle) => makeCommentMutation(bundle)
    },
    transport: neverCalledTransport
  });
  const result = await service.saveConfirmedSuccess(makeMessage());
  assert.equal(result.historySaveStatus, 'saved');
  assert.equal(repository.outbox.length, 1);
});
```

Also test the outbox-write failure path: the comment is retried without cloud mutation, remains
locally saved, and returns `cloudQueueStatus: 'failed'` for visible recovery.

- [ ] **Step 2: Run focused comment-history tests and verify RED**

Run: `node --test --test-name-pattern="cloud" tests/comment-history-service.test.mjs`

Expected: FAIL because cloud enqueue support is absent.

- [ ] **Step 3: Add optional atomic comment mutation enqueue**

Pass the normalized mutation into the repository's local write transaction. If that transaction
fails specifically while writing the outbox, retry the comment-only transaction and report the
cloud queue warning. Do not downgrade an already durable local history save because a later
`runOnce` fails.

```js
let cloudQueueStatus = 'not_enabled';
const syncMutation = await cloudSync.isEnabled()
  ? cloudSync.buildCommentMutation(bundle)
  : undefined;
try {
  await repository.upsertIfFresher(bundle, { syncMutation });
  cloudQueueStatus = syncMutation ? 'queued' : 'not_enabled';
} catch (error) {
  if (!syncMutation || error?.code !== 'SYNC_OUTBOX_WRITE_FAILED') throw error;
  await repository.upsertIfFresher(bundle);
  cloudQueueStatus = 'failed';
}
return { historySaveStatus: 'saved', cloudQueueStatus };
```

- [ ] **Step 4: Run comment-history tests and verify GREEN**

Run: `node --test tests/comment-history-service.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing coordinator push/pull tests**

Cover:

- Due outbox items are pushed in batches of at most 100.
- `applied`, `duplicate`, and `stale` complete local outbox items.
- `rejected` becomes `needs_attention`.
- 401/403 blocks automatic runs.
- 429/5xx update `nextAttemptAt`.
- A pull page updates records and cursor atomically.
- A failed local apply leaves the old cursor.
- Concurrent triggers share one in-flight promise.

```js
const pendingRun = deferred();
const repository = createSyncRepository({
  due: [makeSettingMutation('m-1', 'batch_concurrency', 3)]
});
const service = createCloudSyncService({
  repository,
  storageLocal: createCredentialStorage(),
  settings: createSettingsFixture(),
  transportFactory: () => ({
    async push() {
      await pendingRun.promise;
      return {
        results: [{ mutationId: 'm-1', status: 'applied', serverSeq: 4 }]
      };
    },
    async pull() {
      return {
        changes: [],
        nextCursor: 4,
        hasMore: false,
        highWatermark: 4
      };
    }
  }),
  now: () => 1000,
  random: () => 0.5
});
const first = service.runOnce('manual');
const second = service.runOnce('alarm');
assert.strictEqual(first, second);
pendingRun.resolve();
assert.deepEqual(await first, {
  pushed: 1,
  pulled: 0,
  cursor: 4
});
```

- [ ] **Step 6: Run coordinator tests and verify RED**

Run: `node --test tests/cloud-sync-service.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 7: Implement single-flight push then pull**

`runOnce` reads credentials from local storage, exits cleanly when disabled, sends due mutations,
stores receipts, and pulls until `hasMore` is false or 500 changes have been applied in that trigger.
Always await transport promises; do not leave floating work.

```js
let inFlight = null;
function runOnce(reason) {
  if (inFlight) return inFlight;
  inFlight = performSync(reason).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function performSync(reason) {
  const credentials = await readEnabledCredentials(storageLocal);
  if (!credentials) return { skipped: 'disabled', reason };
  const transport = transportFactory(credentials);
  const due = await repository.listDueSyncMutations({
    vaultId: credentials.vaultId,
    now: now(),
    limit: 100
  });
  const pushResult = due.length ? await transport.push({
    deviceId: credentials.deviceId,
    mutations: due
  }) : { results: [] };
  await applyPushReceipts(repository, due, pushResult.results, { now, random });
  return pullBoundedPages(repository, transport, credentials, 500);
}
```

- [ ] **Step 8: Write failing bootstrap and initial-upload tests**

Prove:

- Importing a key bootstraps pages and then pulls from the returned snapshot cursor.
- Creating a new vault queues one mutation for each currently present allowlisted setting.
- Existing local history scans in bounded pages and resumes from `sync_meta`.
- Duplicate migration runs do not create duplicate mutation IDs for the same record revision.
- A record not successfully uploaded is never marked migration-complete.

```js
const firstPage = await service.enqueueInitialHistory();
assert.deepEqual(firstPage, {
  scanned: 50,
  queued: 50,
  done: false
});
const savedProgress = await repository.getSyncMeta('initialUploadState:vault-a');
assert.deepEqual(savedProgress.cursor, {
  submittedAt: 1721000000000,
  id: 'batch-page-1:49'
});

const rerun = await service.enqueueInitialHistory();
assert.equal(rerun.queued, 0);
assert.equal(new Set(repository.outbox.map(({ mutationId }) => mutationId)).size, 50);

await service.createVault();
assert.deepEqual(
  repository.outbox
    .filter(({ entityType }) => entityType === 'setting')
    .map(({ entityId }) => entityId)
    .sort(),
  ['batch_concurrency', 'promotion_website_url']
);
```

- [ ] **Step 9: Implement resumable bootstrap and initial upload**

Derive deterministic migration mutation IDs from the record ID plus revision ID with SHA-256. Store
only migration progress, not the entire history set, in `sync_meta`. On first vault creation, read
the setting adapter once and queue exactly the present allowlisted values.

```js
const page = await repository.scanRecordsForInitialSync({
  cursor: migrationState.cursor,
  limit: 50
});
for (const record of page.records) {
  const revisionId = normalizeCommentRevision(record.comment).id;
  const mutationId = await hashSyncSecret(
    `initial-comment:${credentials.vaultId}:${record.comment.id}:${revisionId}`
  );
  await repository.enqueueSyncMutation(buildInitialCommentMutation(
    record,
    mutationId,
    now()
  ));
}
await repository.setSyncMeta(`initialUploadState:${credentials.vaultId}`, {
  cursor: page.cursor,
  done: page.done
});
```

- [ ] **Step 10: Run focused and full extension tests**

Run:

```bash
node --test tests/cloud-sync-service.test.mjs tests/comment-history-service.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add lib/cloud-sync-service.mjs lib/comment-history-service.mjs tests/cloud-sync-service.test.mjs tests/comment-history-service.test.mjs
git commit -m "feat: coordinate local first cloud sync"
```

---

### Task 12: Background Wiring and Options-Page Sync Controls

**Files:**
- Create: `lib/cloud-sync-message-listener.mjs`
- Create: `lib/cloud-sync-background.mjs`
- Create: `lib/cloud-sync-batch-status.mjs`
- Create: `tests/cloud-sync-message-listener.test.mjs`
- Create: `tests/cloud-sync-background.test.mjs`
- Modify: `background.js:1-99`
- Modify: `background.js:139-220`
- Modify: `batch.html`
- Modify: `batch.js`
- Modify: `options.html:1-520`
- Modify: `options.js`
- Create: `lib/cloud-sync-options-controller.mjs`
- Create: `tests/cloud-sync-options-controller.test.mjs`
- Create: `tests/cloud-sync-batch-status.test.mjs`

**Interfaces:**
- Adds message types `CLOUD_SYNC_STATUS`, `CLOUD_SYNC_CREATE`, `CLOUD_SYNC_IMPORT`,
  `CLOUD_SYNC_RUN`, `CLOUD_SYNC_SHOW_KEY`, `CLOUD_SYNC_DISCONNECT`, `CLOUD_SYNC_DELETE_VAULT`,
  `CLOUD_HISTORY_LIST`, and `CLOUD_HISTORY_DELETE`.
- Installs alarm name `cloud-sync-check` with `periodInMinutes: 5`.
- Produces `installCloudSyncBackground(chromeApi, syncService, dependencies)`.
- Produces `renderCloudQueueStatus(result, elements)` for the batch-page warning.
- Propagates `cloudQueueStatus` through `BATCH_CONFIRMED` without making it part of
  `isDurableBatchConfirmation`.
- Options controller consumes only `chrome.runtime.sendMessage`; it never reads the cleartext secret
  except for explicit create/import/copy user actions.

- [ ] **Step 1: Write failing message routing and sender tests**

Assert known options/history messages call the matching service method, unknown messages are
ignored, content-script senders cannot request secret display or destructive operations, and every
async branch sends one response.

```js
const chromeApi = createChromeMessageFixture();
installCloudSyncMessageListener(chromeApi, {
  async getStatus() {
    return { state: 'idle', pendingCount: 0 };
  },
  async getCredentialsForDisplay() {
    return { syncKey: VALID_SYNC_KEY };
  }
});
assert.deepEqual(await chromeApi.dispatch(
  { type: 'CLOUD_SYNC_STATUS' },
  { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' }
), {
  ok: true,
  data: { state: 'idle', pendingCount: 0 }
});
assert.deepEqual(await chromeApi.dispatch(
  { type: 'CLOUD_SYNC_SHOW_KEY' },
  { id: 'extension-id', url: 'https://target.test/post' }
), {
  ok: false,
  error: {
    code: 'PRIVILEGED_SENDER_REQUIRED',
    message: '该操作只能从扩展页面发起。',
    retryable: false
  }
});
```

- [ ] **Step 2: Run listener tests and verify RED**

Run: `node --test tests/cloud-sync-message-listener.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the background-only message boundary**

Allow privileged calls only when `sender.id === chrome.runtime.id` and `sender.url` begins with
`chrome.runtime.getURL('')`. Return safe `{ ok, data }` or
`{ ok: false, error: { code, message, retryable } }` envelopes.

```js
chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!CLOUD_SYNC_MESSAGE_TYPES.has(message?.type)) return false;
  if (
    sender.id !== chromeApi.runtime.id
    || typeof sender.url !== 'string'
    || !sender.url.startsWith(chromeApi.runtime.getURL(''))
  ) {
    sendResponse(privilegedSenderError());
    return false;
  }
  routeCloudSyncMessage(message, service)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: publicSyncError(error) }));
  return true;
});
```

- [ ] **Step 4: Write failing startup/alarm integration tests**

Using a Chrome API fixture, assert one five-minute alarm, startup password migration, deferred
initial history upload, and one `runOnce` for the matching alarm. Assert comment confirmation
returns before a pending sync promise resolves.

```js
await installCloudSyncBackground(chromeApi, syncService, {
  migratePassword: async () => ({ status: 'migrated' })
});
assert.deepEqual(chromeApi.createdAlarms, [{
  name: 'cloud-sync-check',
  info: { periodInMinutes: 5 }
}]);
await chromeApi.triggerAlarm('cloud-sync-check');
assert.deepEqual(syncService.runReasons, ['startup', 'alarm']);
```

Add `tests/cloud-sync-batch-status.test.mjs` proving `cloudQueueStatus: 'failed'` renders
“评论已保存，尚未进入云同步队列”, while `queued` and `synced` never change the existing durable local
history result.

```js
renderCloudQueueStatus({
  result: 'success',
  historySaveStatus: 'saved',
  cloudQueueStatus: 'failed'
}, elements);
assert.equal(
  elements.cloudSyncBatchWarning.textContent,
  '评论已保存，尚未进入云同步队列。'
);
assert.equal(elements.cloudSyncBatchWarning.hidden, false);
```

- [ ] **Step 5: Wire repository methods and the coordinator in `background.js`**

Add all Task 2 methods to the existing lazy repository façade. Start migration and sync in guarded
async startup blocks with safe warnings. Pass no cleartext sync key to any content script or batch
message.

```js
const cloudSync = createCloudSyncService({
  repository: commentHistoryRepository,
  storageLocal: chrome.storage.local,
  settings: createCloudSyncSettings(chrome.storage),
  transportFactory: ({ syncKey }) => createCloudSyncTransport({
    baseUrl: CLOUD_SYNC_API_BASE_URL,
    syncKey,
    fetchImpl: fetch
  })
});
installCloudSyncMessageListener(chrome, cloudSync);
installCloudSyncBackground(chrome, cloudSync, {
  migratePassword: () => migratePasswordToLocal(chrome.storage)
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  cloudSync.enqueueSettingChanges(changes, areaName)
    .then(() => cloudSync.runOnce('setting_change'))
    .catch(() => console.warn('[background] Cloud setting sync deferred'));
});
```

In the existing `BATCH_HANDLE_CONFIRM` branch, destructure `cloudQueueStatus` from
`saveConfirmedSuccess`, include it in `BATCH_CONFIRMED` and the direct response, and leave
`isDurableBatchConfirmation` unchanged so only local history durability controls tab release.

- [ ] **Step 6: Write failing options-controller tests**

Cover create, import, invalid key, copy-on-explicit-click, immediate sync, disconnect, vault-delete
confirmation mismatch, status rendering, and disabled buttons during in-flight operations.

```js
const controller = createCloudSyncOptionsController({
  elements,
  sendMessage: async (message) => {
    if (message.type === 'CLOUD_SYNC_STATUS') {
      return {
        ok: true,
        data: {
          state: 'idle',
          pendingCount: 2,
          deviceId: 'device-a',
          lastSuccessfulSyncAt: 1721000000000
        }
      };
    }
    throw new Error(`unexpected:${message.type}`);
  },
  clipboard: { writeText: async () => undefined }
});
await controller.refresh();
assert.equal(elements.cloudSyncPendingCount.textContent, '2');
assert.equal(elements.cloudSyncDeviceId.textContent, 'device-a');
```

- [ ] **Step 7: Add the Cloudflare sync section to options UI**

Use IDs:

```text
cloudSyncCreateBtn
cloudSyncImportInput
cloudSyncImportBtn
cloudSyncCopyBtn
cloudSyncRunBtn
cloudSyncDisconnectBtn
cloudSyncDeleteBtn
cloudSyncStatus
cloudSyncLastSuccess
cloudSyncPendingCount
cloudSyncDeviceId
```

The delete dialog requires the user to type the visible vault ID. The copy button requests the key
only at click time and clears the in-memory returned string after the clipboard promise settles.

```html
<section id="cloudSyncSection" aria-labelledby="cloudSyncHeading">
  <h2 id="cloudSyncHeading">Cloudflare 云同步</h2>
  <div id="cloudSyncStatus" role="status" aria-live="polite">未启用</div>
  <input id="cloudSyncImportInput" type="password" autocomplete="off" />
  <button id="cloudSyncCreateBtn" type="button">创建同步密钥</button>
  <button id="cloudSyncImportBtn" type="button">导入同步密钥</button>
  <button id="cloudSyncCopyBtn" type="button">复制同步密钥</button>
  <button id="cloudSyncRunBtn" type="button">立即同步</button>
  <button id="cloudSyncDisconnectBtn" type="button">断开此设备</button>
  <button id="cloudSyncDeleteBtn" type="button">删除全部云端数据</button>
  <div>最后同步：<span id="cloudSyncLastSuccess">—</span></div>
  <div>等待上传：<span id="cloudSyncPendingCount">0</span></div>
  <div>设备 ID：<span id="cloudSyncDeviceId">—</span></div>
</section>
```

- [ ] **Step 8: Use only the fixed Worker origin**

Instantiate `createCloudSyncTransport` with `CLOUD_SYNC_API_BASE_URL` from Task 10. Assert the
background integration never reads an endpoint from user-controlled storage or a runtime message.

- [ ] **Step 9: Run UI/listener tests and full suite**

Run:

```bash
node --test tests/cloud-sync-message-listener.test.mjs tests/cloud-sync-background.test.mjs tests/cloud-sync-options-controller.test.mjs tests/cloud-sync-batch-status.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/cloud-sync-message-listener.mjs lib/cloud-sync-background.mjs lib/cloud-sync-batch-status.mjs lib/cloud-sync-options-controller.mjs tests/cloud-sync-message-listener.test.mjs tests/cloud-sync-background.test.mjs tests/cloud-sync-options-controller.test.mjs tests/cloud-sync-batch-status.test.mjs background.js batch.html batch.js options.html options.js
git commit -m "feat: add cloud sync extension controls"
```

---

### Task 13: Cloud-Aware History UI and 90-Day Synced Cache Eviction

**Files:**
- Create: `lib/cloud-history-data-source.mjs`
- Create: `lib/cloud-history-controller.mjs`
- Create: `tests/cloud-history-data-source.test.mjs`
- Modify: `history.html:338-476`
- Modify: `history.js:1-780`
- Modify: `tests/comment-history-page.test.mjs`
- Modify: `lib/comment-history-retention.mjs:67-136`
- Modify: `tests/comment-history-retention.test.mjs`

**Interfaces:**
- Produces `createCloudHistoryDataSource({ sendMessage, now })` with
  `list(filter, cursorState)`, `deleteEverywhere(recordId)`, and `status()`.
- Produces `createCloudHistoryController({ document, dataSource, confirmDelete })`.
- Retention installer receives `getCloudSyncStatus()` and
  `evictSyncedCacheBefore({ vaultId, cutoff })`.

- [ ] **Step 1: Write failing data-source selection tests**

Assert:

- Sync disabled uses `HISTORY_LIST`.
- Sync enabled and a recent unfiltered first page uses local history.
- Exhausting local recent pages switches to cloud with `to = cutoff - 1`.
- A date range crossing the 90-day cutoff uses cloud for the whole query.
- Domain or anchor search uses cloud when online so old matches are included.
- Offline cloud-required queries return a stable availability error without discarding current rows.

```js
const source = createCloudHistoryDataSource({
  sendMessage: async (message) => {
    sent.push(message);
    return {
      ok: true,
      data: { records: [], nextCursor: null, hasMore: false }
    };
  },
  now: () => Date.UTC(2026, 6, 25)
});
await source.list({
  targetDomain: 'target.test',
  limit: 50,
  syncEnabled: true,
  online: true
}, null);
assert.equal(sent[0].type, 'CLOUD_HISTORY_LIST');

await source.list({
  limit: 50,
  syncEnabled: false,
  online: true
}, null);
assert.equal(sent[1].type, 'HISTORY_LIST');
```

- [ ] **Step 2: Run data-source tests and verify RED**

Run: `node --test tests/cloud-history-data-source.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic local/cloud pagination**

Maintain source-specific cursors in one state object:

```js
{
  phase: 'local' | 'cloud',
  localCursor: null,
  cloudCursor: null,
  cutoff: 0
}
```

Never merge two unstable pages. Finish the local recent phase before requesting cloud rows older
than the fixed page-session cutoff.

```js
async function list(filter, cursorState) {
  const state = cursorState ?? {
    phase: shouldStartInCloud(filter) ? 'cloud' : 'local',
    localCursor: null,
    cloudCursor: null,
    cutoff: now() - 90 * DAY_MS
  };
  if (state.phase === 'cloud') {
    return sendMessage(buildCloudHistoryRequest(filter, state.cloudCursor));
  }
  const local = await sendMessage(buildLocalHistoryRequest(
    { ...filter, from: Math.max(filter.from ?? state.cutoff, state.cutoff) },
    state.localCursor
  ));
  return local.data.nextCursor
    ? local
    : withNextPhase(local, { ...state, phase: 'cloud' });
}
```

- [ ] **Step 4: Write failing permanent-delete UI tests**

Render a cloud-synced row, click “从所有设备永久删除”, cancel once, confirm once, and assert the row
remains until `CLOUD_HISTORY_DELETE` returns success. Assert failure leaves the row and displays a
safe error.

```js
const controller = createCloudHistoryController({
  document,
  dataSource: {
    async deleteEverywhere() {
      return { status: 'applied' };
    }
  },
  confirmDelete: async () => true
});
controller.renderRecords([{
  comment: {
    id: 'batch-a:1',
    submittedAt: 1721000000000,
    targetPageUrl: 'https://target.test/post',
    promotedWebsiteUrl: 'https://promo.test',
    commentText: 'exact body',
    commentHtml: '<a href="https://promo.test">exact body</a>',
    source: 'live'
  },
  anchors: [],
  storageSource: 'cloud'
}]);
await controller.deleteEverywhere('batch-a:1');
assert.equal(document.querySelector('[data-record-id="batch-a:1"]'), null);
```

- [ ] **Step 5: Update history HTML and controller**

Change the local-only subtitle, add cloud/offline status, add a source badge per row, and add the
permanent-delete button only when cloud sync is enabled. Continue assigning saved comment HTML with
`textContent`, never `innerHTML`.

```js
const storedHtml = document.createElement('pre');
storedHtml.className = 'stored-html';
storedHtml.textContent = record.comment.commentHtml;
detailContent.appendChild(storedHtml);

if (record.storageSource === 'cloud' && syncStatus.enabled) {
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn-danger';
  deleteButton.dataset.recordId = record.comment.id;
  deleteButton.textContent = '从所有设备永久删除';
  actions.appendChild(deleteButton);
}
```

- [ ] **Step 6: Write failing retention-mode tests**

For sync disabled, preserve the daily reminder and zero automatic deletes. For sync enabled, assert
the check invokes:

```js
await service.evictSyncedCacheBefore({
  vaultId: 'vault-a',
  cutoff: now - 90 * DAY_MS
});
```

and does not send the export-before-delete notification. Include pending, mismatched revision, and
needs-attention records and assert they remain.

```js
const retention = installCommentHistoryRetention(chromeApi, {
  async getCloudSyncStatus() {
    return { enabled: true, vaultId: 'vault-a' };
  },
  async evictSyncedCacheBefore({ vaultId, cutoff }) {
    assert.equal(vaultId, 'vault-a');
    assert.equal(cutoff, NOW - 90 * DAY_MS);
    return 2;
  },
  async getRetentionStatus() {
    throw new Error('local reminder path must not run');
  }
}, {
  now: () => NOW,
  startImmediately: false
});
assert.deepEqual(await retention.checkNow(), {
  mode: 'synced_cache',
  evicted: 2
});
assert.equal(chromeApi.createdNotifications.length, 0);
```

- [ ] **Step 7: Implement synced-cache retention mode**

Keep the existing alarm name and schedule. Branch by cloud status inside the check: synced mode
evicts only repository-approved rows; local mode keeps the current reminder behavior. Report
eviction count to history summary without creating tombstones.

```js
async function runRetentionCheck() {
  const cloud = await service.getCloudSyncStatus();
  if (cloud.enabled) {
    const evicted = await service.evictSyncedCacheBefore({
      vaultId: cloud.vaultId,
      cutoff: now() - EXPIRY_DAY * DAY_MS
    });
    return { mode: 'synced_cache', evicted };
  }
  return runLocalReminderCheck();
}
```

- [ ] **Step 8: Run history/retention tests and full suite**

Run:

```bash
node --test tests/cloud-history-data-source.test.mjs tests/comment-history-page.test.mjs tests/comment-history-retention.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/cloud-history-data-source.mjs lib/cloud-history-controller.mjs tests/cloud-history-data-source.test.mjs history.html history.js tests/comment-history-page.test.mjs lib/comment-history-retention.mjs tests/comment-history-retention.test.mjs
git commit -m "feat: add cloud aware history browsing"
```

---

### Task 14: Privacy Disclosure, Documentation, and End-to-End Verification

**Files:**
- Modify: `index.html:60-220`
- Modify: `index.html:245-319`
- Modify: `tests/privacy-policy.test.js`
- Create: `cloudflare-sync/README.md`
- Modify: `package.json`

**Interfaces:**
- Produces documented commands `test:sync-worker`, `typecheck:sync-worker`, and
  `verify:cloud-sync`.
- Verifies the fixed production Worker URL from Task 10 through the complete extension flow.

- [ ] **Step 1: Write failing bilingual privacy-policy tests**

Assert English and Chinese policy text discloses:

- Opt-in Cloudflare/D1 storage of exact submitted comment data and allowlisted settings.
- Sync key behavior and the consequence of sharing it.
- Cloud long-term retention and explicit all-device deletion.
- Local 90-day cache eviction only after cloud confirmation.
- Password and AI API Key remain local and are excluded from cloud sync.
- Uninstalling one device does not delete the cloud vault.

Replace assertions that claim successful-comment history always stays only on the current device.

```js
test('English policy discloses opt-in Cloudflare synchronization', () => {
  assert.match(policy, /Cloudflare D1/);
  assert.match(policy, /optional cloud synchronization/i);
  assert.match(policy, /sync key/i);
  assert.match(policy, /90-day local cache/i);
  assert.match(policy, /permanently delete.*all devices/i);
  assert.match(policy, /AI API key.*not uploaded/i);
  assert.match(policy, /password.*not uploaded/i);
  assert.match(policy, /uninstalling.*does not delete.*cloud/i);
});

test('Chinese policy discloses opt-in Cloudflare synchronization', () => {
  assert.match(policy, /Cloudflare D1/);
  assert.match(policy, /可选.*云同步/);
  assert.match(policy, /同步密钥/);
  assert.match(policy, /本地.*90 天.*缓存/);
  assert.match(policy, /从所有设备永久删除/);
  assert.match(policy, /API Key.*不会上传/);
  assert.match(policy, /密码.*不会上传/);
  assert.match(policy, /卸载.*不会删除云端/);
});
```

- [ ] **Step 2: Run privacy tests and verify RED**

Run: `node --test tests/privacy-policy.test.js`

Expected: FAIL because the policy still says history never leaves the device.

- [ ] **Step 3: Update the complete English and Chinese disclosure**

Set the last-updated date to `2026-07-25`. Describe Cloudflare as the storage/processing provider
without claiming guarantees beyond the implemented retention and deletion behavior.

```html
<p>
  Cloud synchronization is optional. When enabled, the extension sends successful-comment history
  and the listed non-sensitive settings to the AutoComment Cloudflare Worker for storage in
  Cloudflare D1. The AI API key, form password, cookies, and temporary batch data are not uploaded.
</p>
<p>
  Cloud history is retained until you permanently delete individual records or the cloud vault.
  After cloud confirmation, this device may evict local cached records older than 90 days.
</p>
```

Add an equivalent Chinese disclosure in the Chinese section and preserve the existing detailed list
of exact comment-history fields.

- [ ] **Step 4: Run local verification before final documentation**

Run:

```bash
npm test
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
npm --prefix cloudflare-sync run deploy:dry
```

Expected: all commands exit 0.

- [ ] **Step 5: Retrieve current Worker references for final review**

Run:

```bash
npm --prefix cloudflare-sync run types
mkdir -p /tmp/auto-comment-workers-types
npm pack @cloudflare/workers-types --pack-destination /tmp/auto-comment-workers-types
```

Expected: binding types regenerate successfully. Inspect the latest Workers best practices and
generated binding types before final Worker review.

- [ ] **Step 6: Configure the exact installed extension origin**

Load the unpacked extension once in Chrome, copy its exact extension ID from `chrome://extensions`,
and validate the copied value:

```bash
read -r "AUTO_COMMENT_EXTENSION_ID?Paste the extension ID: "
[[ "$AUTO_COMMENT_EXTENSION_ID" =~ ^[a-p]{32}$ ]]
```

Use `apply_patch` to replace the test origin in the non-secret `vars` section of
`cloudflare-sync/wrangler.jsonc` with `chrome-extension://` followed by that validated ID. Run
`npm --prefix cloudflare-sync exec wrangler -- deploy` again, then verify an OPTIONS request from
any other origin is rejected.

- [ ] **Step 7: Add root verification scripts and deployment README**

Set root scripts:

```json
{
  "test:sync-worker": "npm --prefix cloudflare-sync test",
  "typecheck:sync-worker": "npm --prefix cloudflare-sync run typecheck",
  "verify:cloud-sync": "npm test && npm run test:sync-worker && npm run typecheck:sync-worker && npm --prefix cloudflare-sync run deploy:dry"
}
```

Document local migrations, tests, deployment, key-loss consequences, key rotation limitation,
rollback, and the two-profile smoke procedure.

- [ ] **Step 8: Bump the extension version and run final automated verification**

Change `manifest.json` version from `1.5.3` to `1.6.0`.

Run:

```bash
npm run verify:cloud-sync
git diff --check
```

Expected: all commands exit 0 with no warnings caused by project code.

- [ ] **Step 9: Perform the two-profile browser smoke test**

Use two isolated Chrome profiles:

1. Profile A creates a vault and uploads an existing comment.
2. Profile B imports the key and receives the recent record and allowlisted settings.
3. Disconnect A, create another local comment, reconnect, and verify B receives it.
4. Delete the first record everywhere from B and verify A removes it after sync.
5. Confirm both profiles retain their own AI API Key and password values without cloud transfer.

Record the observed Worker request IDs and success timestamps in the implementation handoff, not in
the repository.

- [ ] **Step 10: Commit**

```bash
git add index.html tests/privacy-policy.test.js cloudflare-sync/README.md cloudflare-sync/wrangler.jsonc manifest.json package.json package-lock.json
git commit -m "docs: disclose and verify cloud sync"
```

---

## Final Verification Checklist

- [ ] Every new production behavior was preceded by a focused failing test with the expected failure.
- [ ] `npm test` passes.
- [ ] `npm --prefix cloudflare-sync test` passes inside the Workers runtime with local D1.
- [ ] `npm --prefix cloudflare-sync run typecheck` passes with generated bindings.
- [ ] `npm --prefix cloudflare-sync run deploy:dry` passes.
- [ ] `git diff --check` passes.
- [ ] No source, test fixture, log, request error, or committed config contains a real sync secret,
      AI API Key, Cloudflare credential, or form password.
- [ ] A failed Worker request cannot delay or fail durable local comment confirmation.
- [ ] Replayed mutations do not create duplicate comments, anchors, settings, changes, or tombstones.
- [ ] A stale offline comment cannot revive a tombstoned record.
- [ ] Local cache eviction skips every record lacking an exact cloud-confirmed revision.
- [ ] The English and Chinese privacy disclosures match the shipped behavior.
- [ ] The production Worker origin is fixed in the manifest and transport configuration.
- [ ] The user-owned `.DS_Store` change remains unstaged and unmodified.
