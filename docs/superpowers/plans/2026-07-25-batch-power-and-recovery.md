# Batch Power and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep macOS awake while a batch is running and restore a fully persisted, safely paused batch after Chrome or the batch page restarts.

**Architecture:** Keep `batch.html` as the multi-window scheduler, but make the background service worker the only writer for a versioned `batchRuntimeCheckpoint`. A pure checkpoint state machine supplies deterministic transitions; a background runtime controller serializes storage mutations, owns `chrome.power`, normalizes interrupted active/submitting tasks, closes orphan worker windows, and opens one paused recovery page. The batch page mirrors the checkpoint into its existing UI and scheduler, while content scripts durably mark `submitting` before clicking.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, `chrome.storage.local`, `chrome.power`, `chrome.runtime`, `chrome.tabs`, `chrome.windows`, Node.js built-in test runner.

## Global Constraints

- Chrome restart recovery opens `batch.html` but never resumes work without a user click.
- Only a `running` checkpoint may hold `chrome.power.requestKeepAwake('system')`.
- `paused_recovery`, `terminated`, and `completed` checkpoints release the keep-awake request.
- The checkpoint stores the complete current CSV dataset and results without the existing 100-result truncation.
- Interrupted `active` tasks return to `queued`; interrupted `submitting` tasks become one `manual_required` terminal result and are never automatically retried.
- The background service worker is the only writer of `batchRuntimeCheckpoint`.
- Existing concurrent window scheduling, comment history durability, submit-context recovery, filtering, and CSV export behavior must remain intact.
- Do not modify or stage the user's `.DS_Store` change.

---

## File Structure

- Create `lib/batch-runtime-checkpoint.mjs`: pure schema validation and state transitions.
- Create `lib/batch-runtime-controller.mjs`: serialized storage, power ownership, startup recovery, orphan-window cleanup, and recovery-page creation.
- Create `tests/batch-runtime-checkpoint.test.mjs`: checkpoint state-machine tests.
- Create `tests/batch-runtime-controller.test.mjs`: background controller and Power API tests.
- Modify `background.js`: install the controller and connect terminal result paths.
- Modify `manifest.json`: add the `power` permission.
- Modify `content.js`: persist `submitting` before every automated click.
- Modify `batch.js`: create checkpoints, persist window activity, restore paused state, and release power on terminal transitions.
- Modify `batch.html`: recovery/power status UI.
- Modify `tests/batch-multi-window-integration.test.js`: page lifecycle and recovery integration tests.
- Modify `tests/comment-history-submit-flow.test.js`: assert the submit checkpoint gate precedes every automated click.
- Modify `tests/batch-submit-order.test.js`: retain ordering coverage for the new checkpoint gate.

---

### Task 1: Versioned checkpoint state machine

**Files:**
- Create: `lib/batch-runtime-checkpoint.mjs`
- Create: `tests/batch-runtime-checkpoint.test.mjs`

**Interfaces:**
- Produces: `BATCH_RUNTIME_CHECKPOINT_KEY`, `BATCH_RUNTIME_VERSION`, `createBatchRuntimeCheckpoint(input, now)`, `validateBatchRuntimeCheckpoint(value)`, `applyBatchRuntimeEvent(checkpoint, event, now)`, and `normalizeInterruptedBatch(checkpoint, now)`.
- Consumers: `lib/batch-runtime-controller.mjs` and `batch.js`.

- [ ] **Step 1: Write failing creation and validation tests**

```js
test('creates a versioned checkpoint with the complete dataset', () => {
  const items = Array.from({ length: 125 }, (_, originalIndex) => ({
    originalIndex,
    url: `https://example.test/${originalIndex}`,
    sourceDomain: 'example.test',
    originalRow: [String(originalIndex), `https://example.test/${originalIndex}`]
  }));
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: 'batch-1',
    source: { fileName: 'input.csv', headers: ['id', 'URL'], rows: items.map((item) => item.originalRow), parsedUrls: items },
    settings: { autoOpenPanel: true, autoGenerate: true, autoSubmit: true, timeoutSeconds: 60, concurrency: 3 }
  }, 1000);

  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.source.rows.length, 125);
  assert.equal(checkpoint.source.parsedUrls.length, 125);
  assert.equal(Object.keys(checkpoint.tasks).length, 125);
  assert.ok(Object.values(checkpoint.tasks).every((task) => task.state === 'queued'));
  assert.equal(validateBatchRuntimeCheckpoint(checkpoint).ok, true);
});

