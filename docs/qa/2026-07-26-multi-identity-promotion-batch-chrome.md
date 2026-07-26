# Multi-identity batch Chrome acceptance — 2026-07-26

## Result

- Status: PASS
- Command: `npm run test:chrome:multi-assignment`
- Source baseline: `67146f4` plus the Task 18 fixture/acceptance changes documented here
- Installed Chrome: `150.0.7871.184`
- Full content-flow browser: installed Google Chrome, temporary user-data directory
- MV3 thin smoke: Playwright Chrome for Testing, temporary user-data directory
- Fixture binding: dynamic `127.0.0.1` port (last observed `55327`)
- Third-party submissions: **0**

The runner deletes its temporary Chrome profile in `finally`. The fixture stores
submitted values in process memory only and never stores the password value.

## Five-target assignment proof

| Target | Profile | Promotion Site | Source | Observed |
| --- | --- | --- | --- | --- |
| 1 | `profile-b` | `site-b` | explicit CSV | exact |
| 2 | `profile-a` | `site-a` | weighted | exact |
| 3 | `profile-b` | `site-b` | weighted | exact |
| 4 | `profile-a` | `site-a` | explicit CSV | exact |
| 5 | `profile-a` | `site-a` | weighted | exact |

The runner held at most three active target pages. Every recorded name, email,
password-present flag, promotion URL, generated comment, task ID, Profile ID,
and Promotion Site ID matched that target’s frozen `BATCH_HANDLE`. The model
adapter also observed the correct Promotion Site content in each production AI
request. Completion order did not alter ownership.

## Failure and recovery proof

- A malformed handle missing `profileId` was rejected as
  `invalid_task_config`.
- A handle was acknowledged before a deliberately delayed model request
  completed; its page was then closed during generation and attempt 2
  completed with the same Profile/Site assignment. This is an interruption
  test, not proof of the background task-deadline scheduler.
- A page was closed after the production submit context was saved and the
  `submitting` phase was reached; the safe context remained present at the
  interruption boundary. The runtime’s `submission_uncertain →
  manual_required` reducer remains covered by its contract/integration suite.
- A saved submit context survived reload through the test-only background
  adapter. The reloaded production `content.js` sent one durable confirmation
  with the original task/Profile/Site identity and did not regenerate or
  resubmit the comment.

## Production-code reuse

The ordinary target pages load the production scripts in manifest order:

1. `illegal-site-filter.js`
2. `lib/llm-content-bridge.js`
3. `lib/batch-task-config.js`
4. `lib/batch-handle-dispatch.js`
5. `lib/batch-submit-context-client.js`
6. `lib/comment-history-capture.js`
7. `lib/batch-phase-reporter.js`
8. `content.js`

`tests/fixtures/fake-chrome-adapter.js` replaces only the Chrome
runtime/storage/message boundary. It does not copy field detection, filling,
prompt construction, generation orchestration, submission, or history capture.

## MV3-only thin layer

The automated smoke loaded the unpacked extension, observed its
`background.js` service worker, opened `batch.html`, and verified the console
and wizard mounts. The following browser-owned behaviors are intentionally
proved by contract tests plus a final minimal manual smoke, not by the ordinary
web fixture:

- manifest content-script registration and isolated-world injection;
- real `sender.tab` identity and ownership proof;
- service-worker termination/restart timing;
- native `chrome.storage.session`, `tabs`, `alarms`, and `power` permission
  semantics.

No `chrome://extensions` automation is used.
