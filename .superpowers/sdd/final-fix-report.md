# Multi-window batch comments final fix report

Date: 2026-07-24
Base: `0cf808e` (`fix: isolate deferred batch completion`)

## Result

All four Important findings and the context-clear Minor are implemented. The final focused suite passes 34/34 and the full suite passes 94/94. No known concerns remain.

## Important 1 — immutable lifecycle dataset

Implementation:

- Added an immutable, lifecycle-owned `batchItems` snapshot at the synchronous Start claim. Each item and its `originalRow`/illegal-check data are cloned and frozen.
- Worker opening, result recording, and preview association use the lifecycle snapshot rather than the mutable upload preview.
- CSV parse, file read/drop/select, and removal paths now reject dataset changes outside `idle`.
- Upload zone, file input, and remove control are visibly/semantically disabled during `starting`, `running`, `terminated`, and `completed`.
- Terminated batches retain the original snapshot and the Resume control remains enabled; Clear is required before another CSV can be accepted.

RED:

```text
node --test --test-name-pattern='running batch rejects|terminated batch retains|Start claims|Clear during deferred Start|settings persistence failure' tests/batch-multi-window-integration.test.js

tests 5; pass 0; fail 5
- running replacement/removal: expected retained length 1, got 0
- terminated replacement/removal: original item became undefined
```

GREEN:

```text
tests 5; pass 5; fail 0
```

Additional Resume UI RED/GREEN found during self-review:

```text
node --test --test-name-pattern='terminated batch retains' tests/batch-multi-window-integration.test.js
RED: tests 1; pass 0; fail 1 (Start disabled true, expected false)

node --test --test-name-pattern='terminated batch retains|deferred timeout scan' tests/batch-multi-window-integration.test.js
GREEN: tests 2; pass 2; fail 0
```

## Important 2 — synchronous single-flight Start

Implementation:

- `startBatch()` now rejects non-idle calls and synchronously claims `starting` with a unique lifecycle token, batch ID, immutable items, concurrency, and checkbox settings before the first await.
- Controls update immediately.
- Ownership is revalidated after configuration load, stored-context removal, and task-settings persistence.
- A second Start is ignored.
- Clear invalidates the token synchronously, so an older deferred continuation cannot create scheduler state or worker windows.
- Readiness and settings/storage failures restore `idle` only when the failing continuation still owns the starting lifecycle; newer lifecycle state cannot be overwritten.
- Resume creates a fresh lifecycle token while retaining the original batch snapshot and snapshotted concurrency.

RED/GREEN evidence is the shared five-test lifecycle command above:

```text
RED: Start remained idle while config was pending; Clear was overwritten by the old continuation; storage failure escaped.
GREEN: tests 5; pass 5; fail 0.
```

## Important 3 — Stop cleanup ownership

Implementation:

- Stop captures the exact batch ID, lifecycle token, scheduler, window manager, immutable items, active indices, and opening objects at entry.
- Captured active tasks are finalized together so result recording is claimed before another lifecycle can resume.
- Window closing and scheduler settling operate only on captured objects.
- Opening reservations are deleted only when the current map still contains the exact captured object.
- Post-await stats/UI/logging require the captured identity to remain current.
- Completion cleanup also includes the lifecycle token in its post-await ownership check.
- Timeout scanning was found during await self-review and now uses the same captured ownership pattern, returning before it can continue into a replacement lifecycle.

RED:

```text
node --test --test-name-pattern='deferred Stop cleanup' tests/batch-multi-window-integration.test.js

tests 1; pass 0; fail 1
old manager closeAll count was 0 instead of 1 because the replacement manager was used.
```

GREEN:

```text
tests 1; pass 1; fail 0
```

Timeout await self-review RED/GREEN:

```text
node --test --test-name-pattern='deferred timeout scan' tests/batch-multi-window-integration.test.js
RED: tests 1; pass 0; fail 1 (replacement close count 1, expected 0)

node --test --test-name-pattern='terminated batch retains|deferred timeout scan' tests/batch-multi-window-integration.test.js
GREEN: tests 2; pass 2; fail 0
```

## Important 4 — window removal errors

Implementation:

- Added narrow missing-window classification for Chrome's `No window with id...` and `Window not found` errors.
- Only verified missing-window errors clear the three manager mappings after a rejected `windows.remove()`.
- Other removal failures remove expected-close suppression, retain every mapping, and rethrow.
- A later real `onRemoved` event therefore removes retained mappings and routes the activity as an unexpected close.
- `closeAll()` continues to surface the rejection through `Promise.all`.

RED:

```text
node --test --test-name-pattern='already-absent|transient window removal' tests/batch-window-manager.test.mjs

tests 2; pass 1; fail 1
transient case failed with "Missing expected rejection".
```

GREEN:

```text
tests 2; pass 2; fail 0
```

Removal-path self-review:

- Normal confirmed removal: `onRemoved` clears mappings and consumes expected-close suppression.
- Verified already-absent rejection: suppression and mappings are cleared because Chrome confirms the window does not exist.
- Transient/permission-like rejection: suppression is removed, mappings remain, and the original error is rethrown.
- Later closure after transient rejection remains eligible for unexpected-close routing.

## Minor — clear submit-refresh context only after acknowledgement

Implementation:

- Added `AutoCommentBatchSubmitContext.confirm()`.
- It accepts only the existing client's strict `{ ok: true }` response, then requests context clearing.
- Negative responses and message rejections throw before clearing.
- Both normal post-submit confirmation and restored confirmation use this client method.
- Normal confirmation failures return with the persisted context intact for reload/retry.
- Removed the unconditional catch-path clear after a persisted submission.

RED:

```text
node --test --test-name-pattern='confirmation' tests/batch-submit-context-client.test.js

tests 3; pass 0; fail 3
all failed because client.confirm was not a function.
```

GREEN:

```text
tests 3; pass 3; fail 0
- acknowledged confirmation clears
- negative confirmation preserves
- rejected confirmation preserves
```

## Focused verification

```text
node --test tests/batch-multi-window-integration.test.js tests/batch-window-manager.test.mjs tests/batch-submit-context-client.test.js tests/batch-submit-order.test.js

tests 34
pass 34
fail 0
duration_ms 79.307542
```

## Final required verification

```text
node --check background.js
node --check content.js
node --check batch.js
git diff --check
```

All four commands exited 0 with no output.

```text
npm test

tests 94
pass 94
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 349.143375
```

## Changed files

- `batch.js`
- `batch.html`
- `content.js`
- `lib/batch-window-manager.mjs`
- `lib/batch-submit-context-client.js`
- `tests/batch-multi-window-integration.test.js`
- `tests/batch-window-manager.test.mjs`
- `tests/batch-submit-context-client.test.js`
- `.superpowers/sdd/final-fix-report.md`

## Await/lifecycle self-review

- Start: token claimed before await; ownership checked after every initialization await and in failure recovery.
- Stop: all post-entry work uses captured scheduler/manager/items/openings; UI/state work after awaits is ownership-gated.
- Worker create: batch ID, token, scheduler, and manager are captured; both success and rejection paths validate them.
- Task finalization: item dereference, close, settle, exact-opening deletion, refill, and completion use captured lifecycle objects; post-close global work is ownership-gated.
- Completion: close-all uses the captured manager and post-await cleanup validates batch ID, token, scheduler, and manager.
- Timeout scan: active indices, manager, items, and openings are captured; the scan stops after lifecycle replacement.
- Submit confirmation: context clearing is sequenced after strict acknowledgement only.

## Concerns

None known. The changes deliberately avoid unrelated scheduler, counter, export, detection, and AI refactoring.
