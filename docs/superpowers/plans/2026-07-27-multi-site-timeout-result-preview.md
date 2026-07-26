# Multi-Site Timeout and Result Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the completed multi-Profile/multi-Promotion-Site branch, then make each worker obey a configurable page deadline, freeze terminal elapsed time, honor non-submit automation modes, and show safe comment/anchor/promotion previews in the operations console.

**Architecture:** Merge the assignment-aware checkpoint v3 implementation before changing runtime behavior, so new work targets the canonical `profileId` model once. Keep Chrome APIs at adapters/composition roots, add small testable modules for handle dispatch, task deadlines, and result-preview normalization, and let the console consume immutable checkpoint fields without querying IndexedDB during render.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript ES modules and classic content scripts, Node.js built-in test runner, JSDOM, Playwright/installed Chrome, local HTTP fixtures.

## Global Constraints

- Work only in `/Users/moltbot/.codex/worktrees/5587/autoComment`; preserve unrelated user changes.
- Canonical task identity is `profileId`, never `identityId`, for checkpoint v3 and new interfaces.
- Passwords, API keys, cookies, authorization values and tokens must never enter checkpoint, `BATCH_HANDLE`, submit context, results, history exports or logs.
- Production view modules must not access `chrome.*` at import or render time.
- Manifest V3 CSP must retain `script-src 'self'`, `object-src 'none'`, and no `unsafe-inline` or `unsafe-eval`.
- Keep `"tabs"` permission and `connect-src https: http:` in the final manifest.
- Use packaged styles only; remove all inline `<style>` elements and `style` attributes from extension pages.
- Do not use remote images or third-party resources.
- Do not submit comments to third-party websites during tests or acceptance.
- Every production behavior change follows RED → GREEN → REFACTOR, with the failing test observed before implementation.
- Real Chrome acceptance uses five local fixture URLs with concurrency `3`.

---

### Task 1: Preserve the Current Security and Acceptance Baseline

**Files:**
- Modify: `manifest.json`
- Modify: `tests/extension-page-csp.test.mjs`
- Modify: `.superpowers/sdd/2026-07-26-batch-operations-console/progress.md`
- Delete: `tests/fixtures/extension-checkpoint-inspector.html`
- Delete: `tests/fixtures/extension-checkpoint-inspector.mjs`
- Delete: `tests/fixtures/extension-checkpoint-inspector2.html`
- Delete: `tests/fixtures/extension-checkpoint-inspector2.mjs`
- Delete: `tests/fixtures/extension-checkpoint-inspector3.html`
- Delete: `tests/fixtures/extension-checkpoint-inspector3.mjs`
- Delete: `tests/fixtures/extension-result-inspector.html`
- Delete: `tests/fixtures/extension-result-inspector.mjs`
- Modify: `docs/qa/2026-07-26-batch-operations-console-chrome.md`
- Keep: `docs/qa/screenshots/batch-console-1440.png`
- Keep: `docs/qa/screenshots/batch-console-1024.png`
- Keep: `docs/qa/screenshots/batch-console-640.png`
- Keep: `docs/qa/screenshots/batch-extension-running-3.png`
- Delete: `docs/qa/screenshots/batch-extension-desktop-csv-safe.png`

**Interfaces:**
- Produces: a clean commit that guarantees tab metadata permission and CSP-safe OpenRouter connections before branch integration.
- Consumes: existing `tests/extension-page-csp.test.mjs`.

- [ ] **Step 1: Remove temporary inspector pages and misleading third-party screenshot**

Use `apply_patch` to delete every inspector listed above and
`docs/qa/screenshots/batch-extension-desktop-csv-safe.png`. Do not add inspector
pages to the production package.

- [ ] **Step 2: Correct the acceptance record**

Replace the unverified statement `Third-party comments posted: No` with an
incident note explaining that a real-site diagnostic exposed an `autoSubmit`
contract bug, workers were stopped, and final acceptance will be local-only.
Do not claim whether remote comments were or were not accepted when that is
unknown.

