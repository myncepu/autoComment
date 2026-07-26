# Task 12 Report — Batch Page Composition and Slim Entry Point

## Outcome

- Replaced the legacy page-local implementation with a 38-line module entry
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
- Automatic workers are background-owned tabs in the existing console
  window. The page sends only batch/task identity; the serialized background
  controller derives the checkpoint URL and the real batch-page
  `sender.tab.id` and `sender.tab.windowId`. It persists an opening request
  reservation with a random ownership epoch, precreates the matching
  `chrome.storage.session` journal record, creates an inactive local
  `worker-pending.html#<requestId>` tab with an explicit opener, binds that
  tab in the journal, persists ACTIVE ownership, and only then navigates it
  to the checkpoint URL and responds. Normal windows are created only by the
  explicit manual-work
  adapter and are returned with `automation: false`; they do not receive
  `BATCH_HANDLE` and do not occupy worker slots.
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
- `lib/batch-entry-lifecycle.mjs`: pagehide background-handoff binding that
  does not depend on page boot or page-local async cleanup.
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
- Successful destroy removes runtime/online/tab listeners, timers, overlays,
  view/shell DOM, and automatic tab ownership. Failed durable cleanup leaves
  the projection, page handle, singleton, and retry path mounted.

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

- Page lifecycle teardown was made semantic in round 1. Round 2 moved its
  durable authority from the page command chain into the background runtime
  controller; the current behavior is described below.
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

## Round 2 Background Ownership and Race Hardening

The original round-2 persist-before-close and orphan-list description is
historical. Round 8 supersedes it with journal-proven remove-first cleanup
that retains the original durable ownership until every removal succeeds.

- Ordinary `visibilitychange` events are non-destructive. Moving the batch page
  through hidden and visible states preserves the full UI and handle. Only
  `pagehide` and explicit shared-shell navigation request teardown.
- `pagehide` synchronously hands `BATCH_PAGE_TEARDOWN` to the background and
  does not await page boot, page destroy, or another page-local promise. The
  service-worker promise continues after the page is simulated as unloaded.
- The background runtime controller is the teardown authority and serializes:
  persist `paused_recovery` with every orphan tab ID; close each tab; persist
  the residual orphan IDs and diagnostic; then release system wakefulness.
  Missing tabs count as already cleaned. Startup recovery uses the same path.
- A tab-close failure persists `recoveryCleanup.orphanTabIds` and
  `tab_close_failed` for the next cleanup attempt. A checkpoint-write failure
  performs no destructive cleanup. Navigation succeeds only after background
  cleanup and local disposal both report success; otherwise the page,
  singleton, listeners, local recovery projection, and retry path remain.
- Page-owned start/resume cancellation no longer writes a competing teardown
  pause. It blocks the continuation and waits for the serialized background
  teardown. A missing-attempt or late post-teardown ACTIVE message is safely
  paused/cancelled and its unclaimed tab is durably cleaned.
- Batch CSV now reuses the history exporter `escapeCsvCell` standard for both
  headers and cells. Leading control characters followed by `=`, `+`, `-`, or
  `@` are neutralized while UTF-8 BOM and CSV quoting remain intact.
- Content `BATCH_TASK_PHASE` is accepted only from the actual active
  `sender.tab.id`. After the controller successfully persists it, background
  broadcasts `BATCH_TASK_PHASE_UPDATED` with `sourceTabId`, `attempt`, and
  `phase`. The page adapter accepts only that trusted background event, never
  the raw content payload.

Round-2 RED evidence was observed for: hidden state destroying the page;
pagehide waiting on unresolved page boot; unsupported background teardown;
wrong persist/close/power ownership; cleanup failure being swallowed; storage
failure destroying the page projection; navigation proceeding after failed
cleanup; CSV formulas remaining executable; missing phase broadcast and page
sender rejection; missing-attempt ACTIVE leaving the checkpoint running; late
ACTIVE restarting after teardown; and page teardown issuing a competing local
pause. Each production correction was made after its focused failure. The
explicit draft-write, immutable snapshot, old queued-row reconciliation, and
deferred-completion tests document invariants that already belonged to their
new modules and therefore passed without a production change.

