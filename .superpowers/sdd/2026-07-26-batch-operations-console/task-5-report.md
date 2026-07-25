# Task 5 Report: Attempt Identity and Controlled Content Phases

## Implemented brief

- Added CSP-safe classic helper `lib/batch-phase-reporter.js` and loaded it
  immediately before `content.js`.
- Restricted phase writes to `opening`, `loading`, `detecting`, `generating`,
  `filling`, `submitting`, `confirming`, and `closing`, with complete
  `{ batchId, urlIndex, attempt }` identity.
- Made content task context, duplicate keys, pending results, submit context,
  submitting checkpoints, confirmations, fallback handoffs, and terminal
  reports attempt-aware.
- `BATCH_HANDLE` now rejects a missing/non-integer attempt with
  `invalid_batch_attempt`.
- Added the required content boundaries:
  `loading -> detecting -> generating -> filling -> submitting -> confirming`.
- A failed phase write aborts the task. In particular, a failed `submitting`
  write clears the pre-click submit context and cannot reach the click.
  A failure after a dispatched click retains the context and reports
  `submission_uncertain`.
- Propagated stable terminal error codes:
  `task_timeout`, `window_create_failed`, `content_script_unavailable`,
  `no_comment_box`, `submission_uncertain`, `illegal_site`, and `task_failed`.
- Made submit-context save/get/clear/seal/recovery matching include attempt.
  A delayed attempt-1 clear or seal cannot remove attempt-2 state for the same
  tab, batch, and URL index.
- Added complete matched-clear validation so an incomplete attempt identity
  cannot participate in submit-context CAS.
- Added the deferred Task 4 assertions: fallback and final
  `BATCH_CONFIRMED.attempt` are both `1`.

## `setStatus` root cause and TDD evidence

Root cause:

`ensureAllCommentFormFieldsFilled()` called `setStatus()` directly when the
configured name or email was empty. The only `setStatus` declaration is inside
the `createOrToggleQwenPanel()` closure. Therefore a batch task with missing
profile configuration and no open panel always raised
`ReferenceError: setStatus is not defined`.

RED:

- Ran the real extracted content function in a VM without opening the panel.
- Both the no-UI case and the explicit-reporter case failed with
  `ReferenceError: setStatus is not defined`.

GREEN:

- `ensureAllCommentFormFieldsFilled()` now accepts an optional UI reporter and
  otherwise returns a structured failure.
- Missing fields are exact (`name config missing` and/or
  `email config missing`), rather than always reporting both.
- The panel passes its closure-local reporter explicitly.
- A handler-level regression proves a missing profile reports attempt-scoped
  `task_failed` and never calls the submit click.

## Additional authorized cross-brief dependencies

The parent explicitly authorized these minimal changes after investigation:

- `lib/batch-runtime-controller.mjs`: preserve
  `errorCode: message.errorCode || null` in `markTerminal()`.
- `batch.js`: obtain the current attempt from the checkpoint task, pass it
  through worker activity, `BATCH_TASK_ACTIVE`, `BATCH_HANDLE`, recovery and
  terminal messages, and reject confirmations whose `(tabId, attempt)` does
  not match the active worker.

No worker-manager/tab-creation refactor, retry UI, or Task 7 restructuring was
implemented.

## Changed files

- `manifest.json`
- `lib/batch-phase-reporter.js`
- `content.js`
- `background.js`
- `batch.js`
- `lib/batch-submit-context-client.js`
- `lib/batch-submit-context-store.mjs`
- `lib/batch-runtime-controller.mjs`
- `tests/batch-phase-reporter.test.js`
- `tests/batch-submit-context-client.test.js`
- `tests/batch-submit-context-store.test.mjs`
- `tests/comment-history-message-listener.test.mjs`
- `tests/comment-history-submit-flow.test.js`
- `tests/batch-runtime-controller.test.mjs`
- `tests/batch-multi-window-integration.test.js`
- `tests/comment-history-capture.test.js`
- `tests/llm-content-bridge.test.js`

## Verification

Focused brief suite:

```text
node --test tests/batch-phase-reporter.test.js \
  tests/batch-submit-context-client.test.js \
  tests/batch-submit-context-store.test.mjs \
  tests/comment-history-message-listener.test.mjs \
  tests/comment-history-submit-flow.test.js

44 tests, 44 passed, 0 failed
```

Affected content, controller, manifest, and batch integration suites:

```text
98 tests, 98 passed, 0 failed
```

Full suite:

```text
npm test
273 tests, 273 passed, 0 failed
```

Syntax and whitespace checks:

```text
node --check content.js
node --check background.js
node --check batch.js
node --check lib/batch-phase-reporter.js
node --check lib/batch-submit-context-client.js
node --check lib/batch-submit-context-store.mjs
node --check lib/batch-runtime-controller.mjs
git diff --check
```

All commands exited `0`.

## Commit

`feat: report attempt-aware batch phases` (the commit containing this report).

## Self-check

- Attempt is never inferred from URL index; initial and resumed work reads the
  checkpoint task attempt. Runtime paths no longer synthesize attempt `1`;
  legacy defaulting remains confined to checkpoint migration.
- Background remains the only writer of `batchRuntimeCheckpoint`.
- The code never automatically retries a possibly submitted task.
- No manual-processing window behavior or worker-slot policy was changed.
- Batch concurrency and timeout bounds were not changed.
- No remote CSS, image, font, module, inline handler, or MV3/CSP-incompatible
  construct was introduced.
- The submission click remains behind durable submit-context and phase gates.
- No Task 7 worker-manager/tab creation refactor was started.

## Review-fix follow-up

The Important findings and the related Minor finding were fixed with separate
RED/GREEN cycles:

- Result persistence now stores `attempt` and `errorCode` and keys both
  `batchResults` replacement and `batchReportedUrls` by
  `{ batchId, urlIndex, attempt }`. A delayed attempt 1 therefore cannot
  overwrite or delete attempt 2. `BATCH_HANDLE_CONFIRM` forwards the complete
  identity and stable error code, and the content-side local fallback uses the
  same identity.
- Submit-context saves now reject incomplete task identities. For the same tab,
  batch, and URL index, an already-saved higher attempt rejects a delayed lower
  attempt before it can replace the current context. The message listener
  rejects incomplete save identities before calling the store.
- Initial start, paused hydration, resume, worker opening, and terminal writes
  now require a positive checkpoint/activity attempt. Start rolls back and
  pauses a newly created runtime session when the returned task attempt is
  invalid; paused hydration refuses the checkpoint without mutating page state.
  Initial and resumed attempts greater than 1 are preserved.

Review-fix RED evidence:

```text
result/context focused run: 11 passed, 5 failed
background/content fallback run: 0 passed, 2 failed
checkpoint attempt run: 2 passed, 2 failed
```

Review-fix GREEN verification:

```text
node --test tests/batch-result-store.test.mjs \
  tests/batch-submit-context-store.test.mjs \
  tests/batch-multi-window-integration.test.js \
  tests/comment-history-submit-flow.test.js \
  tests/comment-history-message-listener.test.mjs

75 tests, 75 passed, 0 failed

npm test
280 tests, 280 passed, 0 failed
```

All ten changed JavaScript/module/test files passed `node --check`;
`git diff --check` exited `0`.

Password-boundary self-check:

- No password field was added to result records, submit contexts, checkpoints,
  `BATCH_HANDLE`, or history payloads.
- The review fix propagates only attempt identity and stable error codes through
  those paths.