- [ ] **Step 3: Run the focused permission and CSP tests**

Run:

```bash
node --test tests/extension-page-csp.test.mjs
```

Expected: all tests PASS, including the `"tabs"` permission assertion, packaged
options styles, and `connect-src` policy.

- [ ] **Step 4: Run syntax and diff checks**

Run:

```bash
node --check content.js
node --check background.js
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit the baseline**

```bash
git add manifest.json tests/extension-page-csp.test.mjs \
  .superpowers/sdd/2026-07-26-batch-operations-console/progress.md \
  docs/qa
git commit -m "fix: require tab proof for batch workers"
```

### Task 2: Perform a Controlled Multi-Site Branch Integration

**Files:**
- Merge: `codex/multi-identity-promotion-batch` at `f3f4575`
- Resolve: `options.html`
- Resolve: `scripts/serve-extension-fixture.js`
- Resolve: `tests/fixture-server.test.js`
- Resolve: `tests/fixtures/comment-page.html`
- Verify: `manifest.json`
- Modify: `styles/options.css`
- Test: `tests/extension-page-csp.test.mjs`
- Test: `tests/domain-config-options-page.test.mjs`

**Interfaces:**
- Consumes: checkpoint v3, `profileId`, `promotionSiteId`, domain config repository, assignment plan compiler and Profile secret vault from the multi-site branch.
- Produces: one integrated branch with multiple Promotion Sites and the current console/CSP fixture baseline.

- [ ] **Step 1: Confirm both source worktrees are clean enough to merge**

Run:

```bash
git status --short
git -C /Users/moltbot/.codex/worktrees/b6e7/autoComment status --short
git rev-parse codex/multi-identity-promotion-batch
```

Expected: current worktree has no uncommitted product changes, source worktree is
clean, and the source hash is `f3f457595c4d39830bc2d856ab97e33be597dbd1`.

- [ ] **Step 2: Merge without committing**

Run:

```bash
git merge --no-ff --no-commit codex/multi-identity-promotion-batch
```

Expected: conflicts only in the four files predicted by `git merge-tree`.

- [ ] **Step 3: Resolve the settings page in favor of CSP-safe composition**

Keep the multi-site semantic controls:

```text
profileSelect, promotionSiteSelect, pairSelect, defaultPairSelect,
quotaBatch, quotaProfile, quotaPromotionSite, quotaTargetDomain
```

Keep the current packaged stylesheet link:

```html
<link rel="stylesheet" href="styles/options.css" />
```

Move every merged inline declaration into named classes in
`styles/options.css`. The resolved HTML must satisfy:

```js
assert.equal(document.querySelector('style'), null);
assert.equal(document.querySelector('[style]'), null);
```

- [ ] **Step 4: Resolve the fixture files by preserving both capabilities**

`scripts/serve-extension-fixture.js` must retain:

- the current five-target local console fixture and bounded model endpoint;
- the multi-assignment five-target endpoints and submission recorder;
- dynamic `127.0.0.1` ports;
- no outbound network fallback.

`tests/fixture-server.test.js` must assert both fixture families. The merged
`tests/fixtures/comment-page.html` must retain deterministic delay controls and
the multi-assignment capture fields.

- [ ] **Step 5: Resolve the manifest semantically**

The final manifest must include:

```json
{
  "permissions": ["activeTab", "tabs", "storage", "unlimitedStorage", "alarms", "notifications", "power"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'; default-src 'self'; connect-src https: http:; base-uri 'none'"
  }
}
```

Keep `lib/batch-task-config.js` before `content.js` in content-script order.

- [ ] **Step 6: Run integration-focused tests**

Run:

```bash
node --test \
  tests/extension-page-csp.test.mjs \
  tests/domain-config-options-page.test.mjs \
  tests/domain-config-schema.test.mjs \
  tests/domain-config-migration.test.mjs \
  tests/batch-plan-compiler.test.mjs \
  tests/batch-multi-assignment-integration.test.js \
  tests/fixture-server.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the merge**