## Round 3 Trusted Sender and Atomic Worker Creation

- `BATCH_PAGE_TEARDOWN` and `BATCH_CREATE_WORKER_TAB` accept only a real batch
  page `MessageSender`: the extension ID must match, the sender URL must
  resolve to this extension's exact `batch.html` resource path, and
  `sender.tab.id` plus `sender.tab.windowId` must be integers. Content/http,
  options-page, external-extension, and tabless forged senders are rejected.
  Startup/recovery remain direct controller methods rather than a forged
  service-worker message path.
- Worker creation is a background-owned serialized operation shared with page
  teardown. It validates the batch, URL index, attempt, queued task, and
  running checkpoint; ignores page-provided URL/window values; creates an
  inactive tab in the real console window; and persists the ACTIVE tab
  identity before responding. If ACTIVE persistence fails, background closes
  the newly created tab and leaves the task queued.
- The page Chrome adapter exposes the same tab-manager contract but sends only
  `{ batchId, urlIndex, attempt }`. The returned durable checkpoint is
  propagated through `BatchTabManager`; worker runtime consumes it without a
  duplicate `BATCH_TASK_ACTIVE` continuation. Background creation also
  reasserts wakefulness after a service-worker restart.
- Creation and teardown have no unowned interval. If creation enters the
  background queue first, ACTIVE is persisted before teardown observes and
  closes the tab. If teardown enters first, it persists `paused_recovery` and
  the later create is rejected with `batch_teardown_cancelled`. Both tested
  orderings finish with zero orphan IDs, including simulated page unload with
  no page-side ACTIVE continuation.
- A running console disables the new-batch/preview entry and clicking cannot
  open the wizard. A separately deferred START observes `beginTeardown`
  before worker startup; it creates zero tabs and issues no competing
  page-owned pause, after which background teardown durably persists
  `paused_recovery` with an empty orphan list.

Round-3 RED evidence was observed for the real batch-page sender being
rejected, the tabless forged sender being accepted, all five initial
background-create contracts being unrouted, the page adapter still calling
raw `tabs.create`, the tab manager dropping durable creation identity, the
worker issuing duplicate ACTIVE, and restarted background creation failing to
reassert wakefulness. Each production correction followed its focused
failure. The running-entry and deferred-START tests document already-correct
state/command barriers and passed without an additional production change.

## Round 4 Durable Reservation and Replay-Safe Creation

The round-4 `about:blank` and compensating-close protocol is historical.
Rounds 5 and 8 supersede it with the exact packaged pending URL plus durable
and per-browser-session ownership proof.

- `BATCH_CREATE_WORKER_TAB` is now a four-stage serialized protocol:
  persist `openingReservations[requestId]`; create one inactive `about:blank`
  tab in the trusted batch-page sender window; persist the tab ID as an ACTIVE
  task owned by the same request identity; then call `tabs.update` with the
  sanitized checkpoint URL. The background never returns a usable tab before
  both ownership persistence and navigation succeed.
- `BatchTabManager` derives one stable request ID from
  `{ batchId, urlIndex, attempt }`, and the Chrome page adapter forwards that
  ID unchanged. A transport-level lost response is retried once with the
  exact same message identity. Response-level failures are not converted into
  success.
- An exact ACTIVE replay first checks the durable request identity and calls
  `tabs.get(task.tabId)`. A live tab is returned with the existing ACTIVE
  checkpoint and no second tab is created. If the tab is already absent, the
  controller durably resets the task to queued and re-reserves the same
  request before creating its one replacement.
