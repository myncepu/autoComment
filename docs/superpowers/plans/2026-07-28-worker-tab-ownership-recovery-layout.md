# Worker Tab Ownership Recovery and Queue-First Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably terminalize unexpectedly closed worker tabs in durable background state, refill the vacated slot with the next queued target, replace raw ownership errors with actionable UI, and give the target queue the full console width.

**Architecture:** The background runtime controller becomes authoritative for the ownership-critical `tabs.onRemoved` event, using exact batch/attempt/tab identity and a shared closed-tab result factory. The page runtime consumes a sanitized checkpoint-change message, forgets the removed in-memory tab mapping, reconciles its scheduler, and refills the slot. Production state/view modules remain Chrome-independent; the existing ordinary-web fixture exercises the queue-first layout.

**Tech Stack:** Manifest V3 Chrome extension APIs, ECMAScript modules, Node.js built-in test runner, JSDOM, Playwright with installed Chrome, plain HTML/CSS.

## Global Constraints

- A closed worker target is terminalized; it is never automatically retried.
- A pre-submit close becomes `fail`; a submission-uncertain close becomes `manual_required`.
- `batchId + urlIndex + attempt + tabId` is the exact ownership identity.
- `profileId` is the canonical profile field.
- Passwords and other secrets must never enter checkpoints, `BATCH_HANDLE`, history, UI snapshots, or runtime broadcasts.
- Genuine live ownership must continue blocking destructive start and clear requests.
- Production view/state modules must not import or access `chrome.*`.
- The ordinary-web fixture must reuse production view/state modules and must not expose a production test backdoor.
- Verification must not submit comments to third-party websites.

---

## File Map

**Create**

- `lib/batch-worker-tab-removal.mjs` — shared pure classification and sanitized result creation for an unexpectedly removed worker tab.
- `tests/batch-worker-tab-removal.test.mjs` — focused tests for safe versus submission-uncertain removal results.
- `docs/qa/2026-07-28-worker-tab-ownership-recovery.md` — automated and real-Chrome acceptance record.

**Modify**

- `lib/batch-runtime-controller.mjs` — exact durable tab lookup, idempotent terminal transition, listener installation, and sanitized background notification.
- `lib/batch-window-manager.mjs` — forget an already-removed tab without issuing another close or callback.
- `lib/batch-worker-runtime.mjs` — accept a background terminal checkpoint and replenish the vacated slot.
- `lib/batch-chrome-adapter.mjs` — admit the trusted `BATCH_WORKER_TAB_REMOVED` message.
- `lib/batch-page-composition.mjs` — route the trusted message into the worker runtime and update the rendered checkpoint.
- `lib/batch-console-state.mjs` — translate internal ownership codes to actionable user copy.
- `lib/batch-console-view.mjs` — compose the overview above the queue.
- `styles/batch-console.css` — full-width queue and responsive overview/slot grid.
- `tests/batch-runtime-controller.test.mjs` — durable removal, idempotence, and listener tests.
- `tests/batch-worker-runtime.test.mjs` — external checkpoint reconciliation and refill tests.
- `tests/batch-chrome-adapter.test.mjs` — trusted message allow-list and sender validation.
- `tests/batch-multi-window-integration.test.js` — production-composition close/refill and ownership UI integration.
- `tests/batch-console-state.test.mjs` — ownership-code localization tests.
- `tests/batch-console-view.test.mjs` — DOM order and overview structure tests.
- `tests/batch-console-fixture.test.mjs` — fixture contract for queue-first composition.
- `scripts/run-batch-console-chrome-acceptance.mjs` — 1440/1024/640 geometry assertions.
- `scripts/run-multi-assignment-chrome-acceptance.mjs` — safe local concurrency-three close/refill smoke scenario.

---

### Task 1: Shared Removal Result and Durable Ownership Convergence

**Files:**

- Create: `lib/batch-worker-tab-removal.mjs`
- Create: `tests/batch-worker-tab-removal.test.mjs`
- Modify: `lib/batch-worker-runtime.mjs:487-525`
- Modify: `lib/batch-runtime-controller.mjs:1260-1535,2535-2590`
- Test: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**

- Produces: `createWorkerTabRemovalResult(task) -> { result, aiContent, errorCode, errorMessage }`
- Produces: `controller.handleWorkerTabRemoved(tabId) -> Promise<{ ok, changed, checkpoint, removal? }>`
- `removal`, when present, is `{ batchId, urlIndex, attempt, tabId }`.