```bash
git add -A
git commit -m "merge: integrate multi-site batch assignments"
```

### Task 3: Add Safe Result Preview Fields to Checkpoint v3

**Files:**
- Create: `lib/batch-result-preview.mjs`
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `background.js`
- Modify: `lib/batch-result-record.mjs`
- Test: `tests/batch-result-preview.test.mjs`
- Test: `tests/batch-runtime-checkpoint.test.mjs`
- Test: `tests/batch-runtime-controller.test.mjs`
- Test: `tests/multi-identity-privacy.test.mjs`

**Interfaces:**
- Produces:

```js
normalizeBatchResultPreview({
  commentText,
  anchors,
  promotedWebsiteUrl
}) => {
  commentText: string | null,
  anchorTexts: string[],
  promotedWebsiteUrl: string | null
}
```

- Consumes: `message.history.commentText`, `message.history.anchors[]`, and `message.history.promotedWebsiteUrl` from the already captured submission boundary.

- [ ] **Step 1: Write failing normalization tests**

Add tests that expect:

```js
assert.deepEqual(normalizeBatchResultPreview({
  commentText: '  Full   comment ',
  anchors: [
    { text: ' Product A ', href: 'https://promo.test/a' },
    { text: 'Product A', href: 'https://promo.test/a' },
    { text: 'Docs', href: 'javascript:alert(1)' }
  ],
  promotedWebsiteUrl: 'https://promo.test/path'
}), {
  commentText: 'Full comment',
  anchorTexts: ['Product A', 'Docs'],
  promotedWebsiteUrl: 'https://promo.test/path'
});
```

Also expect overlong text to be bounded, URL credentials/non-HTTP protocols to
be rejected, and recursive sensitive keys to throw
`sensitive_result_preview`.

- [ ] **Step 2: Run the new test and observe RED**

```bash
node --test tests/batch-result-preview.test.mjs
```

Expected: FAIL because `lib/batch-result-preview.mjs` does not exist.

- [ ] **Step 3: Implement the normalizer**

Use `textContent`-ready plain strings only. Normalize whitespace, deduplicate
anchor text in encounter order, cap comment text at `20_000` characters,
individual anchor text at `1_000`, anchor count at `100`, and URL length at
`2_048`.

- [ ] **Step 4: Write failing checkpoint propagation tests**

Create a terminal confirmation containing history preview values and assert the
checkpoint result persists exactly:

```js
{
  commentText: 'Actual submitted comment',
  anchorTexts: ['Product A'],
  promotedWebsiteUrl: 'https://promo.test/'
}
```

Add a legacy checkpoint case with none of the fields and expect normalized
`null`, `[]`, `null` without rejecting the checkpoint.

- [ ] **Step 5: Run checkpoint tests and observe RED**

```bash
node --test \
  tests/batch-runtime-checkpoint.test.mjs \
  tests/batch-runtime-controller.test.mjs
```

Expected: new preview assertions FAIL because terminal results drop the fields.

- [ ] **Step 6: Propagate only normalized preview values**

Normalize at background confirmation ingress, pass the three fields through the
terminal result reducer, checkpoint result schema, and result export record.
Never persist `history.commentHtml` in the checkpoint.

- [ ] **Step 7: Verify privacy and propagation GREEN**

```bash
node --test \
  tests/batch-result-preview.test.mjs \
  tests/batch-runtime-checkpoint.test.mjs \
  tests/batch-runtime-controller.test.mjs \
  tests/multi-identity-privacy.test.mjs
```

