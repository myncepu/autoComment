# Task 12 Report — Batch Page Composition and Slim Entry Point

## Outcome

- Replaced the legacy page-local implementation with a 25-line module entry
  point and a 20-line semantic, CSP-safe HTML shell.
- Added `bootBatchPage(document, dependencies) -> { destroy }` as an
  importable pure-Web composition root. It boots the shared shell, restores
  the authoritative version 2 checkpoint, composes the wizard, console state
  and view, command controller, worker runtime, filters, runtime messages,
  offline handling, history compatibility, export, and teardown.
- Added `createChromeBatchDependencies(chrome)` as the only page boundary for
  runtime, storage, tabs, and manual-window Chrome APIs. The production entry
  module imports without `document` or `chrome` globals and exposes no test
  hook.
- Automatic workers are background tabs in the existing console window:
  `tabs.create({ windowId, url, active: false })`. Normal windows are created
  only by the explicit manual-work adapter and are returned with
  `automation: false`; they do not receive `BATCH_HANDLE` and do not occupy
  worker slots.
- A restored paused checkpoint performs no automatic resume. Explicit resume
  first persists `BATCH_SESSION_RESUME`, then fills the configured three tab
  slots. Returning online never resumes work automatically.
- Checkpoint results are authoritative for counts and export. The old local
  result cache remains only as an export fallback when no checkpoint exists.
  History pending-write retry and 90-day retention status remain visible.
- Removed the obsolete automatic-window manager and the compatibility
  `windowManagerFactory` alias. The worker runtime now composes only
  `BatchTabManager`.

## Production Modules

- `batch.js`: guarded extension auto-boot and public module exports only.
- `batch.html`: app-shell, console, and wizard mounts plus local resources.
- `lib/batch-page-composition.mjs`: pure-Web page lifecycle and composition.
- `lib/batch-chrome-adapter.mjs`: Chrome runtime/storage/tabs/manual-window
  adapters with sender filtering and sensitive-field scrubbing.
- `lib/batch-console-state.mjs`: compatible history/retention banners.
- `lib/batch-console-view.mjs`: explicit active/idle worker-slot state.
- `lib/batch-window-manager.mjs`: tab ownership only; legacy automatic-window
  implementation removed.
- `lib/batch-worker-runtime.mjs`: tab-manager-only runtime factory contract.

## Behavior and Compatibility

- Runtime subscriptions accept only the extension's own sender and the
  whitelisted confirmation/task-phase message types.
- Durable success confirmation closes the matching tab before refill; stale
  tab/attempt confirmations cannot settle a replacement lifecycle.
- Safe retry advances to attempt 2. Submission-uncertain retry still requires
  explicit confirmation.
- Stop is permanent, cleans owned worker tabs, and cannot resume.
- Empty boot composes the production wizard, performs CSV preflight, and starts
  a version 2 checkpoint with `identityId` and `promotionSiteId`.
- Export and history navigation remain available through the shared shell.
- Draft and legacy local-storage adapters recursively remove password, token,
  secret, authorization, credential, and API-key fields. Profile settings are
  loaded through an explicit public-field allowlist; passwords are not
  requested or projected into checkpoint, `BATCH_HANDLE`, history, draft,
  diagnostics, or DOM.
- Destroy removes runtime/online/tab listeners, timers, overlays, view/shell
  DOM, and automatic tab ownership.

The previous page-level race harness depended on the removed monolith and its
global test hook. Its race, lifecycle, and durable-history guarantees remain
covered at their production ownership boundaries by the runtime checkpoint,
runtime controller, worker runtime, command controller, tab manager,
submit-order, history, and new composition integration suites. No moved
responsibility was copied back into the page entry.

## TDD Evidence

- Initial composition RED: all 8 focused tests failed because semantic mounts
  were missing and importing `batch.js` without browser globals threw
  `ReferenceError: document is not defined`.
- Initial Chrome-adapter RED: the adapter import failed with
  `ERR_MODULE_NOT_FOUND`.
- Additional RED-to-GREEN cycles covered:
  - paused boot creating zero tabs, followed by persisted resume and three
    same-window tabs;
  - retry attempt 2 rejecting an attempt 1 confirmation;
  - success waiting for durable history confirmation before tab close;
  - manual normal-window isolation and absence of `BATCH_HANDLE`;
  - permanent stop and no resume;
  - checkpoint-first export and shared history navigation;
  - pending-history and retention banners;
  - wizard preflight into a version 2 start;
  - offline pause with no online auto-resume;
  - complete destroy cleanup;
  - draft password sentinel removal.

## Verification

- Affected composition/runtime/view/history suite:
  `node --test ...` passed 186/186 with zero failures.
- Full repository: `npm test` passed 409/409 with zero failures.
- `node --check` passed for every changed JavaScript module and test.
- `manifest.json` parsed successfully.
- `batch.js` dynamically imported without DOM or Chrome globals.
- `git diff --check` passed.
- Static audits found:
  - zero `chrome.*` references in app-shell, wizard, console view/state, or
    page composition;
  - automatic worker creation only through same-window background tabs;
  - the only production `windows.create/remove` calls in the explicit manual
    adapter;
  - zero inline handlers, remote resources, unsafe HTML sinks, production test
    backdoors, secret sentinels, `profileId`, or removed monolith helpers.

## Multi-profile Version 3 Notes

- This task intentionally preserves the version 2 assignment identity:
  `identityId` plus `promotionSiteId` and their sanitized snapshots.
- `profileId`, multi-profile scheduling, profile concurrency arbitration, and
  migration to checkpoint version 3 remain deferred.
- The composition boundary is ready for that work: profile loading can replace
  the current default-assignment adapter without adding Chrome access to the
  view/state modules or changing worker tab ownership.

## Commit

- Mergeable commit subject: `feat: ship batch operations console`.
- The final commit SHA is reported in the task `DONE` handoff because a file
  cannot contain the hash of the commit that contains itself.
