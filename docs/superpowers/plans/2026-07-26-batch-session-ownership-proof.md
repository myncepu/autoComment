# Batch Session Ownership Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic worker-tab deletion depend on a browser-session journal plus Chrome-maintained opener identity, while preserving durable ownership until removal is proven.

**Architecture:** Durable local checkpoints identify intended ownership and `chrome.storage.session` records what this browser session actually created. The background controller creates pending tabs with `openerTabId`, journals their exact canonical identity before target navigation, and uses a remove-first transaction: prove, remove, then clear durable ownership. Pending and target cleanup both require the trusted journal; pending additionally requires its full-string exact extension URL.

**Tech Stack:** Chrome Extension Manifest V3 (Chrome 102+), `chrome.storage.local`, `chrome.storage.session`, `chrome.tabs`, ECMAScript modules, Node test runner.

## Global Constraints

- Use the existing `storage` permission. `ownershipEpoch` is a
  non-credential opaque ownership marker containing no user secret and may
  exist only in the durable task/reservation and trusted journal; never put
  the epoch, journal records, passwords, or user secrets in results,
  `BATCH_HANDLE`, history, DOM, or diagnostics.
- `chrome.storage.session` is trusted-context-only by default and is cleared on browser restart.
- New target ownership requires canonical request identity, a random
  `ownershipEpoch`, positive tab/window/opener IDs, exact live opener/window
  identity, and an exact session-journal epoch/identity match.
- Pending cleanup requires a valid durable reservation, trusted session
  journal (pre-create records may have `tabId: null`), matching live
  opener/window identity, and the full-string exact canonical extension
  pending URL.
- Teardown is remove-first and clear-ownership-last; every failure retains a checkpoint that independently validates.
- Do not revert edits made by other participants.

---

### Task 1: Checkpoint Ownership Schema and Legacy Recovery

**Files:**
- Modify: `lib/batch-runtime-checkpoint.mjs`
- Modify: `tests/batch-runtime-checkpoint.test.mjs`

**Interfaces:**
- Consumes: existing version 1/version 2 migration and event reducer.
- Produces: `ownerPageTabId` and `ownershipEpoch` on tasks/reservations,
  plus valid legacy `ownership_unverified` paused recovery.

- [ ] **Step 1: Write failing schema and migration tests**

Add literal fixtures proving new ACTIVE ownership requires a positive owner page ID, queued/terminal ownership remains null, and old ACTIVE/SUBMITTING checkpoints retain their tab fields while migrating to `paused_recovery` with reason `ownership_unverified`.

- [ ] **Step 2: Run checkpoint tests and verify RED**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: failures for missing `ownerPageTabId` schema/event/migration behavior.

- [ ] **Step 3: Implement minimal schema and migration changes**

Add `ownerPageTabId` and `ownershipEpoch` to task/reservation validation and
event transitions. Preserve legacy active ownership with null proof markers,
pause it, and attach the explicit recovery reason instead of canonicalizing
it into auto-cleanable ownership.

- [ ] **Step 4: Run checkpoint tests and verify GREEN**

Run: `node --test tests/batch-runtime-checkpoint.test.mjs`

Expected: all checkpoint tests pass.

### Task 2: Trusted Browser-Session Journal

**Files:**
- Create: `lib/batch-session-journal.mjs`
- Create: `tests/batch-session-journal.test.mjs`
- Modify: `background.js`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: a `chrome.storage.session` StorageArea.
- Produces: `createBatchSessionJournal(sessionArea)` with exact
  request-scoped `write(record)`, `read(requestId)`, and `remove(requestId)`
  operations.

- [ ] **Step 1: Write failing journal tests**

Cover exact field validation including `ownershipEpoch`, deterministic
request-key storage before create and tab-key lookup after binding,
secret/extra-field rejection, round-trip cloning, and removal.

- [ ] **Step 2: Run journal tests and verify RED**

