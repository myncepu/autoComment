# Batch Terminal and Recovery Proof Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final three reviewer findings by making terminal side-effect hooks share one exact proof validator, allowing only internally proven ownership-recovery convergence, and binding submit-context recovery to the trusted owner page and exact worker tab.

**Architecture:** Extract one private controller validator for canonical task identity, ACTIVE/SUBMITTING state, sender role, session journal, and positive live tab/opener/window/epoch proof. Both proof-only mutations and terminal side-effect transactions consume that validator; terminal code alone may persist a proof failure and later emit the internal retry marker after a fresh successful proof. Expose a separate serialized owner-page recovery hook so submit-context recovery cannot reuse the content-worker mutation API.

**Tech Stack:** Chrome Extension Manifest V3, ECMAScript modules, Chrome storage/session fakes, Node test runner.

## Global Constraints

- Do not broaden any external runtime message authority.
- A hook never runs for queued/terminal tasks, page senders on content routes, content senders on recovery routes, wrong target tabs, missing live tabs, or uncertain/mismatched ownership proof.
- The `terminalCleanupRetry` marker remains controller-generated and is never read from an external message.
- Browser-restart recovery without a session journal remains fail-closed; no URL-only or page-only deletion/recovery authority is added.
- Preserve result/history/context idempotency and remove-first durable-clear-last ordering.

---

### Task 1: One Proof Validator for Proof-Only and Terminal Hooks

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Produces: a private exact proof validator shared by `runProofBoundTaskHook` and terminal side-effect handling.
- Consumes: canonical `{batchId, urlIndex, attempt}`, ACTIVE/SUBMITTING task, required sender role, exact journal identity, and non-missing live opener/window proof.

- [x] **Step 1: Write RED controller probes**

Add literal behavior tests proving terminal hooks are not invoked for queued, terminal, owner-page, missing-live-tab, transient tab lookup, or transient journal lookup inputs. Assert no tab removal, result append, terminal transition, or journal clear.

- [x] **Step 2: Run the named probes and verify RED**

Run:
`node --test --test-name-pattern="terminal hook shares|terminal side effects require" tests/batch-runtime-controller.test.mjs`

Expected: the queued owner page or explicitly missing live tab invokes/advances through the terminal path.

- [x] **Step 3: Extract and reuse the validator**

Make the validator return the exact checkpoint/task/proof only after canonical identity, state, sender role, journal, live tab, opener, window, and epoch all pass. Treat `proof.missing` exactly like other unverified proof. Keep side effects and cleanup outside the validator.

- [x] **Step 4: Run the controller suite and verify GREEN**

Run: `node --test tests/batch-runtime-controller.test.mjs`

### Task 2: Internally Proven Ownership-Unverified Convergence

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `tests/batch-runtime-checkpoint.test.mjs`

**Interfaces:**
- Consumes: a retained ACTIVE/SUBMITTING task paused only for `ownership_unverified`, followed by a fresh exact proof from the same content worker.
- Produces: one terminal result, one removal, durable ownership clear, and journal cleanup via the controller-only retry marker.

- [x] **Step 1: Write RED recovery probes**

Make the first exact terminal call fail on one transient ownership lookup and persist `paused_recovery/ownership_unverified`. Restore proof and replay the identical message; assert the hook runs only on the proven replay, the worker is removed once, the task terminalizes once, the journal clears, and the checkpoint validates. Add a reducer probe showing `ownership_unverified` still requires the internal marker and ACTIVE/SUBMITTING state.

- [x] **Step 2: Run the named probes and verify RED**

Run:
`node --test --test-name-pattern="ownership-unverified terminal|paused terminal convergence" tests/batch-runtime-controller.test.mjs tests/batch-runtime-checkpoint.test.mjs`

Expected: the replay ends with `invalid_transition`.

- [x] **Step 3: Expand only the internal convergence reason**

Permit the controller-generated terminal cleanup marker for exactly `terminal_cleanup_failed` or `ownership_unverified`, while retaining ACTIVE/SUBMITTING state and fresh proof requirements. Ignore any external marker field.

- [x] **Step 4: Run checkpoint and controller suites and verify GREEN**

Run:
`node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs`

### Task 3: Dedicated Owner-Page Submit-Context Recovery

**Files:**
- Modify: `background.js`
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `lib/batch-submit-context-store.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `tests/batch-submit-context-store.test.mjs`
- Modify: `tests/comment-history-message-listener.test.mjs`

**Interfaces:**
- Produces: `runOwnerPageRecoveryHook(message, sender, targetTabId, hook)`.
- Consumes: trusted exact batch-page sender, exact canonical task identity, `targetTabId === task.tabId`, and the same complete live ownership proof.

- [x] **Step 1: Write RED recovery-route probes**

Replay recovery from the content worker and from the task-11 owner page with `tabId: 99`; snapshot context/recovery storage and assert zero mutation. Add the exact owner-page/task-tab legal case and a missing-journal fail-closed case.

- [x] **Step 2: Run the named probes and verify RED**

Run:
`node --test --test-name-pattern="submit-context recovery|recovery target" tests/batch-runtime-controller.test.mjs tests/batch-submit-context-store.test.mjs tests/comment-history-message-listener.test.mjs`

Expected: content recovery or the mismatched target reaches `sealAndRecover`.

- [x] **Step 3: Add the dedicated serialized recovery API**

Remove the broad `allowOwnerPage` option from the content proof-only API. Require the dedicated recovery API to validate the owner-page sender and exact task tab before its hook. Inject it into the submit-context listener and bind the mutation to the proven target only.

- [x] **Step 4: Run focused integration tests and verify GREEN**

Run:
`node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-submit-context-store.test.mjs tests/comment-history-message-listener.test.mjs`

### Task 4: Audit, Report, Verify, and Commit

**Files:**
- Modify: `.superpowers/sdd/2026-07-26-batch-operations-console/task-12-report.md`

- [x] **Step 1: Audit every proof-to-hook branch**

Enumerate proof-only content, terminal content, and owner-page recovery routes. Confirm queued/terminal/wrong-role/wrong-target/missing/transient cases invoke zero hooks and that no external message controls the retry marker.

- [x] **Step 2: Run focused, affected, full, and static verification**

Run the checkpoint/controller/context/background/content affected suites, `npm test`, `node --check` for changed JS/MJS files, manifest parse, browser-free `batch.js` import, `git diff --check`, ACTIVE-route audit, and ownership-epoch sink audit.

- [x] **Step 3: Update the Task 12 report**

Record the three root causes, RED evidence, exact sender/target contract, recovery convergence, retained browser-restart fail-closed behavior, and exact verification counts.

- [x] **Step 4: Commit separately**

Commit subject: `fix: unify terminal and recovery ownership proof`
