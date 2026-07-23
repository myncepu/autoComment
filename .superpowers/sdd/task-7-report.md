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

No known blockers. The initial page wiring and late-create ownership guards are
source-level because `batch.js` is a DOM/Chrome extension entry point;
lifecycle behavior of the two stateful primitives remains covered by their
existing unit tests, while the late-create guard protects the page-specific
ownership rule.

## Review Fix: Pending-Create Timeout, Send Ownership, and Missing Item

### RED

Added three executable page-lifecycle regressions to
`tests/batch-multi-window-integration.test.js` before changing production code:

- a never-resolving `windows.create` must start the timeout interval as soon as
  its opening activity is recorded;
- an old batch's deferred `BATCH_HANDLE` rejection must not record, close, or
  settle a replacement batch's same-index task;
- a missing `parsedUrls[urlIndex]` must still create a terminal failure entry
  with safe fields and advance processed counters.

```bash
node --test tests/batch-multi-window-integration.test.js
```

Result: 6 passing and 3 failing, as expected:

- timeout interval count was `0` instead of `1`;
- the stale rejection closed one replacement-batch window instead of zero;
- the missing-item path recorded zero results instead of one.

### GREEN

Implemented the three lifecycle fixes:

- `openWorkerWindow` now starts timeout checking immediately after recording
  the opening reservation, before awaiting `windowManager.create`.
- Worker-message ownership captures the issuing batch ID, scheduler, window
  manager, and activity. `canContinueActivity` requires all three current
  objects to match and requires the issuing manager to still track that exact
  activity. The initial send, ready retry, exhausted-retry failure, post-PING
  send, and rejected-`BATCH_HANDLE` failure all use this ownership gate.
- The dispatched `BATCH_HANDLE` payload uses the captured batch ID rather than
  mutable page state.
- The late window-create branch also includes scheduler identity, so a resumed
  scheduler cannot be settled by an earlier create callback.
- `recordTaskResult` converts a missing item to `fail`, stores empty URL/domain
  defaults, clears AI content, supplies `URL 数据不存在` when needed, increments
  `failCount`, updates pending count, and preserves ordinary result behavior
  when the item exists.

Each regression was run independently after its fix:

```bash
node --test --test-name-pattern="opening reservations" \
  tests/batch-multi-window-integration.test.js
node --test --test-name-pattern="stale BATCH_HANDLE" \
  tests/batch-multi-window-integration.test.js
node --test --test-name-pattern="missing parsed URL" \
  tests/batch-multi-window-integration.test.js
```

Result: 1 passing, 0 failing for each command.

Complete integration and syntax check:

```bash
node --check batch.js
node --test tests/batch-multi-window-integration.test.js
```

Result: syntax passed; 9 passing, 0 failing.

Focused verification:

```bash
git diff --check
node --test \
  tests/batch-scheduler.test.mjs \
  tests/batch-window-manager.test.mjs \
  tests/batch-multi-window-integration.test.js
```

Result: whitespace check passed; 23 passing, 0 failing.

Full verification:

```bash
npm test
```

Result: 80 passing, 0 failing.

### Changed Files

- `batch.js`
- `tests/batch-multi-window-integration.test.js`
- `.superpowers/sdd/task-7-report.md`

### Review Self-Check

- With every concurrency slot blocked in `windows.create`, scheduler active
  indices and `openingActivities` now remain visible to the running timeout
  interval. Timeout finalization settles each reservation and can refill
  without waiting for any create promise.
- A create that resolves after its timeout finds the recorded result, closes
  through its issuing manager, and idempotently settles only its issuing
  scheduler.
- No message retry or failure callback can act after clear/start or stop/resume
  replaces the scheduler, even if the new batch uses the same URL index.
- Exact tracked-activity comparison also rejects callbacks after manual close
  or expected close, before another activity could be affected.
- Missing-item finalization now contributes exactly one failure to processed
  totals, allowing completion rather than leaving a settled but uncounted
  index.
- Existing close-before-settle/refill ordering, duplicate-result protection,
  counter branches, CSV mapping, illegal-site handling, stop/resume behavior,
  and terminal completion guards are unchanged.

### Review Concerns

None.

## Re-Review Fix: Deferred Finalizer Lifecycle Ownership

### RED

Added an executable regression that starts finalization for batch A, defers its
`closeByIndex`, replaces the page state with batch B using a new scheduler,
manager, result array, and same-index opening entry, then resolves batch A's
close.

```bash
node --test --test-name-pattern="deferred finalizer" \
  tests/batch-multi-window-integration.test.js
```

Result: 0 passing and 1 failing, as expected. The replacement scheduler's
`settle` count was `1` instead of `0`, demonstrating that the old finalizer's
post-close continuation read mutable global lifecycle state.

