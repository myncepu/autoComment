# Multi-Identity Promotion Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build safe, deterministic multi-Profile and multi-Promotion-Site batch assignment so concurrent Chrome workers use the correct frozen identity/site combination without password leakage or cross-task state.

**Architecture:** Add a local-only versioned domain configuration and secret repository, compile CSV rows into one immutable deterministic `BatchPlan`, and let the background own checkpoint v3 plus a separate batch secret vault. Extend the existing Cloudflare sync branch with versioned non-sensitive domain entities, then integrate the operations-console branch through its controller/view boundaries instead of duplicating its UI.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript ES modules plus classic content-script helpers, `chrome.storage.local`, Chrome runtime/windows/power APIs, IndexedDB, Cloudflare Workers and D1, TypeScript, vendored Papa Parse, Node.js `>=18`, `node:test`, `jsdom`, `fake-indexeddb`, local HTTP and OpenAI-compatible fixtures.

## Global Constraints

- Work only on branch `codex/multi-identity-promotion-batch` in `/Users/moltbot/.codex/worktrees/b6e7/autoComment`; preserve unrelated user and task changes.
- The Cloudflare baseline is the committed `codex/cloudflare-comment-sync` branch; never copy or stage its worktree-local changes to `cloudflare-sync/README.md`, `cloudflare-sync/worker-configuration.d.ts`, or `cloudflare-sync/wrangler.jsonc`.
- The UI baseline is the committed `codex/batch-operations-console` branch; preserve its desktop-console structure and do not build a duplicate temporary UI.
- Use TDD for every production behavior: focused failing test, observed expected failure, minimal implementation, focused green test, affected-suite regression, small commit.
- One Chrome profile still runs at most one active batch.
- Batch concurrency remains `1–10`, default `3`.
- Default quotas are batch `100`, each Profile `50`, each Promotion Site `50`, and each target domain `3`.
- A task receives exactly one frozen `profileId + promotionSiteId` assignment before any worker window opens.
- Smooth weighted assignment is deterministic in CSV row order and never depends on worker completion order.
- `BATCH_HANDLE` contains only the current task’s non-sensitive snapshot.
- Passwords exist only in `chrome.storage.local` Profile/batch secret stores and function-local content-script variables.
- Passwords never enter `chrome.storage.sync`, D1, domain config, checkpoint, URL queue, submit context, results, history, exports, logs, committed fixtures, or public errors.
- Same-batch canonical URL duplicates are never overridable; a 24-hour prior-success block requires a row-level override plus second confirmation.
- Automatic retry occurs at most once and only for allowlisted pre-submit transient failures with no submit context.
- `submitting`, uncertain, manual, illegal, quota, duplicate, recent-success, and user-closed tasks never auto-retry.
- Long-term comment history contains only confirmed successes.
- Background remains the only writer of `batchRuntimeCheckpoint`.
- Checkpoint v3 includes the operations-console v2 attempt/phase/manual fields plus Assignment snapshots; support v1→v3 and v2→v3 migrations.
- Real Chrome acceptance uses 3 concurrent windows, 2 Profiles, 2 Promotion Sites, 5 local fixture URLs, and no third-party submissions.

## File Structure

### New domain and batch-core files

- `lib/domain-config-schema.mjs` — strict Profile/Site/Pair/Policy schemas, normalization, redaction, revisions.
- `lib/domain-config-repository.mjs` — `chrome.storage.local` authoritative config CRUD.
- `lib/profile-secret-repository.mjs` — local-only Profile password CRUD and configured-state queries.
- `lib/domain-config-migration.mjs` — idempotent legacy flat-setting and password migration.
- `lib/domain-config-import-export.mjs` — non-sensitive export, import preview, stable-ID merge.
- `lib/batch-csv-import.mjs` — Papa Parse adapter, column mapping, references, template.
- `lib/batch-plan-compiler.mjs` — URL safety, duplicate/recent-success checks, weighted assignment, quotas.
- `lib/batch-plan-confirmation.mjs` — canonical fingerprint and normal/high-risk confirmation tokens.
- `lib/batch-secret-vault.mjs` — per-batch password snapshot, authorization, cleanup.
- `lib/batch-task-config.js` — classic content-script task context and task-scoped cache helper.
- `lib/batch-result-record.mjs` — stable result schema, skip reasons, result CSV columns.

### Existing extension files to modify

- `background.js`
- `batch.js`
- `content.js`
- `manifest.json`
- `options.html`
- `options.js`
- `history.html`
- `history.js`
- `lib/batch-runtime-checkpoint.mjs`
- `lib/batch-runtime-controller.mjs`
- `lib/batch-submit-context-store.mjs`
- `lib/batch-submit-context-client.js`
- `lib/comment-history-capture.js`
- `lib/comment-history-record.mjs`
- `lib/comment-history-db.mjs`
- `lib/comment-history-service.mjs`
- `lib/comment-history-message-listener.mjs`
- `lib/comment-history-csv.mjs`
- Cloud sync extension modules created by `codex/cloudflare-comment-sync`.

### Cloudflare Worker files to modify

- `cloudflare-sync/migrations/0002_domain_config_entities.sql`
- `cloudflare-sync/src/index.ts`
- `cloudflare-sync/src/validation.ts`
- `cloudflare-sync/src/push.ts`
- `cloudflare-sync/src/pull.ts`
- `cloudflare-sync/src/history.ts`
- `cloudflare-sync/src/vault.ts`
- Worker test files under `cloudflare-sync/test/`.

### New tests

- `tests/domain-config-schema.test.mjs`
- `tests/domain-config-repository.test.mjs`
- `tests/profile-secret-repository.test.mjs`
- `tests/domain-config-migration.test.mjs`
- `tests/domain-config-import-export.test.mjs`
- `tests/batch-csv-import.test.mjs`
- `tests/batch-plan-compiler.test.mjs`
- `tests/batch-plan-confirmation.test.mjs`
- `tests/batch-secret-vault.test.mjs`
- `tests/batch-task-config.test.js`
- `tests/batch-result-record.test.mjs`
- `tests/batch-multi-assignment-integration.test.js`
- `tests/domain-config-options-controller.test.mjs`
- `tests/multi-identity-privacy.test.mjs`

---

### Task 1: Integrate the Committed Cloudflare Baseline

**Files:**
- Merge committed branch: `codex/cloudflare-comment-sync`
- Verify: extension and `cloudflare-sync/` test suites

**Interfaces:**
- Consumes: Cloud sync outbox, transport, service, protocol, options controller, D1 migration `0001_initial.sql`.
- Produces: one branch containing the approved design commits and the committed Cloudflare implementation without copying its dirty worktree files.

- [ ] **Step 1: Record clean pre-merge baselines**

```bash
git status --short
npm ci
npm test
npm --prefix cloudflare-sync ci
npm --prefix cloudflare-sync test
```

Expected: the current extension suite passes; `cloudflare-sync/` is absent before merge, so the final two commands fail only because the directory does not exist.

- [ ] **Step 2: Verify the committed Cloudflare branch and exclude worktree-local files**

```bash
git merge-base --is-ancestor f7c016c codex/cloudflare-comment-sync
git -C /Users/moltbot/Code/autoComment/.worktrees/cloudflare-comment-sync status --short
```

Expected: the ancestry command exits 0. The status output may show the three known local files, but those contents are not read, staged, copied, or committed here.

- [ ] **Step 3: Merge only the committed branch**

```bash
git merge --no-ff codex/cloudflare-comment-sync -m "merge: integrate cloudflare comment sync baseline"
```

Expected: merge succeeds without taking uncommitted files from the Cloudflare worktree.

- [ ] **Step 4: Run both complete baselines**

```bash
npm ci
npm test
npm --prefix cloudflare-sync ci
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
```

Expected: all commands pass.

- [ ] **Step 5: Record the integration state**

```bash
git status --short
git log -1 --oneline
```

Expected: clean status and the merge commit at HEAD.

### Task 2: Define Strict Domain Configuration Schemas

**Files:**
- Create: `lib/domain-config-schema.mjs`
- Test: `tests/domain-config-schema.test.mjs`

