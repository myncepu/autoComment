# Batch Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AutoComment’s single-column batch page with a profile-ready desktop operations console that exposes creation preflight, concurrent worker slots, task-level phases and recovery-safe retry/manual actions.

**Architecture:** Keep the existing scheduler, background checkpoint single-writer and submission recovery behavior, while replacing automatic worker windows with background tabs in the console's Chrome window. Add a versioned attempt-aware checkpoint, pure preflight/error/view-model modules, a command controller around Chrome side effects, local DOM views, and a shared extension shell. `batch.js` becomes the composition root instead of continuing to own parsing, rendering and lifecycle rules.

**Tech Stack:** Manifest V3 Chrome extension, local ES modules and classic content scripts, Chrome storage/tabs/windows/power APIs, HTML/CSS, Node.js `>=18`, `node:test`, `jsdom`, `fake-indexeddb`, vendored PapaParse, local HTTP fixtures.

## Global Constraints

- Work only on branch `codex/batch-operations-console` in `/Users/moltbot/.codex/worktrees/5587/autoComment`; preserve unrelated user changes.
- Use test-driven development: add one focused failing test, run it to observe the expected failure, implement the minimum behavior, rerun the focused test, then run the affected suite.
- Keep one active batch, one default identity and one default promotion site; establish `identityId` / `promotionSiteId` contracts without implementing multi-profile scheduling.
- Keep batch concurrency within `1–10`, default `3`, and timeout within `10–600` seconds.
- Background remains the only writer of `batchRuntimeCheckpoint`.
- Never automatically retry a task whose result may already have been submitted.
- Manual-processing windows must not receive `BATCH_HANDLE`, must not occupy worker slots, and must not auto-generate, fill or submit.
- Automatic workers use `chrome.tabs.create({ windowId: consoleWindowId, url, active: false })`; they never create or remove Chrome windows. `tabId` is the managed resource identity.
- Use only extension-local CSS, SVG and JavaScript plus system fonts; do not add remote images, fonts, modules or inline event handlers.
- Preserve Manifest V3/CSP compatibility.
- Real Chrome acceptance must use five local fixture URLs and a local OpenAI-compatible stub; it must not publish comments to a third-party site.
- Every task ends with a focused green test run and a small commit.

## File Structure

### New production files

- `styles/tokens.css` — shared color, spacing, radius, typography and focus variables.
- `styles/app-shell.css` — shared header/navigation and responsive navigation styles.
- `styles/batch-console.css` — batch console, wizard, queue, slot, details, dialogs and responsive layouts.
- `lib/app-shell.mjs` — shared navigation model and DOM shell bootstrap.
- `lib/batch-profile-contract.mjs` — default identity/promotion-site assignment snapshots.
- `lib/batch-error-policy.mjs` — structured batch error messages and retry policies.
- `lib/batch-preflight.mjs` — CSV decoding adapter, URL normalization and per-row preflight.
- `lib/batch-console-state.mjs` — pure `BatchConsoleSnapshot` derivation.
- `lib/batch-command-controller.mjs` — semantic start/pause/resume/stop/retry/manual/offline commands.
- `lib/batch-worker-runtime.mjs` — existing scheduler/window/timeout side effects extracted from `batch.js`.
- `lib/batch-wizard-view.mjs` — accessible four-step creation flow.
- `lib/batch-console-view.mjs` — accessible console rendering and event delegation.
- `lib/batch-phase-reporter.js` — classic content-script helper for attempt-aware controlled phase messages.

### New test and QA files

- `tests/batch-profile-contract.test.mjs`
- `tests/batch-error-policy.test.mjs`
- `tests/batch-preflight.test.mjs`
- `tests/batch-console-state.test.mjs`
- `tests/batch-command-controller.test.mjs`
- `tests/batch-worker-runtime.test.mjs`
- `tests/batch-wizard-view.test.mjs`
- `tests/batch-console-view.test.mjs`
- `tests/app-shell.test.mjs`
- `tests/batch-phase-reporter.test.js`
- `tests/batch-console-accessibility.test.mjs`
- `tests/helpers/batch-console-fixtures.mjs`
- `tests/fixtures/batch-targets.csv`
- `docs/qa/2026-07-26-batch-operations-console-chrome.md`

### Modified production files

- `batch.html` — replace the long form with shell, console and wizard mount points.
- `batch.js` — reduce to dependency construction, boot, subscriptions and teardown.
- `options.html`, `options.js` — add shared navigation and identity/promotion/settings sections.
- `history.html`, `history.js` — add shared navigation without changing history queries.
- `manifest.json` — load `lib/batch-phase-reporter.js` before `content.js`.
- `content.js` — propagate `attempt` and report controlled phases.
- `background.js` — preserve attempt identity in confirmations.
- `lib/batch-runtime-checkpoint.mjs` — version 2 schema, migration, attempts, phases and manual resolution.
- `lib/batch-runtime-controller.mjs` — migration-on-read and new semantic messages.
- `lib/batch-submit-context-client.js` and `lib/batch-submit-context-store.mjs` — include attempt in submission recovery identity.
- `scripts/serve-extension-fixture.js` — serve five target paths and a local OpenAI-compatible endpoint.

### Modified tests

- `tests/batch-runtime-checkpoint.test.mjs`
- `tests/batch-runtime-controller.test.mjs`
- `tests/batch-multi-window-integration.test.js`
- `tests/batch-submit-context-client.test.js`
- `tests/batch-submit-context-store.test.mjs`
- `tests/comment-history-message-listener.test.mjs`
- `tests/comment-history-submit-flow.test.js`
- `tests/fixture-server.test.js`
- `tests/privacy-policy.test.js` only if the final local-data schema description requires a wording update.

---

### Task 1: Establish Profile-Ready Assignment and Error Policy

**Files:**
- Create: `lib/batch-profile-contract.mjs`
- Create: `lib/batch-error-policy.mjs`
- Create: `tests/batch-profile-contract.test.mjs`
- Create: `tests/batch-error-policy.test.mjs`

**Interfaces:**
- Produces: `createDefaultBatchAssignment(settings) -> BatchAssignment`
- Produces: `getBatchError(errorCode, details) -> { code, message, retryPolicy, diagnostic }`
- Produces: `getBatchRetryPolicy({ result, errorCode }) -> "safe" | "confirm" | "blocked"`
- Consumes: normalized settings object `{ userName, userEmail, websiteUrl, websiteContent }`

- [ ] **Step 1: Write the failing profile contract test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultBatchAssignment } from '../lib/batch-profile-contract.mjs';

test('creates stable default identity and promotion-site snapshots', () => {
  assert.deepEqual(createDefaultBatchAssignment({
    userName: ' CloudHu ',
    userEmail: ' you@test.com ',
    websiteUrl: ' https://promo.test/ ',
    websiteContent: ' A useful promotion site. '
  }), {
    identityId: 'default-identity',
    promotionSiteId: 'default-promotion-site',
    identitySnapshot: {
      displayName: 'CloudHu',
      email: 'you@test.com'
    },
    promotionSiteSnapshot: {
      label: 'promo.test',
      url: 'https://promo.test/',
      contentSummary: 'A useful promotion site.'
    }
  });
});
```

- [ ] **Step 2: Run the profile test and observe the missing module failure**

Run: `node --test tests/batch-profile-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/batch-profile-contract.mjs`.

- [ ] **Step 3: Implement the default assignment contract**

```js
export function createDefaultBatchAssignment(settings = {}) {
  const websiteUrl = String(settings.websiteUrl || '').trim();
  const websiteContent = String(settings.websiteContent || '').trim();
  let label = websiteUrl;
  try {
    label = new URL(websiteUrl).hostname;
  } catch (_) {
    label = websiteUrl;
  }
  return {
    identityId: 'default-identity',
    promotionSiteId: 'default-promotion-site',
    identitySnapshot: {
      displayName: String(settings.userName || '').trim(),
      email: String(settings.userEmail || '').trim()
    },
    promotionSiteSnapshot: {
      label,
      url: websiteUrl,
      contentSummary: websiteContent.slice(0, 160)
    }
  };
}
```

- [ ] **Step 4: Write the failing error-policy tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBatchError,
  getBatchRetryPolicy
} from '../lib/batch-error-policy.mjs';

test('classifies safe, confirmed-risk, and blocked retries', () => {
  assert.equal(getBatchRetryPolicy({
    result: 'fail',
    errorCode: 'task_timeout'
  }), 'safe');
  assert.equal(getBatchRetryPolicy({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  }), 'confirm');
  assert.equal(getBatchRetryPolicy({
    result: 'success',
    errorCode: null
  }), 'blocked');
  assert.equal(getBatchRetryPolicy({
    result: 'blocked_illegal',
    errorCode: 'illegal_site'
  }), 'blocked');
});

test('returns a safe structured timeout error without credentials', () => {
  assert.deepEqual(getBatchError('task_timeout', {
    phase: 'generating',
    elapsedMs: 61000,
    apiKey: 'must-not-leak'
  }), {
    code: 'task_timeout',
    message: '处理超时，窗口已安全关闭',
    retryPolicy: 'safe',
    diagnostic: {
      phase: 'generating',
      elapsedMs: 61000
    }
  });
});
```

- [ ] **Step 5: Run the error-policy tests and observe the missing module failure**

Run: `node --test tests/batch-error-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/batch-error-policy.mjs`.

- [ ] **Step 6: Implement the explicit error and retry maps**