### GREEN

`finalizeTask` now captures, before recording:

- the issuing `batchId`;
- the issuing scheduler;
- the issuing window manager;
- the exact opening activity for the URL index, if present.

It closes through the captured manager. After the close resolves, it deletes
the opening entry only when the map still contains the exact captured object,
and settles only the captured scheduler. It compares current batch, scheduler,
and manager identity before refill or completion checks; stale finalizers
return without touching the replacement lifecycle.

Focused regression:

```bash
node --check batch.js
node --test --test-name-pattern="deferred finalizer" \
  tests/batch-multi-window-integration.test.js
```

Result: syntax passed; 1 passing, 0 failing.

Complete integration:

```bash
node --test tests/batch-multi-window-integration.test.js
```

Result: 10 passing, 0 failing.

Focused scheduler/window/integration verification:

```bash
git diff --check
node --test \
  tests/batch-scheduler.test.mjs \
  tests/batch-window-manager.test.mjs \
  tests/batch-multi-window-integration.test.js
```

Result: whitespace check passed; 24 passing, 0 failing.

Full verification:

```bash
npm test
```

Result: 81 passing, 0 failing.

### Changed Files

- `batch.js`
- `tests/batch-multi-window-integration.test.js`
- `.superpowers/sdd/task-7-report.md`

### Re-Review Self-Check

- A clear/start replacement uses different batch, scheduler, and manager
  identities, so an earlier finalizer can close only its captured manager and
  cannot delete, settle, refill, complete, or record into the replacement.
- A stop/resume replacement can retain batch or manager identity, but its new
  scheduler identity still makes the earlier continuation stale.
- Exact opening-object comparison protects a new same-index opening entry even
  if its key is identical.
- The old scheduler is settled exactly once; the replacement scheduler is
  untouched.
- Result recording remains synchronous before the close await. Replacing the
  result array during that await means the stale continuation has no later
  result mutation.
- Close-before-settle/refill ordering and all previous timeout, message
  ownership, missing-item, duplicate-result, stop/resume, and completion
  protections remain intact.

### Re-Review Concerns

None.

## Re-Review Fix: Deferred Late-Create Cleanup Ownership

### RED

Added an executable stop/resume regression for `openWorkerWindow`: window
creation resolves after the old lifecycle is stopped, its cleanup close is
deferred, then resume installs a replacement scheduler and same-index opening
entry before that old close resolves.

```bash
node --test --test-name-pattern="deferred late-create" \
  tests/batch-multi-window-integration.test.js
```

Result: 0 passing and 1 failing, as expected. The resumed scheduler's settle
count was `1` instead of `0`, proving that the old late-create continuation
used the mutable global scheduler after its close await.

### GREEN

Updated late-create cleanup so that:

- lifecycle identity is evaluated through a function against the captured
  batch ID, scheduler, and window manager rather than stored in a pre-await
  boolean;
- the deferred close always uses the captured window manager;
- post-close opening cleanup occurs only when the current map still contains
  the exact captured opening object;
- reservation settlement always targets the captured `activityScheduler`;
- no refill or completion action is taken by this cleanup continuation, and
  replacement state is never reached through mutable globals.

Focused regression:

```bash
node --check batch.js
node --test --test-name-pattern="deferred late-create" \
  tests/batch-multi-window-integration.test.js
```

Result: syntax passed; 1 passing, 0 failing.

Complete integration:

```bash
node --test tests/batch-multi-window-integration.test.js
```

Result: 11 passing, 0 failing.

Focused scheduler/window/integration verification:

```bash
git diff --check
node --test \
  tests/batch-scheduler.test.mjs \
  tests/batch-window-manager.test.mjs \
  tests/batch-multi-window-integration.test.js
```

Result: whitespace check passed; 25 passing, 0 failing.

Full verification:

```bash
npm test
```

Result: 82 passing, 0 failing.

### Changed Files

- `batch.js`
- `tests/batch-multi-window-integration.test.js`
- `.superpowers/sdd/task-7-report.md`

### Re-Review Self-Check

- The stop/resume case can retain batch and manager identity, but the captured
  scheduler differs from the resumed scheduler and only the former is settled.
- A replacement same-index opening object is not equal to the captured
  opening, so deferred cleanup cannot delete it.
- Clear/start also remains isolated because both batch and manager identity
  change; the old window still closes through its captured manager.
- An already-timed-out or otherwise settled old reservation tolerates the
  captured scheduler's idempotent `settle`.
- The active-window success path still removes its exact opening entry before
  dispatch and retains the existing send ownership gates.
- Prior close-before-settle ordering, deferred finalizer ownership, pending
  create timeout, message rejection isolation, missing-item accounting, and
  completion protections remain covered.

### Re-Review Concerns

None.