Expected: all tests PASS and privacy sentinel paths remain limited to approved
secret stores.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-result-preview.mjs lib/batch-runtime-checkpoint.mjs \
  lib/batch-runtime-controller.mjs lib/batch-result-record.mjs background.js \
  tests/batch-result-preview.test.mjs tests/batch-runtime-checkpoint.test.mjs \
  tests/batch-runtime-controller.test.mjs tests/multi-identity-privacy.test.mjs
git commit -m "feat: persist safe batch result previews"
```

### Task 4: Acknowledge Handles Immediately and Freeze Automation Settings

**Files:**
- Create: `lib/batch-handle-dispatch.js`
- Modify: `lib/batch-task-config.js`
- Modify: `lib/batch-worker-runtime.mjs`
- Modify: `content.js`
- Modify: `manifest.json`
- Test: `tests/batch-handle-dispatch.test.js`
- Test: `tests/batch-task-config.test.js`
- Test: `tests/batch-worker-runtime.test.mjs`

**Interfaces:**
- Produces:

```js
AutoCommentBatchHandleDispatch.dispatch(message, sendResponse, {
  validate,
  isRunning,
  setContext,
  runTask,
  reportError
}) => boolean
```

- Extends the safe handle with:

```js
automation: {
  autoGenerate: boolean,
  autoSubmit: boolean,
  autoOpenPanel: boolean
}
```

- [ ] **Step 1: Write a failing immediate-ack test**

Load the real classic script in a VM. Dispatch a valid handle whose `runTask`
returns a never-settling promise and assert synchronously:

```js
assert.deepEqual(responses, [{
  ok: true,
  accepted: true,
  urlIndex: 2
}]);
assert.equal(dispatchResult, true);
assert.equal(runCalls.length, 1);
```

Add rejection tests for invalid and duplicate tasks.

- [ ] **Step 2: Observe RED**

```bash
node --test tests/batch-handle-dispatch.test.js
```

Expected: FAIL because the dispatcher script is missing.

- [ ] **Step 3: Implement the dispatcher and integrate content listener**

The dispatcher must call `sendResponse` before scheduling `runTask` with
`Promise.resolve().then(...)`. A later task failure is reported through
`reportError`; it cannot attempt a second response.

- [ ] **Step 4: Write failing handle-setting tests**

Expect the worker handle to include immutable booleans copied from
`checkpoint.settings`. Expect `batch-task-config` to reject missing, unknown or
non-boolean automation values and sensitive aliases.

- [ ] **Step 5: Observe RED**

```bash
node --test \
  tests/batch-task-config.test.js \
  tests/batch-worker-runtime.test.mjs
```

Expected: new automation payload assertions FAIL.

- [ ] **Step 6: Extend the handle contract**

Add `automation` to exact handle keys, deep-freeze it with the task config, and
pass:

```js
automation: {
  autoGenerate: checkpoint.settings.autoGenerate === true,
  autoSubmit: checkpoint.settings.autoSubmit === true,
  autoOpenPanel: checkpoint.settings.autoOpenPanel === true
}
```

Do not read global `batch_task_settings` during owned batch execution.

- [ ] **Step 7: Verify GREEN**

```bash
node --test \
  tests/batch-handle-dispatch.test.js \
  tests/batch-task-config.test.js \
  tests/batch-worker-runtime.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-handle-dispatch.js lib/batch-task-config.js \
  lib/batch-worker-runtime.mjs content.js manifest.json \
  tests/batch-handle-dispatch.test.js tests/batch-task-config.test.js \
  tests/batch-worker-runtime.test.mjs
