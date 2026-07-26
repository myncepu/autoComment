# Batch Ingress Ownership Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every batch result, history, and submit-context mutation through one controller-serialized ownership proof before any durable write, clear, close, terminal transition, or broadcast.

**Architecture:** Reuse the round-9 task proof in two controller transactions: a proof-only hook for pre-terminal mutations and the existing proof → terminal hook → re-proof/close → terminal transaction for final mutations. Background owns all durable result/history/context writes. Content sends bounded, identity-stable messages only; authorization failures stop immediately, while transport and cleanup failures receive bounded retries without local storage fallback.

**Tech Stack:** Chrome Extension Manifest V3, `chrome.storage.local`, `chrome.storage.session`, IndexedDB/fake-indexeddb, ECMAScript modules, Node test runner.

## Global Constraints

- Preserve round-8/9 session-journal, epoch, opener/window/tab/request proof and remove-first ownership rules.
- Every mutation carrying `{batchId, urlIndex, attempt}` must prove the exact checkpoint task and sender before its first side effect.
- Wrong, stale, absent, and already-terminal ownership produces zero result, history, submit-context, close, checkpoint, or broadcast mutations.
- Content may read settings/results but may not directly write batch results or history-pending storage.
- Retry only the identical message payload, with a small fixed bound and no production sleep.
- Do not add unrelated functionality or revert other participants' work.

---

### Task 1: Controller Proof-Bound Hook

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Produces: `runProofBoundTaskHook(message, sender, hook, options?)`.
- Consumes: ACTIVE/SUBMITTING task identity, exact content sender by default, optional exact owner-page sender for recovery sealing, session journal, and live opener/window proof.

- [x] **Step 1: Write controller RED probes**

Add literal tests showing exact ACTIVE/SUBMITTING content ownership invokes the hook without close/terminal; wrong tab, stale attempt, missing checkpoint, queued task, and terminal task never invoke it. Add hook-failure and transient live/journal proof cases that retain the original valid ownership.

- [x] **Step 2: Run the named probes and verify RED**

Run:
`node --test --test-name-pattern="proof-bound task hook" tests/batch-runtime-controller.test.mjs`

Expected: `runProofBoundTaskHook` is absent.

- [x] **Step 3: Implement the minimal serialized API**

Factor exact task lookup/sender/proof validation so the new proof-only API and `markTerminal` share it. The proof-only API returns hook metadata and performs no tab close, terminal transition, journal clear, or broadcast. A terminal hook must accept only the exact content worker when a side-effect hook is supplied; legacy internal/page terminal calls without hooks retain their existing behavior.

- [x] **Step 4: Run controller tests and verify GREEN**

Run: `node --test tests/batch-runtime-controller.test.mjs`

### Task 2: Background Ingress Transactions

**Files:**
- Modify: `background.js`
- Modify: `lib/batch-submit-context-store.mjs`
- Modify: `tests/comment-history-message-listener.test.mjs`
- Modify: `tests/batch-submit-context-store.test.mjs`

**Interfaces:**
- `BATCH_PERSIST_PENDING_RESULT` → proof-only hook → result save only.
- `BATCH_REPORT_RESULT` → terminal hook → result/history/exact-context work → re-proof/close/terminal → broadcast.
- `BATCH_HISTORY_PENDING_FALLBACK` → terminal hook → durable history save + exact-context clear → re-proof/close/terminal → broadcast.
- Submit-context SAVE/matched CLEAR → proof-only hook; recovery sealing may use exact owner-page proof.

- [x] **Step 1: Extend the real-background fake-IDB RED matrix**

For CONFIRM, REPORT, PENDING, and HISTORY_PENDING_FALLBACK, dispatch a wrong worker tab and snapshot literal result rows, IndexedDB history count, exact submit context, runtime broadcasts, checkpoint task, session journal, and open tabs. Assert every snapshot is unchanged. Add legal tasks for each route, duplicate-attempt calls, already-terminal non-overwrite, and remove-failure retry convergence.

- [x] **Step 2: Run the integration test and verify RED**

