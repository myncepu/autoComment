# Unified Non-Sensitive Config Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export and restore all portable AutoComment settings through one versioned, secret-free JSON bundle and ship a directly importable 3×3 local dry-run preset.

**Architecture:** Add a Chrome-independent v3 bundle schema, an injected `storage.sync` allowlist adapter, and a controller that combines bundle previews with the existing domain import pipeline. Extract the backup-card interaction into a pure DOM view so production `options.js` and an ordinary HTTP fixture exercise the same behavior. Existing v2 and legacy imports continue through the current domain controller.

**Tech Stack:** Manifest V3 JavaScript modules, `chrome.storage.sync`/`local`, Node.js test runner, JSDOM, Playwright Chrome acceptance, JSON fixtures.

## Global Constraints

- The v3 format name is `autocomment-config-bundle` and its version is exactly `3`.
- Export and import must never contain OpenRouter API keys, Profile passwords, cloud-sync credentials, history, drafts, checkpoints, submit contexts, or result caches.
- `profileId` remains the canonical identity field; do not introduce `identityId`.
- Production schema, controller, and view modules must not access `chrome.*` at import or render time.
- v2 `autocomment-domain-config` and the existing legacy format must remain importable without changing LLM or batch defaults.
- Test preset defaults are `autoGenerate: true`, `autoSubmit: false`, concurrency `3`, and timeout `120` seconds.
- Unknown or sensitive keys fail closed; they are not ignored.
- Keep Manifest V3 CSP compatibility and use no remote images or scripts.
- Every production behavior change follows RED → GREEN → REFACTOR.

## File Structure

- Create `lib/config-bundle.mjs`: exact v3 schema, normalization, sensitive-key rejection, and export builder.
- Create `lib/options-safe-settings-adapter.mjs`: injected allowlist reader/writer for public LLM, batch, and preference settings.
- Create `lib/options-config-bundle-controller.mjs`: one-time preview ownership, v3 application, v2/legacy delegation, and rollback.
- Create `lib/options-config-bundle-view.mjs`: pure DOM behavior for export, file preview, summary, and explicit apply.
- Modify `options.js`: compose the new adapter/controller/view and refresh imported controls.
- Modify `options.html`: update backup copy and add stable preview summary nodes.
- Create `examples/autocomment-local-dry-run-config.json`: stable 3 Profile × 3 Site preset.
- Create `tests/config-bundle.test.mjs`.
- Create `tests/options-safe-settings-adapter.test.mjs`.
- Create `tests/options-config-bundle-controller.test.mjs`.
- Create `tests/options-config-bundle-view.test.mjs`.
- Create `tests/config-bundle-preset.test.mjs`.
- Create `tests/fixtures/options-config-bundle-page.html`.
- Create `tests/fixtures/options-config-bundle-app.mjs`.
- Modify `scripts/serve-extension-fixture.js`: serve the ordinary HTTP config fixture and production dependencies.
- Create `scripts/run-options-config-bundle-chrome-acceptance.mjs`.
- Modify `package.json`: add `test:chrome:config-bundle`.
- Create `docs/qa/2026-07-27-unified-config-bundle-chrome.md`.

---

### Task 1: Define the v3 secret-free bundle contract

**Files:**

- Create: `lib/config-bundle.mjs`
- Create: `tests/config-bundle.test.mjs`

**Interfaces:**

- Produces:
  - `CONFIG_BUNDLE_FORMAT: "autocomment-config-bundle"`
  - `CONFIG_BUNDLE_VERSION: 3`
  - `isConfigBundle(input): boolean`
  - `parseConfigBundle(input): Readonly<PortableConfigData>`
  - `buildConfigBundle(data, { exportedAt }): Readonly<ConfigBundle>`
- `PortableConfigData` contains exact keys `domainConfig`, `llm`, `batchDefaults`, and `preferences`.

- [ ] **Step 1: Write failing tests for valid parse and normalized immutable output**