git commit -m "fix: acknowledge batch handles before automation"
```

### Task 5: Honor Generate-Only and Manual Automation Modes

**Files:**
- Modify: `content.js`
- Modify: `lib/batch-error-policy.mjs`
- Test: `tests/comment-history-submit-flow.test.js`
- Test: `tests/batch-error-policy.test.mjs`

**Interfaces:**
- Consumes: `AutoCommentBatchTaskConfig.getCurrent().automation`.
- Produces:
  - `autoSubmit: true`: existing generate/fill/submit path.
  - `autoGenerate: true, autoSubmit: false`: generate/fill then durable `manual_required`.
  - both false: detect form then durable `manual_required` without model generation or click.

- [ ] **Step 1: Write failing no-submit tests**

Exercise the real extracted `handleBatchTask` flow with a frozen task config.
For generate-only assert:

```js
assert.equal(generateCalls, 1);
assert.equal(fillCalls > 0, true);
assert.equal(clickCalls, 0);
assert.equal(markSubmittingCalls, 0);
assert.equal(persistSubmitContextCalls, 0);
assert.equal(confirmation.result, 'manual_required');
```

For manual mode assert generation, submitting context and click counts are all
zero.

- [ ] **Step 2: Observe RED**

```bash
node --test tests/comment-history-submit-flow.test.js
```

Expected: FAIL because the owned batch path clicks submit regardless of settings.

- [ ] **Step 3: Implement mode gates before submission state**

For generate-only, write the preview and report:

```js
{
  result: 'manual_required',
  errorCode: 'manual_submission_required',
  errorMessage: '评论内容已生成并填充，等待人工提交'
}
```

For manual mode use `manual_generation_required` with a clear message. Neither
code implies a possible prior submission.

- [ ] **Step 4: Add error policy labels**

Both new codes use retry policy `confirm` and must display manual-processing
copy distinct from `submission_uncertain`.

- [ ] **Step 5: Verify GREEN**

```bash
node --test \
  tests/comment-history-submit-flow.test.js \
  tests/batch-error-policy.test.mjs
```

Expected: all tests PASS with zero click/context calls in non-submit modes.

- [ ] **Step 6: Commit**

```bash
git add content.js lib/batch-error-policy.mjs \
  tests/comment-history-submit-flow.test.js tests/batch-error-policy.test.mjs
git commit -m "fix: honor batch submission modes"
```

### Task 6: Enforce an Independent Deadline Per Task

**Files:**
- Create: `lib/batch-task-deadlines.mjs`
- Modify: `lib/batch-worker-runtime.mjs`
- Test: `tests/batch-task-deadlines.test.mjs`
- Test: `tests/batch-worker-runtime.test.mjs`

**Interfaces:**
- Produces:

```js
createBatchTaskDeadlines({
  clock,
  timers,
  onExpire
}) => {
  arm(identity, startedAt, timeoutSeconds),
  cancel(identity),
  clear()
}
```

where identity is `{ batchId, urlIndex, attempt }`.

- [ ] **Step 1: Write failing deadline unit tests**

Use deterministic fake timers. Assert `arm` schedules exactly
`max(0, startedAt + timeoutSeconds * 1000 - clock())`, rearming the same identity
cancels the old timer, and `cancel`/`clear` prevent expiration.

- [ ] **Step 2: Observe RED**

```bash
node --test tests/batch-task-deadlines.test.mjs
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the deadline registry**

Key timers by `batchId:urlIndex:attempt`. Remove the timer from the registry
before awaiting `onExpire` so reentrant finalization cannot fire twice.

- [ ] **Step 4: Write failing runtime integration tests**

Cover:

1. a handle that acknowledges immediately but never confirms;
2. an opening tab promise that never resolves;
3. a submitting task that expires;
4. a manually closed active tab;
5. a late confirmation after timeout.

For case 1 with concurrency 1 and two tasks, advance to the configured deadline
and assert:

```js
assert.equal(firstResult.errorCode, 'task_timeout');
assert.deepEqual(tabsApi.removeCalls, [100]);
assert.equal(sentHandles.at(-1).urlIndex, 1);
```

- [ ] **Step 5: Observe RED**

```bash
node --test tests/batch-worker-runtime.test.mjs
```

Expected: new tests FAIL because correctness still relies on shared interval
callbacks.

