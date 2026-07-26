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

## Automated real-Chrome results

`npm run test:chrome:multi-assignment` passed with:

- five local targets completed with maximum concurrency `3`;
- every worker page was created in one persistent browser context;
- each task kept its canonical `profileId` and selected promotion site;
- `BATCH_HANDLE` was acknowledged synchronously, then allowed to finish before
  the page was closed;
- a generating-phase interruption was closed safely and retried with the same
  assignment;
- submitting context survived an interruption and refresh recovery confirmed
  the pending result;
- the unpacked worktree loaded an MV3 service worker and opened `batch.html`;
- no password appeared in serialized acceptance output;
- no non-loopback request or third-party submission was observed.

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