```js
test('parses one exact v3 portable bundle and freezes a clone', () => {
  const input = bundleFixture();
  const parsed = parseConfigBundle(input);

  assert.equal(parsed.llm.apiBaseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(parsed.batchDefaults, {
    autoOpenPanel: true,
    autoGenerate: true,
    autoSubmit: false,
    concurrency: 3,
    timeoutSeconds: 120
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parsed.domainConfig, input.data.domainConfig);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/config-bundle.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/config-bundle.mjs`.

- [ ] **Step 3: Implement exact-key validation and normalization**

Create exports with this public shape:

```js
export const CONFIG_BUNDLE_FORMAT = 'autocomment-config-bundle';
export const CONFIG_BUNDLE_VERSION = 3;

export function isConfigBundle(input) {
  return Boolean(
    input &&
    input.format === CONFIG_BUNDLE_FORMAT
  );
}

export function parseConfigBundle(input) {
  // Validate exact top-level and data keys.
  // Call validateDomainConfig(input.data.domainConfig).
  // Normalize public LLM, batch, and preference values.
  // Return a deeply frozen structured clone.
}

export function buildConfigBundle(data, { exportedAt = Date.now() } = {}) {
  const normalized = parsePortableData(data);
  return deepFreeze({
    format: CONFIG_BUNDLE_FORMAT,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt,
    data: structuredClone(normalized)
  });
}
```

Use the same recursive sensitive-name semantics already enforced by
`assertNoSensitiveFields`, and validate all objects with exact key sets.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/config-bundle.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add failing tests for every fail-closed boundary**

Add separate tests that assert stable codes for:

```js
[
  ['apiKey', 'secret-value'],
  ['password', 'secret-value'],
  ['cloud_sync_secret', 'secret-value'],
  ['authorization', 'secret-value'],
  ['token', 'secret-value'],
  ['credential', 'secret-value']
]
```

Also cover:

- extra top-level, data, LLM, batch, or preference keys;
- version other than `3`;
- non-HTTP(S) API base URL;
- empty model;
- concurrency outside `1..10`;
- timeout outside `10..600`;
- `autoSubmit: true` with `autoGenerate: false`;
- invalid timestamps.

Expected errors:

- `invalid_config_bundle_format`
- `unsupported_config_bundle_version`
- `sensitive_config_bundle_field`
- `invalid_config_bundle_llm`
- `invalid_config_bundle_batch_defaults`
- `invalid_config_bundle_preferences`

- [ ] **Step 6: Run tests and verify RED for incomplete validation**

Run: `node --test tests/config-bundle.test.mjs`

Expected: FAIL on the first missing validation with the asserted stable code mismatch.

- [ ] **Step 7: Complete minimal validation and export tests**

Add:

```js
test('build output contains no sensitive or runtime state key', () => {
  const output = buildConfigBundle(portableFixture(), { exportedAt: 100 });
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(
    serialized,
    /api[_-]?key|password|secret|token|authorization|credential|checkpoint|history|batchDraft|submitContext/i
  );
});
```

Implement only the checks needed for the defined v3 contract.

- [ ] **Step 8: Run focused and existing domain schema tests**

Run:

```bash
node --test \
  tests/config-bundle.test.mjs \
  tests/domain-config-schema.test.mjs \
  tests/domain-config-import-export.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add lib/config-bundle.mjs tests/config-bundle.test.mjs
git commit -m "feat: define portable config bundle"
```

---

### Task 2: Add the safe settings adapter and transactional bundle controller

**Files:**

- Create: `lib/options-safe-settings-adapter.mjs`
- Create: `lib/options-config-bundle-controller.mjs`
- Create: `tests/options-safe-settings-adapter.test.mjs`
- Create: `tests/options-config-bundle-controller.test.mjs`

**Interfaces:**

- Consumes:
  - `parseConfigBundle` and `buildConfigBundle` from Task 1.
  - `previewDomainConfigImport` and `buildDomainConfigExport`.
  - Existing `domainController.previewImport/applyImport` for v2 and legacy.