- If ACTIVE persistence fails, the background closes only the still-blank
  tab. If that close also fails, it durably records the blank tab ID in both
  the opening reservation and `recoveryCleanup.orphanTabIds`, transitions to
  `paused_recovery`, and returns `checkpoint_write_failed`. No target
  navigation or `BATCH_HANDLE` can occur. Startup and explicit page teardown
  use the same cleanup path and retain only tab IDs whose removal still
  fails.
- A permanent failure while writing the initial reservation creates no tab
  and cannot report queued work as a successful create. A target navigation
  failure normalizes the now-owned ACTIVE task into `paused_recovery`, closes
  the orphan through the durable teardown path, and returns
  `tab_navigation_failed`.
- The round-3 create/teardown ordering remains serialized. Create-first
  reaches durable ACTIVE before teardown closes it; teardown-first rejects
  create with zero tabs. Three concurrent workers still create and navigate
  three distinct tabs in the trusted console window.

Round-4 RED evidence was captured before production changes: the focused
controller/adapter/manager command ran 55 tests with 11 failures. The failures
showed direct target navigation, no opening reservation, successful tab
creation before permanent storage failure, lost-response
`invalid_transition`, missing-tab replay failure, ignored navigation failure,
missing request IDs, no adapter retry, and unstable manager identity. After
the protocol implementation, the expanded affected runtime/page command
passed 121/121.

## Round 5 Discoverable Pending Ownership and Uncertainty

The round-5 URL-only discovery description is historical. Round 8 requires
the exact session journal, epoch, opener, window, durable request identity,
and full-string pending URL together; there is no journal-free discovery
path.

- The opening resource is now the packaged, script-free, content-free
  `worker-pending.html`. Its fragment is the encoded stable request ID.
  Background creates it inactive in the trusted console window. The manifest
  explicitly includes an extension-page CSP and the pending resource; the
  document itself has a stricter `default-src 'none'` policy and contains no
  script, event handler, Chrome API reference, visible content, or
  `BATCH_HANDLE` path.
- Startup, teardown, and replay query open tabs and parse only this extension's
  exact pending resource path. A discovered tab is cleanup-eligible only when
  its decoded fragment matches a strictly validated reservation and its
  window/tab identity agrees. This recovers a crash between `tabs.create` and
  ACTIVE persistence, and also recovers when ACTIVE persistence, tab close,
  and the compensating recovery write all fail. Unmatched pending URLs and
  ordinary user tabs are never removed.
- Version 2 migration now adds `task.requestId: null` and
  `openingReservations: {}` exactly once for older checkpoints. Validation
  requires request IDs to be string-or-null and reservations to have the
  exact key/shape, matching batch, task range, attempt, window, optional tab,
  timestamp, queued task, and source bounds. Malformed reservation state is
  rejected before any tab query/removal.
- A thrown `tabs.update` is treated as an uncertain response. Background uses
  a bounded `tabs.get`: if the observed URL is already the target, the create
  succeeds with the existing ACTIVE tab; if the target was not applied, the
  durable teardown path pauses and cleans it; if lookup is transient or times
  out, the response carries `recoveryRequired` with the still-ACTIVE
  checkpoint. ACTIVE replay resets only after an explicit missing-tab error;
  transient lookup failure preserves ownership.
- The page adapter retains `recoveryRequired` and its returned checkpoint on
  the thrown create error. Worker runtime adopts that checkpoint, stops
  scheduling, emits `runtime-error`, sends no `BATCH_TASK_TERMINAL`, delivers
  no handle, and does not clear the background-owned tab ID. Transport retry
  continues to use the exact same request ID.

Round-5 RED evidence was captured as 15 focused failures among 148 tests:
missing pending resource/manifest contract, permissive checkpoint schema,
undiscoverable create-to-ACTIVE crashes, unsafe forged reservation cleanup,
unverified update-response loss, transient lookup dropping recovery metadata,
adapter metadata loss, and worker terminalization of owned uncertain work.
The same affected command passed 148/148 after implementation.