- [ ] **Step 1: Write failing pure-classification tests**

```js
test('classifies a pre-submit worker close as a safe failure', () => {
  assert.deepEqual(createWorkerTabRemovalResult({
    state: 'active',
    phase: 'generating'
  }), {
    result: 'fail',
    aiContent: null,
    errorCode: 'task_failed',
    errorMessage: '用户关闭了自动 worker 标签页'
  });
});

test('classifies a submitting worker close as manual-required', () => {
  assert.deepEqual(createWorkerTabRemovalResult({
    state: 'submitting',
    phase: 'confirming'
  }), {
    result: 'manual_required',
    aiContent: null,
    errorCode: 'submission_uncertain',
    errorMessage: 'worker 标签页在提交确认期间被关闭'
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node --test tests/batch-worker-tab-removal.test.mjs
```

Expected: FAIL because `lib/batch-worker-tab-removal.mjs` does not exist.

- [ ] **Step 3: Implement the pure result factory and reuse it in the page runtime**

```js
export function createWorkerTabRemovalResult(task) {
  const uncertain = task?.state === 'submitting' ||
    task?.phase === 'submitting' ||
    task?.phase === 'confirming';
  return {
    result: uncertain ? 'manual_required' : 'fail',
    aiContent: null,
    errorCode: uncertain ? 'submission_uncertain' : 'task_failed',
    errorMessage: uncertain
      ? 'worker 标签页在提交确认期间被关闭'
      : '用户关闭了自动 worker 标签页'
  };
}
```

In `batch-worker-runtime.mjs`, make the `unexpected` branch of
`interruptionResult()` return `createWorkerTabRemovalResult(task)` so the page
and background generate byte-for-byte identical terminal results.

- [ ] **Step 4: Run the pure tests and the existing unexpected-close tests**

Run:

```bash
node --test tests/batch-worker-tab-removal.test.mjs
node --test --test-name-pattern="unexpected worker-tab close|unexpected close during submission" tests/batch-worker-runtime.test.mjs
```

Expected: all selected tests PASS.

- [ ] **Step 5: Write failing controller tests for exact durable convergence**

Add tests that start a two-target batch, activate target zero with `tabId: 11`,
then call `handleWorkerTabRemoved(11)` and assert:

```js
assert.equal(response.ok, true);
assert.equal(response.changed, true);
assert.deepEqual(response.removal, {
  batchId: 'batch-1',
  urlIndex: 0,
  attempt: 1,
  tabId: 11
});
assert.equal(response.checkpoint.tasks['0'].state, 'terminal');
assert.equal(response.checkpoint.results[0].result, 'fail');
assert.equal(response.checkpoint.tasks['1'].state, 'queued');
assert.equal(response.checkpoint.tasks['0'].tabId, null);
```

Add separate cases for:

```js
assert.equal(submittingResponse.checkpoint.results[0].result, 'manual_required');
assert.equal(submittingResponse.checkpoint.results[0].errorCode, 'submission_uncertain');
assert.equal((await controller.handleWorkerTabRemoved(11)).changed, false);
assert.equal((await controller.handleWorkerTabRemoved(999)).changed, false);
```

Also assert the session journal entry for the terminalized request is removed
after checkpoint persistence.

- [ ] **Step 6: Run the controller tests and verify the new cases fail**

Run:

```bash
node --test --test-name-pattern="removed worker tab|duplicate worker removal|unrelated removed tab" tests/batch-runtime-controller.test.mjs
```

Expected: FAIL because `handleWorkerTabRemoved` is not exported.

- [ ] **Step 7: Implement `handleWorkerTabRemoved` without weakening live-tab proof**

Inside the controller queue, load the validated checkpoint, locate exactly one
`active` or `submitting` task whose `tabId` equals the removed tab, and apply
the existing `task_terminal` checkpoint event:

```js
const candidate = applyBatchRuntimeEvent(checkpoint, {
  type: 'task_terminal',
  batchId: checkpoint.batchId,
  taskId: task.taskId,
  urlIndex: task.urlIndex,
  profileId: task.profileId,
  promotionSiteId: task.promotionSiteId,
  attempt: task.attempt,
  result: createWorkerTabRemovalResult(task)
}, now());
```

Persist `candidate.checkpoint` before removing `task.requestId` from the session
journal. Return `changed: false` for absent, stale, or already-terminal
ownership. Do not call `removeTaskWithProof`: `tabs.onRemoved` is itself the
authoritative fact that this exact `tabId` is gone. Keep the existing
`terminalTask()` proof path unchanged for all message-driven terminalization.