Run: `node --test tests/batch-session-journal.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement and wire the journal**

Create the strict journal module, inject it into the background controller from `chrome.storage.session`, and set `minimum_chrome_version` to `102`.

- [ ] **Step 4: Run journal/background integration tests and verify GREEN**

Run: `node --test tests/batch-session-journal.test.mjs tests/comment-history-message-listener.test.mjs`

Expected: all selected tests pass with a complete session-storage mock.

### Task 3: Journaled Create Protocol

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `tests/batch-runtime-controller.test.mjs`

**Interfaces:**
- Consumes: strict journal API, batch-page sender tab/window, checkpoint reservations.
- Produces: pending tab creation with `openerTabId`, journal-before-ACTIVE-before-navigation ordering.

- [ ] **Step 1: Write failing create-protocol tests**

Assert literal `tabs.create` details include exact pending URL and owner opener,
the pre-create journal is written before tab creation with `tabId: null`, the
journal is rebound to the returned tab with the same injected random
`ownershipEpoch` before ACTIVE persistence, navigation occurs only after
journal and ACTIVE persistence, and pre-create journal-write failure creates
zero tabs.

- [ ] **Step 2: Run focused controller tests and verify RED**

Run: `node --test --test-name-pattern "session journal|opener|journal write" tests/batch-runtime-controller.test.mjs`

Expected: missing opener/journal calls and unsafe navigation failures.

- [ ] **Step 3: Implement the minimal journaled create transaction**

Persist the owner page ID in the reservation, write the trusted pre-create
journal, create the pending tab with explicit opener, bind its ID into the
journal, persist ACTIVE ownership while clearing the reservation, and only
then navigate.

- [ ] **Step 4: Run focused and complete controller tests**

Run: `node --test tests/batch-runtime-controller.test.mjs`

Expected: all controller tests pass.

### Task 4: Remove-First Teardown and Terminal Ownership

**Files:**
- Modify: `lib/batch-runtime-controller.mjs`
- Modify: `background.js`
- Modify: `tests/batch-runtime-controller.test.mjs`
- Modify: `tests/comment-history-message-listener.test.mjs`

**Interfaces:**
- Consumes: durable checkpoint identity, live tab identity, session journal, exact pending URL.
- Produces: proof-based removal outcomes and sender-bound terminal transitions.

- [ ] **Step 1: Write reviewer-reproduction tests**

Cover same-URL user tab zero-removal, redirected/fragmented owned target
removal, mismatched/stale epochs, submitting remove failure validation/retry,
remove plus durable-clear failure retaining the journal, durable clear plus
journal-clear failure leaving a non-authoritative journal, raw/query pending
rejection, transient tab/journal lookup fail-closed, restart journal loss, and
wrong content sender terminal rejection.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern "ownership|redirect|submitting|pending|transient|sender" tests/batch-runtime-controller.test.mjs`

Expected: failures showing URL-based target proof, normalize-before-remove, invalid recovery checkpoint, and unrestricted terminal sender behavior.

- [ ] **Step 3: Implement proof evaluation and remove-first transaction**

Evaluate each target from the original checkpoint with `tabs.get` plus exact
journal/live identity. Evaluate pending tabs by reservation, pre-created or
bound journal, matching live opener/window, and exact canonical pending URL.
On any uncertainty/failure, retain the original task/reservation/journal and
persist a valid paused recovery checkpoint. After all tabs are removed or
missing, persist durable ownership clearing first and clear journals last.

- [ ] **Step 4: Bind terminal transitions to the owning sender and cleanup**

Require content terminal reports to match the task tab/attempt, require page
terminal reports to match the owner page, and have background prove and close
the live owned tab before applying a terminal transition that clears fields.

- [ ] **Step 5: Run controller and background integration tests**

Run: `node --test tests/batch-runtime-controller.test.mjs tests/comment-history-message-listener.test.mjs`

Expected: all selected tests pass.

### Task 5: Verification, Report, and Commit

**Files:**
- Modify: `.superpowers/sdd/2026-07-26-batch-operations-console/task-12-report.md`

**Interfaces:**
- Consumes: completed implementation and observed TDD evidence.
- Produces: round-8 architecture report and one clean commit.

- [ ] **Step 1: Run affected and full verification**

Run the checkpoint/controller/journal/adapter/worker/integration suites, then `npm test`.

- [ ] **Step 2: Run static checks**

Run `node --check` on changed scripts, parse `manifest.json`, import `batch.js` without browser globals, run `git diff --check`, and audit ownership-clearing transitions and journal data sinks.

- [ ] **Step 3: Update the Task 12 report**

Document Chrome 102+ `storage.session`, trusted-context behavior, opener proof, remove-first ordering, exact pending fallback, and the browser-restart manual-recovery boundary.

- [ ] **Step 4: Commit**

Commit subject: `fix: journal batch tab ownership per browser session`