- Produces:
  - `createSafeOptionsSettingsAdapter(syncStorage)`
  - `adapter.load(): Promise<{ llm, batchDefaults, preferences }>`
  - `adapter.save(settings): Promise<void>`
  - `createOptionsConfigBundleController(dependencies)`
  - `controller.exportConfig()`
  - `controller.previewImport(input)`
  - `controller.applyImport(preview)`

- [ ] **Step 1: Write the adapter RED tests**

```js
test('loads and saves only the explicit portable sync keys', async () => {
  const storage = createStorageArea({
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    llm_api_key: 'must-not-read',
    cloud_sync_secret: 'must-not-read',
    batch_concurrency: 3,
    batch_timeout_seconds: 120,
    batch_checkbox_settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: false
    },
    show_export_outlinks_floating_button: true
  });
  const adapter = createSafeOptionsSettingsAdapter(storage);

  const loaded = await adapter.load();
  assert.doesNotMatch(JSON.stringify(loaded), /must-not-read/);
  assert.deepEqual(storage.requestedKeys, [
    'llm_api_base_url',
    'llm_model',
    'batch_checkbox_settings',
    'batch_concurrency',
    'batch_timeout_seconds',
    'show_export_outlinks_floating_button'
  ]);
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `node --test tests/options-safe-settings-adapter.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the allowlist adapter**

The adapter must call only:

```js
syncStorage.get(PORTABLE_SYNC_KEYS);
syncStorage.set({
  llm_api_base_url: settings.llm.apiBaseUrl,
  llm_model: settings.llm.model,
  batch_checkbox_settings: {
    autoOpenPanel: settings.batchDefaults.autoOpenPanel,
    autoGenerate: settings.batchDefaults.autoGenerate,
    autoSubmit: settings.batchDefaults.autoSubmit
  },
  batch_concurrency: settings.batchDefaults.concurrency,
  batch_timeout_seconds: settings.batchDefaults.timeoutSeconds,
  show_export_outlinks_floating_button:
    settings.preferences.showExportOutlinksFloatingButton
});
```

Normalize through Task 1 rather than maintaining a second validation schema.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `node --test tests/options-safe-settings-adapter.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write controller RED tests for export, preview, and no-write preview**

```js
test('exports domain and public settings as one v3 bundle', async () => {
  const harness = createHarness();
  const exported = await harness.controller.exportConfig();

  assert.equal(exported.format, 'autocomment-config-bundle');
  assert.equal(exported.version, 3);
  assert.equal(exported.data.domainConfig.profiles.length, 1);
  assert.equal(exported.data.batchDefaults.autoSubmit, false);
  assert.doesNotMatch(JSON.stringify(exported), /local-api-key|profile-password/);
});

test('previews v3 changes without writing either repository', async () => {
  const harness = createHarness();
  const before = harness.writeCounts();
  const preview = await harness.controller.previewImport(bundleFixture());

  assert.deepEqual(preview.settingChanges.sort(), [
    'batchDefaults',
    'llm',
    'preferences'
  ]);
  assert.deepEqual(harness.writeCounts(), before);
});
```

- [ ] **Step 6: Run controller tests and verify RED**

Run: `node --test tests/options-config-bundle-controller.test.mjs`

Expected: FAIL with missing controller module.

- [ ] **Step 7: Implement export and one-time preview ownership**

Use dependencies:

```js
createOptionsConfigBundleController({
  configRepository,
  domainController,
  settingsAdapter,
  now = Date.now
})
```

For v3:

1. Parse the bundle.
2. Load current domain and public settings.
3. Build a v2 domain wrapper in memory and call
   `previewDomainConfigImport(currentDomain, wrapper)`.
4. Store the raw preview, parsed settings, and pre-apply snapshots under an opaque
   `config-bundle-preview-N` ID.
5. Return an immutable safe summary.

For non-v3 input, call `domainController.previewImport(input)` and store the returned
domain preview under the same facade.

- [ ] **Step 8: Run controller tests and verify export/preview GREEN**

Run: `node --test tests/options-config-bundle-controller.test.mjs`

Expected: export and preview tests PASS.

- [ ] **Step 9: Add RED tests for apply, stale preview, rollback, and legacy delegation**

```js
test('applies one v3 preview exactly once', async () => {
  const harness = createHarness();
  const preview = await harness.controller.previewImport(bundleFixture());
  await harness.controller.applyImport(preview);

  assert.equal((await harness.configRepository.load()).profiles.length, 3);
  assert.equal((await harness.settingsAdapter.load()).batchDefaults.concurrency, 3);
  await assert.rejects(
    harness.controller.applyImport(preview),
    error => error.code === 'stale_config_bundle_preview'
  );
});