**Interfaces:**
- Produces: `DOMAIN_CONFIG_KEY`, `DOMAIN_CONFIG_VERSION`, `DEFAULT_QUOTAS`.
- Produces: `createDefaultDomainConfig(legacy, { now }) -> DomainConfig`.
- Produces: `normalizeDomainConfig(value) -> DomainConfig`.
- Produces: `validateDomainConfig(value) -> { ok, value?, error? }`.
- Produces: `assertNoSensitiveFields(value)`.

- [ ] **Step 1: Write failing schema tests**

```js
test('normalizes valid profiles, sites, pairs, default pair, and quotas', () => {
  const config = normalizeDomainConfig(validConfig());
  assert.equal(config.version, 2);
  assert.deepEqual(config.assignmentPolicy.quotas, {
    batch: 100,
    perProfile: 50,
    perPromotionSite: 50,
    perTargetDomain: 3
  });
});

test('rejects duplicate names, dangling pairs, disabled defaults, and secrets', () => {
  assert.equal(validateDomainConfig(duplicateDisplayNames()).error, 'duplicate_profile_display_name');
  assert.equal(validateDomainConfig(danglingPair()).error, 'invalid_assignment_pair');
  assert.throws(() => assertNoSensitiveFields({ nested: { password: 'x' } }),
    /sensitive_field_forbidden/);
});
```

- [ ] **Step 2: Run the test and observe the missing module**

Run: `node --test tests/domain-config-schema.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact schemas and defaults**

```js
export const DOMAIN_CONFIG_KEY = 'autoCommentDomainConfig';
export const DOMAIN_CONFIG_VERSION = 2;
export const DEFAULT_QUOTAS = Object.freeze({
  batch: 100,
  perProfile: 50,
  perPromotionSite: 50,
  perTargetDomain: 3
});

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw codedError(code);
  }
}

export function validateDomainConfig(value) {
  try {
    exactKeys(value, ['version', 'revision', 'profiles', 'promotionSites', 'assignmentPolicy'],
      'invalid_domain_config');
    const normalized = normalizeDomainConfig(value);
    validateUniqueProfiles(normalized.profiles);
    validateUniqueSites(normalized.promotionSites);
    validatePolicy(normalized);
    assertNoSensitiveFields(normalized);
    return { ok: true, value: structuredClone(normalized) };
  } catch (error) {
    return { ok: false, error: error.code || 'invalid_domain_config' };
  }
}
```

Top-level exact keys are `version/revision/profiles/promotionSites/assignmentPolicy`; a new default
config starts at `revision: 0`, and every successful repository write increments it once. Implement
the private `normalizeDomainConfig`, `validateUniqueProfiles`, `validateUniqueSites`, and
`validatePolicy` in the same file using the exact entity keys and stable error codes asserted above.
Profile exact keys `id/displayName/name/email/createdAt/updatedAt`, Site exact keys
`id/name/url/content/enabled/createdAt/updatedAt`, Pair exact keys
`id/profileId/promotionSiteId/weight/enabled`, and Policy exact keys
`defaultPairId/pairs/quotas`. Weight range is `1–100`; all quotas are positive integers.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/domain-config-schema.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain-config-schema.mjs tests/domain-config-schema.test.mjs
git commit -m "feat: define multi profile domain config"
```

### Task 3: Add the Authoritative Config and Profile Secret Repositories

**Files:**
- Create: `lib/domain-config-repository.mjs`
- Create: `lib/profile-secret-repository.mjs`
- Test: `tests/domain-config-repository.test.mjs`
- Test: `tests/profile-secret-repository.test.mjs`

**Interfaces:**
- Consumes: Task 2 schema exports.
- Produces: `createDomainConfigRepository(storageArea, options)`.
- Produces repository methods: `load`, `replace`, `saveProfile`, `deleteProfile`, `savePromotionSite`, `deletePromotionSite`, `saveAssignmentPolicy`.
- Produces: `createProfileSecretRepository(storageArea)` with `setPassword`, `clearPassword`, `getPasswordForBackground`, `getConfiguredStates`.

- [ ] **Step 1: Write failing repository tests**

```js
test('serializes concurrent config writes and increments revision', async () => {
  const repository = createDomainConfigRepository(storageArea());
  await Promise.all([
    repository.saveProfile(profileA()),
    repository.saveProfile(profileB())
  ]);
  const saved = await repository.load();
  assert.deepEqual(saved.profiles.map((item) => item.id).sort(), ['profile-a', 'profile-b']);
  assert.equal(saved.revision, 2);
});

test('returns only configured booleans outside background password reads', async () => {
  const secrets = createProfileSecretRepository(storageArea());
  await secrets.setPassword('profile-a', runtimeSecret());
  assert.deepEqual(await secrets.getConfiguredStates(['profile-a', 'profile-b']), {
    'profile-a': true,
    'profile-b': false
  });
  assert.equal(Object.hasOwn(await secrets.getConfiguredStates(['profile-a']), 'password'), false);
});
```

- [ ] **Step 2: Run tests and observe missing modules**

Run: `node --test tests/domain-config-repository.test.mjs tests/profile-secret-repository.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement serialized config writes**

```js
export function createDomainConfigRepository(storageArea, { now = Date.now } = {}) {
  let operation = Promise.resolve();
  const enqueue = (work) => {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  };
  return {
    load,
    replace: (value) => enqueue(() => validateAndWrite(value)),
    saveProfile: (profile) => enqueue(() => updateProfile(profile, now())),
    savePromotionSite: (site) => enqueue(() => updateSite(site, now())),
    saveAssignmentPolicy: (policy) => enqueue(() => updatePolicy(policy, now())),
    deleteProfile: (profileId) => enqueue(() => removeProfile(profileId, now())),
    deletePromotionSite: (siteId) => enqueue(() => removeSite(siteId, now()))
  };
}
```

- [ ] **Step 4: Implement a separate secret store**

Use storage key `autoCommentProfileSecrets`, exact shape
`{ version: 1, passwordsByProfileId: {} }`. Trim Profile IDs but preserve password bytes exactly;
an empty input clears the Profile entry. `getPasswordForBackground` is exported only by this module
and never included in the domain repository.

- [ ] **Step 5: Run focused and privacy tests**

```bash
node --test tests/domain-config-repository.test.mjs tests/profile-secret-repository.test.mjs
node --test tests/cloud-sync-settings.test.mjs tests/privacy-policy.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-config-repository.mjs lib/profile-secret-repository.mjs tests/domain-config-repository.test.mjs tests/profile-secret-repository.test.mjs
git commit -m "feat: store profiles and local only passwords"
```

### Task 4: Migrate Legacy Global Settings Safely

**Files:**
- Create: `lib/domain-config-migration.mjs`
- Modify: `background.js`
- Modify: Cloud sync startup wiring from `lib/cloud-sync-background.mjs`
- Test: `tests/domain-config-migration.test.mjs`
- Modify test: `tests/cloud-sync-background.test.mjs`

**Interfaces:**
- Consumes: Task 3 repositories and Chrome `storage.sync/local`.
- Produces: `migrateLegacyDomainConfig({ storage, configRepository, secretRepository, now })`.
- Uses fixed IDs: `default-profile`, `default-promotion-site`, `default-assignment-pair`.

- [ ] **Step 1: Write failing ordered-migration tests**

```js
test('copies and verifies password before deleting both legacy copies', async () => {
  const harness = migrationHarness({
    sync: legacySettings({ auto_fill_user_password: runtimeSecret() }),
    local: { auto_fill_user_password: runtimeSecret() }
  });
  await migrateLegacyDomainConfig(harness.dependencies);
  assert.deepEqual(harness.calls.slice(-4).map(([name]) => name), [
    'profileSecrets.set',
    'profileSecrets.read',
    'local.remove',
    'sync.remove'
  ]);
  assert.equal(harness.local.domainConfigMigrationVersion, 2);
});

test('does not delete legacy password or mark complete after verification failure', async () => {
  const harness = migrationHarness({ failSecretReadback: true });
  await assert.rejects(() => migrateLegacyDomainConfig(harness.dependencies));
  assert.equal(harness.sync.auto_fill_user_password, harness.password);
  assert.equal(harness.local.domainConfigMigrationVersion, undefined);
});
```

- [ ] **Step 2: Run the migration test**

Run: `node --test tests/domain-config-migration.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement idempotent migration**