```js
const ERROR_DEFINITIONS = {
  task_timeout: {
    message: '处理超时，worker 标签页已安全关闭',
    retryPolicy: 'safe'
  },
  tab_create_failed: {
    message: '无法创建 worker 标签页',
    retryPolicy: 'safe'
  },
  content_script_unavailable: {
    message: '目标页面未能启动扩展内容脚本',
    retryPolicy: 'safe'
  },
  no_comment_box: {
    message: '未检测到可用评论框',
    retryPolicy: 'safe'
  },
  submission_uncertain: {
    message: '提交确认前中断，评论可能已提交',
    retryPolicy: 'confirm'
  },
  illegal_site: {
    message: '目标网站命中非法站点规则',
    retryPolicy: 'blocked'
  }
};

export function getBatchRetryPolicy({ result, errorCode } = {}) {
  if (result === 'success' || result === 'skipped' || result === 'blocked_illegal') {
    return 'blocked';
  }
  if (result === 'manual_required') return 'confirm';
  return ERROR_DEFINITIONS[errorCode]?.retryPolicy || 'safe';
}

export function getBatchError(errorCode, details = {}) {
  const definition = ERROR_DEFINITIONS[errorCode] || {
    message: '任务执行失败',
    retryPolicy: 'safe'
  };
  const diagnostic = {};
  if (typeof details.phase === 'string') diagnostic.phase = details.phase;
  if (Number.isFinite(details.elapsedMs)) diagnostic.elapsedMs = details.elapsedMs;
  return {
    code: errorCode || 'task_failed',
    message: definition.message,
    retryPolicy: definition.retryPolicy,
    diagnostic
  };
}
```

- [ ] **Step 7: Run focused tests**

Run: `node --test tests/batch-profile-contract.test.mjs tests/batch-error-policy.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-profile-contract.mjs lib/batch-error-policy.mjs tests/batch-profile-contract.test.mjs tests/batch-error-policy.test.mjs
git commit -m "feat: define batch profile and error contracts"
```

### Task 2: Extract CSV Preflight Into a Pure Module

**Files:**
- Create: `lib/batch-preflight.mjs`
- Create: `tests/batch-preflight.test.mjs`
- Modify later in Task 9: `batch.js:420-753`

**Interfaces:**
- Consumes: `parseCsv(text, options)` adapter compatible with `Papa.parse`
- Consumes: `evaluateUrl(url, { sourceDomain }) -> { blocked, reason, code }`
- Produces: `decodeBatchCsv(arrayBuffer) -> string`
- Produces: `parseBatchCsv(text, parseCsv) -> { headers, rows }`
- Produces: `preflightBatchRows(document, dependencies) -> BatchPreflight`
- Produces: `withDuplicateIncluded(preflight, rowNumber, included) -> BatchPreflight`

- [ ] **Step 1: Write failing preflight tests for all four row states**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preflightBatchRows,
  withDuplicateIncluded
} from '../lib/batch-preflight.mjs';

const parsed = {
  headers: ['页面AS', '原URL', 'URL对应域名'],
  rows: [
    ['1', 'https://good.test/post', 'good.test'],
    ['2', 'https://good.test/post', 'good.test'],
    ['3', 'https://blocked.test/post', 'blocked.test'],
    ['4', 'not a url', ''],
    ['5', 'https://next.test/post', 'next.test']
  ]
};

test('preflights eligible, duplicate, blocked, and invalid rows', () => {
  const result = preflightBatchRows(parsed, {
    evaluateUrl(url) {
      return url.includes('blocked.test')
        ? { blocked: true, code: 'illegal_site', reason: 'blocked fixture' }
        : { blocked: false };
    }
  });
  assert.deepEqual(result.summary, {
    raw: 5,
    eligible: 2,
    duplicate: 1,
    blocked: 1,
    invalid: 1,
    included: 2
  });
  assert.deepEqual(result.rows.map(({ status, included }) => ({
    status,
    included
  })), [
    { status: 'eligible', included: true },
    { status: 'duplicate', included: false },
    { status: 'blocked', included: false },
    { status: 'invalid', included: false },
    { status: 'eligible', included: true }
  ]);
});

test('allows only duplicate rows to be explicitly included', () => {
  const result = preflightBatchRows(parsed, {
    evaluateUrl() {
      return { blocked: false };
    }
  });
  const included = withDuplicateIncluded(result, 3, true);
  assert.equal(included.rows[1].included, true);
  assert.equal(included.summary.included, 4);
  assert.throws(
    () => withDuplicateIncluded(result, 4, true),
    /preflight_row_not_overridable/
  );
});
```

- [ ] **Step 2: Run the tests and observe the missing module failure**

Run: `node --test tests/batch-preflight.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement decoding and PapaParse adapter validation**

```js
export function decodeBatchCsv(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.slice(2));
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? 3
    : 0;
  return new TextDecoder('utf-8').decode(bytes.slice(offset));
}

export function parseBatchCsv(text, parseCsv) {
  const response = parseCsv(text, {
    skipEmptyLines: 'greedy'
  });
  if (response.errors?.length) {
    throw new Error('csv_parse_failed');
  }
  const [headers, ...rows] = response.data;
  if (!Array.isArray(headers) || rows.length === 0) {
    throw new Error('csv_empty');
  }
  return {
    headers: headers.map((value) => String(value || '').trim()),
    rows
  };
}
```

- [ ] **Step 4: Implement immutable row preflight and duplicate overrides**

Implementation requirements:

```js
const URL_HEADERS = new Set(['原URL', 'URL', 'url', 'Url']);
const DOMAIN_HEADERS = new Set(['URL对应域名', '来源域名', 'sourceDomain']);

function asHttpUrl(value) {
  const raw = String(value || '').trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (_) {
    return null;
  }
}
```

For each row, return:

```js
{
  rowNumber: 2,
  originalRow: ['1', 'https://good.test/post', 'good.test'],
  url: 'https://good.test/post',
  sourceDomain: 'good.test',
  status: 'eligible',
  reasonCode: 'eligible',
  reason: 'URL 和域名有效',
  overridable: false,
  included: true
}
```

Use the normalized URL as the duplicate key. `blocked` and `invalid` are never overridable. Recalculate the summary after an immutable duplicate override.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/batch-preflight.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-preflight.mjs tests/batch-preflight.test.mjs
git commit -m "feat: add batch CSV preflight"
```

### Task 3: Upgrade Checkpoints to Version 2 With Attempts

**Files:**
- Modify: `lib/batch-runtime-checkpoint.mjs:1-409`
- Modify: `tests/batch-runtime-checkpoint.test.mjs`

**Interfaces:**
- Consumes: `getBatchRetryPolicy()` from Task 1
- Produces: `migrateBatchRuntimeCheckpoint(value, now) -> { ok, checkpoint, changed }`
- Extends: `applyBatchRuntimeEvent(checkpoint, event, now)` with `task_phase`, `task_retried`, `task_manual_updated`
- Extends task shape with `attempt` and `manualResolution`
- Extends every task event and result with `attempt`

- [ ] **Step 1: Write failing migration and retry tests**

```js
test('migrates a version 1 checkpoint to attempt-aware version 2', () => {
  const version1 = createVersion1CheckpointFixture();
  const migrated = migrateBatchRuntimeCheckpoint(version1, 2000);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.version, 2);
  assert.equal(migrated.checkpoint.tasks['0'].attempt, 1);
  assert.deepEqual(migrated.checkpoint.tasks['0'].manualResolution, {
    status: 'idle',
    updatedAt: null
  });
  assert.equal(migrated.checkpoint.results[0].attempt, 1);
});

test('retries a safe terminal attempt without deleting attempt history', () => {
  const terminal = createTerminalCheckpoint({
    result: 'fail',
    errorCode: 'task_timeout'
  });
  const retried = applyBatchRuntimeEvent(terminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    confirmedRisk: false
  }, 2200);
  assert.equal(retried.ok, true);
  assert.equal(retried.checkpoint.tasks['0'].state, 'queued');
  assert.equal(retried.checkpoint.tasks['0'].attempt, 2);
  assert.equal(retried.checkpoint.results.length, 1);
  assert.equal(retried.checkpoint.results[0].attempt, 1);
});

test('requires confirmation for uncertain submissions and rejects stale attempts', () => {
  const terminal = createTerminalCheckpoint({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  });
  const unconfirmed = applyBatchRuntimeEvent(terminal, {
    type: 'task_retried',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    confirmedRisk: false
  }, 2200);
  assert.equal(unconfirmed.error, 'retry_confirmation_required');
  const stale = applyBatchRuntimeEvent(terminal, {
    type: 'task_phase',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 0,
    phase: 'loading'
  }, 2200);
  assert.equal(stale.error, 'stale_attempt');
});

function createVersion1CheckpointFixture() {
  return {
    version: 1,
    batchId: 'batch-1',
    status: 'completed',
    createdAt: 1000,
    updatedAt: 1500,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: [['https://target.test/0']],
      parsedUrls: [{
        originalIndex: 0,
        url: 'https://target.test/0',
        sourceDomain: 'target.test',
        originalRow: ['https://target.test/0']
      }]
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    },
    cursor: { nextIndex: 1 },
    tasks: {
      0: {
        urlIndex: 0,
        state: 'terminal',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1500
      }
    },
    results: [{
      originalIndex: 0,
      url: 'https://target.test/0',
      sourceDomain: 'target.test',
      result: 'success',
      aiContent: 'saved',
      errorCode: null,
      errorMessage: null,
      timestamp: 1500,
      elapsed: 1,
      originalRow: ['https://target.test/0']
    }]
  };
}

