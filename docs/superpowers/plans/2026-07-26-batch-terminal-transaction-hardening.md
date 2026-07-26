# Batch Terminal Transaction Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close the four final ownership gaps in terminal retry, background side-effect ordering, newly created tab proof, and startup recovery-page visibility without weakening round-8 authorization.

**Architecture:** Keep the background runtime controller as the single serialized owner. Split task proof from removal so terminal work can prove checkpoint, sender, journal, opener, and live tab before an injected idempotent side-effect hook, re-prove immediately before removal, then apply a narrowly authorized paused-recovery terminal transition. Newly created tabs receive the same live proof before journal binding or ACTIVE persistence, and startup attempts recovery-page visibility even when automatic ownership cleanup fails closed.

**Tech Stack:** Chrome Extension Manifest V3, `chrome.storage.local`, `chrome.storage.session`, `chrome.tabs`, IndexedDB/fake-indexeddb, ECMAScript modules, Node test runner.

## Global Constraints

- Preserve all round-8 durable reservation, session journal, ownership epoch, opener, exact pending URL, remove-first, and secret-sink invariants.
- Do not route externally supplied ACTIVE ownership.
- Never place `ownershipEpoch` in results, `BATCH_HANDLE`, history, DOM, or diagnostics.
- Wrong or stale content senders must cause zero batch-result, history, submit-context, close, terminal, and broadcast side effects.
- Do not add features outside the four reviewer reproductions.
- Do not revert edits made by other participants.

---

### Task 1: Constrained Paused Terminal Convergence

**Files:**
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-checkpoint.test.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Consumes: exact ACTIVE/SUBMITTING task identity, `terminal_cleanup_failed`, sender tab, session journal, and live opener/window proof.
- Produces: `task_terminal` convergence from only the matching terminal-cleanup recovery state.

- [x] **Step 1: Write failing reducer and controller tests**

Add literal reducer cases proving arbitrary paused terminal transitions remain invalid while an internal `terminalCleanupRetry: true` event is accepted only for `paused_recovery` + `terminal_cleanup_failed` + ACTIVE/SUBMITTING. Add ACTIVE and SUBMITTING controller probes where the first `tabs.remove` fails, the exact sender retries, removal succeeds, one terminal result exists, the journal is cleared, checkpoint validation passes, and later startup does not requeue the task.

- [x] **Step 2: Run the focused tests and verify RED**

Run:
`node --test --test-name-pattern="terminal cleanup retry|paused terminal convergence" tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs`

Expected: retry reaches removal but reducer returns `invalid_transition`.

- [x] **Step 3: Implement the narrow state-machine branch**

Allow `task_terminal` from paused recovery only when task ownership remains ACTIVE/SUBMITTING, recovery reason is exactly `terminal_cleanup_failed`, and the controller supplies the internal retry flag after exact sender and journal ownership proof. Keep all other paused terminal events invalid.

- [x] **Step 4: Run focused suites and verify GREEN**

Run:
`node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs`

Expected: all checkpoint/controller tests pass.

### Task 2: Sender-Proven Terminal Side-Effect Hook

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `background.js`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `tests/comment-history-message-listener.test.mjs`

**Interfaces:**
- Consumes: `markTerminal(message, sender, sideEffectHook?)`.
- Produces: controller-serialized proof → idempotent hook → re-proof/remove → terminal persistence, with the hook result returned to background.

- [x] **Step 1: Write failing controller hook-order tests**

Assert wrong sender and stale attempt never invoke the hook; hook failure retains the original ownership and does not call `tabs.remove`; a remove failure may invoke an idempotent hook again on the exact retry while producing one durable effect and one checkpoint result.

- [x] **Step 2: Write the failing real-background integration probe**

In the fake-indexeddb background test, send a wrong-tab `BATCH_HANDLE_CONFIRM` while the task is SUBMITTING. Assert the response is rejected and literal pre/post snapshots show unchanged `batchResults`, comment-history rows, submit context, runtime broadcasts, task state, and open tab. Then run the existing legal success and fail paths.

- [x] **Step 3: Run focused tests and verify RED**

Run:
`node --test --test-name-pattern="terminal side effect|wrong sender" tests/batch-runtime-controller.test.mjs tests/comment-history-message-listener.test.mjs`