- [ ] **Step 6: Integrate deadlines with finalizer ownership**

Arm when an opening reservation is created. Rearm from the same original
`startTime` when it becomes active. Cancel only after the unique finalizer owns
the terminal transition. On resume, rebuild deadlines from checkpoint
`startedAt`; do not grant a new full duration.

Keep the one-second scanner only as reconciliation fallback.

- [ ] **Step 7: Verify GREEN and race safety**

```bash
node --test \
  tests/batch-task-deadlines.test.mjs \
  tests/batch-worker-runtime.test.mjs \
  tests/batch-multi-window-integration.test.js
```

Expected: all tests PASS; each identity has at most one terminal payload.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-task-deadlines.mjs lib/batch-worker-runtime.mjs \
  tests/batch-task-deadlines.test.mjs tests/batch-worker-runtime.test.mjs
git commit -m "fix: enforce per-task batch deadlines"
```

### Task 7: Freeze Terminal Elapsed Time in the Console

**Files:**
- Modify: `lib/batch-console-state.mjs`
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Test: `tests/batch-console-state.test.mjs`
- Test: `tests/batch-runtime-checkpoint.test.mjs`

**Interfaces:**
- Consumes: terminal result `elapsed` in seconds.
- Produces: terminal row `elapsedMs` that is independent of render `now`.

- [ ] **Step 1: Write a failing terminal freeze regression**

Create one terminal result with `elapsed: 8`, render at `now: 10_000` and again
at `now: 900_000`, then assert:

```js
assert.equal(first.rows[0].elapsedMs, 8_000);
assert.equal(second.rows[0].elapsedMs, 8_000);
```

Add a closed active task transition and assert its terminal reducer stores an
elapsed value before clearing `startedAt`.

- [ ] **Step 2: Observe RED**

```bash
node --test \
  tests/batch-console-state.test.mjs \
  tests/batch-runtime-checkpoint.test.mjs
```

Expected: at least the closed-active regression FAILS before the runtime/result
normalization change.

- [ ] **Step 3: Make terminal elapsed authoritative**

Use result elapsed first for any terminal row. Calculate elapsed during the
terminal transition from the task’s original `startedAt`, then clear active
ownership. Never derive terminal elapsed from current render time.

- [ ] **Step 4: Verify GREEN**

Run the same two test files and expect all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/batch-console-state.mjs lib/batch-runtime-checkpoint.mjs \
  tests/batch-console-state.test.mjs tests/batch-runtime-checkpoint.test.mjs
git commit -m "fix: freeze terminal task durations"
```

### Task 8: Render Comment, Anchor and Promotion Previews Accessibly

**Files:**
- Create: `lib/batch-overflow-preview.mjs`
- Modify: `lib/batch-console-state.mjs`
- Modify: `lib/batch-console-view.mjs`
- Modify: `styles/batch-console.css`
- Test: `tests/batch-overflow-preview.test.mjs`
- Test: `tests/batch-console-state.test.mjs`
- Test: `tests/batch-console-view.test.mjs`
- Test: `tests/batch-console-fixture.test.mjs`

**Interfaces:**
- Produces rows with:

```js
{
  commentText: string | null,
  anchorTexts: string[],
  promotedWebsiteUrl: string | null,
  promotionSiteLabel: string
}
```

- Produces `installBatchOverflowPreview(root)` for delegated hover, focus,
Escape and teardown behavior without Chrome dependencies.

- [ ] **Step 1: Write failing state/search tests**

Expect result fields to project to the row, fallback comment text to
`aiContent`, fallback promoted website to the frozen checkpoint Site URL, and
keyword search to match comment, anchor and promotion values.

- [ ] **Step 2: Observe RED**

```bash
node --test tests/batch-console-state.test.mjs
```

Expected: new field and search assertions FAIL.

- [ ] **Step 3: Implement state projection**