function createTerminalCheckpoint({ result, errorCode }) {
  const checkpoint = migrateBatchRuntimeCheckpoint(
    createVersion1CheckpointFixture(),
    2000
  ).checkpoint;
  checkpoint.status = 'paused_recovery';
  checkpoint.results[0].result = result;
  checkpoint.results[0].errorCode = errorCode;
  checkpoint.results[0].errorMessage = errorCode;
  return checkpoint;
}
```

- [ ] **Step 2: Run the focused checkpoint tests**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: FAIL because version 2 migration and events do not exist.

- [ ] **Step 3: Add version 1 validation and idempotent migration**

Set `BATCH_RUNTIME_VERSION = 2`. Add an internal `validateVersion1Checkpoint` that preserves the existing version 1 checks. Implement `migrateBatchRuntimeCheckpoint` by cloning valid version 1 data, assigning `attempt: 1`, adding empty `manualResolution`, adding `attempt: 1` to each result, and validating the migrated version 2 checkpoint.

Assign missing version 1 result codes deterministically:

```js
const LEGACY_RESULT_ERROR_CODES = {
  success: null,
  skipped: null,
  no_comment_box: 'no_comment_box',
  manual_required: 'submission_uncertain',
  blocked_illegal: 'illegal_site',
  fail: 'task_failed'
};
```

The function must return unchanged valid version 2 checkpoints:

```js
{
  ok: true,
  checkpoint: value,
  changed: false
}
```

- [ ] **Step 4: Make task validation attempt-aware**

Validation requirements:

- Every task has an integer `attempt >= 1`.
- Every result has an integer `attempt >= 1`.
- Every result has `errorCode: string | null` and `errorMessage: string | null`.
- Result uniqueness uses `${originalIndex}:${attempt}`.
- A result attempt may not exceed the current task attempt.
- A current `terminal` task has exactly one result for its current attempt.
- A queued/active/submitting task may retain results only from prior attempts.
- Manual resolution is exactly one of `idle`, `in_progress`, `resolved`, `unresolved`.

- [ ] **Step 5: Implement phase, retry and manual events**

Allowed phases:

```js
export const BATCH_TASK_PHASES = new Set([
  'opening',
  'loading',
  'detecting',
  'generating',
  'filling',
  'submitting',
  'confirming',
  'closing'
]);
```

All task events must reject `event.attempt !== task.attempt` with `stale_attempt`.

`task_retried` must:

- operate only on `terminal`;
- read the current attempt’s result;
- call `getBatchRetryPolicy`;
- reject `blocked`;
- reject `confirm` unless `confirmedRisk === true`;
- increment `attempt`;
- set `state: 'queued'`;
- clear phase, tab/window IDs, start time and manual resolution.

`task_manual_updated` must operate only on a terminal `manual_required` or `no_comment_box` task and persist a valid manual status.

`createResultEntry` must persist:

```js
{
  attempt: task.attempt,
  errorCode: result.errorCode || null,
  errorMessage: result.errorMessage || null
}
```

alongside the existing URL, content, timestamp, elapsed time and original row fields.

- [ ] **Step 6: Update interruption normalization**

When normalizing:

- preserve `attempt`;
- attach the current `attempt` to generated `manual_required` results;
- attach `errorCode: 'submission_uncertain'` to generated `manual_required` results;
- reset phase/window/start data for active tasks;
- reject late events from older attempts.

- [ ] **Step 7: Run checkpoint tests**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/batch-runtime-checkpoint.mjs tests/batch-runtime-checkpoint.test.mjs
git commit -m "feat: add attempt-aware batch checkpoints"
```

### Task 4: Add Runtime Commands and Migration-on-Read

**Files:**
- Modify: `lib/batch-runtime-controller.mjs:1-417`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `background.js:90-130`

**Interfaces:**
- Consumes: `migrateBatchRuntimeCheckpoint`
- Adds messages: `BATCH_TASK_PHASE`, `BATCH_TASK_RETRY`, `BATCH_TASK_MANUAL_UPDATE`
- Requires `attempt` on active, submitting, phase, terminal and confirmation commands
- Returns the updated checkpoint after every accepted command

- [ ] **Step 1: Write failing controller tests**

```js
test('migrates version 1 exactly once before returning it to the page', async () => {
  const harness = createHarness();
  harness.data.batchRuntimeCheckpoint = createVersion1ControllerFixture();
  const first = await harness.controller.handleMessage({
    type: 'BATCH_SESSION_GET'
  });
  const second = await harness.controller.handleMessage({
    type: 'BATCH_SESSION_GET'
  });
  assert.equal(first.checkpoint.version, 2);
  assert.equal(second.checkpoint.version, 2);
  assert.equal(
    harness.setCalls.filter((call) => call.batchRuntimeCheckpoint?.version === 2).length,
    1
  );
});

test('serializes phase, retry, and manual updates', async () => {
  const { controller } = createHarness();
  await controller.handleMessage(startMessage(1));
  await controller.handleMessage({
    type: 'BATCH_TASK_ACTIVE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 11,
    windowId: 21
  });
  const phase = await controller.handleMessage({
    type: 'BATCH_TASK_PHASE',
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    phase: 'generating'
  });
  assert.equal(phase.checkpoint.tasks['0'].phase, 'generating');
});

function createVersion1ControllerFixture() {
  const items = createItems(1);
  return {
    version: 1,
    batchId: 'batch-1',
    status: 'paused_recovery',
    createdAt: 1000,
    updatedAt: 1000,
    source: {
      fileName: 'input.csv',
      headers: ['id', 'URL'],
      rows: items.map((item) => item.originalRow),
      parsedUrls: items
    },
    settings: {
      autoOpenPanel: true,
      autoGenerate: true,
      autoSubmit: true,
      timeoutSeconds: 60,
      concurrency: 3
    },
    cursor: { nextIndex: 0 },
    tasks: {
      0: {
        urlIndex: 0,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 1000
      }
    },
    results: []
  };
}
```

- [ ] **Step 2: Run the controller tests**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: FAIL on missing migration and unsupported messages.

- [ ] **Step 3: Migrate checkpoints inside the serialized read path**

`readCheckpoint()` must:

1. read storage;
2. call `migrateBatchRuntimeCheckpoint`;
3. write the migrated checkpoint before returning it;
4. never write an already valid version 2 checkpoint;
5. return the original validation error without clearing storage.

- [ ] **Step 4: Route the three new messages**

Add to `MESSAGE_TYPES` and `handleMessage`:

```js
case 'BATCH_TASK_PHASE':
  return await mutate(message, {
    type: 'task_phase',
    urlIndex: message.urlIndex,
    attempt: message.attempt,
    phase: message.phase
  }, { ensureWakefulness: true });
case 'BATCH_TASK_RETRY':
  return await mutate(message, {
    type: 'task_retried',
    urlIndex: message.urlIndex,
    attempt: message.attempt,
    confirmedRisk: message.confirmedRisk === true
  });
case 'BATCH_TASK_MANUAL_UPDATE':
  return await mutate(message, {
    type: 'task_manual_updated',
    urlIndex: message.urlIndex,
    attempt: message.attempt,
    status: message.status
  });
```

Pass `attempt` through `BATCH_TASK_ACTIVE`, `BATCH_TASK_SUBMITTING` and `BATCH_TASK_TERMINAL`.

- [ ] **Step 5: Make background terminal writes attempt-aware**

`markTerminal(message)` must pass `message.attempt`. `BATCH_CONFIRMED` broadcasts must preserve `attempt`. Missing attempts from legacy recovery data default to `1` only during version 1 migration; current messages without an attempt are rejected.

- [ ] **Step 6: Run runtime and background-focused tests**

Run: `node --test tests/batch-runtime-controller.test.mjs tests/batch-multi-window-integration.test.js`

Expected: PASS after updating existing fixtures to include `attempt: 1`.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-runtime-controller.mjs tests/batch-runtime-controller.test.mjs background.js tests/batch-multi-window-integration.test.js
git commit -m "feat: expose batch phase retry and manual commands"
```

### Task 5: Propagate Attempt Identity and Controlled Content Phases

**Files:**
- Create: `lib/batch-phase-reporter.js`
- Create: `tests/batch-phase-reporter.test.js`
- Modify: `manifest.json`
- Modify: `content.js:806-1139,3905-4192,4450-4498`
- Modify: `background.js`
- Modify: `lib/batch-submit-context-client.js`
- Modify: `lib/batch-submit-context-store.mjs`
- Modify: `tests/batch-submit-context-client.test.js`
- Modify: `tests/batch-submit-context-store.test.mjs`
- Modify: `tests/comment-history-message-listener.test.mjs`
- Modify: `tests/comment-history-submit-flow.test.js`

**Interfaces:**
- Produces classic global: `globalThis.AutoCommentBatchPhaseReporter`
- Produces: `report(runtime, context, phase) -> Promise<{ ok }>`
- Context: `{ batchId, urlIndex, attempt }`
- All submission recovery identities become `{ batchId, urlIndex, attempt }`

- [ ] **Step 1: Write the failing phase reporter test**

```js
test('reports only controlled phases with complete task identity', async () => {
  const sent = [];
  const reporter = loadReporter();
  await reporter.report({
    sendMessage(message) {
      sent.push(message);
      return Promise.resolve({ ok: true });
    }
  }, {
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3
  }, 'generating');
  assert.deepEqual(sent, [{
    type: 'BATCH_TASK_PHASE',
    batchId: 'batch-1',
    urlIndex: 2,
    attempt: 3,
    phase: 'generating'
  }]);
  await assert.rejects(
    reporter.report({ sendMessage() {} }, {
      batchId: 'batch-1',
      urlIndex: 2,
      attempt: 3
    }, 'arbitrary-dom-state'),
    /invalid_batch_phase/
  );
});