## Round 6 Strict Task Ownership and Legacy Reservation Migration

- Version 2 validation now enforces an explicit task ownership matrix.
  `active` and `submitting` tasks must carry the canonical
  `${batchId}:${urlIndex}:${attempt}` request ID, positive integer tab/window
  IDs, and a positive finite `startedAt`. `queued` and `terminal` tasks must
  carry null request/tab/window/start fields. Task map key, `urlIndex`,
  attempt, source bounds, results, and reservation attempts remain mutually
  consistent.
- `task_activated` derives the canonical request ID when an older caller omits
  it and rejects a conflicting ID. Older version 2 ACTIVE/SUBMITTING tasks
  missing only `requestId` are migrated to their canonical identity; queued
  and terminal tasks receive null.
- A malformed ACTIVE owner (including reviewer reproduction
  `requestId: forged-request`, `tabId: 777`), a canonical request with
  contradictory ownership fields, or an out-of-bounds task fails migration
  validation before recovery queries or removes tabs. Tests assert tab 777
  remains untouched in every case.
- Round-4 non-empty reservations that lack only `batchId` are migrated when
  their exact legacy shape, map key/request ID, canonical batch/index/attempt,
  queued task identity, window/tab types, source bounds, and task attempt all
  agree. The batch ID is added with `changed: true`. Inconsistent legacy
  entries are dropped before validation and cannot authorize cleanup. A
  compatible migrated reservation still discovers and removes only its exact
  pending extension URL.

Round-6 focused RED ran 71 checkpoint/controller tests with four failures:
the permissive task ownership matrix, missing safe legacy reservation
migration, malformed task cleanup accepting tab 777, and compatible pending
recovery failing to load. The focused command passed 71/71 after the schema
change; the expanded round-5 affected command passed 152/152.

## Round 7 Fail-Closed Ownership Recovery

The round-7 target-URL check is historical. Round 8 proves an ACTIVE target
by durable identity, journal epoch, opener, window, tab, and request instead,
so legitimate redirects and fragments remain cleanup-eligible.

- Legacy version 1 and older version 2 ACTIVE/SUBMITTING tasks now gain a
  canonical request ID only when the complete ownership tuple is valid:
  in-bounds task/index/attempt, positive tab and window IDs, and a positive
  finite start time. Incomplete or contradictory legacy ownership fails
  migration validation without exposing the claimed tab to cleanup.
- A naked `recoveryCleanup.orphanTabIds` array is diagnostic state only. It is
  never copied into the deletion candidate set, and a legacy array is cleared
  without removing its claimed tab. A failed close remains retryable because
  teardown preserves the original validated task or opening-reservation
  ownership, not because the integer ID is trusted.
- Every deletion candidate is re-proven against the live tab query. ACTIVE or
  SUBMITTING ownership requires the same positive tab/window tuple and an
  exact source target URL or canonical pending-worker URL. Opening
  reservations still require their exact extension pending URL, request
  identity, and window/tab constraints. A valid checkpoint whose tab ID has
  since been reused for a different URL cannot delete that user tab.
- The installed runtime no longer routes `BATCH_TASK_ACTIVE`. A forged
  content-page message claiming tab 777 returns synchronously as unhandled
  with zero checkpoint writes and zero tab removals. Normal page operation
  continues through trusted `BATCH_CREATE_WORKER_TAB`, which creates,
  checkpoints, and navigates the worker in the background. The background
  history integration test now uses that production activation path.
- The checkpoint `task_activated` event rejects zero/negative tab IDs,
  zero/negative window IDs, and zero, negative, NaN, or infinite start times.
  The controller supplies its own positive clock value only for its internal
  compatibility call when an explicit start time is absent.