```js
export const DOMAIN_CONFIG_MIGRATION_VERSION_KEY = 'domainConfigMigrationVersion';

export async function migrateLegacyDomainConfig({
  storage,
  configRepository,
  secretRepository,
  now = Date.now
}) {
  const [syncValues, localValues, current] = await Promise.all([
    storage.sync.get(LEGACY_KEYS),
    storage.local.get([...LEGACY_KEYS, DOMAIN_CONFIG_MIGRATION_VERSION_KEY]),
    configRepository.load()
  ]);
  if (localValues[DOMAIN_CONFIG_MIGRATION_VERSION_KEY] === 2) {
    return { status: 'already_migrated' };
  }
  const mergedLegacy = { ...syncValues, ...localValues };
  await configRepository.replace(mergeFixedLegacyEntities(current, mergedLegacy, now()));
  const password = localValues.auto_fill_user_password ?? syncValues.auto_fill_user_password;
  if (password !== undefined) {
    await secretRepository.setPassword('default-profile', password);
    const copied = await secretRepository.getPasswordForBackground('default-profile');
    if (copied !== password) throw codedError('legacy_password_verification_failed');
    await storage.local.remove('auto_fill_user_password');
    await storage.sync.remove('auto_fill_user_password');
  }
  await storage.local.set({ [DOMAIN_CONFIG_MIGRATION_VERSION_KEY]: 2 });
  return { status: 'migrated' };
}
```

- [ ] **Step 4: Wire migration before cloud sync or batch recovery startup**

In `background.js`, await one shared migration promise before installing handlers that can start a
batch or enqueue setting mutations. Preserve Cloudflare’s existing `migratePasswordToLocal` call as
an input compatibility step, then let domain migration remove the legacy local key after the new
secret store verifies it.

- [ ] **Step 5: Run focused and background tests**

```bash
node --test tests/domain-config-migration.test.mjs tests/cloud-sync-background.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-config-migration.mjs background.js lib/cloud-sync-background.mjs tests/domain-config-migration.test.mjs tests/cloud-sync-background.test.mjs
git commit -m "feat: migrate legacy identity settings safely"
```

### Task 5: Implement Secure Config Import and Export

**Files:**
- Create: `lib/domain-config-import-export.mjs`
- Test: `tests/domain-config-import-export.test.mjs`

**Interfaces:**
- Consumes: Task 2 schema and Task 3 repositories.
- Produces: `buildDomainConfigExport(config, { exportedAt })`.
- Produces: `previewDomainConfigImport(current, input)`.
- Produces: `applyDomainConfigImport(preview, { configRepository, secretRepository })`.

- [ ] **Step 1: Write failing security and merge tests**

```js
test('exports only non-sensitive domain entities', () => {
  const exported = buildDomainConfigExport(validConfig(), { exportedAt: 10 });
  const json = JSON.stringify(exported);
  assert.doesNotMatch(json, /password|apiKey|cookie|token|checkpoint/i);
  assert.equal(exported.version, 2);
});

test('merges stable ids and preserves local passwords', async () => {
  const preview = previewDomainConfigImport(currentConfig(), importedConfig());
  await applyDomainConfigImport(preview, harness.repositories);
  assert.equal(await harness.secrets.getPasswordForBackground('profile-a'), harness.originalPassword);
});

test('accepts a legacy password only through the default-profile secret path', async () => {
  const preview = previewDomainConfigImport(currentConfig(), legacyExport(runtimeSecret()));
  await applyDomainConfigImport(preview, harness.repositories);
  assert.equal(preview.localSecretImport.profileId, 'default-profile');
  assert.equal(Object.hasOwn(preview.mergedConfig.profiles[0], 'password'), false);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/domain-config-import-export.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement export and preview**

```js
export function buildDomainConfigExport(config, { exportedAt = Date.now() } = {}) {
  assertNoSensitiveFields(config);
  return {
    format: 'autocomment-domain-config',
    version: 2,
    exportedAt,
    data: structuredClone(config)
  };
}
```

The preview reports `creates`, `updates`, `conflicts`, `mergedConfig`, and an optional
`localSecretImport`. Duplicate names, dangling pairs, invalid URLs, unknown fields, or a secret in
new-format data produce stable blocking errors.

- [ ] **Step 4: Implement apply ordering**

Write the local legacy password through `secretRepository` first, verify configured state, then write
the merged non-sensitive config. New-format imports never call `setPassword`.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/domain-config-import-export.test.mjs tests/profile-secret-repository.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-config-import-export.mjs tests/domain-config-import-export.test.mjs
git commit -m "feat: import and export domain config safely"
```

### Task 6: Parse CSV, Map Columns, Resolve Assignment References, and Build Templates

**Files:**
- Create: `lib/batch-csv-import.mjs`
- Test: `tests/batch-csv-import.test.mjs`

**Interfaces:**
- Consumes: vendored/global Papa Parse adapter and a validated DomainConfig.
- Produces: `decodeBatchCsv(arrayBuffer)`.
- Produces: `parseBatchCsv(text, parseCsv)`.
- Produces: `inferBatchColumnMapping(headers)`.
- Produces: `resolveBatchRows(parsed, mapping, config)`.
- Produces: `buildBatchCsvTemplate(config)`.

- [ ] **Step 1: Write failing parser and mapping tests**

```js
test('parses quoted newlines and maps old csv without assignments', () => {
  const parsed = parseBatchCsv('原URL,来源域名,备注\r\n"https://a.test/p",a.test,"line 1\\nline 2"', papa);
  assert.deepEqual(inferBatchColumnMapping(parsed.headers), {
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  });
});

test('resolves id then unique display values and rejects half assignments', () => {
  const rows = resolveBatchRows(parsedAssignments(), explicitMapping(), validConfig());
  assert.equal(rows[0].profileId, 'profile-a');
  assert.equal(rows[1].promotionSiteId, 'site-b');
  assert.throws(() => resolveBatchRows(halfAssigned(), explicitMapping(), validConfig()),
    /assignment_columns_must_both_be_filled/);
});

test('template contains ids but no pii or site description', () => {
  const template = buildBatchCsvTemplate(validConfig());
  assert.match(template.csv, /原URL,来源域名,profileId,promotionSiteId/);
  assert.doesNotMatch(JSON.stringify(template), /alice@example|site description|password/i);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/batch-csv-import.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement Papa parsing and inference**

```js
export function parseBatchCsv(text, parseCsv) {
  const result = parseCsv(text, { skipEmptyLines: 'greedy' });
  if (result.errors.length) throw codedError('csv_parse_failed');
  const [headers = [], ...rows] = result.data;
  return { headers: headers.map(normalizeHeader), rows };
}
```

Recognize old URL/source-domain names and canonical `profileId/promotionSiteId`. Preserve raw rows
and 1-based source row numbers.

- [ ] **Step 4: Implement strict reference resolution**

Resolve Profile by stable ID then unique exact display name. Resolve Site by stable ID, unique exact
name, then unique canonical URL. Require both assignment values or neither, require an enabled valid
Pair for explicit values, and return stable errors for ambiguity, disabled Site, missing entity, or
unapproved Pair.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/batch-csv-import.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-csv-import.mjs tests/batch-csv-import.test.mjs
git commit -m "feat: map csv rows to assignment references"
```

### Task 7: Compile Deterministic Batch Plans

**Files:**
- Create: `lib/batch-plan-compiler.mjs`
- Test: `tests/batch-plan-compiler.test.mjs`

**Interfaces:**
- Consumes: resolved rows from Task 6, validated config, local recent-success URLs, repeat overrides, illegal-site evaluator.
- Produces: `compileBatchPlan(input) -> BatchPlanDraft`.
- Produces: `summarizeBatchPlan(planDraft)`.
- Exports stable `BATCH_SKIP_REASONS`.

- [ ] **Step 1: Write failing deterministic assignment tests**