function loadReporter() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync('lib/batch-phase-reporter.js', 'utf8'),
    context
  );
  return context.AutoCommentBatchPhaseReporter;
}
```

- [ ] **Step 2: Run the reporter test**

Run: `node --test tests/batch-phase-reporter.test.js`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the CSP-safe classic helper**

Use an IIFE and expose a frozen object:

```js
(function installBatchPhaseReporter(globalObject) {
  const allowed = new Set([
    'opening',
    'loading',
    'detecting',
    'generating',
    'filling',
    'submitting',
    'confirming',
    'closing'
  ]);
  async function report(runtime, context, phase) {
    if (!allowed.has(phase)) throw new Error('invalid_batch_phase');
    if (
      !context ||
      typeof context.batchId !== 'string' ||
      !Number.isInteger(context.urlIndex) ||
      !Number.isInteger(context.attempt)
    ) {
      throw new Error('invalid_batch_identity');
    }
    return runtime.sendMessage({
      type: 'BATCH_TASK_PHASE',
      batchId: context.batchId,
      urlIndex: context.urlIndex,
      attempt: context.attempt,
      phase
    });
  }
  globalObject.AutoCommentBatchPhaseReporter = Object.freeze({ report });
})(globalThis);
```

- [ ] **Step 4: Load the helper before `content.js`**

In `manifest.json`, add `lib/batch-phase-reporter.js` immediately before `content.js` in `content_scripts[0].js`.

- [ ] **Step 5: Make content batch context attempt-aware**

Change `_batchCtx`, `setBatchContext`, task keys, pending results, submitting commands and confirmations to include `attempt`. `BATCH_HANDLE` without an integer attempt returns:

```js
{ ok: false, error: 'invalid_batch_attempt', urlIndex: message.urlIndex }
```

Report phases at these exact boundaries:

- after accepting `BATCH_HANDLE`: `loading`;
- before comment-form detection: `detecting`;
- immediately before model generation: `generating`;
- before filling fields: `filling`;
- before `BATCH_TASK_SUBMITTING`: `submitting`;
- after the click and before durable confirmation: `confirming`.

Phase-report failure must abort the current automatic task and report a safe failure; it must never continue to a click after a failed `submitting` phase write.

Every terminal report must include a stable `errorCode`:

- timeout: `task_timeout`;
- worker-window creation: `window_create_failed`;
- content script readiness: `content_script_unavailable`;
- no comment box: `no_comment_box`;
- uncertain submission: `submission_uncertain`;
- illegal site: `illegal_site`;
- other caught execution errors: `task_failed`.

- [ ] **Step 6: Add attempt to submission context storage**

Update save/get/clear/seal matching so a context matches only when `tabId`, `batchId`, `urlIndex` and `attempt` match. Add tests proving a delayed attempt 1 clear cannot remove attempt 2 data for the same batch/index/tab.

- [ ] **Step 7: Run focused identity and content-flow tests**

Run:

```bash
node --test tests/batch-phase-reporter.test.js tests/batch-submit-context-client.test.js tests/batch-submit-context-store.test.mjs tests/comment-history-message-listener.test.mjs tests/comment-history-submit-flow.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add manifest.json lib/batch-phase-reporter.js content.js background.js lib/batch-submit-context-client.js lib/batch-submit-context-store.mjs tests/batch-phase-reporter.test.js tests/batch-submit-context-client.test.js tests/batch-submit-context-store.test.mjs tests/comment-history-message-listener.test.mjs tests/comment-history-submit-flow.test.js
git commit -m "feat: report attempt-aware batch phases"
```

### Task 6: Derive One Console Snapshot

**Files:**
- Create: `lib/batch-console-state.mjs`
- Create: `tests/batch-console-state.test.mjs`

**Interfaces:**
- Consumes: version 2 checkpoint, `now`, optional `{ online, lastCheckpointSavedAt }`
- Consumes: Task 1 error policy
- Produces: `createBatchConsoleSnapshot(checkpoint, options) -> BatchConsoleSnapshot`
- Produces: `filterBatchTaskRows(rows, filters) -> rows`

- [ ] **Step 1: Write failing snapshot tests**

```js
test('derives counters, slots and latest-attempt rows from one checkpoint', () => {
  const checkpoint = createConsoleCheckpointFixture();
  const snapshot = createBatchConsoleSnapshot(checkpoint, {
    now: 70000,
    online: true,
    lastCheckpointSavedAt: 69000
  });
  assert.deepEqual(snapshot.counts, {
    total: 5,
    queued: 1,
    running: 2,
    success: 1,
    failed: 0,
    manual: 1
  });
  assert.deepEqual(snapshot.slots.map((slot) => ({
    urlIndex: slot.urlIndex,
    attempt: slot.attempt,
    phase: slot.phase
  })), [
    { urlIndex: 1, attempt: 1, phase: 'generating' },
    { urlIndex: 2, attempt: 2, phase: 'detecting' }
  ]);
  assert.equal(snapshot.rows[2].result, null);
  assert.equal(snapshot.rows[2].attemptHistory.length, 1);
});

test('does not count manual resolution as automatic success', () => {
  const checkpoint = createManualResolvedCheckpointFixture();
  const snapshot = createBatchConsoleSnapshot(checkpoint, { now: 70000 });
  assert.equal(snapshot.counts.success, 0);
  assert.equal(snapshot.counts.manual, 1);
  assert.equal(snapshot.rows[0].manualResolution.status, 'resolved');
});

function createConsoleCheckpointFixture() {
  const parsedUrls = Array.from({ length: 5 }, (_, originalIndex) => ({
    originalIndex,
    url: `https://target.test/${originalIndex}`,
    sourceDomain: 'target.test',
    originalRow: [`https://target.test/${originalIndex}`]
  }));
  const task = (urlIndex, values) => ({
    urlIndex,
    attempt: 1,
    state: 'queued',
    phase: null,
    tabId: null,
    windowId: null,
    startedAt: null,
    updatedAt: 60000,
    manualResolution: { status: 'idle', updatedAt: null },
    ...values
  });
  return {
    version: 2,
    batchId: 'batch-1',
    status: 'running',
    createdAt: 1000,
    updatedAt: 69000,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: {
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site'
      }
    },
    cursor: { nextIndex: 0 },
    tasks: {
      0: task(0, { state: 'queued' }),
      1: task(1, {
        state: 'active',
        phase: 'generating',
        tabId: 11,
        windowId: 21,
        startedAt: 60000
      }),
      2: task(2, {
        attempt: 2,
        state: 'active',
        phase: 'detecting',
        tabId: 12,
        windowId: 22,
        startedAt: 65000
      }),
      3: task(3, { state: 'terminal' }),
      4: task(4, {
        state: 'terminal',
        manualResolution: { status: 'in_progress', updatedAt: 68000 }
      })
    },
    results: [{
      originalIndex: 2,
      attempt: 1,
      url: 'https://target.test/2',
      sourceDomain: 'target.test',
      result: 'fail',
      aiContent: null,
      errorCode: 'task_timeout',
      errorMessage: '处理超时',
      timestamp: 50000,
      elapsed: 60,
      originalRow: ['https://target.test/2']
    }, {
      originalIndex: 3,
      attempt: 1,
      url: 'https://target.test/3',
      sourceDomain: 'target.test',
      result: 'success',
      aiContent: 'saved',
      errorCode: null,
      errorMessage: null,
      timestamp: 67000,
      elapsed: 7,
      originalRow: ['https://target.test/3']
    }, {
      originalIndex: 4,
      attempt: 1,
      url: 'https://target.test/4',
      sourceDomain: 'target.test',
      result: 'manual_required',
      aiContent: null,
      errorCode: 'submission_uncertain',
      errorMessage: '提交确认前中断',
      timestamp: 68000,
      elapsed: 8,
      originalRow: ['https://target.test/4']
    }]
  };
}

function createManualResolvedCheckpointFixture() {
  const checkpoint = createConsoleCheckpointFixture();
  checkpoint.source.rows = checkpoint.source.rows.slice(4, 5);
  checkpoint.source.parsedUrls = checkpoint.source.parsedUrls.slice(4, 5)
    .map((item) => ({ ...item, originalIndex: 0 }));
  checkpoint.tasks = {
    0: {
      ...checkpoint.tasks['4'],
      urlIndex: 0,
      manualResolution: { status: 'resolved', updatedAt: 69000 }
    }
  };
  checkpoint.results = [{
    ...checkpoint.results[2],
    originalIndex: 0
  }];
  checkpoint.cursor.nextIndex = 1;
  return checkpoint;
}
```

- [ ] **Step 2: Run the snapshot tests**

Run: `node --test tests/batch-console-state.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement current-attempt selection and counters**

Use task core state for queued/running and the result matching the task’s current attempt for terminal counts. Older results belong only in `attemptHistory`.

Every row must include:

```js
{
  taskId: 'batch-1:2:2',
  urlIndex: 2,
  attempt: 2,
  url: 'https://target.test/2',
  domain: 'target.test',
  state: 'active',
  phase: 'detecting',
  elapsedMs: 5000,
  result: null,
  error: null,
  retryPolicy: 'safe',
  actions: ['details', 'focus-window'],
  manualResolution: {
    status: 'idle',
    updatedAt: null
  },
  attemptHistory: []
}
```

- [ ] **Step 4: Implement filter semantics**

`filterBatchTaskRows` accepts:

```js
{
  status: 'all',
  domain: 'all',
  timeRange: 'all',
  keyword: ''
}
```

Keyword searches URL, error message and AI content. Filtering must not mutate the checkpoint or counts.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/batch-console-state.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-console-state.mjs tests/batch-console-state.test.mjs
git commit -m "feat: derive batch console snapshots"
```

### Task 7: Extract Worker Runtime Side Effects

> **Decision change:** The original Task 7 draft below used one Chrome window per worker. That resource model is superseded. The implementation and tests use multiple inactive worker tabs in the console's single window; the historical window-oriented sample remains only as a record of the changed decision and is not normative.

**Files:**
- Create: `lib/batch-worker-runtime.mjs`
- Create: `tests/batch-worker-runtime.test.mjs`
- Modify later in Task 12: `batch.js:282-1646`
- Reuse: `lib/batch-scheduler.mjs`, `lib/batch-window-manager.mjs`

**Interfaces:**
- Produces: `createBatchWorkerRuntime(dependencies)`
- Methods: `start(checkpoint)`, `pause(reason)`, `resume(checkpoint)`, `refill(checkpoint)`, `stop()`, `focus(urlIndex)`, `handleConfirmation(message)`, `dispose()`
- Emits: `{ type: "changed" | "confirmed" | "runtime-error", checkpoint }`
- Consumes adapters: `runtimeRequest`, `sendHandle`, `sealSubmitContext`, `tabsApi`, `windowId`, `clock`, `timers`
- Accepts optional `tabManagerFactory` (plus temporary `windowManagerFactory` compatibility) and `schedulerFactory` test seams; production defaults construct the tab-backed `BatchTabManager` and `BatchScheduler`

- [ ] **Step 1: Write failing worker-runtime tests**

```js
test('opens no more than three attempt-aware worker tabs and replenishes one', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 5 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  assert.equal(harness.createdTabs.length, 3);
  assert.deepEqual(harness.sentHandles.map((message) => ({
    urlIndex: message.urlIndex,
    attempt: message.attempt
  })), [
    { urlIndex: 0, attempt: 1 },
    { urlIndex: 1, attempt: 1 },
    { urlIndex: 2, attempt: 1 }
  ]);
  await runtime.handleConfirmation({
    batchId: 'batch-1',
    urlIndex: 1,
    attempt: 1,
    result: 'success'
  });
  assert.equal(harness.createdTabs.length, 4);
});

