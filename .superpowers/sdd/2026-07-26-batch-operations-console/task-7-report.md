# Task 7 Report — Worker Runtime / Single-Window Worker Tabs

## Outcome

- Added `createBatchWorkerRuntime()` with start, pause, resume, refill, stop,
  focus, confirmation, completion, subscription, and disposal ownership.
- Replaced the automatic worker resource model with inactive tabs created by
  `tabs.create({ windowId: consoleWindowId, url, active: false })`.
- `BatchTabManager` keys resources by `tabId`, listens to `tabs.onRemoved`, and
  closes only through `tabs.remove(tabId)`. `BatchWindowManager` remains a
  temporary import alias for Task 11 composition compatibility; it is tab
  backed and never owns the shared window.
- Manual-processing windows remain outside this runtime and receive no
  `BATCH_HANDLE`.
- Added scheduler reconciliation so a retried task can return to the queue
  without releasing or duplicating current active slots.

## Readiness timeout root cause

The old `batch.js` implementation retried `PING` 21 times at a fixed 500 ms
delay. Every rejection was discarded by an empty catch. At roughly 10.5
seconds it produced only `content.js 就绪超时`, without the last Chrome error,
fresh tab state, navigation evidence, or a distinction between loading,
permissions, restricted pages, and an invalid tab. This was unrelated to the
earlier `setStatus` fix.

The extracted runtime now waits on the actual condition:

1. subscribe to `tabs.onUpdated`;
2. read a fresh `tabs.get(tabId)` snapshot on every probe;
3. wait while navigation is loading or has a `pendingUrl`;
4. accept readiness only when `PING` returns exactly `{ ok: true }`;
5. retain a total timeout ceiling and condition poll as a missed-event
   fallback.

A controlled-clock test injects readiness at 12 seconds (past the former
10.5-second boundary) without real sleeping and sends `BATCH_HANDLE` once.

## Stable error code and classifications

Every readiness failure persists the stable code
`content_script_unavailable`. The actionable `errorMessage` contains reason,
last raw send error, `tabId`, final `url`, `pendingUrl`, `status`, `discarded`,
last navigation change, and elapsed milliseconds.

| Reason | Behavior |
| --- | --- |
| `timeout` / missing receiver | keep waiting until the total ceiling; retain the last raw error |
| `chrome_error_page` | fail before `BATCH_HANDLE` |
| `restricted_scheme` / `invalid_url` | fail before `BATCH_HANDLE` |
| `permission_denied` | fail immediately with the original permission error |
| `tab_invalid` / `tab_query_failed` | fail with fresh query evidence |
| `tab_discarded` | fail before automation |
| `handle_delivery_failed` / `handle_rejected` | terminalize only the owned attempt |

## Lifecycle and race evidence

- `BATCH_TASK_ACTIVE` persists before readiness and `BATCH_HANDLE`.
- Confirmation, timeout, pause, and stop seal the submit context before
  terminal persistence and tab close.
- Terminal persistence succeeds before close; close succeeds before refill.
- Opening timeout releases capacity; a late created tab is cleaned up without
  becoming active.
- Deferred timeout, stop, finalizer, and stale-handle continuations clean only
  their old `tabId` after lifecycle replacement.
- A newer same-index attempt supersedes a pending create; the late old tab
  cannot overwrite the replacement mapping.
- Processed scheduler indices come from current task state `terminal`, not
  historical result entries.
- The final terminal worker closes before `BATCH_SESSION_COMPLETE`.

## Verification

- Focused:
  `node --test tests/batch-worker-runtime.test.mjs tests/batch-scheduler.test.mjs tests/batch-window-manager.test.mjs`
  — 37 passed, 0 failed.
- Full:
  `npm test`
  — 311 passed, 0 failed.
- Syntax:
  `node --check lib/batch-worker-runtime.mjs`,
  `node --check lib/batch-window-manager.mjs`,
  `node --check lib/batch-scheduler.mjs`.
- Diff hygiene: `git diff --check`.
- Static automatic-worker check: no `chrome.windows.create`,
  `chrome.windows.remove`, `windowsApi.create/remove`, `focused: false`, or
  normal-window creation in the runtime/manager and their focused tests.
- Safety scan: no password, API key, or token fields were introduced in the
  runtime, manager, or tests. Diagnostics contain only worker/navigation
  state and Chrome error text.

## Documentation and commit

The design and implementation plan now record that the original
one-window-per-worker choice was superseded by single-window background worker
tabs, while preserving the separate manual-window decision.

Commit subject: `refactor: extract batch worker tab runtime`. The final commit
hash is reported in the Task 7 DONE message (a commit cannot contain its own
final object hash).
