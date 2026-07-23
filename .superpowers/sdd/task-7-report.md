# Task 7 Report: Concurrent Window Batch Scheduling

## RED

Appended the required real-window wiring and terminal-order integration guards
to `tests/batch-multi-window-integration.test.js` before changing `batch.js`.

```bash
node --test tests/batch-multi-window-integration.test.js
```

Result: 3 passing and 2 failing, as expected. The executor did not construct
`BatchScheduler` or `BatchWindowManager`, still used the single-active-tab
path, and did not provide the required close → settle → refill terminal path.

During race self-review, added a further guard for a `windows.create` promise
that resolves after stop/clear has replaced the page's current batch and window
manager.

```bash
node --test tests/batch-multi-window-integration.test.js
```

Result: 5 passing and 1 failing, as expected. `openWorkerWindow` still used the
mutable global manager after the await and had no captured batch identity.

## GREEN

Integrated `BatchScheduler` and `BatchWindowManager` into `batch.js`:

- Start and resume construct schedulers with the configured concurrency;
  resume seeds every already-recorded original index.
- `fillAvailableWindows` claims capacity synchronously, and
  `openWorkerWindow` creates isolated, non-focused Chrome windows through the
  window manager.
- Illegal sites and window-creation failures finalize without a window while
  releasing their scheduler reservation.
- Content readiness retains the PING retry behavior, uses the worker tab ID,
  and immediately finalizes exhausted retries or rejected `BATCH_HANDLE`
  sends unless a confirmation already recorded the result.
- `finalizeTask` records each terminal result once, closes its matching window
  before scheduler settlement, then refills only while the batch is running.
- Unexpected window close, timeout, stop, completion, clear, and resume paths
  now use scheduler/window-manager state.
- Late window creation remains attached to the batch and manager that issued
  it; after stop/clear it closes through that original manager without
  touching a replacement scheduler.
- Removed obsolete single-tab maps/locks and both obsolete
  `batchSubmitCtx` cleanup-key references.

Focused verification:

```bash
node --check batch.js
node --test \
  tests/batch-scheduler.test.mjs \
  tests/batch-window-manager.test.mjs \
  tests/batch-multi-window-integration.test.js \
  tests/batch-submit-order.test.js
```

Result: syntax passed; 21 passing, 0 failing.

## Full Suite

```bash
git diff --check
npm test
```

Result: whitespace check passed; 77 passing, 0 failing.

## Files

- `batch.js`
- `tests/batch-multi-window-integration.test.js`
- `.superpowers/sdd/task-7-report.md`

## Self-Review

- Concurrent or overlapping refill callbacks cannot exceed the configured
  limit because `takeAvailable()` reserves indices synchronously in the
  scheduler before any window promise starts.
- Terminal confirmation records synchronously and then awaits
  `closeByIndex(urlIndex)` before settlement/refill. Duplicate confirmations,
  manual-close callbacks, send failures, and timeout callbacks see the
  existing original index and cannot increment counters twice.
- Illegal-site, missing-item, and create-failure paths request no window close
  and still settle their scheduler reservation. The missing-item condition is
  defensive; normal batches always have one parsed item per scheduler index.
- Stop sets `isTerminated`, stops the scheduler, and changes page status before
  awaiting any cleanup. Consequently neither ordinary finalization nor a late
  `windows.create` resolution can refill work.
- A late create captures its issuing batch and manager. If clear/restart has
  replaced either, the late window closes through the original manager and
  does not delete a new batch's same-index opening record or settle its
  scheduler.
- Resume creates a new scheduler from all recorded `originalIndex` values, so
  it claims only unfinished indices.
- Completion changes status synchronously before awaiting `closeAll`; duplicate
  completion checks return at the status guard and residue is closed once.
- Each timeout lookup uses the start time for that scheduler index's tracked
  window or pending create activity.
- Confirmation filtering requires the current `batchId` and valid URL index;
  terminal handling closes only `closeByIndex(urlIndex)`. Old-batch and
  duplicate messages therefore cannot close another task's window.
- Result counters, terminal status branches, row highlighting, pending count,
  statistics rendering, local result storage, CSV result mapping, illegal-site
  behavior, and submit-order coverage remain intact.

## Concerns

No known blockers. The page integration guards are source-level because
`batch.js` is a DOM/Chrome extension entry point; lifecycle behavior of the two
stateful primitives remains covered by their existing unit tests, while the
added late-create guard protects the page-specific ownership rule.