test('rejects malformed and unsupported checkpoints', () => {
  assert.deepEqual(validateBatchRuntimeCheckpoint(null), { ok: false, error: 'invalid_checkpoint' });
  assert.deepEqual(validateBatchRuntimeCheckpoint({ version: 99 }), { ok: false, error: 'unsupported_version' });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: FAIL because `lib/batch-runtime-checkpoint.mjs` does not exist.

- [ ] **Step 3: Implement the schema and immutable creation**

Use constants:

```js
export const BATCH_RUNTIME_CHECKPOINT_KEY = 'batchRuntimeCheckpoint';
export const BATCH_RUNTIME_VERSION = 1;
export const BATCH_TERMINAL_RESULTS = new Set([
  'success', 'skipped', 'no_comment_box',
  'manual_required', 'blocked_illegal', 'fail'
]);
```

`createBatchRuntimeCheckpoint` must structured-clone the source/settings, create one `queued` task per parsed URL, initialize `results: []`, `status: 'paused_recovery'`, `cursor.nextIndex: 0`, and timestamps. Validation must reject missing identity, non-array source fields, duplicate/out-of-range task indices, invalid task states, invalid results, and unsupported versions.

- [ ] **Step 4: Run creation tests and verify GREEN**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing transition tests**

Cover these concrete events:

```js
{ type: 'session_started' }
{ type: 'task_activated', urlIndex: 0, tabId: 41, windowId: 51, startedAt: 1100 }
{ type: 'task_submitting', urlIndex: 0 }
{ type: 'task_terminal', urlIndex: 0, result: { result: 'success', aiContent: 'ok' } }
{ type: 'session_paused' }
{ type: 'session_terminated' }
{ type: 'session_completed' }
```

Assertions:

- only `queued` becomes `active`;
- activity stores both `tabId` and `windowId` for the current multi-window implementation;
- only `active` becomes `submitting`;
- terminal results are idempotent and cannot be overwritten;
- completed/terminated checkpoints reject `session_started`;
- stale `batchId` and out-of-range indices return `{ ok: false }` without mutation;
- `cursor.nextIndex` always points at the first non-terminal task.

- [ ] **Step 6: Run transition tests and verify RED**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: FAIL because `applyBatchRuntimeEvent` does not implement the events.

- [ ] **Step 7: Implement minimal pure transitions**

Return:

```js
{ ok: true, checkpoint: nextCheckpoint, changed: true }
```

or:

```js
{ ok: false, error: 'invalid_transition', checkpoint }
```

Never mutate the input object. A repeated identical terminal event returns `ok: true`, `changed: false`; a different second terminal result returns `ok: false`, `error: 'task_already_terminal'`.

- [ ] **Step 8: Run transition tests and verify GREEN**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: PASS.

- [ ] **Step 9: Write failing interrupted-normalization tests**

Create a checkpoint containing one `queued`, one `active`, one `submitting`, and one terminal task. Assert:

- `active` becomes `queued` and clears `tabId`, `windowId`, and `startedAt`;
- `submitting` becomes terminal `manual_required` with exact message `任务在提交确认前中断，评论可能已提交，请人工确认`;
- the old active/submitting window IDs are returned in `orphanWindowIds`;
- batch status becomes `paused_recovery`;
- calling normalization twice does not append another result.

- [ ] **Step 10: Implement and verify interrupted normalization**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: PASS with all checkpoint tests.

- [ ] **Step 11: Commit Task 1**

```bash
git add lib/batch-runtime-checkpoint.mjs tests/batch-runtime-checkpoint.test.mjs
git commit -m "feat: add durable batch checkpoint state machine"
```

---

### Task 2: Background runtime controller and Power API

**Files:**
- Create: `lib/batch-runtime-controller.mjs`
- Create: `tests/batch-runtime-controller.test.mjs`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: all exports from `lib/batch-runtime-checkpoint.mjs`.
- Produces: `createBatchRuntimeController(dependencies)`, `installBatchRuntimeController(chromeApi, controller)`, `handleMessage(message, sender)`, `markTerminal(resultMessage)`, `recoverOnStartup()`, and `loadForPage()`.
- Message responses: `{ ok: true, checkpoint }` or `{ ok: false, error }`.

- [ ] **Step 1: Write the failing serialized-storage tests**

Use delayed in-memory storage and call two task events concurrently. Assert neither event is lost and that only the controller calls `storage.set({ batchRuntimeCheckpoint })`.

```js
await Promise.all([
  controller.handleMessage({ type: 'BATCH_TASK_ACTIVE', batchId: 'batch-1', urlIndex: 0, tabId: 1, windowId: 11 }),
  controller.handleMessage({ type: 'BATCH_TASK_ACTIVE', batchId: 'batch-1', urlIndex: 1, tabId: 2, windowId: 12 })
]);
```

- [ ] **Step 2: Run controller tests and verify RED**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement serialized checkpoint mutations**

Follow `createBatchResultStore`'s Promise-chain pattern:

```js
let operation = Promise.resolve();
function enqueue(work) {
  const current = operation.then(work);
  operation = current.catch(() => {});
  return current;
}
```

Support:

- `BATCH_SESSION_START`
- `BATCH_SESSION_GET`
- `BATCH_SESSION_LOAD_FOR_PAGE`
- `BATCH_SESSION_RESUME`
- `BATCH_SESSION_PAUSE`
- `BATCH_SESSION_STOP`
- `BATCH_SESSION_COMPLETE`
- `BATCH_TASK_ACTIVE`
- `BATCH_TASK_SUBMITTING`
- `BATCH_TASK_TERMINAL`
- `BATCH_SESSION_CLEAR`

Validate the sender with `sender.id === chrome.runtime.id` in the installed listener.

- [ ] **Step 4: Write failing power lifecycle tests**

Assert:

- create/resume calls `power.requestKeepAwake('system')`;
- pause/stop/complete calls `power.releaseKeepAwake()`;
- repeated running commands do not duplicate the request;
- a failed `requestKeepAwake` leaves the checkpoint paused and returns `power_request_failed`;
- `loadForPage` normalizes a stale running checkpoint and releases power;
- startup recovery never requests power.

- [ ] **Step 5: Run power tests and verify RED**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: FAIL because power ownership is not implemented.

- [ ] **Step 6: Implement power ownership**

Use an internal `keepAwake` boolean. For create/resume:

1. Persist or retain a paused checkpoint.
2. call `requestKeepAwake('system')`;
3. apply `session_started`;
4. persist the running checkpoint.

If step 2 or 4 fails, call `releaseKeepAwake`, retain/restore `paused_recovery`, and return an error. Pause/stop/complete persist the non-running state before releasing.

- [ ] **Step 7: Write failing startup and orphan cleanup tests**

Assert startup:

- normalizes a stale `running` checkpoint;
- best-effort closes every unique recorded `windowId`;
- opens `runtime.getURL('batch.html?recovery=1')` only if no existing batch page is found;
- does not open for completed/terminated checkpoints;
- does not create a duplicate recovery tab.

- [ ] **Step 8: Implement startup recovery and listener installation**

`installBatchRuntimeController` must register:

- one `runtime.onMessage` listener for the supported message types;
- one `runtime.onStartup` listener that calls `recoverOnStartup()` without returning a Promise;
- safe `.catch()` logging without exposing checkpoint contents.

- [ ] **Step 9: Add the Manifest permission**

Add `"power"` to `manifest.json` permissions without changing unrelated permissions or host access.

- [ ] **Step 10: Run Task 2 tests and manifest validation**

Run:

```bash
node --test tests/batch-runtime-controller.test.mjs
node -e "const m=require('./manifest.json'); if(!m.permissions.includes('power')) process.exit(1)"
```

Expected: both commands exit 0.

- [ ] **Step 11: Commit Task 2**

```bash
git add lib/batch-runtime-controller.mjs tests/batch-runtime-controller.test.mjs manifest.json
git commit -m "feat: manage batch recovery and system wakefulness"
```

---

### Task 3: Durable submit phase and terminal result integration

**Files:**
- Modify: `background.js`
- Modify: `content.js`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `tests/comment-history-submit-flow.test.js`
- Modify: `tests/batch-submit-order.test.js`

**Interfaces:**
- Consumes: `createBatchRuntimeController` and `installBatchRuntimeController`.
- Produces: content-to-background `BATCH_TASK_SUBMITTING` acknowledgements and atomic terminal checkpoint updates before `BATCH_CONFIRMED`.

- [ ] **Step 1: Write failing background installation tests**

Extend the controller harness to assert `background.js`:

- constructs one controller with `chrome.storage.local`, `chrome.power`, `chrome.tabs`, `chrome.windows`, and `chrome.runtime`;
- installs its message/startup listeners once;
- calls `markTerminal` before broadcasting `BATCH_CONFIRMED` in `BATCH_HANDLE_CONFIRM`, `BATCH_HISTORY_FALLBACK_DURABLE`, and non-deferred `BATCH_REPORT_RESULT` flows.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test tests/batch-runtime-controller.test.mjs tests/comment-history-message-listener.test.mjs
```

Expected: FAIL because `background.js` has no runtime controller.

- [ ] **Step 3: Install the controller and gate confirmations**

At background startup:

```js
const batchRuntimeController = createBatchRuntimeController({
  storageArea: chrome.storage.local,
  power: chrome.power,
  tabs: chrome.tabs,
  windows: chrome.windows,
  runtime: chrome.runtime
});
installBatchRuntimeController(chrome, batchRuntimeController);
```

Before any durable confirmation broadcast, await:

```js
await batchRuntimeController.markTerminal({
  batchId: message.batchId,
  urlIndex: message.urlIndex,
  result: message.result ?? 'success',
  aiContent: message.aiContent || null,
  errorMessage: message.errorMessage || null
});
```

If checkpoint persistence fails, return `{ ok: false, error: 'checkpoint_write_failed' }` and do not broadcast/close the work window.

- [ ] **Step 4: Write failing submit-order tests**

For every automated click path, assert source order is:

1. `persistBatchSubmitContext(...)`;
2. `markBatchTaskSubmitting(batchId, urlIndex)`;
3. `clickCommentSubmitButton()`.

Also assert a failed `BATCH_TASK_SUBMITTING` response clears the just-saved submit context and throws before the click.

- [ ] **Step 5: Run submit tests and verify RED**

Run:

```bash
node --test tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js
```

Expected: FAIL because the submitting checkpoint gate does not exist.

- [ ] **Step 6: Implement the content checkpoint gate**

Add:

```js
async function markBatchTaskSubmitting(batchId, urlIndex) {
  const response = await chrome.runtime.sendMessage({
    type: 'BATCH_TASK_SUBMITTING',
    batchId,
    urlIndex
  });
  if (!response?.ok) {
    throw new Error(response?.error || '无法保存批处理提交阶段');
  }
}
```

Call it after submit-context persistence and before all automated click paths. On failure, clear only the matching submit context, report a normal task failure, and do not click.

- [ ] **Step 7: Run Task 3 focused tests**

Run:

```bash
node --test tests/batch-runtime-controller.test.mjs tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js tests/batch-submit-context-client.test.js tests/batch-submit-context-store.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add background.js content.js tests/batch-runtime-controller.test.mjs tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js
git commit -m "feat: checkpoint batch submissions before click"
```

---

### Task 4: Batch page creation, activity persistence, and paused recovery UI

**Files:**
- Modify: `batch.js`
- Modify: `batch.html`
- Modify: `tests/batch-multi-window-integration.test.js`

**Interfaces:**
- Consumes: controller messages from Task 2.
- Produces: a reconstructed `paused_recovery` page and persisted activity/window lifecycle.

- [ ] **Step 1: Write failing start and power-error tests**

Extend `createBatchHarness` so `runtimeSendMessage` records messages. Assert:

- `startBatch()` sends `BATCH_SESSION_START` with the full immutable `batchItems`, filename, headers, raw parsed rows, settings, timeout, and concurrency;
- no worker window is filled before the response succeeds;
- a `power_request_failed` response returns the UI to idle, preserves the uploaded CSV, and shows a user-facing error.

- [ ] **Step 2: Run integration test and verify RED**

Run: `node --test tests/batch-multi-window-integration.test.js`

Expected: FAIL because start does not create a runtime checkpoint.

- [ ] **Step 3: Persist source metadata and create the session**

Add page state:

```js
let batchSourceFileName = '';
let batchSourceHeaders = [];
```

Set them in `parseCSV`, clear them in `resetFile`, and include them plus every parsed row in `BATCH_SESSION_START`. Wait for `{ ok: true, checkpoint }` before setting `status = 'running'` and calling `fillAvailableWindows()`.

- [ ] **Step 4: Write failing activity and terminal lifecycle tests**

Assert:

- after a worker window is created but before `BATCH_HANDLE`, page sends `BATCH_TASK_ACTIVE` with `tabId` and `windowId`;
- persistence failure closes that window and pauses the batch;
- `stopBatch` sends `BATCH_SESSION_STOP`;
- `onAllCompleted` sends `BATCH_SESSION_COMPLETE`;
- `clearBatch` sends `BATCH_SESSION_CLEAR`;
- no path calls `chrome.power` directly from `batch.js`.

- [ ] **Step 5: Implement activity and terminal lifecycle messages**

Use a small page helper:

```js
async function sendBatchRuntimeMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '批次状态保存失败');
  return response.checkpoint;
}
```

After `BatchWindowManager.create`, persist activity before sending `BATCH_HANDLE`. When checkpointing fails, stop new scheduling, close the new window, request `BATCH_SESSION_PAUSE`, and show the recovery banner.

- [ ] **Step 6: Write failing recovery hydration tests**

Feed a `paused_recovery` checkpoint into `BATCH_SESSION_LOAD_FOR_PAGE` and assert:

- no worker windows open during `init`;
- file name, URL preview, `parsedUrls`, `batchItems`, `localResults`, counters, timeout, concurrency, and checkbox settings are restored;
- status badge says `已暂停`;
- banner text says `上次任务异常中断，已暂停恢复`;
- start button says `继续处理`;
- clicking it sends `BATCH_SESSION_RESUME` before the scheduler takes queued tasks;
- submitting-at-interruption result appears as `manual_required`;
- terminate preserves exportable results.

- [ ] **Step 7: Add recovery UI**

Add to `batch.html`:

```html
<div class="recovery-banner" id="recoveryBanner" hidden>
  <span id="recoveryMessage">上次任务异常中断，已暂停恢复</span>
  <span class="wake-status" id="wakeStatus">系统保活已暂停</span>
