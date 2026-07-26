# Batch timeout and result preview — Chrome acceptance

## Scope and safety

- Date: 2026-07-27 (Asia/Shanghai)
- Branch: `codex/batch-operations-console`
- Installed browser: Google Chrome `150.0.7871.184`
- Target source: local deterministic fixtures only
- Intended concurrency: `3`
- Target count: `5`
- Third-party requests/submissions: `0`
- Remote images/resources: none

No desktop CSV target was opened during this acceptance. The five-target run
used the local fixture server created by
`scripts/run-multi-assignment-chrome-acceptance.mjs`.

## Automated browser results

`npm run test:chrome:multi-assignment` passed with:

- five local content flows completed while the runner limited active pages to
  maximum concurrency `3`; this does not claim to exercise the production
  background scheduler;
- every target page was created in one installed-Chrome persistent context;
- each task kept its canonical `profileId` and selected promotion site;
- `BATCH_HANDLE` was acknowledged synchronously, then allowed to finish before
  the page was closed;
- a generating-phase interruption was closed safely and retried with the same
  assignment;
- submitting context survived an interruption and refresh recovery confirmed
  the pending result;
- automation Chromium loaded the unpacked worktree's MV3 service worker and
  opened `batch.html`;
- no password appeared in serialized acceptance output;
- request auditing covered both browser contexts; no non-loopback web request
  or third-party submission was observed.

Google Chrome 150 cannot be used for command-line unpacked-extension loading:
Chrome removed `--load-extension` from branded builds starting in Chrome 137.
The installed Google Chrome checks and the command-line MV3 host smoke are
therefore reported as separate evidence instead of labelling Chromium as
Google Chrome. See the
[Chrome Extensions June 2025 update](https://developer.chrome.com/blog/extension-news-june-2025).
The connected-browser safety policy also blocks automation of
`chrome://extensions`, so the installed extension's reload button was not
clicked by the acceptance runner. Reloading the user's installed unpacked
extension remains a manual smoke step; it is not implied by the automated
results below.

`npm run test:chrome:console` passed with:

- 1440 × 900: table layout, three visible tab slots, preview columns and no
  document-level horizontal overflow;
- 1024 × 900: three-column runtime overview, scroll-contained queue table and
  no document-level horizontal overflow;
- 640 × 900: card queue layout, all five tasks available and no document-level
  horizontal overflow;
- queue filtering, details, preview text, focus restoration, pause, resume and
  irreversible stop all completed without a page error;
- all requests stayed on the ephemeral loopback origin.

Screenshots:

- `docs/qa/screenshots/batch-console-1440.png`
- `docs/qa/screenshots/batch-console-1024.png`
- `docs/qa/screenshots/batch-console-640.png`

## Timeout and elapsed-time contract

The wizard accepts a per-task timeout from 10 to 600 seconds and stores it as
`timeoutSeconds`. Attempt-scoped deadlines use
`batchId + urlIndex + attempt`; deadlines are cleared on terminal completion,
pause, stop and batch completion. The scan remains a recovery fallback.

Deadline finalization also has bounded submit-context sealing. If that boundary
does not answer, the task becomes `manual_required`, closes its proven worker
tab and replenishes capacity. At the page-runtime layer, a timed-out
tab-creation reservation is released before the underlying create promise
settles; any late-created activity waits for terminal persistence and is then
cleaned up. Dedicated never-settling seal and late-create tests cover both
liveness paths.

The background controller independently bounds proof-bound storage hooks and
`chrome.tabs.create`, so a hung Chrome/storage operation cannot retain the
controller's serialized checkpoint queue. The opening request ID remains the
durable ownership token; queued terminal persistence clears that exact token,
and a late `tabs.create` completion closes only the exact tab returned by its
own operation.

The result row reads elapsed time from the terminal result once one exists.
Only active/submitting tasks derive elapsed time from the current clock.
`tests/batch-console-state.test.mjs` therefore verifies that success and failure
durations remain frozen across later renders while a running task continues to
increase.

## Result preview and privacy contract

The queue table, cards and task drawer expose:

- sanitized `commentText`;
- bounded `anchorTexts`;
- sanitized `promotedWebsiteUrl`.

Long table values use ellipsis. Each value is keyboard-focusable and exposes
its full content through the native `title` tooltip. Preview persistence rejects
password/secret fields and never stores `commentHtml`; passwords remain outside
checkpoint, `BATCH_HANDLE`, result history and acceptance output.

## Responsive regression fixed during acceptance

The first 1024px run exposed a document-level horizontal overflow: the queue's
minimum content width expanded the parent grid. The layout now sets
`min-width: 0` on direct grid children so the queue table scrolls inside its own
container. A CSS contract test and the real-Chrome `documentWidth ===
clientWidth` assertion cover the regression.