test('restores domain content when public settings save fails', async () => {
  const harness = createHarness({ failSettingsSave: true });
  const before = await harness.configRepository.load();
  const preview = await harness.controller.previewImport(bundleFixture());

  await assert.rejects(
    harness.controller.applyImport(preview),
    error => error.code === 'config_bundle_apply_failed'
  );
  assert.deepEqual(
    stripRevision(await harness.configRepository.load()),
    stripRevision(before)
  );
});
```

Also assert a rollback write failure returns `config_bundle_rollback_failed`, and a v2
input reaches the existing `domainController.previewImport/applyImport` without calling
`settingsAdapter.save`.

- [ ] **Step 10: Run apply tests and verify RED**

Run: `node --test tests/options-config-bundle-controller.test.mjs`

Expected: FAIL because `applyImport` is absent or incomplete.

- [ ] **Step 11: Implement apply and compensation**

For a v3 preview:

```js
await configRepository.replace(raw.domainPreview.mergedConfig);
try {
  await settingsAdapter.save(raw.importedSettings);
} catch (primaryError) {
  try {
    await configRepository.replace(raw.beforeDomainConfig);
  } catch {
    throw codedError('config_bundle_rollback_failed');
  }
  throw codedError('config_bundle_apply_failed');
}
```

Delete the preview ID before writes so retries cannot reuse it.

- [ ] **Step 12: Run controller and existing domain import tests**

Run:

```bash
node --test \
  tests/options-config-bundle-controller.test.mjs \
  tests/options-safe-settings-adapter.test.mjs \
  tests/domain-config-options-controller.test.mjs \
  tests/domain-config-import-export.test.mjs
```

Expected: PASS.

- [ ] **Step 13: Commit Task 2**

```bash
git add \
  lib/options-safe-settings-adapter.mjs \
  lib/options-config-bundle-controller.mjs \
  tests/options-safe-settings-adapter.test.mjs \
  tests/options-config-bundle-controller.test.mjs
git commit -m "feat: apply unified config bundles"
```

---

### Task 3: Reuse one backup-card view in production and ordinary HTTP

**Files:**

- Create: `lib/options-config-bundle-view.mjs`
- Create: `tests/options-config-bundle-view.test.mjs`
- Modify: `options.html`
- Modify: `options.js`
- Modify: `tests/domain-config-options-page.test.mjs`

**Interfaces:**

- Consumes `controller.exportConfig`, `previewImport`, and `applyImport` from Task 2.
- Produces:

```js
createOptionsConfigBundleView({
  documentRef,
  controller,
  downloadJson,
  onApplied
}): { destroy(): void }
```

- Required DOM IDs:
  - `exportConfigBtn`
  - `importConfigBtn`
  - `importConfigFileInput`
  - `applyImportConfigBtn`
  - `importExportStatus`
  - `importPreviewSummary`

- [ ] **Step 1: Write view RED tests**

```js
test('previews one selected file and applies only after explicit click', async () => {
  const harness = createViewHarness();
  harness.selectJson(bundleFixture());
  await harness.flush();

  assert.match(harness.status(), /新增 6/);
  assert.match(harness.status(), /更新 3/);
  assert.match(harness.status(), /设置变化 3/);
  assert.equal(harness.applyButton.hidden, false);
  assert.equal(harness.controller.applyCalls.length, 0);

  harness.applyButton.click();
  await harness.flush();
  assert.equal(harness.controller.applyCalls.length, 1);
  assert.equal(harness.onAppliedCalls, 1);
});
```

Also cover invalid JSON, conflict codes, repeated selection, disabled busy state, and
destroyed listeners.

- [ ] **Step 2: Run view tests and verify RED**

Run: `node --test tests/options-config-bundle-view.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the pure DOM view**

