# Task 12 Report — Batch Page Composition and Slim Entry Point

## Outcome

- Replaced the legacy page-local implementation with a 35-line module entry
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
- `lib/batch-entry-lifecycle.mjs`: pagehide/hidden-page teardown binding that
  retains the boot handle without a product global.
- `lib/batch-page-composition.mjs`: pure-Web page lifecycle and composition.
- `lib/batch-chrome-adapter.mjs`: Chrome runtime/storage/tabs/manual-window
  adapters with sender filtering and sensitive-field scrubbing.
- `lib/batch-console-state.mjs`: compatible history/retention banners.
- `lib/batch-console-view.mjs`: explicit active/idle worker-slot state.
- `lib/batch-window-manager.mjs`: tab ownership only; legacy automatic-window
  implementation removed.
- `lib/batch-worker-runtime.mjs`: tab-manager-only runtime factory contract.

## Behavior and Compatibility

- Runtime subscriptions accept only trusted background/service-worker
  senders: the extension ID must match, `sender.tab` must be absent, and a
  present URL must be the exact extension `background.js` URL.
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

## Round 1 Review Hardening

- Page lifecycle teardown is now semantic and durable. Pagehide,
  `visibilityState === "hidden"`, shared-shell links, and the brand link all
  request `commandController.pause("page_teardown")` before teardown or
  navigation. The persisted checkpoint becomes `paused_recovery`, background
  power is released, owned tabs are closed, then listeners/views are disposed.
  A close failure keeps the recovery checkpoint and exact tab ownership
  instead of presenting a false running or terminated state.
- Offline is a synchronous scheduling barrier, not a best-effort command.
  Empty/offline state cannot create or open a wizard. An already-open wizard
  rerenders with `batch_offline` readiness and a disabled start action.
  Deferred start/resume responses observe the barrier before worker creation,
  persist the recovery pause, and create zero tabs. Returning online only
  clears the barrier; it never resumes automatically.
- Stop now propagates worker cleanup rejection. `tabs.remove` failure keeps
  the worker manager attached, returns `false`, persists `paused_recovery`,
  and prevents `BATCH_SESSION_STOP`.
- Legacy-only results enable export without becoming an active batch. The
  actual CSV exporter is tested for UTF-8 BOM, generic headers, result labels,
  checkpoint precedence, and sensitive original-row column redaction.
- `bootBatchPage` is a per-document singleton. Concurrent/repeated boot calls
  share one handle, one listener graph, and one tab owner; destroy is
  promise-idempotent and releases the singleton only after cleanup.
- Confirmation/task-phase messages reject content-script senders, extension
  pages, external extensions, and unrelated message types while retaining the
  MV3 missing-URL service-worker case.

Round-1 RED evidence included: teardown leaving a persisted `running`
checkpoint; navigation bypassing cleanup; pagehide/hidden lifecycle missing;
deferred resume creating tabs after teardown/offline; offline create/readiness
remaining enabled; worker stop returning success after `tabs.remove` failure;
controller issuing STOP after cleanup rejection; missing/default exporter and
secret CSV values; duplicate page boots; and content/page forged
confirmations. Every focused case was observed failing for that specific
production gap before the corresponding implementation.

## Legacy Race Coverage Map

The removed monolith fixture is not retained. Each former integration
guarantee is owned and tested by the production module that now implements it:

1. `batch UI exposes the supported persisted concurrency control` →
   console-state “derives a complete paused console view model”.
2. `batch UI exposes paused recovery and wakefulness status` →
   console-state paused model plus runtime-controller “requests system
   wakefulness only while a batch is running”.
3. `background confirmations preserve batch identity` →
   worker-runtime “confirmation seals and closes its tab…” and result-store
   attempt identity tests.
4. `batch page rejects confirmations that do not match its batch` →
   composition “retry advances to attempt 2…” plus worker confirmation
   identity checks.
5. `batch execution uses the scheduler and isolated Chrome windows` →
   worker-runtime “opens no more than three attempt-aware background worker
   tabs in the console window”.