Round-7 focused RED ran 75 checkpoint/controller tests with four failures for
legacy ACTIVE migration, malformed legacy fail-closed behavior, non-positive
activation identity, naked orphan authorization, and forged external ACTIVE
ownership. A separate live-proof test was observed failing by deleting the
reused tab before the teardown correction. The focused controller suite
passed 47/47, and the expanded affected command passed 157/157.

## Round 8 Browser-Session Ownership Proof

- Chrome 102 is now the declared minimum. Background composes a strict
  `chrome.storage.session` ownership journal keyed by the canonical
  `${batchId}:${urlIndex}:${attempt}` request. Every exact journal record
  contains the request identity, positive owner-page tab and window IDs,
  nullable worker tab ID, created time, and a random opaque
  `ownershipEpoch`. The epoch exists only in durable task/reservation
  ownership and the session journal; it is never placed in `BATCH_HANDLE`,
  results, history, DOM, or diagnostics.
- Session storage is trusted-context-only by Chrome's default access level
  and is cleared on browser restart. If a durable active owner outlives that
  journal, startup retains its tab fields and pauses as
  `ownership_unverified`; recovery is manual and never URL-authorized.
- Creation is fail-closed and ordered: durable reservation first; session
  journal precreate with `tabId: null`; `tabs.create` in the sender window
  with the exact full pending URL and explicit `openerTabId`; journal bind to
  the returned tab; durable ACTIVE persistence; target navigation last. A
  journal-precreate failure creates and navigates zero tabs. Lost responses
  replay only when durable identity, exact journal epoch, live opener/window,
  and tab all match. A replay after ACTIVE persistence failure promotes the
  already journal-bound pending tab and never creates a duplicate.
- Pending cleanup requires the valid durable reservation and matching session
  journal (including a legitimate precreate `tabId: null` state), exact
  request/epoch/opener/window identity, and exact full-string pending URL.
  Query or raw-fragment lookalikes fail closed. There is no journal-free
  pending cleanup and no integer orphan-list deletion path.
- ACTIVE/SUBMITTING target cleanup does not depend on the current target URL.
  Redirects and fragments are expected. Cleanup instead requires the exact
  canonical durable task, positive tab/window/owner tuple, matching journal
  epoch/request/tab, and live opener/window proof. A same-URL user tab, stale
  epoch, missing journal, wrong opener, wrong window, transient lookup, or
  malformed legacy owner is retained for manual recovery.
- Legacy active ownership without both owner-page identity and epoch migrates
  to `paused_recovery` with `ownership_unverified`. Its tab fields remain
  visible and are never automatically removed. Start and Clear also reject
  while any durable ACTIVE/SUBMITTING task or opening reservation exists, so
  audit or UI commands cannot discard ownership.
- Cleanup is remove-first and durable-clear-last. Generic failures preserve
  the original task/reservation and journal for retry. If removal succeeds
  but the durable clear fails, the next attempt may advance only through the
  explicit missing-tab result. The session journal is removed only after the
  durable ownership clear; a journal-clear failure is harmless because a
  journal without matching durable ownership is non-authoritative.
- Terminal handling is background-owned and close-first. Content senders may
  update phase, submitting, or terminal state only for their exact active
  `{batchId, urlIndex, attempt, tabId}`. A trusted batch-page sender may
  terminalize only a task owned by that same page tab. Content cannot issue
  start/resume/pause/stop/complete/clear, teardown, create, retry, or manual
  session controls, and externally supplied ACTIVE ownership is not routed.

Round-8 RED-to-GREEN probes covered session-journal precreate failure,
raw/query pending lookalikes, redirected targets, same-URL user tabs, stale
epochs, missing journals/openers, legacy unverified ownership, ACTIVE replay
without proof, journal-bound pending replay without duplication, submitting
close failure, remove-success plus durable-write failure, transient
tab/journal reads, close-first terminal persistence, content/page sender
binding, and protected Start/Clear. The affected command passed 187/187, and
the full repository passed 504/504.