test('pauses by stopping replenishment and sealing every activity before close', async () => {
  const harness = createWorkerHarness({ concurrency: 3, taskCount: 5 });
  const runtime = createBatchWorkerRuntime(harness.dependencies);
  await runtime.start(harness.checkpoint);
  await runtime.pause('user');
  assert.deepEqual(harness.calls.slice(-6), [
    ['seal', 0, 1],
    ['close', 0, 1],
    ['seal', 1, 1],
    ['close', 1, 1],
    ['seal', 2, 1],
    ['close', 2, 1]
  ]);
  assert.equal(harness.createdTabs.length, 3);
});

function createWorkerHarness({ concurrency, taskCount }) {
  const createdTabs = [];
  const sentHandles = [];
  const calls = [];
  const activities = new Map();
  let nextTabId = 100;
  const parsedUrls = Array.from({ length: taskCount }, (_, urlIndex) => ({
    originalIndex: urlIndex,
    url: `https://target.test/${urlIndex}`,
    sourceDomain: 'target.test',
    originalRow: [`https://target.test/${urlIndex}`]
  }));
  const tasks = Object.fromEntries(parsedUrls.map((item) => [
    String(item.originalIndex),
    {
      urlIndex: item.originalIndex,
      attempt: 1,
      state: 'queued',
      phase: null,
      tabId: null,
      windowId: null,
      startedAt: null,
      updatedAt: 1000,
      manualResolution: { status: 'idle', updatedAt: null }
    }
  ]));
  const checkpoint = {
    version: 2,
    batchId: 'batch-1',
    status: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: { concurrency, timeoutSeconds: 60 },
    cursor: { nextIndex: 0 },
    tasks,
    results: []
  };
  const tabManager = {
    async create(task) {
      const activity = {
        ...task,
        windowId: 42,
        tabId: nextTabId,
        startTime: 1000
      };
      nextTabId += 1;
      activities.set(task.urlIndex, activity);
      createdTabs.push(activity);
      return activity;
    },
    getByIndex(urlIndex) {
      return activities.get(urlIndex) || null;
    },
    async closeByIndex(urlIndex) {
      const activity = activities.get(urlIndex);
      if (!activity) return null;
      calls.push(['close', urlIndex, activity.attempt]);
      activities.delete(urlIndex);
      return activity;
    },
    async closeAll() {
      for (const urlIndex of [...activities.keys()].sort((a, b) => a - b)) {
        await this.closeByIndex(urlIndex);
      }
    },
    dispose() {}
  };
  const dependencies = {
    runtimeRequest: async (type, payload) => {
      calls.push(['runtime', type, payload.urlIndex, payload.attempt]);
      return { ok: true, checkpoint };
    },
    sendHandle: async (activity) => {
      sentHandles.push({
        type: 'BATCH_HANDLE',
        batchId: activity.batchId,
        urlIndex: activity.urlIndex,
        attempt: activity.attempt,
        url: activity.url
      });
      return { ok: true };
    },
    sealSubmitContext: async (activity) => {
      calls.push(['seal', activity.urlIndex, activity.attempt]);
      return { sealed: true, recovered: false };
    },
    tabManagerFactory: () => tabManager,
    clock: () => 1000,
    timers: {
      setInterval() {
        return 1;
      },
      clearInterval() {}
    }
  };
  return {
    checkpoint,
    dependencies,
    createdTabs,
    sentHandles,
    calls
  };
}
```

- [ ] **Step 2: Run the worker-runtime tests**

Run: `node --test tests/batch-worker-runtime.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Extract lifecycle ownership from `batch.js`**

Move scheduler, worker tab manager, opening reservations, content-script readiness, timeout checking, submit-context sealing, confirmation routing and close-before-replenish ordering into the new module.

Keep these invariants from existing tests:

- lifecycle ownership prevents delayed work from mutating a replacement batch;
- scheduler processed indices come from tasks whose current core state is `terminal`, never from every historical result;
- worker creation is `tabs.create({ windowId, url, active: false })`, with no automatic `windows.create/remove`;
- `BATCH_TASK_ACTIVE` succeeds before `BATCH_HANDLE`;
- every handle carries `batchId`, `urlIndex`, `attempt`;
- terminal persistence succeeds before close;
- close succeeds before scheduler replenishment;
- timeout seals submission context before deciding `fail` versus `manual_required`.

- [ ] **Step 4: Port existing race tests to the new module**

Move the reusable harness cases from `tests/batch-multi-window-integration.test.js` for:

- late worker-tab creation;
- deferred timeout;
- stale handle rejection;
- deferred finalizer;
- deferred stop;
- deferred completion;
- same-index replacement attempts.

Keep the old integration tests until Task 12 proves the composed page uses the extracted module.

- [ ] **Step 5: Run worker and scheduler tests**

Run:

```bash
node --test tests/batch-worker-runtime.test.mjs tests/batch-scheduler.test.mjs tests/batch-window-manager.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-worker-runtime.mjs tests/batch-worker-runtime.test.mjs
git commit -m "refactor: extract batch worker runtime"
```

### Task 8: Implement Semantic Batch Commands

**Files:**
- Create: `lib/batch-command-controller.mjs`
- Create: `tests/batch-command-controller.test.mjs`

**Interfaces:**
- Consumes: `runtimeRequest(type, payload)`, worker runtime from Task 7, manual window adapter, draft storage adapter, online state
- Produces: `createBatchCommandController(dependencies)`
- Methods: `start(draft)`, `pause()`, `resume()`, `stop()`, `retry(task, confirmedRisk)`, `openManual(task)`, `updateManual(task, status)`, `handleOffline()`
- Emits updated checkpoints through `subscribe(listener)`

- [ ] **Step 1: Write failing command tests**

```js
test('pauses through worker sealing before the session pause command', async () => {
  const harness = createCommandHarness();
  const controller = createBatchCommandController(harness.dependencies);
  await controller.pause();
  assert.deepEqual(harness.calls, [
    ['worker.pause', 'user'],
    ['runtime', 'BATCH_SESSION_PAUSE', { batchId: 'batch-1' }]
  ]);
});

test('opens manual work outside the worker runtime and persists its state', async () => {
  const harness = createCommandHarness();
  const controller = createBatchCommandController(harness.dependencies);
  await controller.openManual({
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 1,
    url: 'https://manual.test/page'
  });
  assert.deepEqual(harness.calls, [
    ['manual.open', 'https://manual.test/page'],
    ['runtime', 'BATCH_TASK_MANUAL_UPDATE', {
      batchId: 'batch-1',
      urlIndex: 3,
      attempt: 1,
      status: 'in_progress'
    }]
  ]);
});

test('offline detection safely pauses and never auto-resumes', async () => {
  const harness = createCommandHarness();
  const controller = createBatchCommandController(harness.dependencies);
  await controller.handleOffline();
  harness.onlineListeners.emit(true);
  assert.equal(harness.calls.some(([name]) => name === 'worker.resume'), false);
});

function createCommandHarness() {
  const calls = [];
  const onlineListeners = {
    callbacks: new Map(),
    addEventListener(type, callback) {
      this.callbacks.set(type, callback);
    },
    removeEventListener(type) {
      this.callbacks.delete(type);
    },
    emit(online) {
      const type = online ? 'online' : 'offline';
      this.callbacks.get(type)?.();
    }
  };
  const workerRuntime = {
    async start() {
      calls.push(['worker.start']);
    },
    async pause(reason) {
      calls.push(['worker.pause', reason]);
    },
    async resume() {
      calls.push(['worker.resume']);
    },
    async stop() {
      calls.push(['worker.stop']);
    },
    async refill() {
      calls.push(['worker.refill']);
    }
  };
  const dependencies = {
    getCheckpoint() {
      return {
        batchId: 'batch-1',
        status: 'running'
      };
    },
    runtimeRequest: async (type, payload) => {
      calls.push(['runtime', type, payload]);
      return {
        ok: true,
        checkpoint: {
          batchId: 'batch-1',
          status: type === 'BATCH_SESSION_PAUSE'
            ? 'paused_recovery'
            : 'running'
        }
      };
    },
    workerRuntime,
    manualWindows: {
      async open(url) {
        calls.push(['manual.open', url]);
        return { id: 91 };
      }
    },
    onlineTarget: onlineListeners,
    draftStorage: {
      async set() {},
      async remove() {}
    }
  };
  return {
    calls,
    dependencies,
    onlineListeners
  };
}
```

- [ ] **Step 2: Run the command tests**

Run: `node --test tests/batch-command-controller.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement guarded semantic commands**

The controller keeps one in-flight command promise. A second click on the same command returns that promise; incompatible commands reject with `batch_command_in_progress`.

Order:

- start: persist session, then start workers;
- pause/offline: stop and seal workers, then persist pause;
- resume: persist resume, then resume workers;
- stop: stop and seal workers, then persist terminal session;
- retry: persist retry, then call `workerRuntime.refill(response.checkpoint)` only if the session is running;
- manual: open an ordinary window adapter, then persist manual status.

- [ ] **Step 4: Add offline listener behavior**

Expose `attachOnlineListeners(target)` and `detachOnlineListeners()`. Only the `offline` event executes a command. The `online` event publishes `{ online: true, requiresUserResume: true }`.

`createBatchCommandController` calls `attachOnlineListeners(dependencies.onlineTarget)` during construction when that dependency exists.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/batch-command-controller.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-command-controller.mjs tests/batch-command-controller.test.mjs
git commit -m "feat: add safe batch command controller"
```

### Task 9: Add the Shared Extension Shell

**Files:**
- Create: `styles/tokens.css`
- Create: `styles/app-shell.css`
- Create: `lib/app-shell.mjs`
- Create: `tests/app-shell.test.mjs`
- Modify: `options.html`, `options.js`
- Modify: `history.html`, `history.js`
- Modify later in Task 11: `batch.html`, `batch.js`