Prefer actual result values. Use checkpoint v3 Site snapshots only as display
fallback; do not fabricate anchor text.

- [ ] **Step 4: Write failing view and interaction tests**

Expect desktop headers:

```text
评论文本, 锚文本, 推广网站
```

Expect each non-empty cell to contain a keyboard-focusable
`[data-overflow-preview]`, no `title` attribute, and a single
`role="tooltip"` layer that opens for hover/focus, closes on Escape and restores
no unrelated focus.

Expect the details drawer to show complete values and mobile cards to show the
comment summary and promotion domain.

- [ ] **Step 5: Observe RED**

```bash
node --test \
  tests/batch-overflow-preview.test.mjs \
  tests/batch-console-view.test.mjs \
  tests/batch-console-fixture.test.mjs
```

Expected: FAIL because columns and overflow controller do not exist.

- [ ] **Step 6: Implement accessible truncation**

Render plain text with `textContent`. CSS uses:

```css
.batch-console__preview-text {
  display: block;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

The tooltip is a shared DOM layer positioned from
`getBoundingClientRect()`, referenced by `aria-describedby`, and never copies
HTML.

- [ ] **Step 7: Verify GREEN at all layouts**

Run the three view/fixture test files and expect all tests PASS at the existing
1440, 1024 and 640 layout contracts.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-overflow-preview.mjs lib/batch-console-state.mjs \
  lib/batch-console-view.mjs styles/batch-console.css \
  tests/batch-overflow-preview.test.mjs tests/batch-console-state.test.mjs \
  tests/batch-console-view.test.mjs tests/batch-console-fixture.test.mjs
git commit -m "feat: show batch comment and promotion previews"
```

### Task 9: Extend the Local Fixture for Deadline and Preview Acceptance

**Files:**
- Modify: `scripts/serve-extension-fixture.js`
- Modify: `tests/fixture-server.test.js`
- Modify: `tests/fixtures/comment-page.html`
- Modify: `tests/fixtures/comment-page-submit.js`
- Modify: `tests/fixtures/batch-targets.csv`
- Modify: `scripts/run-multi-assignment-chrome-acceptance.mjs`
- Test: `tests/fixture-server.test.js`

**Interfaces:**
- Produces five local targets, one deterministic timeout target, captured
comment/anchor/promotion fields, and zero outbound requests.

- [ ] **Step 1: Write failing fixture assertions**

Assert:

- one target delays beyond a test timeout;
- completed targets record comment text, normalized anchor text and promotion
  URL;
- generate-only mode records no submit request;
- fixture server rejects unknown paths and does not proxy.

- [ ] **Step 2: Observe RED**

```bash
node --test tests/fixture-server.test.js
```

Expected: new endpoint and recorder assertions FAIL.

- [ ] **Step 3: Implement deterministic fixture behavior**

Use query/path flags interpreted only by local fixture scripts. Store only safe
task fields in process memory; record password presence as a boolean, never the
password value.

- [ ] **Step 4: Update Chrome acceptance assertions**

The runner must assert:

```js
maxConcurrency === 3
terminalElapsedBeforeWait === terminalElapsedAfterWait
thirdPartySubmissions === 0
generateOnlySubmitCount === 0
```

and check preview values for at least one success row.

- [ ] **Step 5: Verify GREEN**

```bash
node --test tests/fixture-server.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/serve-extension-fixture.js \
  scripts/run-multi-assignment-chrome-acceptance.mjs \
  tests/fixture-server.test.js tests/fixtures/comment-page.html \
  tests/fixtures/comment-page-submit.js tests/fixtures/batch-targets.csv
git commit -m "test: cover batch deadlines and result previews"
```

### Task 10: Full Verification and Real Chrome Acceptance

**Files:**
- Modify: `docs/qa/2026-07-27-multi-site-timeout-result-preview-chrome.md`
- Add screenshots under: `docs/qa/screenshots/`