```js
test('smoothly assigns weighted atomic pairs in csv order', () => {
  const plan = compileBatchPlan(fiveRowInput({
    pairs: [pair('pair-a', 'profile-a', 'site-a', 3), pair('pair-b', 'profile-b', 'site-b', 1)]
  }));
  assert.deepEqual(plan.tasks.map((task) => task.assignmentPairId), [
    'pair-a', 'pair-a', 'pair-b', 'pair-a', 'pair-a'
  ]);
  assert.deepEqual(
    compileBatchPlan(fiveRowInput()).tasks.map(taskProjection),
    compileBatchPlan(fiveRowInput()).tasks.map(taskProjection)
  );
});
```

- [ ] **Step 2: Write failing safety and quota tests**

```js
test('blocks duplicates, recent successes, illegal urls, and all four quotas before dispatch', () => {
  const plan = compileBatchPlan(safetyInput());
  assert.deepEqual(plan.tasks.map((task) => task.blockReason), [
    null,
    'duplicate_in_batch',
    'recent_success',
    'blocked_illegal',
    'quota_target_domain',
    'quota_profile',
    'quota_promotion_site',
    'quota_batch'
  ]);
  assert.ok(plan.tasks.every((task) => task.profileId && task.promotionSiteId));
});

test('does not reassign an explicit pair when its quota is exhausted', () => {
  const task = compileBatchPlan(explicitQuotaInput()).tasks[1];
  assert.equal(task.assignmentPairId, 'pair-a');
  assert.equal(task.blockReason, 'quota_profile');
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test tests/batch-plan-compiler.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement canonical URL and safety classification**

Use `new URL`, allow only HTTP(S), lowercase host, clear hash, normalize default port, preserve path
and query order. Same-batch duplicates are never overridable. A recent-success URL is eligible only
when its canonical URL is in `repeatOverrides`. Filter failure is `illegal_filter_unavailable`, not a
silent pass.

- [ ] **Step 5: Implement smooth weights and quota-aware selection**

```js
function nextSmoothPair(state, candidates) {
  for (const candidate of candidates) candidate.current += candidate.weight;
  const selected = [...candidates].sort(compareCurrentThenId)[0];
  selected.current -= state.totalWeight;
  return selected;
}
```

Apply batch/domain limits before weighted state, then Profile/Site limits during Pair selection.
Blocked automatic rows receive the default Pair with `assignmentSource: 'default_blocked'` and do not
advance weights.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/batch-plan-compiler.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-plan-compiler.mjs tests/batch-plan-compiler.test.mjs
git commit -m "feat: compile deterministic batch assignments"
```

### Task 8: Fingerprint and Confirm Batch Plans

**Files:**
- Create: `lib/batch-plan-confirmation.mjs`
- Test: `tests/batch-plan-confirmation.test.mjs`

**Interfaces:**
- Consumes: Task 7 BatchPlanDraft.
- Produces: `fingerprintBatchPlan(plan, cryptoImpl) -> Promise<string>`.
- Produces: `finalizeBatchPlan(planDraft, cryptoImpl) -> Promise<BatchPlan>`.
- Produces: `getPlanConfirmationRequirements(plan)`.
- Produces: `createPlanConfirmation(plan, input, now)`.
- Produces: `validatePlanConfirmation(plan, confirmation, { now, maxAgeMs })`.

- [ ] **Step 1: Write failing fingerprint and risk tests**

```js
test('changes fingerprint when rows, config revision, quotas, or override changes', async () => {
  const base = await fingerprintBatchPlan(plan(), crypto.webcrypto);
  assert.notEqual(base, await fingerprintBatchPlan(plan({ quota: 101 }), crypto.webcrypto));
  assert.notEqual(base, await fingerprintBatchPlan(plan({ override: true }), crypto.webcrypto));
});

test('requires high-risk confirmation for multiple entities, raised quota, or recent override', () => {
  assert.deepEqual(getPlanConfirmationRequirements(riskyPlan()).sort(), [
    'multiple_assignments',
    'raised_quota',
    'recent_success_override'
  ]);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/batch-plan-confirmation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement canonical serialization and SHA-256**

Sort object keys recursively, preserve task array order, remove UI-only messages, and hash UTF-8
canonical JSON with Web Crypto SHA-256. `finalizeBatchPlan` attaches the returned fingerprint to a
deep-frozen clone. Confirmation contains fingerprint, normal-confirmed flag,
required risk codes, high-risk-confirmed flag, and `confirmedAt`.

- [ ] **Step 4: Implement expiry and exact-risk validation**

Reject changed fingerprint, missing normal confirmation, missing high-risk confirmation, changed risk
set, future timestamps, or confirmation older than 15 minutes.

- [ ] **Step 5: Run focused tests and commit**

```bash
node --test tests/batch-plan-confirmation.test.mjs tests/batch-plan-compiler.test.mjs
git add lib/batch-plan-confirmation.mjs tests/batch-plan-confirmation.test.mjs
git commit -m "feat: bind confirmations to batch plans"
```

### Task 9: Snapshot and Authorize Batch Passwords

**Files:**
- Create: `lib/batch-secret-vault.mjs`
- Modify: `background.js`
- Test: `tests/batch-secret-vault.test.mjs`

**Interfaces:**
- Consumes: Task 3 Profile secrets and a v3 checkpoint reader.
- Produces: `createBatchSecretVaultStore(storageArea)`.
- Produces methods: `buildPreparedEntry`, `buildStoragePatch`, `getAuthorizedPassword`, `clear`, `cleanupOrphans`.
- Installs message: `BATCH_GET_TASK_PASSWORD`.

- [ ] **Step 1: Write failing snapshot and authorization tests**

```js
test('freezes only referenced profile passwords and preserves later profile edits', async () => {
  const entry = await vault.buildPreparedEntry('batch-a', ['profile-a', 'profile-b'], profileSecrets);
  await storage.set(await vault.buildStoragePatch('batch-a', entry));
  await profileSecrets.setPassword('profile-a', runtimeSecret('changed'));
  assert.equal(await vault.readForTest('batch-a', 'profile-a'), originalA);
  assert.equal(JSON.stringify(checkpoint), checkpointJsonWithoutSecretSentinel);
});