Expose `handleWorkerTabRemoved` on the returned controller object.

- [ ] **Step 8: Run focused and full controller tests**

Run:

```bash
node --test tests/batch-worker-tab-removal.test.mjs tests/batch-runtime-controller.test.mjs
```

Expected: PASS, including the existing test that live durable ownership blocks
start and clear.

- [ ] **Step 9: Commit Task 1**

```bash
git add lib/batch-worker-tab-removal.mjs lib/batch-worker-runtime.mjs lib/batch-runtime-controller.mjs tests/batch-worker-tab-removal.test.mjs tests/batch-runtime-controller.test.mjs
git commit -m "fix: converge removed worker tab ownership"
```

---

### Task 2: Background Notification and Page-Side Slot Refill

**Files:**

- Modify: `lib/batch-runtime-controller.mjs:2550-2590`
- Modify: `lib/batch-window-manager.mjs:105-175`
- Modify: `lib/batch-worker-runtime.mjs:1300-1475`
- Modify: `lib/batch-chrome-adapter.mjs:15-25,195-215`
- Modify: `lib/batch-page-composition.mjs:330-365,666-705`
- Test: `tests/batch-runtime-controller.test.mjs`
- Test: `tests/batch-worker-runtime.test.mjs`
- Test: `tests/batch-chrome-adapter.test.mjs`
- Test: `tests/batch-multi-window-integration.test.js`

**Interfaces:**

- Consumes: `controller.handleWorkerTabRemoved(tabId)`.
- Produces: trusted runtime message
  `{ type: 'BATCH_WORKER_TAB_REMOVED', batchId, urlIndex, attempt, tabId, checkpoint }`.
- Produces: `BatchTabManager.forgetRemoved(tabId) -> activity | null`.
- Produces: `workerRuntime.acceptRemovedTabCheckpoint(message) -> Promise<boolean>`.

- [ ] **Step 1: Write failing background-listener tests**

Extend the fake Chrome harness with a `tabs.onRemoved` event. Install the
controller and emit `11`. Assert one sanitized broadcast occurs only after
durable persistence:

```js
assert.deepEqual(broadcasts.at(-1), {
  type: 'BATCH_WORKER_TAB_REMOVED',
  batchId: 'batch-1',
  urlIndex: 0,
  attempt: 1,
  tabId: 11,
  checkpoint: responseCheckpoint
});
assert.ok(
  operationLog.findIndex(([name]) => name === 'persist') <
  operationLog.findIndex(([name]) => name === 'broadcast')
);
```

Assert unrelated tab removal produces no broadcast.

- [ ] **Step 2: Run the listener tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="installed removed-tab listener|broadcasts removed worker checkpoint" tests/batch-runtime-controller.test.mjs
```

Expected: FAIL because the installer does not register `tabs.onRemoved`.

- [ ] **Step 3: Install the authoritative listener and broadcast only sanitized success**

Add a listener in `installBatchRuntimeController`:

```js
chromeApi.tabs.onRemoved.addListener((tabId) => {
  void controller.handleWorkerTabRemoved(tabId).then((response) => {
    if (!response?.ok || !response.changed || !response.removal) return;
    return chromeApi.runtime.sendMessage({
      type: 'BATCH_WORKER_TAB_REMOVED',
      ...response.removal,
      checkpoint: response.checkpoint
    }).catch(() => {});
  });
});
```

The controller checkpoint contract already excludes profile secrets; retain the
adapter’s recursive sensitive-key scrub before the page consumes the message.

- [ ] **Step 4: Write failing manager/runtime reconciliation tests**

For `BatchTabManager`, create one activity and assert:

```js
assert.equal(manager.forgetRemoved(activity.tabId), activity);
assert.equal(manager.getByIndex(activity.urlIndex), null);
assert.equal(unexpectedCloseCalls.length, 0);
assert.deepEqual(tabsApi.removeCalls, []);
```

For `BatchWorkerRuntime`, start a two-target/concurrency-one batch, provide the
background-terminalized checkpoint for target zero, and assert:

```js
assert.equal(
  await runtime.acceptRemovedTabCheckpoint({
    batchId: 'batch-1',
    urlIndex: 0,
    attempt: 1,
    tabId: 100,
    checkpoint: terminalCheckpoint
  }),
  true
);
assert.deepEqual(
  harness.sentHandles.map(({ urlIndex }) => urlIndex),
  [0, 1]
);
```

Add stale batch, stale attempt, and duplicate message cases returning `false`
without opening another tab.

- [ ] **Step 5: Run the runtime tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="forgetRemoved|accepts removed-tab checkpoint|ignores stale removed-tab checkpoint" tests/batch-window-manager.test.mjs tests/batch-worker-runtime.test.mjs
```