## Round 9 Terminal Transaction and Creation Proof

- A failed terminal close now has one narrowly constrained convergence path.
  `task_terminal` may advance from `paused_recovery` only when the recovery
  reason is exactly `terminal_cleanup_failed`, the task still holds complete
  ACTIVE/SUBMITTING ownership, and the controller supplies its internal
  `terminalCleanupRetry` marker after proving the exact sender, journal,
  epoch, opener, window, tab, and request. Navigation and generic
  `ownership_unverified` pauses cannot use this path. ACTIVE and SUBMITTING
  close retries each converge to one terminal result, clear their journal
  only after the durable ownership write, and are not requeued at startup.
- `BATCH_HANDLE_CONFIRM` side effects now execute inside the controller's
  serialized terminal transaction. The controller validates the checkpoint,
  attempt, task, exact content sender, session journal, and live ownership
  before invoking the injected idempotent hook; it re-proves ownership before
  removal and terminal persistence. Background result persistence, comment
  history durability, and exact submit-context release all run in that hook.
  Hook failure retains the worker and original ownership. A close failure may
  replay the hook, so each operation uses its existing idempotent identity.
  Hook metadata is returned through the committed checkpoint response.
- Missing, stale-batch, wrong-index, stale-attempt, and wrong-tab
  `BATCH_HANDLE_CONFIRM` messages are rejected before the hook. The real
  fake-IndexedDB background integration snapshots batch results, comment
  history, submit context, broadcasts, checkpoint task state, and open tabs;
  all remain byte-for-byte/equivalently unchanged after the wrong-tab probe.
  Legal success, history-failure fallback, and untracked legacy report paths
  remain covered.
- A fresh `tabs.create` response is no longer sufficient ownership evidence.
  Before binding the session journal, persisting ACTIVE, navigating, or
  returning success, the controller performs a bounded live `tabs.get` and
  proves a positive tab ID plus the exact sender window, opener tab, and full
  canonical pending URL against both the create response and live tab.
  Wrong opener, wrong URL, and transient lookup probes pause as
  `ownership_unverified`, retain the valid durable reservation and precreate
  `tabId: null` journal, and perform no ACTIVE write, navigation, or unsafe
  removal.
- Startup recovery now attempts a deduplicated
  `batch.html?recovery=1` page whenever normalization returns a nonterminal
  checkpoint, including an `ownership_unverified` failure. The recovery-page
  query/create is best effort: failure does not replace or weaken the primary
  ownership error, and repeated startup calls neither duplicate workers nor
  recovery pages.