The view:

- reads `File.text()` only after a selection;
- clears the native input value after each selection;
- renders all strings through `textContent`;
- stores only the opaque returned preview object;
- disables export/import/apply while a command is in flight;
- calls `onApplied(await controller.applyImport(preview))`;
- never references `chrome`, storage keys, or secrets.

- [ ] **Step 4: Run view tests and verify GREEN**

Run: `node --test tests/options-config-bundle-view.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write production composition RED assertions**

Update `tests/domain-config-options-page.test.mjs`:

```js
assert.ok(document.getElementById('importPreviewSummary'));
assert.match(source, /createOptionsConfigBundleController/);
assert.match(source, /createOptionsConfigBundleView/);
assert.match(source, /createSafeOptionsSettingsAdapter\(chrome\.storage\.sync\)/);
assert.doesNotMatch(
  source,
  /JSON\.parse\(await file\.text\(\)\)/
);
```

- [ ] **Step 6: Run page tests and verify RED**

Run:

```bash
node --test \
  tests/domain-config-options-page.test.mjs \
  tests/options-config-bundle-view.test.mjs
```

Expected: FAIL because production composition still owns the old handlers.

- [ ] **Step 7: Integrate the bundle facade and refresh imported controls**

In `options.js`:

1. Keep `domainController` for Profile/Site/Pair editing.
2. Create `safeSettingsAdapter`.
3. Create `bundleController`.
4. Create the backup-card view.
5. On successful apply:
   - refresh `snapshot` from `domainController.snapshot()`;
   - call `renderAll()`;
   - reload LLM Base URL/model into their inputs without touching API Key;
   - reload the outlinks preference and update its button.

Remove the old inline export/import/file/apply event handlers and the page-local
`pendingImportPreview`.

Change copy in `options.html` to say the bundle includes non-sensitive model and batch
defaults but excludes API keys and passwords.

- [ ] **Step 8: Run production composition tests**

Run:

```bash
node --test \
  tests/domain-config-options-page.test.mjs \
  tests/options-config-bundle-view.test.mjs \
  tests/domain-config-options-controller.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
  lib/options-config-bundle-view.mjs \
  options.html \
  options.js \
  tests/options-config-bundle-view.test.mjs \
  tests/domain-config-options-page.test.mjs