</div>
```

Style the banner consistently with the existing history warning. Do not add a new modal.

- [ ] **Step 8: Implement checkpoint hydration**

During `init`, call `BATCH_SESSION_LOAD_FOR_PAGE` after settings load and before `updateUI`. Build a focused `hydrateBatchFromCheckpoint(checkpoint)` that:

- validates the response status;
- clones source items into page-owned state;
- rebuilds preview rows using an extracted `renderBatchPreview(items)` helper;
- derives counters from checkpoint results instead of trusting stored counters;
- constructs `BatchScheduler` with all terminal indices as `processedIndices`;
- leaves scheduler stopped until the user clicks continue.

Add `paused_recovery` to `setStatus` and `updateUI`. `resumeBatch` must accept only `paused_recovery`, send `BATCH_SESSION_RESUME`, then start the scheduler and fill windows.

- [ ] **Step 9: Run Task 4 tests**

Run:

```bash
node --test tests/batch-multi-window-integration.test.js tests/batch-scheduler.test.mjs tests/batch-window-manager.test.mjs
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

```bash
git add batch.js batch.html tests/batch-multi-window-integration.test.js
git commit -m "feat: restore paused batch sessions after restart"
```

---

### Task 5: Full regression and browser acceptance

**Files:**
- Modify only if a failing regression demonstrates a required fix.