**Interfaces:**
- Produces: `getAppNavigation(currentUrl) -> NavigationItem[]`
- Produces: `bootAppShell(document, { currentUrl, onNavigate })`
- Navigation targets: `batch.html`, `options.html#identity`, `options.html#promotion`, `history.html`, `options.html#settings`

- [ ] **Step 1: Write failing navigation tests**

```js
test('maps options hashes to distinct active navigation items', () => {
  assert.equal(
    getAppNavigation('chrome-extension://id/options.html#identity')
      .find((item) => item.active).id,
    'identity'
  );
  assert.equal(
    getAppNavigation('chrome-extension://id/options.html#promotion')
      .find((item) => item.active).id,
    'promotion'
  );
  assert.equal(
    getAppNavigation('chrome-extension://id/options.html#settings')
      .find((item) => item.active).id,
    'settings'
  );
});

test('renders one labelled navigation landmark', () => {
  const document = shellDocument();
  bootAppShell(document, {
    currentUrl: 'chrome-extension://id/history.html',
    onNavigate() {}
  });
  assert.equal(document.querySelectorAll('nav[aria-label="插件主导航"]').length, 1);
  assert.equal(document.querySelector('[aria-current="page"]').textContent, '评论历史');
});

function shellDocument() {
  return new JSDOM(
    '<!doctype html><html><body><header data-app-shell></header></body></html>',
    { url: 'chrome-extension://id/history.html' }
  ).window.document;
}
```

Add `import { JSDOM } from 'jsdom';` to the test file with the `node:test` and module imports.

- [ ] **Step 2: Run the shell tests**

Run: `node --test tests/app-shell.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement navigation model and local styles**

Use anchor elements with real extension-relative `href` values so navigation works without JavaScript. `bootAppShell` may intercept clicks only when an injected `onNavigate` is supplied. Use CSS variables from `styles/tokens.css`; include a `:focus-visible` ring and a `<900px` collapsed layout.

- [ ] **Step 4: Integrate options sections**

Wrap existing fields in:

- `<section id="identity">`;
- `<section id="promotion">`;
- `<section id="settings">`.

On load and `hashchange`, scroll the matching section into view and move programmatic focus to its heading using `tabindex="-1"`. Preserve every existing field ID and storage key.

- [ ] **Step 5: Integrate history shell**

Add the shell mount before the existing history `<main>`. Do not alter history filters, pagination, IndexedDB messages or deletion behavior.

- [ ] **Step 6: Run shell, options and history tests**

Run:

```bash
node --test tests/app-shell.test.mjs tests/llm-options-controller.test.mjs tests/comment-history-page.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add styles/tokens.css styles/app-shell.css lib/app-shell.mjs tests/app-shell.test.mjs options.html options.js history.html history.js
git commit -m "feat: add unified extension navigation"
```

### Task 10: Build the Accessible Batch Creation Wizard

**Files:**
- Create: `lib/batch-wizard-view.mjs`
- Create: `tests/batch-wizard-view.test.mjs`
- Modify later in Task 11: `batch.html`, `batch.js`, `styles/batch-console.css`

**Interfaces:**
- Consumes: Task 1 assignment, Task 2 preflight
- Produces: `createBatchWizardView(document, handlers)`
- Methods: `open(initialDraft)`, `render(state)`, `close()`, `destroy()`
- Handler events: `onDraftChange`, `onParseFile`, `onStart`, `onCancel`
- Draft key: `batchDraftV1`

- [ ] **Step 1: Write failing wizard DOM tests**

```js
test('moves through labelled steps and allows start when invalid rows stay excluded', async () => {
  const document = wizardDocument();
  const events = [];
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      events.push(['draft', draft]);
    },
    onStart(draft) {
      events.push(['start', draft]);
    }
  });
  view.open(validDraftFixture());
  assert.equal(document.querySelector('[aria-current="step"]').textContent, '分配配置');
  click(document, '[data-action="wizard-next"]');
  assert.equal(document.querySelector('[aria-current="step"]').textContent, '导入与预检');
  view.render(preflightWithOneBlockedRow());
  assert.match(document.querySelector('[data-preflight-summary]').textContent, /将处理 5/);
  assert.equal(
    document.querySelector('[data-preflight-row="7"]').dataset.included,
    'false'
  );
  view.render({
    ...preflightWithOneBlockedRow(),
    step: 4
  });
  assert.equal(document.querySelector('[data-action="wizard-start"]').disabled, false);
});

test('locks focus while open and restores it to the trigger on close', () => {
  const document = wizardDocument();
  const trigger = document.querySelector('[data-action="new-batch"]');
  trigger.focus();
  const view = createBatchWizardView(document, wizardHandlers());
  view.open(validDraftFixture());
  assert.equal(document.activeElement, document.querySelector('[data-wizard-close]'));
  view.close();
  assert.equal(document.activeElement, trigger);
});

function wizardDocument() {
  return new JSDOM(`<!doctype html>
    <html>
      <body>
        <button data-action="new-batch">新建批次</button>
        <dialog data-batch-wizard></dialog>
      </body>
    </html>`, {
    url: 'chrome-extension://id/batch.html'
  }).window.document;
}

function validDraftFixture() {
  return {
    step: 1,
    assignment: {
      identityId: 'default-identity',
      promotionSiteId: 'default-promotion-site',
      identitySnapshot: {
        displayName: 'CloudHu',
        email: 'you@test.com'
      },
      promotionSiteSnapshot: {
        label: 'promo.test',
        url: 'https://promo.test/',
        contentSummary: 'Local fixture'
      }
    },
    preflight: null,
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60
    },
    readinessError: ''
  };
}

function preflightWithOneBlockedRow() {
  const draft = validDraftFixture();
  return {
    ...draft,
    step: 2,
    preflight: {
      summary: {
        raw: 6,
        eligible: 5,
        duplicate: 0,
        blocked: 1,
        invalid: 0,
        included: 5
      },
      rows: [
        ...Array.from({ length: 5 }, (_, index) => ({
          rowNumber: index + 2,
          url: `https://target.test/${index + 1}`,
          status: 'eligible',
          reason: 'URL 和域名有效',
          included: true,
          overridable: false
        })),
        {
          rowNumber: 7,
          url: 'https://blocked.test/',
          status: 'blocked',
          reason: '命中非法站点规则',
          included: false,
          overridable: false
        }
      ]
    }
  };
}

function wizardHandlers() {
  return {
    onDraftChange() {},
    onParseFile() {},
    onStart() {},
    onCancel() {}
  };
}

function click(document, selector) {
  document.querySelector(selector).dispatchEvent(
    new document.defaultView.MouseEvent('click', { bubbles: true })
  );
}
```

Add `import { JSDOM } from 'jsdom';` to the test file.

- [ ] **Step 2: Run the wizard tests**

Run: `node --test tests/batch-wizard-view.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement semantic wizard rendering**

Use:

- `<dialog>` where supported, with an accessible fallback wrapper for JSDOM;
- one `<ol>` for steps;
- labelled `<section>` per step;
- a native file input paired with the drop zone;
- a real `<table>` for preflight at desktop width;
- text buttons for duplicate include/exclude actions;
- no inline event handlers.

The view must never call `chrome.*`.

- [ ] **Step 4: Implement step validation**

- Step 1 requires non-empty snapshots.
- Step 2 requires at least one included eligible/duplicate row.
- Step 3 clamps concurrency and timeout and enforces `autoSubmit => autoGenerate`.
- Step 4 requires the final readiness callback to return no error.

- [ ] **Step 5: Run wizard tests**

Run: `node --test tests/batch-wizard-view.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/batch-wizard-view.mjs tests/batch-wizard-view.test.mjs
git commit -m "feat: add accessible batch creation wizard"
```

### Task 11: Build the Console View and Interaction Contract

**Files:**
- Create: `lib/batch-console-view.mjs`
- Create: `styles/batch-console.css`
- Create: `tests/batch-console-view.test.mjs`
- Create: `tests/batch-console-accessibility.test.mjs`
- Create: `tests/helpers/batch-console-fixtures.mjs`

**Interfaces:**
- Consumes: `BatchConsoleSnapshot` from Task 6
- Produces: `createBatchConsoleView(document, handlers)`
- Methods: `render(snapshot)`, `destroy()`
- Handlers: `onPause`, `onResume`, `onStop`, `onRetry`, `onOpenManual`, `onManualUpdate`, `onFocusWindow`, `onFilterChange`, `onNewBatch`, `onExport`

- [ ] **Step 1: Write failing console rendering tests**