git commit -m "feat: add unified config backup controls"
```

---

### Task 4: Ship and validate the 3×3 local dry-run preset

**Files:**

- Create: `examples/autocomment-local-dry-run-config.json`
- Create: `tests/config-bundle-preset.test.mjs`

**Interfaces:**

- Consumes `parseConfigBundle` from Task 1.
- Produces a stable user-importable v3 JSON file.

- [ ] **Step 1: Write the preset RED test before the JSON exists**

```js
test('local preset is one valid safe 3 by 3 dry-run bundle', async () => {
  const raw = JSON.parse(await fs.readFile(
    new URL('../examples/autocomment-local-dry-run-config.json', import.meta.url),
    'utf8'
  ));
  const parsed = parseConfigBundle(raw);
  const domain = parsed.domainConfig;

  assert.equal(domain.profiles.length, 3);
  assert.equal(domain.promotionSites.length, 3);
  assert.equal(domain.assignmentPolicy.pairs.length, 3);
  assert.deepEqual(
    domain.assignmentPolicy.pairs.map(({ weight }) => weight),
    [1, 1, 1]
  );
  assert.equal(domain.assignmentPolicy.quotas.batch, 80);
  assert.equal(domain.assignmentPolicy.quotas.perTargetDomain, 1);
  assert.equal(parsed.batchDefaults.autoGenerate, true);
  assert.equal(parsed.batchDefaults.autoSubmit, false);
  assert.equal(parsed.batchDefaults.concurrency, 3);
  assert.equal(parsed.batchDefaults.timeoutSeconds, 120);
  assert.doesNotMatch(
    JSON.stringify(raw),
    /api[_-]?key|password|secret|token|authorization|credential/i
  );
});
```

- [ ] **Step 2: Run preset test and verify RED**

Run: `node --test tests/config-bundle-preset.test.mjs`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Add the deterministic preset**

Use IDs:

- `test-profile-a`, `test-profile-b`, `test-profile-c`
- `test-site-a`, `test-site-b`, `test-site-c`
- `test-pair-a`, `test-pair-b`, `test-pair-c`

Use Profile values such as `本地测试作者 A`, `Local Test Author A`, and
`local-a@example.test`. Use Site URLs:

- `http://127.0.0.1:4173/promotion/a`
- `http://127.0.0.1:4173/promotion/b`
- `http://127.0.0.1:4173/promotion/c`

Set all deterministic timestamps to `1785110400000`.

- [ ] **Step 4: Run preset and schema tests**

Run:

```bash
node --test \
  tests/config-bundle-preset.test.mjs \
  tests/config-bundle.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add \
  examples/autocomment-local-dry-run-config.json \
  tests/config-bundle-preset.test.mjs
git commit -m "test: add local dry-run config preset"
```

---

### Task 5: Verify the shared UI through ordinary HTTP Chrome

**Files:**

- Create: `tests/fixtures/options-config-bundle-page.html`
- Create: `tests/fixtures/options-config-bundle-app.mjs`
- Modify: `scripts/serve-extension-fixture.js`
- Create: `scripts/run-options-config-bundle-chrome-acceptance.mjs`
- Modify: `package.json`
- Create: `docs/qa/2026-07-27-unified-config-bundle-chrome.md`
- Test: `tests/fixture-server.test.js`
- Test: `tests/domain-config-options-page.test.mjs`

**Interfaces:**

- Fixture imports production `options-config-bundle-view.mjs`,
  `options-config-bundle-controller.mjs`, and `config-bundle.mjs`.
- Fixture-only app injects fake repositories and never appears in production imports.
- Runner command is `npm run test:chrome:config-bundle`.

- [ ] **Step 1: Write fixture server RED tests**

```js
test('serves the ordinary config bundle fixture and production modules', async () => {
  const origin = await listen(createFixtureServer());
  for (const path of [
    '/options-config-bundle/',
    '/tests/fixtures/options-config-bundle-app.mjs',
    '/lib/options-config-bundle-view.mjs',
    '/lib/options-config-bundle-controller.mjs',
    '/lib/config-bundle.mjs'
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
  }
});
```

- [ ] **Step 2: Run fixture tests and verify RED**

Run: `node --test tests/fixture-server.test.js`

Expected: FAIL with a 404 for `/options-config-bundle/`.

- [ ] **Step 3: Add the CSP-safe fixture and routes**

Fixture requirements:

- module script only;
- no inline event handlers;
- no remote resources;
- same backup-card DOM IDs as production;
- fixture adapter imports production modules;
- deterministic fake export, preview, apply, and rollback-error scenarios.

- [ ] **Step 4: Run fixture tests and verify GREEN**

Run: `node --test tests/fixture-server.test.js`

Expected: PASS.

- [ ] **Step 5: Write the Chrome acceptance runner**

Runner assertions:

1. Open ordinary HTTP fixture in installed Chrome.
2. Load `examples/autocomment-local-dry-run-config.json` through a file chooser.
3. Observe preview text for 3 Profiles, 3 Sites, 3 Pairs, and 3 setting groups.
4. Verify fake repositories remain unchanged before apply.
5. Click explicit apply.
6. Verify rendered defaults: generate on, submit off, concurrency 3, timeout 120.
7. Re-import and verify update—not duplicate—semantics.
8. Switch fixture to a settings-save failure and verify rollback error plus unchanged domain content.
9. Assert `pageErrors: []` and third-party requests `0`.

Add:

```json
"test:chrome:config-bundle": "node scripts/run-options-config-bundle-chrome-acceptance.mjs"
```

- [ ] **Step 6: Run Chrome acceptance and verify GREEN**

Run: `npm run test:chrome:config-bundle`

Expected JSON:

```json
{
  "ok": true,
  "profiles": 3,
  "promotionSites": 3,
  "pairs": 3,
  "autoGenerate": true,
  "autoSubmit": false,
  "concurrency": 3,
  "timeoutSeconds": 120,
  "repeatImport": "updates_without_duplicates",
  "rollback": "content_restored",
  "pageErrors": [],
  "thirdPartyRequests": 0
}
```

- [ ] **Step 7: Record QA evidence**

Write the exact Chrome version, command, result JSON, and the limitation that the user's
`chrome-extension://` settings page must be manually opened locally.

- [ ] **Step 8: Run complete verification**

Run:

```bash
npm test
npm run test:sync-worker
npm run typecheck:sync-worker
npm --prefix cloudflare-sync run deploy:dry
npm run test:chrome:config-bundle
npm run test:chrome:console
for file in $(rg --files -g '*.js' -g '*.mjs'); do
  node --check "$file" || exit 1
done
git diff --check
```

Expected:

- every command exits `0`;
- Node reports `0` failing tests;
- Worker reports `99` passing tests;
- both Chrome acceptance runners report `"ok": true`;
- no third-party request or submission occurs.

- [ ] **Step 9: Commit Task 5**

```bash
git add \
  tests/fixtures/options-config-bundle-page.html \
  tests/fixtures/options-config-bundle-app.mjs \
  scripts/serve-extension-fixture.js \
  scripts/run-options-config-bundle-chrome-acceptance.mjs \
  package.json \
  tests/fixture-server.test.js \
  tests/domain-config-options-page.test.mjs \
  docs/qa/2026-07-27-unified-config-bundle-chrome.md
git commit -m "test: verify config bundle in Chrome"
```

---

### Task 6: Final review, push, and PR

**Files:**

- Review all files changed by Tasks 1–5.
- Modify only files required by review findings.

**Interfaces:**

- Produces one merge-ready branch and PR against `master`.

- [ ] **Step 1: Review the complete branch against the approved spec**

Check:

- each v3 field maps to one explicit allowlisted storage key;
- sensitive fields are rejected recursively;
- v2/legacy imports do not write public settings;
- preview does not write;
- apply cannot reuse a preview;
- rollback tests prove restored domain content;
- production modules do not import fixture code;
- example config passes the production parser.

- [ ] **Step 2: Run final fresh verification**

Run all commands from Task 5 Step 8 again after the last review change.

Expected: all exit `0`.

- [ ] **Step 3: Verify branch state**

```bash
git status --short
git log --oneline --decorate origin/master..HEAD
git diff --check origin/master...HEAD
```

Expected: clean status, only the planned commits, and no whitespace errors.

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin codex/unified-config-import-export
gh pr create \
  --base master \
  --head codex/unified-config-import-export \
  --title "feat: add unified config import and export" \
  --body "Adds a versioned secret-free settings bundle, backward-compatible imports, and a directly importable 3×3 local dry-run preset."
```

- [ ] **Step 5: Report local test handoff**

Report:

- PR URL;
- latest commit hash;
- example JSON path;
- exact local commands to pull/reload;
- the one remaining manual action: enter the local OpenRouter API Key once.
