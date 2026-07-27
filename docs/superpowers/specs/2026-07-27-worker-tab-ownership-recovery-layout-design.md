# Worker Tab Ownership Recovery and Queue-First Console Design

**Date:** 2026-07-27  
**Status:** Approved  
**Scope:** AutoComment batch runtime and batch operations console  

## Problem

The batch checkpoint stored by the background service worker is the durable
source of worker-tab ownership, but unexpected tab removal is currently
observed only by the page-owned `BatchTabManager`. If that listener is absent,
is torn down, or cannot finish its terminal transition, the removed tab can
remain recorded as an active task in the durable checkpoint.

This creates two visible failures:

1. the vacated concurrency slot does not open the next queued target; and
2. a later start or clear request is rejected with the internal error
   `batch_ownership_active`.

The current wide-screen console also places assignment, worker slots, and
runtime health in a 245px left sidebar. That compresses the target queue and
causes high-value columns to wrap excessively.

## Goals

- Make durable ownership converge when a worker tab is closed unexpectedly.
- Immediately fill a vacated slot with the next queued target.
- Never automatically retry the URL whose tab was closed.
- Avoid duplicate submission when a tab disappears during or after submission.
- Preserve the existing protection against replacing a genuinely active batch.
- Replace raw ownership error codes with actionable Chinese UI states.
- Move assignment, runtime health, and worker slots above a full-width queue.
- Keep the behavior deterministic across console reloads and MV3 service-worker
  suspension.

## Non-goals

- Moving the complete scheduler into the service worker.
- Automatically retrying a closed target.
- Changing profile or promotion-site assignment.
- Weakening ownership proof or attempt identity checks.
- Storing profile passwords in checkpoints, handles, history, or UI snapshots.
- Publishing comments to third-party sites during verification.

## Options Considered

### Option A: Repair only the page-owned close handler

Keep the current architecture and make `BatchWorkerRuntime` more aggressively
refill after `tabs.onRemoved`.

This is small, but it still loses the removal event when the console page is
reloaded or its runtime is torn down. Durable ownership would remain dependent
on an ephemeral page.

### Option B: Background ownership convergence with page-side refill

Observe worker-tab removal in the background, terminalize the exact durable
attempt there, broadcast the changed checkpoint, and let the page-owned
scheduler reconcile and refill.

This keeps scheduling and view composition where they are today while moving
the ownership-critical event to the component that owns the durable
checkpoint. It is the approved option.

### Option C: Move the complete scheduler into the service worker

This would make all worker lifecycle decisions background-owned, but it is a
larger migration with substantial lifecycle and regression risk. It is not
required to fix the current failures.

## Approved Runtime Design

### Exact ownership identity

Every removal decision is bound to:

- `batchId`
- `urlIndex`
- `attempt`
- `tabId`

The background handler must derive this identity from the current validated
checkpoint. A stale attempt, unrelated tab, previous batch, or duplicate
removal notification is ignored.

`profileId` remains the canonical profile field. No secret value is copied into
the checkpoint, batch handle, result, history record, or broadcast event.

### Removal outcome

When a tracked worker tab is removed unexpectedly:

| Durable phase | Result | Reason |
| --- | --- | --- |
| Before submission | `fail` | The target was interrupted before a submit could occur. |
| Submitting, confirming, or otherwise submission-uncertain | `manual_required` | Retrying could publish a duplicate comment. |

The closed URL becomes terminal for its current attempt. It is not automatically
retried.

The terminal transition clears `tabId`, `windowId`, and other active ownership
from the task while preserving the result and diagnostic required by the
console. The transition is idempotent: processing the same removal twice does
not add a second result or advance the queue twice.

### Background listener

The background installation layer adds a `chrome.tabs.onRemoved` listener next
to the existing batch runtime controller installation.

The listener:

1. loads and validates the current checkpoint;
2. looks up an active or submitting task with the removed `tabId`;
3. performs the exact attempt-bound terminal transition;
4. persists the updated checkpoint before announcing the change;
5. broadcasts a sanitized runtime event containing the batch identity and
   checkpoint revision/state, but no credentials.

Expected closes initiated by successful completion, pause, stop, or teardown
remain safe because their task is already terminalized or their durable
ownership has been cleared before the removal event is actionable. The
background transition still treats any duplicate event as a no-op.

### Page reconciliation and refill

`BatchWorkerRuntime` continues to own the in-page scheduler. It subscribes to
the background ownership-change event through the Chrome adapter.

For a matching running batch, it:

1. accepts the newer checkpoint;
2. removes any stale in-memory mapping for the terminalized task;
3. reconciles scheduler active and settled indices;
4. calls the existing replenishment path;
5. opens the next queued target in the vacated slot.

If the console page was reloaded or absent when the tab closed, the background
checkpoint remains correct. Loading or resuming the console reconstructs the
scheduler from that checkpoint and fills available slots.