Expected: background persists result/history before controller rejects the sender, and controller has no hook boundary.

- [x] **Step 4: Implement the serialized hook**

Split proof from close. For owned tasks: validate checkpoint/attempt/sender, prove the exact journal and live opener/window, execute the injected hook, re-prove, remove, apply terminal, persist, then clear the journal. Return hook metadata. A thrown hook returns a safe failure with unchanged ownership and no close. Background moves `BATCH_HANDLE_CONFIRM` result/history/context work into this hook and suppresses broadcasts for unchanged/rejected terminal calls.

- [x] **Step 5: Run focused suites and verify GREEN**

Run:
`node --test tests/batch-runtime-controller.test.mjs tests/comment-history-message-listener.test.mjs`

Expected: wrong/stale confirmation has zero side effects; legal success/fail behavior remains green.

### Task 3: Live Proof After `tabs.create`

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Consumes: first `tabs.create` return plus `tabs.get(createdTab.id)`.
- Produces: proof of exact positive tab ID, sender window, opener tab, and full canonical pending URL before journal binding or ACTIVE persistence.

- [x] **Step 1: Write failing live-proof tests**

Add table cases for live `openerTabId: 999`, a wrong live URL, and transient `tabs.get` failure. Each must return recovery-required paused/manual ownership, retain a valid durable reservation and precreate journal, perform no ACTIVE write, navigation, success response, or unsafe removal.

- [x] **Step 2: Run tests and verify RED**

Run:
`node --test --test-name-pattern="newly created tab live proof" tests/batch-runtime-controller.test.mjs`

Expected: current code binds the journal, writes ACTIVE, navigates, and succeeds without `tabs.get`.

- [x] **Step 3: Implement the proof gate**

After the first create response and before binding, call bounded `tabs.get`; compare live ID/window/opener/full pending URL and the returned positive identity. On mismatch or transient lookup, persist `paused_recovery` with `ownership_unverified` while retaining the valid reservation and precreate journal. Remove only if the same proof establishes that removal is safe.

- [x] **Step 4: Run controller tests and verify GREEN**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: all controller tests pass.

### Task 4: Recovery Page on Unverified Startup

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Consumes: failed `normalizeForRecovery()` responses that retain a checkpoint.
- Produces: best-effort, deduplicated `batch.html?recovery=1` visibility without altering the primary recovery response.

- [x] **Step 1: Write failing startup tests**

Delete the session journal for a verified ACTIVE task and call `recoverOnStartup()` twice. Assert zero worker removals, zero worker duplicates, exactly one recovery page, and the original `ownership_unverified` response. Add a `tabs.create` recovery-page failure and assert the response still reports the original ownership failure and checkpoint.

- [x] **Step 2: Run tests and verify RED**

Run:
`node --test --test-name-pattern="unverified startup recovery page" tests/batch-runtime-controller.test.mjs`

Expected: current early return creates no recovery page.

- [x] **Step 3: Make recovery-page opening best effort**

Call `ensureRecoveryPage(recovery.checkpoint)` for both successful and failed normalization responses when a nonterminal checkpoint exists. Catch query/create failure and return the untouched primary recovery response.

- [x] **Step 4: Run controller tests and verify GREEN**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: all controller tests pass.

### Task 5: Verification, Report, and Commit

**Files:**
- Modify: `.superpowers/sdd/2026-07-26-batch-operations-console/task-12-report.md`

**Interfaces:**
- Consumes: all four green fixes.
- Produces: round-9 evidence and a separate clean commit.

- [x] **Step 1: Run affected and full verification**

Run the round-8 affected command plus checkpoint, controller, background integration, submit-order, and submit-flow coverage; then run `npm test`.

- [x] **Step 2: Run static and sink checks**

Run `node --check` for every changed JavaScript/MJS file, parse `manifest.json`, import `batch.js` without browser globals, run `git diff --check`, and audit epoch/secret sinks plus installed ACTIVE routing.

- [x] **Step 3: Update the Task 12 report**

Document the constrained paused terminal retry, controller-owned side-effect hook, post-create live proof, recovery-page behavior, RED evidence, and final test counts.

- [x] **Step 4: Commit**

Commit subject: `fix: close final batch ownership races`