**Interfaces:**
- Validates all requirements from the approved design.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: exit 0 with zero failing tests.

- [ ] **Step 2: Run static extension checks**

Run:

```bash
node --check background.js
node --check content.js
node --check batch.js
node -e "const m=require('./manifest.json'); for (const p of ['storage','power']) if (!m.permissions.includes(p)) throw new Error('missing '+p)"
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Exercise deterministic recovery cases**

Run the focused suites together:

```bash
node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-multi-window-integration.test.js tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js
```

Expected: exit 0; active tasks retry, submitting tasks become one manual result, recovery stays paused, and Power API lifecycle assertions pass.

- [ ] **Step 4: Manual Chrome acceptance**

Load the unpacked extension and verify:

1. Start a batch with at least five fixture URLs and concurrency 2.
2. Confirm `chrome://extensions` service-worker console logs one `system` keep-awake acquisition.
3. Let the display turn off; wake it and verify processing continued.
4. Start another batch, wait until at least one result is terminal, then force-quit Chrome.
5. Reopen Chrome and confirm exactly one recovery page opens.
6. Confirm no worker window opens until “继续处理” is clicked.
7. Confirm an item interrupted before submission is queued again.
8. Confirm an item interrupted at submission is shown once as `需手动处理`.
9. Click continue and verify remaining queued items progress.
10. Complete or terminate and confirm keep-awake is released.

- [ ] **Step 5: Review repository state**

Run:

```bash
git status --short
git diff --stat HEAD~4..HEAD
git log -5 --oneline
```

Expected: only intended feature files plus the pre-existing unstaged `.DS_Store` modification; no secrets, generated archives, or unrelated changes.

- [ ] **Step 6: Commit any test-driven regression fixes**

If Step 1–4 exposed a defect, add a failing regression test first, implement the smallest fix, rerun the focused and full suites, then commit only those files:

```bash
git commit -m "fix: harden interrupted batch recovery"
```