Run:
`node --test tests/comment-history-message-listener.test.mjs`

Expected: REPORT/PENDING/FALLBACK mutate before proof or accept untracked ownership.

- [x] **Step 3: Route handlers through controller hooks**

Move all store/service/context work inside the appropriate controller hook. Remove the old `BATCH_HISTORY_FALLBACK_DURABLE` clear-first route. Preserve `submit_context_unresolved` as a no-write/no-close deferred REPORT result. Broadcast only after a changed terminal checkpoint.

- [x] **Step 4: Proof-bind submit-context mutation listeners**

Inject the controller proof hook into the submit-context listener. Require complete matched identity for content SAVE/CLEAR, reject unscoped clear, and keep GET/HAS read-only. Route batch-page recovery sealing through the optional exact owner-page proof.

- [x] **Step 5: Run background/context tests and verify GREEN**

Run:
`node --test tests/comment-history-message-listener.test.mjs tests/batch-submit-context-store.test.mjs`

### Task 3: Content Retry and No-Local-Fallback

**Files:**
- Modify: `content.js`
- Modify: `lib/batch-submit-context-client.js`
- Modify: `tests/comment-history-submit-flow.test.js`
- Modify: `tests/batch-submit-context-client.test.js`

**Interfaces:**
- Produces: bounded identical-payload background requests with authorization-terminal classification.
- Removes: content writes to `historyPending:*`, `batchResults`, and `batchReportedUrls`.

- [x] **Step 1: Write content RED probes**

Assert authorization rejection sends only the original confirmation, writes no history pending entry, sends no fallback, and clears no context. Assert transport exhaustion retries only to the fixed bound and writes no local result/history. Assert `batch_teardown_cleanup_failed` followed by success resends the exact CONFIRM payload and becomes durable. Assert `historySaveStatus: failed` uses `BATCH_HISTORY_PENDING_FALLBACK` with the complete history payload.

- [x] **Step 2: Run the named content tests and verify RED**

Run:
`node --test --test-name-pattern="authorization rejection|cleanup retry|no local" tests/comment-history-submit-flow.test.js tests/batch-submit-context-client.test.js`

- [x] **Step 3: Implement bounded proven-message transport**

Classify `stale_worker_tab`, `stale_attempt`, `checkpoint_not_found`, `task_already_terminal`, `stale_batch`, `invalid_url_index`, and `forbidden_sender` as terminal authorization errors. Retry identical payloads only for transport failure and retryable ownership cleanup. On exhaustion, return structured non-durable state and preserve submit context.

- [x] **Step 4: Remove direct local mutation fallbacks**

Delete content history-pending and result-store writes. Route every direct CONFIRM call through the same bounded confirmation helper. Stop the submit-context client from issuing a second clear after background has committed confirmation.

- [x] **Step 5: Run content tests and verify GREEN**

Run:
`node --test tests/comment-history-submit-flow.test.js tests/batch-submit-context-client.test.js`

### Task 4: Audit and Full Verification

**Files:**
- Modify: `.superpowers/sdd/2026-07-26-batch-operations-console/task-12-report.md`

- [x] **Step 1: Audit mutation call sites**

Enumerate every production `batchResultStore.save`, history-pending write, submit-context save/clear/seal, and `BATCH_CONFIRMED` broadcast. Record the controller transaction authorizing each remaining mutation and prove there are no content-side batch result/history writes.

- [x] **Step 2: Run focused and affected verification**

Run controller, background integration, context-store/client, submit-flow, submit-order, worker-runtime, and multi-window suites.

- [x] **Step 3: Run full and static verification**

Run `npm test`, `node --check` for every changed JS/MJS file, `git diff --check`, manifest parse, browser-free `batch.js` import, ACTIVE-route audit, and ownership-epoch sink audit.

- [x] **Step 4: Update the Task 12 report**

Document the ingress whitelist, RED evidence, bounded retry behavior, exact counts, and retained ownership behavior.

- [x] **Step 5: Commit separately**

Commit subject: `fix: prove every batch persistence ingress`