test('authorizes exact running task, tab, and profile only', async () => {
  assert.equal((await vault.getAuthorizedPassword({
    request: request('batch-a', 'task-1', 0, 'profile-a'),
    senderTabId: 41,
    checkpoint: activeCheckpoint({ tabId: 41 })
  })).password, originalA);
  await assert.rejects(() => vault.getAuthorizedPassword({
    request: request('batch-a', 'task-1', 0, 'profile-b'),
    senderTabId: 41,
    checkpoint: activeCheckpoint({ tabId: 41 })
  }), /forbidden_task_secret/);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/batch-secret-vault.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement vault storage and redacted errors**

Use key `autoCommentBatchSecretVaults`. `buildPreparedEntry` reads only requested Profile entries;
the caller can combine `buildStoragePatch` with a checkpoint patch in one `storage.local.set`.
`getAuthorizedPassword` validates batch status, task ID, url index, task state, sender tab, and
Profile ID before reading one value. All mismatches return the same `forbidden_task_secret` code.

- [ ] **Step 4: Install the background listener**

The listener accepts only `sender.id === chrome.runtime.id` and integer `sender.tab.id`, reads the
current checkpoint through the runtime controller, calls `getAuthorizedPassword`, and never logs the
request or response body.

- [ ] **Step 5: Test cleanup**

Add tests for completion, termination, explicit clear, unrelated vault preservation, and startup
orphan cleanup. Paused-recovery vaults remain.

- [ ] **Step 6: Run focused and background tests**

```bash
node --test tests/batch-secret-vault.test.mjs tests/batch-runtime-controller.test.mjs
node --check background.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-secret-vault.mjs background.js tests/batch-secret-vault.test.mjs
git commit -m "feat: isolate batch profile passwords"
```

### Task 10: Add Assignment-Aware Results and Local History

**Files:**
- Create: `lib/batch-result-record.mjs`
- Modify: `lib/comment-history-capture.js`
- Modify: `lib/comment-history-record.mjs`
- Modify: `lib/comment-history-db.mjs`
- Modify: `lib/comment-history-service.mjs`
- Modify: `lib/comment-history-message-listener.mjs`
- Modify: `lib/comment-history-csv.mjs`
- Test: `tests/batch-result-record.test.mjs`
- Modify tests: `tests/comment-history-record.test.mjs`, `tests/comment-history-db.test.mjs`, `tests/comment-history-service.test.mjs`, `tests/comment-history-csv.test.mjs`

**Interfaces:**
- Produces: `buildBatchResult(task, outcome, timing)`.
- Produces: `buildBatchResultCsv(headers, results)`.
- Extends history filter with `profileId` and `promotionSiteId`.
- Produces repository method `listRecentSuccessfulTargetUrls({ since })`.

- [ ] **Step 1: Write failing result privacy tests**

```js
test('records ids and display snapshots without pii or description', () => {
  const result = buildBatchResult(taskSnapshot(), successfulOutcome(), timing());
  assert.equal(result.profileId, 'profile-a');
  assert.equal(result.promotionSiteId, 'site-a');
  assert.equal(result.profileDisplayName, 'Operator A');
  assert.equal(result.promotionSiteUrl, 'https://promo-a.test/');
  assert.doesNotMatch(JSON.stringify(result), /alice@example|real name|site description|password/i);
});
```

- [ ] **Step 2: Write failing history/filter tests**

Add a history bundle with Assignment fields and assert:

```js
assert.deepEqual(
  (await repository.queryRecords({ profileId: 'profile-a' })).records.map(r => r.id),
  ['batch-a:1']
);
assert.deepEqual(
  await repository.listRecentSuccessfulTargetUrls({ since: now - 86_400_000 }),
  ['https://target.test/post']
);
```

- [ ] **Step 3: Run focused tests**

```bash
node --test tests/batch-result-record.test.mjs tests/comment-history-record.test.mjs tests/comment-history-db.test.mjs
```

Expected: FAIL on missing result module and missing fields/indexes.

- [ ] **Step 4: Implement result and history fields**

Add Profile/Site IDs, display names, Site URL, Pair ID, assignment source, config version,
`attemptCount` (`checkpoint task.attempt - 1`), error code, and skip reason. Keep `attempt` only in
checkpoint/submit identity and attempt-history internals. Do not add Profile name/email or Site content. Upgrade IndexedDB from
Cloudflare baseline version 2 to version 3 and add compound indexes
`by_profile_submitted_at` and `by_promotion_site_submitted_at`.

- [ ] **Step 5: Extend filter, export, and recent-success query**

Normalize `profileId/promotionSiteId` through message listener and service, use the new indexes for
cursor plans, and append non-sensitive Assignment columns to history/result CSV output with existing
formula-injection protection.

- [ ] **Step 6: Run affected history suites**

```bash
node --test tests/batch-result-record.test.mjs tests/comment-history-record.test.mjs tests/comment-history-db.test.mjs tests/comment-history-service.test.mjs tests/comment-history-csv.test.mjs tests/comment-history-message-listener.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-result-record.mjs lib/comment-history-capture.js lib/comment-history-record.mjs lib/comment-history-db.mjs lib/comment-history-service.mjs lib/comment-history-message-listener.mjs lib/comment-history-csv.mjs tests
git commit -m "feat: record assignment aware comment history"
```

### Task 11: Extend the Extension Cloud Protocol With Domain Entities

**Files:**
- Modify: `lib/cloud-sync-protocol.mjs`
- Modify: `lib/cloud-sync-settings.mjs`
- Modify: `lib/cloud-sync-transport.mjs`
- Modify: `lib/cloud-sync-service.mjs`
- Modify: `lib/comment-history-db.mjs`
- Modify tests: `tests/cloud-sync-protocol.test.mjs`, `tests/cloud-sync-settings.test.mjs`, `tests/cloud-sync-transport.test.mjs`, `tests/cloud-sync-service.test.mjs`

**Interfaces:**
- Produces: `CLOUD_SYNC_PROTOCOL_VERSION = 2`.
- Adds entity types: `profile`, `promotion_site`, `assignment_pair`, `assignment_policy`.
- Adds transport `protocolVersion=2` to status/pull/bootstrap.
- Applies domain entity pages atomically through Task 3 repository.

- [ ] **Step 1: Write failing protocol tests**

```js
test('accepts exact non-sensitive v2 domain entities', () => {
  assert.equal(normalizeSyncMutation(profileMutation()).entityType, 'profile');
  assert.equal(normalizeSyncMutation(siteMutation()).entityType, 'promotion_site');
  assert.throws(() => normalizeSyncMutation(profileMutation({
    payload: { profile: { password: runtimeSecret() } }
  })), /SENSITIVE_FIELD_NOT_SYNCABLE/);
});

test('keeps v2 outbox pending when worker capability is absent', async () => {
  const result = await service.syncOnce(credentials(), transportWithCapabilities([]));
  assert.equal(result.skipped, 'domain_protocol_upgrade_required');
  assert.equal((await repository.listDueMutations()).length, 1);
});
```

- [ ] **Step 2: Run protocol/service tests**

```bash
node --test tests/cloud-sync-protocol.test.mjs tests/cloud-sync-service.test.mjs
```

Expected: FAIL on invalid entity types and missing capability handling.

- [ ] **Step 3: Implement exact entity schemas**

Extend `normalizeSyncMutation` with exact allowed payload keys:

```js
const DOMAIN_ENTITY_KEYS = {
  profile: ['id', 'displayName', 'name', 'email', 'createdAt', 'updatedAt'],
  promotion_site: ['id', 'name', 'url', 'content', 'enabled', 'createdAt', 'updatedAt'],
  assignment_pair: ['id', 'profileId', 'promotionSiteId', 'weight', 'enabled'],
  assignment_policy: ['id', 'defaultPairId', 'quotas']
};
```

Support upsert and delete for the first three; policy supports upsert under entity ID
`default-assignment-policy`. Continue accepting old setting mutations for old clients, but v2 domain
writes never emit old flat identity/site setting mutations. Split those four legacy keys into an
accept-only `CLOUD_SYNC_LEGACY_SETTING_KEYS` list: the v2 protocol validates old incoming mutations,
while `loadSyncableSettings` and `createStorageChangeMutations` do not scan or emit them.

- [ ] **Step 4: Add capability-aware transport and atomic apply**

Send `protocolVersion=2` on status/pull/bootstrap. Store v1 and v2 cursors separately. On first v2
connection, run domain-config bootstrap before v2 pull. Apply Profile/Site/Pair/Policy changes as one
validated domain config replacement, advance the cloud cursor only after that replacement succeeds,
and make replay idempotent. Suppress storage-change echoes.

- [ ] **Step 5: Run extension cloud suites**

```bash
node --test tests/cloud-sync-protocol.test.mjs tests/cloud-sync-settings.test.mjs tests/cloud-sync-transport.test.mjs tests/cloud-sync-service.test.mjs tests/comment-history-db.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/cloud-sync-protocol.mjs lib/cloud-sync-settings.mjs lib/cloud-sync-transport.mjs lib/cloud-sync-service.mjs lib/comment-history-db.mjs tests/cloud-sync-*.test.mjs tests/comment-history-db.test.mjs
git commit -m "feat: sync domain config entities"
```

### Task 12: Add D1 Domain Entities, Tombstones, Capabilities, and History Filters

**Files:**
- Create: `cloudflare-sync/migrations/0002_domain_config_entities.sql`
- Modify: `cloudflare-sync/src/index.ts`
- Modify: `cloudflare-sync/src/validation.ts`
- Modify: `cloudflare-sync/src/push.ts`
- Modify: `cloudflare-sync/src/pull.ts`
- Modify: `cloudflare-sync/src/history.ts`
- Modify: `cloudflare-sync/src/vault.ts`
- Create: `cloudflare-sync/test/domain-config.test.ts`
- Modify: `cloudflare-sync/test/migrations.test.ts`
- Modify: `cloudflare-sync/test/bootstrap.test.ts`
- Modify: `cloudflare-sync/test/history.test.ts`

**Interfaces:**
- Consumes: Task 11 shared protocol.
- Produces status `{ protocolVersion: 2, capabilities: [...] }`.
- Persists four domain entity types plus tombstones and Assignment comment columns.
- Filters pull/bootstrap responses by requested protocol version.

- [ ] **Step 1: Write failing migration and Worker tests**

```ts
it('applies v2 migration after the existing v1 schema', async () => {
  await applyMigrations(env.DB);
  const tables = await tableNames(env.DB);
  expect(tables).toContain('sync_profiles');
  expect(tables).toContain('sync_promotion_sites');
  expect(tables).toContain('sync_assignment_pairs');
  expect(tables).toContain('sync_assignment_policy');
  expect(tables).toContain('domain_entity_tombstones');
});

it('pushes, pulls, deletes, and refuses to resurrect a profile', async () => {
  await push(profileMutation('profile-a'));
  await push(profileDelete('profile-a'));
  expect((await push(olderProfileMutation('profile-a'))).status).toBe('stale');
  expect(await pullV2()).toContainEqual(expect.objectContaining({
    entityType: 'profile',
    operation: 'delete'
  }));
});
```

- [ ] **Step 2: Run Worker tests**

Run: `npm --prefix cloudflare-sync test -- domain-config.test.ts migrations.test.ts`

Expected: FAIL on missing migration/tables.

- [ ] **Step 3: Add migration 0002**

Create separate Profile, Promotion Site, Pair, Policy, and tombstone tables with
`(vault_id, entity_id)` primary keys, accepted mutation IDs, server sequence, and update timestamps.
Add nullable Assignment columns and indexes to `comment_records`. Do not edit `0001_initial.sql`.

- [ ] **Step 4: Extend validation and push atomics**

Reuse shared protocol validation, add exact SQL upsert/delete paths, record every accepted mutation in
`sync_mutations` and `sync_changes`, and reject older upserts when a tombstone exists. Deleting a
Profile/Site/Pair writes a tombstone; deleting a vault removes active domain rows but preserves the
vault-deleted behavior.

- [ ] **Step 5: Extend status, pull, bootstrap, and history**

Absent `protocolVersion` means v1: omit v2 entities and v2-only comment columns while advancing the
v1 cursor. Version 2 includes domain pages and comment Assignment fields. Add Profile/Site filters to
`GET /v1/history` and indexes.

- [ ] **Step 6: Run Worker tests and typecheck**

```bash
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare-sync/migrations/0002_domain_config_entities.sql cloudflare-sync/src cloudflare-sync/test
git commit -m "feat: persist domain config in d1"
```

### Task 13: Integrate the Operations Console Implementation Dependency

**Files:**
- Merge committed branch: `codex/batch-operations-console`
- Resolve shared files according to the two approved specs.

**Interfaces:**
- Consumes expected UI modules: `lib/batch-preflight.mjs`, `lib/batch-console-state.mjs`, `lib/batch-command-controller.mjs`, `lib/batch-worker-runtime.mjs`, `lib/batch-wizard-view.mjs`, `lib/batch-console-view.mjs`, `lib/app-shell.mjs`.
- Produces the console UI and checkpoint v2 attempt/phase/manual contract as the base for v3.

- [ ] **Step 1: Verify the UI dependency has implementation commits**

```bash
git log --oneline e813c08..codex/batch-operations-console
git diff --name-only e813c08..codex/batch-operations-console
```

Expected: at least one commit beyond the design commit and changes to `batch.html`, `batch.js`,
`lib/batch-console-state.mjs`, `lib/batch-command-controller.mjs`, and
`lib/batch-runtime-checkpoint.mjs`. If these exact artifacts are absent, stop at this dependency gate
and report that the console implementation is not committed; do not create replacement UI files.

- [ ] **Step 2: Run the UI branch’s own committed tests without modifying its worktree**

```bash
ui_check_parent="$(mktemp -d)"
ui_check_dir="$ui_check_parent/autoComment"
git worktree add --detach "$ui_check_dir" codex/batch-operations-console
(cd "$ui_check_dir" && npm ci && npm test)
git worktree remove "$ui_check_dir"
rmdir "$ui_check_parent"
```

Expected: PASS. Only the exact directory returned by `mktemp -d` is removed.

- [ ] **Step 3: Merge the committed UI branch**

```bash
git merge --no-ff codex/batch-operations-console -m "merge: integrate batch operations console"
```

Resolve conflicts by preserving:

- console HTML/CSS/view structure from the UI branch;
- canonical `profileId` naming and multi-entity contracts from Tasks 2–8;
- non-overridable same-batch duplicates from Task 7;
- current approved automatic retry allowlist, not the UI design’s broader retry policy;
- Cloudflare controls and history behavior from Tasks 1, 10–12.

- [ ] **Step 4: Run the combined suite**

```bash
npm ci
npm test
```

Expected: PASS before adding checkpoint v3.

- [ ] **Step 5: Commit only if conflict resolution changed tracked content after the merge commit**

```bash
git status --short
git add -u
git commit -m "fix: reconcile console and assignment contracts"
```

Expected: no extra commit when Git resolved the merge without conflicts.

### Task 14: Upgrade Operations-Console Checkpoint v2 to Assignment-Aware v3

**Files:**
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `lib/batch-submit-context-store.mjs`
- Modify: `lib/batch-submit-context-client.js`
- Modify: `background.js`
- Modify tests: `tests/batch-runtime-checkpoint.test.mjs`, `tests/batch-runtime-controller.test.mjs`, `tests/batch-submit-context-store.test.mjs`, `tests/batch-submit-context-client.test.js`

**Interfaces:**
- Consumes: console v2 attempt/phase/manual fields and Task 8 confirmed BatchPlan.
- Produces: `BATCH_RUNTIME_VERSION = 3`.
- Produces migrations `migrateBatchRuntimeCheckpoint(v1|v2) -> v3`.
- Adds task identity validation `batchId + taskId + urlIndex + attempt + tabId`.

- [ ] **Step 1: Write failing v1/v2 migration tests**

```js
test('migrates v1 directly to v3 with attempt fields and default assignment', () => {
  const result = migrateBatchRuntimeCheckpoint(v1Checkpoint(), now);
  assert.equal(result.checkpoint.version, 3);
  assert.equal(result.checkpoint.tasks['0'].attempt, 1);
  assert.equal(result.checkpoint.tasks['0'].profileId, 'default-profile');
});

test('migrates console v2 to v3 without losing attempts or manual resolution', () => {
  const result = migrateBatchRuntimeCheckpoint(v2Checkpoint({ attempt: 2 }), now);
  assert.equal(result.checkpoint.tasks['0'].attempt, 2);
  assert.equal(result.checkpoint.tasks['0'].manualResolution.status, 'unresolved');
  assert.equal(result.checkpoint.tasks['0'].promotionSiteId, 'default-promotion-site');
});
```

- [ ] **Step 2: Write failing frozen-plan and race tests**

Assert v3 checkpoint stores safe Profile/Site maps and each task Assignment, recursively rejects a
runtime-generated secret sentinel, rejects stale `taskId/attempt/tabId`, and keeps Assignment unchanged
through `active → queued` recovery and one retry. Plan rows with `state: 'blocked'` start as terminal
results with their stable skip/block reason, and never become scheduler candidates.

- [ ] **Step 3: Run focused tests**

```bash
node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs
```

Expected: FAIL on version and missing Assignment.

- [ ] **Step 4: Implement v3 creation and migration**

Start messages now carry `plan` and `confirmation`. The controller verifies Task 8 confirmation,
builds a Task 9 vault entry only for Profiles referenced by `eligible` rows, and writes the safe plan
checkpoint plus updated vault map in one local storage set. It then requests power and transitions to
running. A failure removes the unstarted checkpoint/vault pair and opens no windows.

- [ ] **Step 5: Extend submit context identity**

Persist `taskId/profileId/promotionSiteId/attempt` but no Profile fields or password. Context match,
clear, seal, and recovery require all task identity fields. A `submitting` recovery remains one-time
`manual_required`.

- [ ] **Step 6: Implement the automatic retry transition**

Allow only `attempt === 1`, pre-submit allowlisted `errorCode`, `retryable === true`, and no submit
context. Increment to attempt 2, keep Assignment, clear window/phase/timing, and return queued. All
other results become terminal.

- [ ] **Step 7: Run checkpoint, controller, context, and integration tests**

```bash
node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-submit-context-store.test.mjs tests/batch-submit-context-client.test.js tests/batch-multi-window-integration.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-runtime-checkpoint.mjs lib/batch-runtime-controller.mjs lib/batch-submit-context-store.mjs lib/batch-submit-context-client.js background.js tests
git commit -m "feat: checkpoint frozen task assignments"
```

### Task 15: Make Content Workers Consume Only Their Frozen Task Configuration

**Files:**
- Create: `lib/batch-task-config.js`
- Modify: `manifest.json`
- Modify: `content.js`
- Modify: `background.js`
- Test: `tests/batch-task-config.test.js`
- Modify tests: `tests/comment-history-submit-flow.test.js`, `tests/batch-multi-window-integration.test.js`

**Interfaces:**
- Produces global `AutoCommentBatchTaskConfig`.
- Methods: `acceptHandle(message)`, `getCurrent()`, `cacheKey()`, `getTaskPassword(runtime)`, `clear()`.
- Consumes v2 `BATCH_HANDLE` safe payload and `BATCH_GET_TASK_PASSWORD`.

- [ ] **Step 1: Write failing task-context tests**

```js
test('accepts exact safe snapshots and rejects secrets in BATCH_HANDLE', () => {
  const context = taskConfig.acceptHandle(validHandle());
  assert.equal(context.profile.name, 'Alice');
  assert.equal(context.promotionSite.url, 'https://promo-a.test/');
  assert.throws(() => taskConfig.acceptHandle({
    ...validHandle(),
    profile: { ...validHandle().profile, password: runtimeSecret() }
  }), /sensitive_task_config/);
});

test('uses task-scoped cache keys and requests one authorized password', async () => {
  taskConfig.acceptHandle(validHandle({ taskId: 'task-a', promotionSiteId: 'site-a' }));
  assert.equal(taskConfig.cacheKey(), 'batch-a:task-a:site-a:2');
  assert.deepEqual(runtime.messages[0], {
    type: 'BATCH_GET_TASK_PASSWORD',
    batchId: 'batch-a',
    taskId: 'task-a',
    urlIndex: 0,
    profileId: 'profile-a'
  });
});

test('manual mode resolves the current default pair without advancing batch weights', async () => {
  const manual = await taskConfig.loadManualDefault(domainConfigRepository);
  assert.deepEqual({
    profileId: manual.profile.id,
    promotionSiteId: manual.promotionSite.id
  }, {
    profileId: 'profile-a',
    promotionSiteId: 'site-a'
  });
});
```

- [ ] **Step 2: Run the task-config test**

Run: `node --test tests/batch-task-config.test.js`

Expected: FAIL because the global helper is absent.

- [ ] **Step 3: Implement the classic helper and manifest ordering**

Use an IIFE like existing content helpers and load `lib/batch-task-config.js` before `content.js`.
Freeze cloned snapshots, exact-key validate, and keep returned password only in the awaited caller’s
local variable.

- [ ] **Step 4: Replace batch global reads in `content.js`**

Batch generation template, name/email fields, Site URL/content, history capture, cache, confirm, and
submit context use the accepted task context. Manual mode continues using the current default Pair
through a domain-config adapter. Request password only after a password input exists.

- [ ] **Step 5: Add controlled phase/error reports**

Include `taskId`, `attempt`, `profileId`, and `promotionSiteId` in phase/terminal confirmation. Report
only stable phase/error codes. Never log Profile name/email, Site content, or password.

- [ ] **Step 6: Run content and integration suites**

```bash
node --test tests/batch-task-config.test.js tests/comment-history-submit-flow.test.js tests/batch-multi-window-integration.test.js tests/comment-history-capture.test.js
node --check content.js
node --check background.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-task-config.js manifest.json content.js background.js tests/batch-task-config.test.js tests/comment-history-submit-flow.test.js tests/batch-multi-window-integration.test.js
git commit -m "feat: isolate content worker task config"
```

### Task 16: Integrate Profile/Site Management Into the Console Shell

**Files:**
- Create: `lib/domain-config-options-controller.mjs`
- Modify: `options.html`
- Modify: `options.js`
- Modify: console shell styles from the UI branch.
- Test: `tests/domain-config-options-controller.test.mjs`
- Modify: UI branch options/app-shell tests.

**Interfaces:**
- Consumes: Tasks 3–5 controllers.
- Produces Profile/Site/Pair/Policy view model and semantic commands.
- Password commands return only configured booleans.

- [ ] **Step 1: Write failing controller tests**

```js
test('edits profiles, sites, pairs, default pair, and quotas through repositories', async () => {
  const controller = createDomainConfigOptionsController(dependencies());
  await controller.saveProfile(profileA());
  await controller.savePromotionSite(siteA());
  await controller.savePair(pairA());
  await controller.savePolicy(policy({ defaultPairId: 'pair-a' }));
  assert.equal((await controller.snapshot()).defaultPairId, 'pair-a');
});

test('password save and clear never enter the domain snapshot or export', async () => {
  await controller.savePassword('profile-a', runtimeSecret());
  assert.equal((await controller.snapshot()).passwordConfigured['profile-a'], true);
  assert.doesNotMatch(JSON.stringify(await controller.exportConfig()), secretSentinelPattern);
});
```

- [ ] **Step 2: Run controller tests**

Run: `node --test tests/domain-config-options-controller.test.mjs`

Expected: FAIL with missing controller.

- [ ] **Step 3: Implement the semantic controller**

The controller wraps repositories/import-export, emits immutable snapshots, validates before writes,
and keeps secret methods separate. It does not depend on DOM.

- [ ] **Step 4: Bind the existing console sections**

Replace the operations-console placeholder single identity/site cards with lists and editors inside its
existing `options.html#identity` and `options.html#promotion` sections. Add Pair, weight, default, and
quota controls without changing the shared shell. Password inputs never prefill; configured state is a
separate label.

- [ ] **Step 5: Bind import preview and safe export**

Use Task 5 preview results and require explicit apply. Keep Cloudflare controls from Task 1. Delete
the old options code path that writes password or multi-entity data to `chrome.storage.sync`.

- [ ] **Step 6: Run options and shell suites**

```bash
node --test tests/domain-config-options-controller.test.mjs tests/app-shell.test.mjs tests/cloud-sync-options-controller.test.mjs tests/privacy-policy.test.js
node --check options.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/domain-config-options-controller.mjs options.html options.js styles tests/domain-config-options-controller.test.mjs tests/app-shell.test.mjs tests/cloud-sync-options-controller.test.mjs tests/privacy-policy.test.js
git commit -m "feat: manage profiles and promotion sites"
```

### Task 17: Connect CSV Mapping, Assignment Preview, Dispatch, Results, and Filters

**Files:**
- Modify: `lib/batch-wizard-view.mjs`
- Modify: `lib/batch-console-state.mjs`
- Modify: `lib/batch-command-controller.mjs`
- Modify: `lib/batch-worker-runtime.mjs`
- Modify: `lib/batch-console-view.mjs`
- Modify: `batch.html`
- Modify: `batch.js`
- Modify: `history.html`
- Modify: `history.js`
- Create: `tests/batch-multi-assignment-integration.test.js`
- Modify UI branch wizard/console/page/history tests.

**Interfaces:**
- Consumes: Tasks 6–8 Plan compiler and Task 14 v3 runtime.
- Produces full mapping/preview/confirmation UI and per-task safe `BATCH_HANDLE`.
- Adds Profile/Site result and history filters.

- [ ] **Step 1: Write failing five-row integration test**

```js
test('dispatches five rows with frozen expected combinations across three slots', async () => {
  const harness = multiAssignmentHarness({
    concurrency: 3,
    rows: fiveRows(),
    config: twoProfilesTwoSites()
  });
  await harness.confirmAndStart();
  assert.equal(harness.createdWindows.length, 3);
  assert.deepEqual(
    harness.sentHandles.map(({ taskId, profile, promotionSite }) => ({
      taskId,
      profileId: profile.id,
      promotionSiteId: promotionSite.id
    })),
    harness.plan.tasks.slice(0, 3).map(expectedHandleIdentity)
  );
  await harness.finishOutOfOrder([2, 0, 1, 4, 3]);
  assert.deepEqual(harness.results.map(resultIdentity), harness.expectedResults);
});
```

- [ ] **Step 2: Write failing preview and safety UI tests**

Assert the wizard shows column mapping, row Profile/Site, explicit/weighted source, all quota counts,
non-overridable same-batch duplicate, row-level recent override, normal confirmation, and the three
high-risk confirmation reasons.

- [ ] **Step 3: Run focused UI/integration tests**

```bash
node --test tests/batch-multi-assignment-integration.test.js tests/batch-wizard-view.test.mjs tests/batch-console-view.test.mjs
```

Expected: FAIL on missing mapping/plan adapters.

- [ ] **Step 4: Replace preflight draft with BatchPlan compilation**

Wizard state stores CSV text/rows, column mapping, repeat overrides, compiled plan, fingerprint, and
confirmation. Any edit invalidates fingerprint and confirmation. Starting passes the confirmed plan
to `BATCH_SESSION_START`; it never reconstructs Assignment in `batch.js`.

- [ ] **Step 5: Dispatch one safe task snapshot per window**

`batch-worker-runtime` takes the v3 task and referenced Profile/Site safe snapshots and sends the Task
15 exact handle. Scheduler only receives eligible queued tasks; blocked plan rows become terminal
results before window creation and do not consume slots.

- [ ] **Step 6: Render Assignment-aware console and history**

Show Profile/Site in batch summary, slot, row, details, result filters, result CSV, and history filters.
Use display snapshots for old deleted/renamed entities. Do not show Profile real name/email in result
tables or history.

- [ ] **Step 7: Run page and runtime suites**

```bash
node --test tests/batch-multi-assignment-integration.test.js tests/batch-wizard-view.test.mjs tests/batch-console-view.test.mjs tests/batch-console-state.test.mjs tests/batch-command-controller.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-multi-window-integration.test.js tests/comment-history-page.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-wizard-view.mjs lib/batch-console-state.mjs lib/batch-command-controller.mjs lib/batch-worker-runtime.mjs lib/batch-console-view.mjs batch.html batch.js history.html history.js tests
git commit -m "feat: run assignment aware batch plans"
```

### Task 18: Add the Real Chrome Five-Target Acceptance Fixture

**Files:**
- Modify: `scripts/serve-extension-fixture.js`
- Modify: `tests/fixtures/comment-page.html`
- Modify: `tests/fixtures/comment-page-submit.js`
- Create: `tests/fixtures/multi-assignment-targets.csv`
- Create: `scripts/run-multi-assignment-chrome-acceptance.mjs`
- Create: `docs/qa/2026-07-26-multi-identity-promotion-batch-chrome.md`
- Modify: `package.json`
- Modify: `tests/fixture-server.test.js`

**Interfaces:**
- Produces npm script `test:chrome:multi-assignment`.
- Fixture records submitted field values in process memory only.
- Acceptance script launches a temporary Chrome profile with the unpacked extension.

- [ ] **Step 1: Write failing fixture-server tests**

```js
test('serves five isolated targets and records task fields locally', async () => {
  const pages = await Promise.all(
    [1, 2, 3, 4, 5].map((id) => fetch(`${baseUrl}/multi/${id}`).then(r => r.text()))
  );
  assert.ok(pages.every((html) => /data-fixture-target/.test(html)));
  const records = await fetch(`${baseUrl}/__fixture/submissions`).then(r => r.json());
  assert.deepEqual(records, []);
});
```

- [ ] **Step 2: Run fixture tests**

Run: `node --test tests/fixture-server.test.js`

Expected: FAIL on missing routes.

- [ ] **Step 3: Implement loopback-only targets and model stub**

Bind to `127.0.0.1`, expose five paths, one local OpenAI-compatible endpoint, submission reset/read
endpoints, and no outbound network calls. Store target ID, name, email, password-present boolean,
website URL, comment, task ID, Profile ID, and Site ID; never store the password value.

- [ ] **Step 4: Implement the Chrome acceptance runner**

Create `temporaryProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'autocomment-multi-'))`, resolve
`projectRoot` from `import.meta.url`, and launch installed Chrome with arguments
``--user-data-dir=${temporaryProfile}`` and ``--load-extension=${projectRoot}``. Configure two
Profiles/two Sites via extension APIs, import five local URLs, select concurrency 3, confirm the plan,
and wait for five terminal results. Close Chrome and call
`fs.rm(temporaryProfile, { recursive: true, force: true })` only in `finally`.

- [ ] **Step 5: Assert isolation and recovery**

Assert:

- maximum simultaneous worker windows is 3;
- expected `profileId/promotionSiteId` for all five targets;
- fixture name/email/password-presence/Site URL match each task;
- out-of-order completion does not change ownership;
- one allowlisted pre-submit failure retries once with the same Assignment;
- one submitting interruption becomes `manual_required`;
- pause/resume preserves Assignment;
- no requested URL has a non-loopback host.

- [ ] **Step 6: Run fixture and Chrome acceptance**

```bash
node --test tests/fixture-server.test.js
npm run test:chrome:multi-assignment
```

Expected: PASS. The QA document records Chrome version, extension commit, fixture ports, five
expected/actual Assignments, max concurrency, recovery result, and “no third-party submission”.

- [ ] **Step 7: Commit**

```bash
git add scripts/serve-extension-fixture.js scripts/run-multi-assignment-chrome-acceptance.mjs tests/fixtures tests/fixture-server.test.js docs/qa/2026-07-26-multi-identity-promotion-batch-chrome.md package.json
git commit -m "test: verify multi assignment chrome batches"
```

### Task 19: Run Full Security, Regression, Syntax, and Clean-Branch Verification

**Files:**
- Create: `tests/multi-identity-privacy.test.mjs`

**Interfaces:**
- Verifies all approved requirements and produces no new runtime interface.

- [ ] **Step 1: Write the final recursive privacy regression**

Load representative domain config, BatchPlan, checkpoint, URL queue, handle, submit context, result,
history export, config export, cloud mutation, and captured logs. Generate a runtime secret sentinel
and assert it appears only in the Profile secret store, batch secret vault, and the one authorized
password response.

- [ ] **Step 2: Run the privacy test**

Run: `node --test tests/multi-identity-privacy.test.mjs`

Expected: PASS. A failure means the responsible earlier task is incomplete; return to that task,
remove the unexpected surface, rerun its focused tests, and commit that scoped fix before continuing.

- [ ] **Step 3: Remove every unexpected sensitive surface**

If Step 2 failed, use the reported surface name to identify the responsible module. Replace
value-bearing diagnostics with stable codes and lengths, rerun that module’s focused suite, and commit
only that module and its tests. Never weaken the assertion or add an allowlist beyond the three
approved in-memory/local-only surfaces.

- [ ] **Step 4: Run complete extension verification**

```bash
npm ci
npm test
node --check background.js
node --check batch.js
node --check content.js
node --check options.js
node --check history.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

Expected: PASS.

- [ ] **Step 5: Run complete Cloudflare verification**

```bash
npm --prefix cloudflare-sync ci
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
npm --prefix cloudflare-sync exec wrangler deploy --dry-run
```

Expected: PASS without production deployment.

- [ ] **Step 6: Re-run real Chrome acceptance**

Run: `npm run test:chrome:multi-assignment`

Expected: PASS with the QA record updated to the final commit.

- [ ] **Step 7: Audit branch scope and forbidden strings**

```bash
git diff --check master...HEAD
git status --short
rg -n \"auto_fill_user_password|passwordsByProfileId|BATCH_GET_TASK_PASSWORD\" . -g '!node_modules' -g '!cloudflare-sync/node_modules'
```

Expected: clean status. Every match is one of the designed repository/vault/message authorization
paths or a synthetic security test; no export, D1 SQL, history, log, fixture data file, or checkpoint
serializer contains a password value.

- [ ] **Step 8: Commit final verification-only fixes**

```bash
git add tests/multi-identity-privacy.test.mjs
git commit -m "test: verify multi identity batch privacy"
```

Expected: a clean branch after the commit.

## Completion Evidence

Before claiming completion, capture:

- `git status --short --branch`;
- `git log --oneline master..HEAD`;
- full extension test count and result;
- full Worker test count, typecheck, and dry-run result;
- syntax-check result;
- real Chrome QA document path;
- evidence of 3 concurrent windows, 2 Profiles, 2 Promotion Sites, 5 loopback targets;
- evidence that each target used its planned combination;
- evidence that no third-party request or password-bearing durable surface occurred.
