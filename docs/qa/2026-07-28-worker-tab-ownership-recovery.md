# Worker Tab Ownership Recovery Acceptance

- Branch: `codex/fix-worker-tab-ownership-layout`
- Automated suite: `npm test` — PASS

  ```text
  # tests 955
  # pass 955
  # fail 0
  # duration_ms 6007.883916
  ```

- Syntax checks: PASS
- Console Chrome acceptance: PASS at 1440 / 1024 / 640
- Extension Chrome acceptance: PASS, concurrency 3, local targets 5
- Closed target: index 0
- Replacement target: index 3
- Third-party requests: 0
- Comments submitted: 0
- Page errors: 0

## Acceptance TDD

The acceptance change began with summary assertions for the new
close-and-refill behavior, before the scenario populated those fields.

RED command:

```bash
npm run test:chrome:multi-assignment
```

RED exit: `1`

```text
actual:
  closedUrlIndex: undefined
  replacementUrlIndex: undefined
  maxConcurrency: 3
  thirdPartyRequests: undefined
  commentsSubmitted: undefined
  pageErrors: undefined
expected:
  closedUrlIndex: 0
  replacementUrlIndex: 3
  maxConcurrency: 3
  thirdPartyRequests: 0
  commentsSubmitted: 0
  pageErrors: []
```

GREEN command:

```bash
npm run test:chrome:multi-assignment
```

GREEN exit: `0`

```json
{
  "ok": true,
  "chromeVersion": "150.0.7871.184",
  "extensionAutomationVersion": "149.0.7827.55",
  "closedUrlIndex": 0,
  "replacementUrlIndex": 3,
  "maxConcurrency": 3,
  "thirdPartyRequests": 0,
  "commentsSubmitted": 0,
  "pageErrors": [],
  "extensionSmoke": "automation-chromium-service-worker-batch-page-and-worker-refill"
}
```

The runner generated five target URLs on its ephemeral
`http://127.0.0.1:<port>` fixture origin, started the real unpacked extension
with concurrency three, closed URL index 0 through Playwright, and observed
URL index 3 become active. At that checkpoint:

- task 0 was terminal with `errorCode: task_failed`;
- task 3 was active;
- exactly three fixture worker tabs remained open;
- no raw `batch_ownership_active` error was visible;
- the local fixture had recorded zero submissions.

The temporary unpacked copy adds only `http://127.0.0.1/*` to its generated
manifest so headless Chromium can load local target content scripts without
an interactive optional-permission prompt. The tracked production manifest is
not changed.

## Test Cleanup RED/GREEN

The first exact `npm test` run reported all 164 tests from
`batch-multi-window-integration.test.js` as `ok` but did not exit because the
Task 3 ownership-rejection test intentionally left an active checkpoint after
`page.destroy()` rejected teardown. Its page render interval therefore kept
the test worker alive.

Focused hanging RED:

```bash
node --test --test-name-pattern="rejected new batch keeps active ownership" \
  tests/batch-multi-window-integration.test.js
```

It printed `ok 1` but no TAP totals and remained running. The test-only
cleanup now restores its original paused checkpoint, destroys the page, and
closes the JSDOM window.

Focused natural-exit GREEN:

```text
# tests 1
# pass 1
# fail 0
# duration_ms 236.761708
```

No production runtime behavior was changed for this cleanup.

## Syntax Evidence

The following command group exited `0` with no syntax output:

```bash
node --check background.js
node --check batch.js
node --check lib/batch-runtime-controller.mjs
node --check lib/batch-worker-runtime.mjs
node --check lib/batch-page-composition.mjs
node --check lib/batch-console-view.mjs
node --check scripts/run-multi-assignment-chrome-acceptance.mjs
```

## Console Chrome Evidence

Command:

```bash
npm run test:chrome:console
```

Exit: `0`; installed Google Chrome `150.0.7871.184`.

| Viewport | Mode | Horizontal overflow | Worker slots |
| --- | --- | --- | --- |
| 1440 | table | false | 3 |
| 1024 | table | false | 3 |
| 640 | cards | false | 3 |

The output also reported:

```json
{
  "pageErrors": [],
  "thirdPartyRequests": 0
}
```

## Safety Review

- All five targets and the promotion site snapshot use the ephemeral
  `127.0.0.1` fixture origin.
- The test uses a generated in-memory CSV payload; it does not read a desktop
  CSV or any user data.
- Automatic generation uses the local fixture model endpoint.
- `autoSubmit` is false, and the scenario checkpoints before any submit
  action.
- The fixture submission ledger is reset immediately before the extension
  scenario and remains empty.
- Every extension request is audited; non-loopback requests are rejected.
- No production extension file, stored user profile, or third-party site is
  mutated.