Round-9 RED probes reproduced all four gaps: paused terminal retry failed with
`invalid_transition`; the terminal hook was absent and removal happened after
a throwing test hook; a wrong-tab background confirmation increased both
result and history counts; fresh tab creation accepted wrong opener/URL and
lookup uncertainty; and unverified startup created no recovery page. After
the fixes, the focused checkpoint/controller/background command passed
111/111, the expanded affected command passed 216/216, and the full repository
passed 512/512.

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
   start snapshot` → the old preview replacement/removal UI no longer exists.
   Its surviving invariant is covered explicitly by command-controller
   “Start owns an immutable upload snapshot after the editable draft changes”.
7. `terminated batch retains its start snapshot and cannot resume` →
   checkpoint “terminal session states cannot be restarted” plus composition
   permanent-stop coverage.
8. `Start claims synchronously and ignores a second Start while config is
   pending` → command-controller “deduplicates the same command promise and
   rejects incompatible commands”.
9. `Start durably creates the complete runtime session before scheduling` →
   command-controller “persists a sanitized session before starting workers”.
10. `Start safely pauses a runtime checkpoint with a missing task attempt` →
    runtime-controller “missing-attempt worker activation pauses without
    deleting an unclaimed tab ID”; late unverified ownership also remains
    manual-only.
11. `a keep-awake failure preserves the uploaded dataset and stays idle` →
    runtime-controller “a power acquisition failure leaves a new checkpoint
    safely paused”.
12. `worker activity is checkpointed before the content task is sent` →
    runtime-controller background create/ACTIVE persistence tests plus
    worker-runtime background-checkpoint-before-handle coverage.
13. `a paused checkpoint hydrates the complete page and resumes only on click`
    → composition paused boot/resume test.
14. `paused checkpoint hydration rejects a task without an attempt identity` →
    checkpoint malformed-version-2 validation tests.
15. `Clear during deferred Start invalidates the old continuation` → the old
    page-local Clear command no longer exists. Its cancellation invariant is
    covered by command-controller `beginTeardown` versus deferred START,
    composition durable deferred-START teardown, and runtime-controller
    create/teardown serialization in both orderings.
16. `settings persistence failure restores the claimed Start lifecycle to
    safe idle state` → command-controller “draft storage failure leaves Start
    safely unclaimed with no runtime side effects”.
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
    history-page “zero post-retry pending count clears an earlier queued-row
    warning”.
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
    worker-runtime “a deferred completion cannot stop or clear its replacement
    lifecycle”.

## Verification

- Round-9 affected runtime/background command:
  `node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-session-journal.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-chrome-adapter.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-multi-window-integration.test.js tests/comment-history-message-listener.test.mjs tests/batch-submit-order.test.js tests/comment-history-submit-flow.test.js`
  passed 216/216 with zero failures.
- Round-9 full repository: `npm test` passed 512/512 with zero failures.
- `node --check` passed for every round-9 changed JavaScript/MJS module and
  test; `git diff --check` passed.
- `manifest.json` parsed successfully and `batch.js` dynamically imported
  without DOM or Chrome globals.
- Round-9 static sink audits found no installed `BATCH_TASK_ACTIVE` route and
  no `ownershipEpoch` reference in background, content, batch result, comment
  history, page composition, or DOM-facing modules.
- Round-8 affected runtime/page command:
  `node --test tests/batch-runtime-checkpoint.test.mjs tests/batch-session-journal.test.mjs tests/batch-runtime-controller.test.mjs tests/batch-chrome-adapter.test.mjs tests/batch-worker-runtime.test.mjs tests/batch-multi-window-integration.test.js tests/comment-history-message-listener.test.mjs`
  passed 187/187 with zero failures.
- Full repository: `npm test` passed 504/504 with zero failures.
- `node --check` passed for every round-8 changed JavaScript module and test.
- `manifest.json` parsed successfully.
- `batch.js` dynamically imported without DOM or Chrome globals.
- `git diff --check` passed.
- Static audits found:
  - zero installed runtime routes for externally supplied
    `BATCH_TASK_ACTIVE`;
  - no deletion authorization from naked recovery orphan arrays;
  - exact durable + session-journal epoch proof and a live opener/window for
    every teardown candidate;
  - exact full-string pending URL proof and no target-URL dependency;
  - `ownershipEpoch` absent from results, `BATCH_HANDLE`, history, DOM, and
    diagnostics;
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
- Round-2 hardening commit subject:
  `fix: move batch teardown ownership to background`.
- Round-3 hardening commit subject:
  `fix: atomically create background-owned batch tabs`.
- Round-4 hardening commit subject:
  `fix: make worker tab creation replay-safe`.
- Round-5 hardening commit subject:
  `fix: recover pending worker tab ownership`.
- Round-6 hardening commit subject:
  `fix: validate batch task ownership identities`.
- Round-7 hardening commit subject:
  `fix: prove batch tab ownership before cleanup`.
- Round-8 hardening commit subject:
  `fix: journal batch tab ownership per browser session`.
- Round-9 hardening commit subject:
  `fix: close final batch ownership races`.
- The final commit SHA is reported in the task `DONE` handoff because a file
  cannot contain the hash of the commit that contains itself.