```js
test('renders fixed controls, six counters, three slots and full-lifecycle rows', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(runningSnapshotFixture());
  assert.equal(document.querySelector('[data-command-bar]').dataset.sticky, 'true');
  assert.equal(document.querySelectorAll('[data-summary-count]').length, 6);
  assert.equal(document.querySelectorAll('[data-worker-slot]').length, 3);
  assert.equal(document.querySelectorAll('[data-task-row]').length, 5);
  assert.match(document.querySelector('[data-task-row="18"]').textContent, /处理超时/);
});

test('uses distinct pause and irreversible stop confirmations', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(runningSnapshotFixture());
  click(document, '[data-action="pause"]');
  assert.match(document.querySelector('[role="dialog"]').textContent, /稍后可继续/);
  click(document, '[data-dialog-cancel]');
  click(document, '[data-action="stop"]');
  assert.match(document.querySelector('[role="dialog"]').textContent, /不能恢复/);
  assert.match(document.querySelector('[data-dialog-confirm]').className, /danger/);
});

function consoleDocument() {
  return new JSDOM(`<!doctype html>
    <html>
      <body>
        <header data-app-shell></header>
        <main data-batch-console></main>
      </body>
    </html>`, {
    url: 'chrome-extension://id/batch.html'
  }).window.document;
}

function consoleHandlers() {
  return {
    onPause() {},
    onResume() {},
    onStop() {},
    onRetry() {},
    onOpenManual() {},
    onManualUpdate() {},
    onFocusWindow() {},
    onFilterChange() {},
    onNewBatch() {},
    onExport() {}
  };
}

function runningSnapshotFixture() {
  const rows = [{
    taskId: 'batch-1:18:1',
    urlIndex: 18,
    attempt: 1,
    url: 'https://old.blog/article',
    domain: 'old.blog',
    state: 'terminal',
    phase: null,
    elapsedMs: 61000,
    result: 'fail',
    error: {
      code: 'task_timeout',
      message: '处理超时，窗口已安全关闭',
      retryPolicy: 'safe',
      diagnostic: { phase: 'generating', elapsedMs: 61000 }
    },
    retryPolicy: 'safe',
    actions: ['details', 'retry'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: []
  }, {
    taskId: 'batch-1:17:1',
    urlIndex: 17,
    attempt: 1,
    url: 'https://manual.test/page',
    domain: 'manual.test',
    state: 'terminal',
    phase: null,
    elapsedMs: 22000,
    result: 'manual_required',
    error: {
      code: 'submission_uncertain',
      message: '提交确认前中断，评论可能已提交',
      retryPolicy: 'confirm',
      diagnostic: { phase: 'submitting', elapsedMs: 22000 }
    },
    retryPolicy: 'confirm',
    actions: ['details', 'manual'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: []
  }, ...Array.from({ length: 3 }, (_, offset) => ({
    taskId: `batch-1:${offset}:1`,
    urlIndex: offset,
    attempt: 1,
    url: `https://target.test/${offset}`,
    domain: 'target.test',
    state: 'active',
    phase: ['loading', 'detecting', 'generating'][offset],
    elapsedMs: (offset + 1) * 1000,
    result: null,
    error: null,
    retryPolicy: 'safe',
    actions: ['details', 'focus-window'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: []
  }))];
  return {
    batchId: 'batch-1',
    status: 'running',
    batchName: '夏季外链批次',
    online: true,
    counts: {
      total: 5,
      queued: 0,
      running: 3,
      success: 0,
      failed: 1,
      manual: 1
    },
    assignment: {
      identityLabel: '默认身份 · CloudHu',
      promotionSiteLabel: 'promo.test',
      automationLabel: '生成并自动提交',
      limitsLabel: '并发 3 · 超时 60s'
    },
    slots: rows.slice(2).map((row, index) => ({
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      url: row.url,
      domain: row.domain,
      phase: row.phase,
      elapsedMs: row.elapsedMs,
      windowLabel: `窗口 ${index + 1}`
    })),
    rows,
    filteredRows: rows,
    banners: [],
    command: {
      inFlight: null,
      canPause: true,
      canResume: false,
      canStop: true,
      canExport: true,
      canCreate: false
    }
  };
}

function recoverySnapshotFixture() {
  const snapshot = runningSnapshotFixture();
  return {
    ...snapshot,
    status: 'paused_recovery',
    slots: [],
    banners: [{
      kind: 'recovery',
      title: '已从检查点安全恢复',
      message: '1 个提交中断任务已标记需人工'
    }],
    command: {
      ...snapshot.command,
      canPause: false,
      canResume: true
    }
  };
}

function click(document, selector) {
  document.querySelector(selector).dispatchEvent(
    new document.defaultView.MouseEvent('click', { bubbles: true })
  );
}
```

Add `import { JSDOM } from 'jsdom';` to both DOM test files. The accessibility test imports `consoleDocument`, `consoleHandlers` and `recoverySnapshotFixture` from a shared `tests/helpers/batch-console-fixtures.mjs`; move those three helpers and `runningSnapshotFixture` into that helper file before adding the second test.

- [ ] **Step 2: Run the console view tests**

Run: `node --test tests/batch-console-view.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement DOM rendering without `innerHTML` for user data**

Static templates may use trusted local HTML. URL, AI text, error messages and snapshot labels must be assigned through `textContent`.

Render:

- shared navigation mount;
- command bar;
- six summary counters;
- assignment/slots/health sidebar;
- queue toolbar and table;
- details drawer;
- pause/stop/retry dialogs;
- recovery/offline/checkpoint banners;
- empty state.

- [ ] **Step 4: Implement event delegation and dialog focus**

Use one click listener on the console root and one input/change listener for filters. Preserve the trigger before opening a drawer/dialog and restore focus on close. Escape closes details and cancelable dialogs but does not cancel an in-flight command.

- [ ] **Step 5: Add responsive and reduced-motion CSS**

Implement the approved breakpoints:

- `>=1280px`: 245px sidebar plus table;
- `900–1279px`: overview above table;
- `<900px`: task cards and full-page wizard;
- `<640px`: two-column metrics and collapsed navigation.

Add `@media (prefers-reduced-motion: reduce)` and visible focus styles.

- [ ] **Step 6: Write and run accessibility assertions**

```js
test('exposes labelled status regions and equivalent mobile task data', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(recoverySnapshotFixture());
  assert.ok(document.querySelector('[aria-live="polite"][data-batch-status]'));
  assert.ok(document.querySelector('table thead th[scope="col"]'));
  const row = document.querySelector('[data-task-row="17"]');
  assert.match(row.getAttribute('aria-label'), /需人工/);
  assert.match(row.getAttribute('aria-label'), /提交确认前中断/);
});
```

Run:

```bash
node --test tests/batch-console-view.test.mjs tests/batch-console-accessibility.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/batch-console-view.mjs styles/batch-console.css tests/batch-console-view.test.mjs tests/batch-console-accessibility.test.mjs tests/helpers/batch-console-fixtures.mjs
git commit -m "feat: add batch operations console view"
```

### Task 12: Compose the New Page and Slim `batch.js`

**Files:**
- Modify: `batch.html:1-972`
- Modify: `batch.js:1-2349`
- Modify: `tests/batch-multi-window-integration.test.js`
- Modify: `tests/batch-readiness.test.mjs`
- Modify: `tests/privacy-policy.test.js` only if required by the final stored attempt/manual metadata

**Interfaces:**
- Consumes all modules from Tasks 1–11
- `batch.js` exports no product globals; tests boot the page through `bootBatchPage(document, dependencies)`
- Produces: `bootBatchPage(document, dependencies) -> { destroy }`

- [ ] **Step 1: Add a failing composition test**

Extend the integration harness:

```js
test('boots the console from a paused checkpoint and performs no automatic resume', async () => {
  const harness = createBatchHarness({
    checkpoint: pausedVersion2CheckpointFixture()
  });
  await harness.boot();
  assert.match(harness.document.querySelector('[data-batch-status]').textContent, /已暂停/);
  assert.equal(harness.tabsCreated.length, 0);
  harness.document.querySelector('[data-action="resume"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.runtimeMessages[0].type, 'BATCH_SESSION_RESUME');
  assert.equal(harness.tabsCreated.length, 3);
});

function pausedVersion2CheckpointFixture() {
  const parsedUrls = Array.from({ length: 5 }, (_, urlIndex) => ({
    originalIndex: urlIndex,
    url: `https://target.test/${urlIndex}`,
    sourceDomain: 'target.test',
    originalRow: [`https://target.test/${urlIndex}`]
  }));
  return {
    version: 2,
    batchId: 'batch-1',
    status: 'paused_recovery',
    createdAt: 1000,
    updatedAt: 2000,
    source: {
      fileName: 'targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site'
      }
    },
    cursor: { nextIndex: 0 },
    tasks: Object.fromEntries(parsedUrls.map((item) => [
      String(item.originalIndex),
      {
        urlIndex: item.originalIndex,
        attempt: 1,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 2000,
        manualResolution: { status: 'idle', updatedAt: null }
      }
    ])),
    results: []
  };
}
```

Extend the existing `createBatchHarness` rather than adding a second harness. It must expose `boot`, `document`, `runtimeMessages`, and `tabsCreated` while retaining the existing `api`, `elements`, `alerts`, `runtimeListeners`, `intervalCalls`, `FakeScheduler`, and temporary legacy `FakeWindowManager` fields used by older tests.

- [ ] **Step 2: Run the composition test**

Run: `node --test tests/batch-multi-window-integration.test.js`

Expected: FAIL because the current page does not expose the new mount points or boot API.

- [ ] **Step 3: Replace `batch.html` with semantic mount structure**

Keep only:

- app shell header mount;
- `<main data-batch-console>`;
- accessible empty/status/queue/detail/dialog containers;
- wizard dialog;
- local CSS links;
- PapaParse, illegal filter and module scripts.

Remove the 700px container and all inline event handlers. Preserve stable IDs only where current content/background code or export tests require them; update tests to prefer `data-*` view contracts.

- [ ] **Step 4: Compose dependencies in `batch.js`**

`bootBatchPage` must:

1. boot the shared shell;
2. load version 2 checkpoint through runtime controller;
3. load current settings and build the default assignment;
4. create worker runtime and command controller;
5. create wizard and console views;
6. derive/render a snapshot after every checkpoint or filter change;
7. attach runtime confirmations, offline listeners and teardown handlers.

Use the checkpoint as the authoritative full result source. Keep `batchLocalResults` only for backwards-compatible export fallback; do not derive current counts from its 100-row truncated cache.

Export `bootBatchPage` for tests. Auto-boot only in an extension page:

```js
if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootBatchPage(document, createChromeBatchDependencies(chrome));
  });
}
```

This guard is required so Task 14 can dynamically import the module during syntax verification without fabricating DOM or Chrome globals.

- [ ] **Step 5: Remove moved responsibilities from `batch.js`**

Delete:

- `normalizeEncoding`, `parseCSV`, `parseCSVLine` and preview DOM construction;
- counter globals and `recalculateCountsFromResults`;
- `renderStats`, `updateStatsUI`, `updateUI`, row highlighting and DOM filters;
- scheduler/window/opening/timeout functions moved to `batch-worker-runtime.mjs`;
- error-string-to-action branching moved to `batch-error-policy.mjs`;
- unused page-local comment form helpers `findCommentForm` and `findLikelyCommentTextarea`.

Keep only small storage/export adapters that are still page-specific.

- [ ] **Step 6: Update existing integration assertions**

Preserve all race, lifecycle and durable-history tests. Update fixtures to version 2 and include `attempt`. Add assertions for:

- three visible slots match three created windows;
- queue rows include active and queued tasks;
- retry creates attempt 2 and old attempt confirmation is ignored;
- manual window creation never sends `BATCH_HANDLE`;
- stopped batch cannot resume.

- [ ] **Step 7: Run affected tests**

Run:

```bash
node --test tests/batch-multi-window-integration.test.js tests/batch-readiness.test.mjs tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-command-controller.test.mjs tests/batch-console-state.test.mjs tests/batch-wizard-view.test.mjs tests/batch-console-view.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add batch.html batch.js tests/batch-multi-window-integration.test.js tests/batch-readiness.test.mjs tests/privacy-policy.test.js
git commit -m "feat: ship batch operations console"
```

### Task 13: Add Local Five-URL Fixture and Automated Acceptance

**Files:**
- Create: `tests/fixtures/batch-targets.csv`
- Modify: `scripts/serve-extension-fixture.js`
- Modify: `tests/fixture-server.test.js`
- Modify: `tests/fixtures/comment-page.html` only to display the requested path and deterministic delay/result controls

**Interfaces:**
- Fixture targets:
  - `/target/1?delay=3500`
  - `/target/2?delay=3000`
  - `/target/3?delay=2500`
  - `/target/4?delay=2000`
  - `/target/5?delay=1500`
- Model endpoint: `POST /v1/chat/completions`
- Model response: OpenAI-compatible `{ choices: [{ message: { content } }] }`

- [ ] **Step 1: Write failing fixture server tests**

```js
test('serves five local targets and an OpenAI-compatible local model', async (t) => {
  await withFixtureServer(t, async (origin) => {
    const targets = await Promise.all(
      [1, 2, 3, 4, 5].map((id) => fetch(`${origin}/target/${id}`))
    );
    assert.ok(targets.every((response) => response.status === 200));
    const model = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local-fixture',
        messages: [{ role: 'user', content: 'target 3' }]
      })
    });
    assert.deepEqual(await model.json(), {
      choices: [{
        message: {
          content: 'Local fixture comment for target 3'
        }
      }]
    });
  });
});
```

- [ ] **Step 2: Run the fixture tests**

Run: `node --test tests/fixture-server.test.js`

Expected: FAIL with 404 for target/model paths.

- [ ] **Step 3: Implement local target and model routes**

The fixture server must:

- bind only to `127.0.0.1`;
- never proxy a request;
- answer local CORS preflight with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: authorization, content-type`, and `Access-Control-Allow-Methods: POST, OPTIONS`;
- reject non-POST model calls;
- parse a bounded JSON body;
- generate deterministic text from the requested target number;
- delay only the local model response by the bounded `delay` query value embedded in the prompt URL, clamped to `0–5000ms`;
- preserve the existing navigation-free local submit handler.