6. `running batch rejects preview replacement/removal and records from its
   start snapshot` → checkpoint “creates…complete dataset” plus
   command-controller sanitized persisted-start ordering.
7. `terminated batch retains its start snapshot and cannot resume` →
   checkpoint “terminal session states cannot be restarted” plus composition
   permanent-stop coverage.
8. `Start claims synchronously and ignores a second Start while config is
   pending` → command-controller “deduplicates the same command promise and
   rejects incompatible commands”.
9. `Start durably creates the complete runtime session before scheduling` →
   command-controller “persists a sanitized session before starting workers”.
10. `Start safely pauses a runtime checkpoint with a missing task attempt` →
    runtime-controller missing-attempt rejection plus command recovery tests.
11. `a keep-awake failure preserves the uploaded dataset and stays idle` →
    runtime-controller “a power acquisition failure leaves a new checkpoint
    safely paused”.
12. `worker activity is checkpointed before the content task is sent` →
    worker-runtime ACTIVE-before-handle call-order tests.
13. `a paused checkpoint hydrates the complete page and resumes only on click`
    → composition paused boot/resume test.
14. `paused checkpoint hydration rejects a task without an attempt identity` →
    checkpoint malformed-version-2 validation tests.
15. `Clear during deferred Start invalidates the old continuation` →
    command cancellation barrier plus worker “concurrent starts dispose every
    intermediate manager before the last owner wins”.
16. `settings persistence failure restores the claimed Start lifecycle to
    safe idle state` → command-controller persisted-start recovery and stable
    runtime-error tests.
17. `terminal paths close a worker window before replenishing the queue` →
    worker-runtime durable confirmation close-before-refill test.
18. `terminal checkpoint messages carry the active attempt and stable error
    code` → checkpoint/result-store attempt and stable-error tests.
19. `late window creation stays bound to the batch and manager that opened it`
    → worker-runtime cancelled-late-create and replacement-owner tests.
20. `opening reservations time out and release capacity before window creation
    resolves` → worker-runtime opening-timeout replenishment test.
21. `deferred timeout scan cannot continue into a replacement lifecycle` →
    worker-runtime deferred-timeout replacement test.
22. `timeout seals and recovers a worker context before closing its window` →
    worker-runtime timeout seal/terminal/close order test.
23. `stale BATCH_HANDLE rejection cannot finalize the replacement batch` →
    worker-runtime stale-handle replacement test.
24. `missing parsed URL records a terminal failure with safe defaults` →
    worker-runtime “missing parsed URL terminalizes the task with safe source
    defaults”.
25. `a zero pending count reconciles earlier queued history rows` →
    history-page startup retry/pending-count tests.
26. `a durable confirmation from an old tab cannot close a replacement worker`
    → worker-runtime deferred-finalizer replacement test.
27. `a durable confirmation must match the current tab and attempt` →
    composition durable-confirmation test plus worker identity checks.
28. `deferred finalizer cannot mutate a replacement same-index lifecycle` →
    worker-runtime deferred-finalizer replacement test.
29. `deferred late-create cleanup cannot mutate resumed same-index work` →
    worker-runtime cancelled-late-create terminal-persistence tests.
30. `deferred Stop cleanup cannot close or erase a replacement lifecycle` →
    worker-runtime deferred-stop replacement test.
31. `Stop recovers an unresolved submit context before closing its worker` →
    worker-runtime stop seal-before-close test.
32. `deferred completion cannot stop or clear a replacement lifecycle` →
    worker-runtime completion-adapter recovery and concurrent-owner tests.

## Verification

- Affected composition/runtime/view/history suite:
  `node --test ...` passed 209/209 with zero failures.
- Full repository: `npm test` passed 428/428 with zero failures.
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
- Round-1 hardening commit subject:
  `fix: harden batch console teardown and races`.
- The final commit SHA is reported in the task `DONE` handoff because a file
  cannot contain the hash of the commit that contains itself.