The existing page-side `tabs.onRemoved` observation can remain as a fast path,
but both paths converge through the same attempt-bound terminal semantics.

### `batch_ownership_active` handling

The runtime keeps `batch_ownership_active` as an internal safety code for a
start or clear request that would discard real durable ownership.

The console must not display that raw code. Instead:

- if the checkpoint refers to removed tabs, background reconciliation releases
  those stale owners and restores the current batch;
- if live owners remain, the console restores that batch and shows:
  `当前批次仍有活动任务，请继续处理或停止批次。`;
- starting a second batch remains disabled until the current batch has safely
  converged;
- the Continue action sends only the resume command for the existing batch and
  never falls through to start or clear.

## Queue-First Console Layout

The desktop sidebar is removed. The content order becomes:

1. command bar and recovery/error banners;
2. batch summary metrics;
3. full-width runtime overview;
4. full-width target queue.

### Runtime overview

The runtime overview contains three production view components:

- `AssignmentSummary`: compact identity count, promotion-site count,
  automation mode, concurrency, and timeout;
- `RuntimeHealth`: checkpoint, keep-alive, connectivity, and recovery state as
  concise status chips;
- `WorkerSlotGrid`: one card per configured concurrency slot.

The slot cards retain domain, profile, promotion site, phase, elapsed time, and
tab label. Empty cards say `等待队列`.

### Responsive behavior

- **1280px and wider:** assignment and health share a compact summary row;
  worker slots form a horizontal grid beneath it; the queue uses the full
  content width.
- **900–1279px:** assignment and health may wrap to separate rows; slot cards
  wrap without introducing a left rail.
- **Below 900px:** queue table switches to the existing accessible cards;
  overview components stack vertically.
- **Below 640px:** controls remain single-column and drawers remain full-screen.

The DOM order follows the visual order, so keyboard and screen-reader users
encounter runtime context before the queue. Status changes continue to use
polite live regions, and color is not the sole indicator of state.

## Module Boundaries

The change should preserve the existing production separation:

- `batch-runtime-controller.mjs`: durable ownership lookup and exact terminal
  transition for a removed tab.
- Background installation/composition: registers the Chrome removal listener
  and broadcasts sanitized checkpoint changes.
- `batch-chrome-adapter.mjs`: translates Chrome runtime messages into the
  runtime subscription contract.
- `batch-worker-runtime.mjs`: reconciles the newer checkpoint and refills.
- `batch-console-state.mjs`: maps internal ownership conditions to actionable
  UI state.
- `batch-console-view.mjs`: composes the queue-first overview without accessing
  `chrome.*`.
- `batch-console.css`: implements the responsive full-width layout.

The ordinary-web fixture must continue importing the same production
state/view modules. Test adapters remain fixture-only and no global test
backdoor is added to the extension.

## Error Handling and Recovery

- A checkpoint write failure pauses the batch in recovery mode and does not
  open a replacement tab before durable state is known.
- A replacement-tab creation failure terminalizes only that queued attempt with
  the existing `tab_create_failed` behavior, then continues if persistence
  succeeds.
- An ownership mismatch fails closed and displays an actionable recovery
  message rather than silently releasing an unproven tab.
- Console teardown does not delete durable task ownership.
- Reopening the console loads the durable checkpoint, normalizes missing tabs,
  and resumes only after persistence is complete.

## TDD and Verification

Implementation begins with failing tests for:

1. background removal of a pre-submit worker terminalizes it as `fail`;
2. background removal during submission terminalizes it as
   `manual_required`;
3. duplicate, stale-attempt, and unrelated removal events are no-ops;
4. terminal persistence occurs before replacement creation;
5. the page runtime reconciles a background terminal event and opens the next
   queued target;
6. console reload after removal reconstructs the correct slot count;
7. live ownership still blocks destructive start/clear, but the UI renders an
   actionable message rather than the raw code;
8. the overview renders above a full-width queue at 1440, 1024, and 640 widths.

Verification includes:

- focused unit and integration tests;
- the full `npm test` suite;
- relevant JavaScript syntax checks;
- the ordinary-web console fixture at 1440, 1024, and 640 pixels;
- a real unpacked Chrome extension smoke test using five local fixture targets
  with concurrency three;
- manually closing one worker tab and verifying that the next queued fixture
  opens;
- confirming that no third-party comment is submitted.

## Acceptance Criteria

- Closing a worker tab before submission ends that target and opens the next
  queued target.
- Closing during submission produces a manual-required result and still frees
  the slot without retrying the same URL.
- A console reload does not leave removed tabs as durable active owners.
- Users no longer see the raw `batch_ownership_active` code.
- Genuine live ownership cannot be overwritten by a new batch.
- Assignment, health, and slots appear above the queue at all desktop widths.
- The target queue receives the full content width.
- All automated and real-Chrome safety checks pass.