Expected: FAIL because both new methods are absent.

- [ ] **Step 6: Implement in-memory forgetting and scheduler reconciliation**

Implement `forgetRemoved(tabId)` by deleting manager maps and expected-close
state without invoking `onUnexpectedClose`.

Implement `acceptRemovedTabCheckpoint(message)` inside the worker lifecycle
queue. Validate batch, attempt, old tab identity, and terminal checkpoint;
forget the old activity; assign the newer checkpoint; reconcile the scheduler;
emit `changed`; and call `replenishOrComplete(owner)` only when owner status and
checkpoint status are both `running`.

- [ ] **Step 7: Write failing adapter and page-composition integration tests**

Assert the adapter accepts `BATCH_WORKER_TAB_REMOVED` only from the trusted
background sender and rejects a tab sender.

In the production harness, start concurrency one with two local targets, emit a
trusted removal message for the first activity, and assert the second target is
created while the first is terminal:

```js
assert.equal(harness.storageLocal.data.batchRuntimeCheckpoint.tasks['0'].state, 'terminal');
assert.ok(harness.tabsApi.createCalls.some(({ url }) => url.endsWith('/target-1')));
assert.equal(
  harness.document.querySelector('[data-runtime-error]'),
  null
);
```

- [ ] **Step 8: Route the trusted notification through production composition**

Add `BATCH_WORKER_TAB_REMOVED` to `PAGE_RUNTIME_MESSAGE_TYPES`. In the page
runtime subscription:

```js
if (message?.type === 'BATCH_WORKER_TAB_REMOVED') {
  void coreWorkerRuntime.acceptRemovedTabCheckpoint(message).then((accepted) => {
    if (!accepted && message.checkpoint?.batchId === checkpoint?.batchId) {
      checkpoint = message.checkpoint;
      render();
    }
  }).catch(() => {
    runtimeError = 'worker_tab_reconcile_failed';
    render();
  });
  return;
}
```

Expose the method on the page’s worker-runtime wrapper only if command code
needs it; the runtime-message subscription may call the core method directly.

- [ ] **Step 9: Run all Task 2 tests**

Run:

```bash
node --test tests/batch-runtime-controller.test.mjs tests/batch-window-manager.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-chrome-adapter.test.mjs tests/batch-multi-window-integration.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add lib/batch-runtime-controller.mjs lib/batch-window-manager.mjs lib/batch-worker-runtime.mjs lib/batch-chrome-adapter.mjs lib/batch-page-composition.mjs tests/batch-runtime-controller.test.mjs tests/batch-window-manager.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-chrome-adapter.test.mjs tests/batch-multi-window-integration.test.js
git commit -m "fix: refill slots after worker tab removal"
```

---

### Task 3: Actionable Ownership Recovery UI

**Files:**

- Modify: `lib/batch-console-state.mjs:232-285`
- Modify: `lib/batch-page-composition.mjs:405-450`
- Test: `tests/batch-console-state.test.mjs`
- Test: `tests/batch-multi-window-integration.test.js`

**Interfaces:**

- Produces: `runtimeErrorMessage(errorCode) -> string`.
- Preserves: internal runtime code `batch_ownership_active`.

- [ ] **Step 1: Write failing state tests for ownership messaging**

```js
const snapshot = createBatchConsoleSnapshot(activeCheckpoint, {
  runtimeError: 'batch_ownership_active'
});
assert.equal(snapshot.banners.at(-1).title, '当前批次仍在运行');
assert.equal(
  snapshot.banners.at(-1).message,
  '当前批次仍有活动任务，请继续处理或停止批次。'
);
assert.doesNotMatch(
  snapshot.banners.at(-1).message,
  /batch_ownership_active/
);
assert.equal(snapshot.command.canCreate, false);
```

Add a fallback assertion showing an unknown safe diagnostic code remains
visible for supportability.