**Interfaces:**
- Consumes: integrated unpacked extension and local fixture.
- Produces: reproducible verification record with no third-party submission.

- [ ] **Step 1: Run the complete extension suite**

```bash
npm test
```

Expected: zero failures.

- [ ] **Step 2: Run every JavaScript syntax check**

```bash
git ls-files '*.js' '*.mjs' -z |
  xargs -0 -n1 node --check
```

Expected: zero failures.

- [ ] **Step 3: Run Worker tests and typecheck**

```bash
npm --prefix cloudflare-sync test
npm --prefix cloudflare-sync run typecheck
```

Expected: all Worker tests PASS and TypeScript exits `0`.

- [ ] **Step 4: Reload the unpacked extension**

Reload `/Users/moltbot/.codex/worktrees/5587/autoComment` in the existing
acceptance Chrome profile. Verify the settings page loads packaged CSS and lists
multiple Promotion Sites.

- [ ] **Step 5: Run local Chrome concurrency acceptance**

Start the local fixture, import its five local URLs, set concurrency to `3` and
a short page timeout, then verify:

- exactly three same-window worker tabs;
- the hanging task closes at its configured deadline and the next queued task
  starts;
- terminal elapsed values do not change after waiting;
- comment, anchor and promotion columns truncate visually;
- hover and keyboard focus expose full values;
- generate-only mode never submits;
- no navigation leaves `127.0.0.1`;
- third-party submission count is `0`.

- [ ] **Step 6: Capture responsive evidence**

Capture 1440, 1024 and 640 screenshots with the new preview fields and one
tooltip/focus state. Do not include API keys, passwords or unrelated personal
tabs.

- [ ] **Step 7: Write the QA record**

Record exact commit, Chrome version, fixture origin, configured timeout,
concurrency, five terminal outcomes, frozen elapsed comparison, preview values,
and zero third-party submissions.

- [ ] **Step 8: Run final repository checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended QA files uncommitted.

- [ ] **Step 9: Commit verification evidence**

```bash
git add docs/qa
git commit -m "docs: verify multi-site batch console in Chrome"
```

### Task 11: Final Review and Branch Handoff

**Files:**
- Review all changes since: `90a0cb1`
- Update: `.superpowers/sdd/2026-07-26-batch-operations-console/progress.md`

**Interfaces:**
- Produces: a clean, mergeable commit range and explicit downstream integration notes.

- [ ] **Step 1: Inspect the complete diff**

```bash
git diff --stat 90a0cb1..HEAD
git diff --check 90a0cb1..HEAD
git log --oneline 90a0cb1..HEAD
```

Expected: changes match this plan; no temporary inspectors or secrets.

- [ ] **Step 2: Scan privacy-critical surfaces**

```bash
rg -n -i "password|api.?key|authorization|cookie|token" \
  lib/batch-* content.js background.js tests/multi-identity-privacy.test.mjs
```

Review every match. Expected: secrets occur only in approved local repositories,
minimal background retrieval, tests and user-input controls.

- [ ] **Step 3: Run the final focused safety set**

```bash
node --test \
  tests/extension-page-csp.test.mjs \
  tests/multi-identity-privacy.test.mjs \
  tests/batch-worker-runtime.test.mjs \
  tests/comment-history-submit-flow.test.js \
  tests/batch-console-state.test.mjs \
  tests/batch-console-view.test.mjs
```

Expected: all PASS.

- [ ] **Step 4: Update the progress ledger and commit**

Record exact test totals, Chrome acceptance results, the merge commit, and the
canonical `profileId` handoff.

```bash
git add .superpowers/sdd/2026-07-26-batch-operations-console/progress.md
git commit -m "docs: complete multi-site console handoff"
```

- [ ] **Step 5: Confirm clean handoff**

```bash
git status --short
git rev-parse HEAD
```

Expected: clean status and one explicit mergeable commit hash for the user.