- [ ] **Step 4: Add the five-row CSV**

Use header:

```csv
页面AS,原URL,URL对应域名,目标域名,类型,外部链接数量
1,http://127.0.0.1:4173/target/1?delay=3500,127.0.0.1,fixture.local,comment,0
2,http://127.0.0.1:4173/target/2?delay=3000,127.0.0.1,fixture.local,comment,0
3,http://127.0.0.1:4173/target/3?delay=2500,127.0.0.1,fixture.local,comment,0
4,http://127.0.0.1:4173/target/4?delay=2000,127.0.0.1,fixture.local,comment,0
5,http://127.0.0.1:4173/target/5?delay=1500,127.0.0.1,fixture.local,comment,0
```

- [ ] **Step 5: Run fixture tests**

Run: `node --test tests/fixture-server.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/serve-extension-fixture.js tests/fixture-server.test.js tests/fixtures/comment-page.html tests/fixtures/batch-targets.csv
git commit -m "test: add local batch acceptance fixture"
```

### Task 14: Full Verification and Real Chrome Acceptance

**Files:**
- Create: `docs/qa/2026-07-26-batch-operations-console-chrome.md`
- Create: `docs/qa/screenshots/batch-console-1440.png`
- Create: `docs/qa/screenshots/batch-console-1024.png`
- Create: `docs/qa/screenshots/batch-console-640.png`
- Modify only if verification finds a defect: files owned by the preceding task that introduced the defect

**Interfaces:**
- Consumes the unpacked extension in the current worktree
- Consumes local fixture server and `tests/fixtures/batch-targets.csv`
- Produces an evidence-backed QA record

- [ ] **Step 1: Install the locked dependencies and establish a green baseline**

Run: `npm ci`

Run: `npm test`

Expected: all tests pass. The design-phase baseline had 172 passing tests and 6 loader failures only because `node_modules` was absent; after `npm ci`, there must be no missing-module failures.

- [ ] **Step 2: Run syntax and manifest checks**

Run:

```bash
node --check background.js
node --check content.js
node --check lib/batch-phase-reporter.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8'))"
node -e "Promise.all(['batch.js','lib/app-shell.mjs','lib/batch-preflight.mjs','lib/batch-console-state.mjs','lib/batch-command-controller.mjs','lib/batch-worker-runtime.mjs','lib/batch-wizard-view.mjs','lib/batch-console-view.mjs','lib/batch-runtime-checkpoint.mjs','lib/batch-runtime-controller.mjs'].map((file)=>import('./'+file)))"
```

Expected: every command exits `0`.

- [ ] **Step 3: Start the local fixture server**

Run: `npm run test:fixture`

Expected: terminal prints `Fixture: http://127.0.0.1:4173/comment-page.html` and remains running.

- [ ] **Step 4: Load the unpacked extension in real Chrome**

Use the Chrome extension page:

1. open `chrome://extensions`;
2. enable Developer mode;
3. choose “Load unpacked”;
4. select `/Users/moltbot/.codex/worktrees/5587/autoComment`;
5. record Chrome version and extension ID in the QA document.

- [ ] **Step 5: Configure local-only settings**

In the extension options:

- API Base URL: `http://127.0.0.1:4173/v1`;
- API key: `local-fixture-key`;
- model: `local-fixture`;
- promoted website: `http://127.0.0.1:4173/promotion`;
- identity name/email: local fixture values.

Grant only the localhost optional host permission. Test the model connection and record success.

- [ ] **Step 6: Run the five-URL, concurrency-three acceptance**

Import `tests/fixtures/batch-targets.csv`, set concurrency `3`, timeout `60`, enable automatic generation and submission, and start.

Verify and record:

- preflight includes exactly five rows;
- three worker tabs and three slots appear first;
- two tasks remain queued;
- no fourth worker exists before one slot settles;
- completion immediately replenishes one slot;
- each row keeps the correct URL, attempt, stage, elapsed time and result;
- all requests stay on `127.0.0.1`.

- [ ] **Step 7: Verify pause, recovery, retry and manual processing**

Run another local batch and:

1. pause while three workers are active;
2. confirm no new worker tabs open;
3. reload `batch.html`;
4. confirm the recovery banner and user-gated resume;
5. resume and confirm only safe queued work runs;
6. force a safe timeout and use direct retry;
7. force an uncertain submission and confirm default automatic retry is absent;
8. open the manual window and confirm no panel, generation, filling or submission occurs;
9. mark the task resolved and reload to confirm persistence;
10. stop a batch and confirm resume is unavailable.

- [ ] **Step 8: Capture responsive and keyboard evidence**

Capture:

- 1440px desktop with sidebar, slots and table;
- 1024px compact overview;
- approximately 640px task-card layout.

Keyboard-check:

- global navigation;
- new-batch wizard;
- preflight duplicate action;
- queue filters;
- details drawer;
- pause dialog;
- stop dialog;
- focus restoration after close.

- [ ] **Step 9: Write the QA record**

Write `docs/qa/2026-07-26-batch-operations-console-chrome.md` using only observed values from Steps 4–8. The top metadata must include:

- date `2026-07-26`;
- the exact Chrome version copied from `chrome://version`;
- the exact output of `git rev-parse HEAD`;
- fixture origin `http://127.0.0.1:4173`;
- CSV path `tests/fixtures/batch-targets.csv`;
- concurrency `3`;
- target count `5`;
- “Third-party comments posted: No”.

Add a results table with one row for each of:

- initial 3/5 slot fill;
- replenishment;
- pause and reload recovery;
- safe retry with the observed attempt transition;
- manual window isolation;
- permanent stop;
- 1440/1024/640 layouts;
- keyboard operation.

Every evidence cell must contain a real screenshot path, observed task/window identity, checkpoint state, or list of traversed controls. Do not commit generic text such as “screenshot path” or “observed IDs”.

- [ ] **Step 10: Run final regression and inspect the diff**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: all tests pass, no whitespace errors, and only intended files remain modified.

- [ ] **Step 11: Commit verification evidence**

```bash
git add docs/qa/2026-07-26-batch-operations-console-chrome.md docs/qa/screenshots/batch-console-1440.png docs/qa/screenshots/batch-console-1024.png docs/qa/screenshots/batch-console-640.png
git commit -m "test: verify batch operations console in Chrome"
```

## Final Review Checklist

- [ ] Every design requirement maps to at least one task.
- [ ] All checkpoint task messages carry `batchId`, `urlIndex` and `attempt`.
- [ ] Version 1 recovery data migrates locally and idempotently to version 2.
- [ ] Current counts derive from current attempts, not the truncated compatibility cache.
- [ ] Safe, confirmed-risk and blocked retry policies are enforced in both UI and runtime.
- [ ] Manual resolution never becomes automatic success history.
- [ ] Pause is recoverable; stop is terminal.
- [ ] Online restoration never silently resumes.
- [ ] Unified navigation reaches identity, promotion, batch, history and settings.
- [ ] No profile scheduler or multiple-batch engine was introduced.
- [ ] No remote asset or CSP-incompatible script was introduced.
- [ ] Five local targets run with concurrency three in real Chrome.
- [ ] No third-party comment was submitted.