- [ ] **Step 2: Run the state tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="ownership error|unknown runtime error" tests/batch-console-state.test.mjs
```

Expected: FAIL because the raw code is currently rendered.

- [ ] **Step 3: Implement exact error presentation and create-button guard**

Add a pure mapping:

```js
const RUNTIME_ERROR_PRESENTATION = Object.freeze({
  batch_ownership_active: {
    title: '当前批次仍在运行',
    message: '当前批次仍有活动任务，请继续处理或停止批次。'
  }
});
```

Use it in `bannersFor()`. Keep the raw error code in command state for logs, but
render only the mapped title/message. Tighten `canCreate` so a checkpoint with
`active` or `submitting` durable tasks cannot open a new wizard even if its
status is temporarily `paused_recovery`.

- [ ] **Step 4: Add and run a production-composition regression**

Drive a rejected create attempt with `batch_ownership_active` and assert the
Chinese banner is shown, the existing batch remains selected, and no
`BATCH_SESSION_CLEAR` message follows.

Run:

```bash
node --test tests/batch-console-state.test.mjs tests/batch-multi-window-integration.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add lib/batch-console-state.mjs lib/batch-page-composition.mjs tests/batch-console-state.test.mjs tests/batch-multi-window-integration.test.js
git commit -m "fix: explain active batch ownership in console"
```

---

### Task 4: Queue-First Responsive Console Layout

**Files:**

- Modify: `lib/batch-console-view.mjs:409-510,870-910,1215-1250`
- Modify: `styles/batch-console.css:540-680,840-930`
- Test: `tests/batch-console-view.test.mjs`
- Test: `tests/batch-console-fixture.test.mjs`
- Modify: `scripts/run-batch-console-chrome-acceptance.mjs`

**Interfaces:**

- Produces DOM order:
  `[data-console-overview]` immediately before `.batch-console__queue`.
- Produces overview children:
  `[data-assignment-summary]`, `[data-runtime-health]`,
  `[data-worker-slots]`.

- [ ] **Step 1: Write failing DOM-order and landmark tests**

```js
const content = document.querySelector('[data-console-content]');
const overview = content.querySelector('[data-console-overview]');
const queue = content.querySelector('.batch-console__queue');
assert.equal(overview.nextElementSibling, queue);
assert.ok(overview.querySelector('[data-assignment-summary]'));
assert.ok(overview.querySelector('[data-runtime-health]'));
assert.ok(overview.querySelector('[data-worker-slots]'));
assert.equal(document.querySelector('aside.batch-console__overview'), null);
```

Retain assertions for slot labels, elapsed time, profile labels, promotion-site
labels, and accessible headings.

- [ ] **Step 2: Run view tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="overview above full-width queue|worker slots remain accessible" tests/batch-console-view.test.mjs
```

Expected: FAIL because the overview is currently an `aside` in a desktop
two-column grid and lacks the new component data attributes.

- [ ] **Step 3: Recompose the production view without Chrome dependencies**

Render the overview as a full-width section:

```js
function renderOverview(documentRef, snapshot) {
  const overview = documentRef.createElement('section');
  overview.className = 'batch-console__overview';
  overview.dataset.consoleOverview = '';
  overview.setAttribute('aria-label', '批次运行概览');
  const summaries = documentRef.createElement('div');
  summaries.className = 'batch-console__overview-summaries';
  summaries.append(
    renderAssignment(documentRef, snapshot),
    renderHealth(documentRef, snapshot)
  );
  overview.append(summaries, renderSlots(documentRef, snapshot));
  return overview;
}
```

Add the three data attributes in their render functions. Keep `renderCurrent`
ordering as overview then queue and do not add any `chrome.*` access.

- [ ] **Step 4: Replace the desktop rail with a responsive overview grid**

Use full-width layout CSS:

```css
.batch-console__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--app-space-4, 16px);
}

.batch-console__overview-summaries {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-3, 12px);
}

.batch-console__slots {
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}
```

Remove the `@media (min-width: 1280px)` 245px sidebar rule. At 899px and below,
stack overview summaries; retain the existing table-to-card breakpoint and
single-column 639px controls.

- [ ] **Step 5: Extend ordinary-web fixture and Chrome geometry assertions**

At each viewport, capture `overviewRect`, `queueRect`, and slot-grid columns.
Assert:

```js
assert.ok(state.overviewBottom <= state.queueTop);
assert.ok(Math.abs(state.queueLeft - state.contentLeft) <= 1);
assert.ok(Math.abs(state.queueRight - state.contentRight) <= 1);
assert.equal(state.horizontalOverflow, false);
```

Keep the existing 1440/1024 table and 640 card assertions, filters, drawer,
pause/resume/stop interactions, same-origin request audit, and zero page errors.

- [ ] **Step 6: Run view, fixture, and browser acceptance tests**

Run:

```bash
node --test tests/batch-console-view.test.mjs tests/batch-console-fixture.test.mjs tests/batch-console-accessibility.test.mjs
npm run test:chrome:console
```

Expected: PASS at 1440, 1024, and 640 with no horizontal overflow and zero
third-party requests.

- [ ] **Step 7: Commit Task 4**

```bash
git add lib/batch-console-view.mjs styles/batch-console.css tests/batch-console-view.test.mjs tests/batch-console-fixture.test.mjs scripts/run-batch-console-chrome-acceptance.mjs
git commit -m "feat: move worker overview above target queue"
```

---

### Task 5: End-to-End Safety Verification and QA Record

**Files:**

- Modify: `scripts/run-multi-assignment-chrome-acceptance.mjs`
- Create: `docs/qa/2026-07-28-worker-tab-ownership-recovery.md`

**Interfaces:**

- Consumes all prior task interfaces.
- Produces a machine-readable acceptance summary with
  `closedUrlIndex`, `replacementUrlIndex`, `maxConcurrency`,
  `thirdPartyRequests`, and `pageErrors`.

- [ ] **Step 1: Add the real-extension close/refill acceptance scenario**

Use five local fixture target URLs and concurrency three. After three worker
tabs are active, close the tab for URL index zero through Playwright/Chrome,
then wait for index three to become active.

Assert:

```js
assert.equal(checkpoint.tasks['0'].state, 'terminal');
assert.equal(checkpoint.results.find(
  ({ originalIndex }) => originalIndex === 0
).errorCode, 'task_failed');
assert.equal(checkpoint.tasks['3'].state, 'active');
assert.equal(activeWorkerTabs.length, 3);
assert.equal(runtimeErrorText.includes('batch_ownership_active'), false);
assert.equal(thirdPartyRequests.length, 0);
assert.deepEqual(pageErrors, []);
```

All targets must remain on the locally started HTTP fixture origin. Automation
must stop before any real submit action.

- [ ] **Step 2: Run focused syntax checks**

Run:

```bash
node --check background.js
node --check batch.js
node --check lib/batch-runtime-controller.mjs
node --check lib/batch-worker-runtime.mjs
node --check lib/batch-page-composition.mjs
node --check lib/batch-console-view.mjs
node --check scripts/run-multi-assignment-chrome-acceptance.mjs
```

Expected: every command exits 0.

- [ ] **Step 3: Run the full automated suite**

Run:

```bash
npm test
```

Expected: PASS with zero failing tests.

- [ ] **Step 4: Run both Chrome acceptances**

Run:

```bash
npm run test:chrome:console
npm run test:chrome:multi-assignment
```

Expected:

- console acceptance passes at 1440, 1024, and 640;
- multi-assignment acceptance reports concurrency three;
- closing target zero opens target three;
- `thirdPartyRequests` is `0`;
- no comment is submitted.

- [ ] **Step 5: Write the QA record with exact evidence**

Create `docs/qa/2026-07-28-worker-tab-ownership-recovery.md` containing:

```markdown
# Worker Tab Ownership Recovery Acceptance

- Branch: `codex/fix-worker-tab-ownership-layout`
- Automated suite: `npm test` — PASS; include the exact `# tests`, `# pass`,
  `# fail`, and `duration_ms` lines printed by Node
- Syntax checks: PASS
- Console Chrome acceptance: PASS at 1440 / 1024 / 640
- Extension Chrome acceptance: PASS, concurrency 3, local targets 5
- Closed target: index 0
- Replacement target: index 3
- Third-party requests: 0
- Comments submitted: 0
- Page errors: 0
```

- [ ] **Step 6: Verify the final diff and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -6
```

Expected: no whitespace errors; only the QA record and acceptance-script change
remain uncommitted before the final commit.

- [ ] **Step 7: Commit Task 5**

```bash
git add scripts/run-multi-assignment-chrome-acceptance.mjs docs/qa/2026-07-28-worker-tab-ownership-recovery.md
git commit -m "test: verify worker tab recovery in Chrome"
```

- [ ] **Step 8: Final verification after the commit**

Run:

```bash
npm test
npm run test:chrome:console
npm run test:chrome:multi-assignment
git status --short --branch
```

Expected: all tests PASS and the worktree is clean.
