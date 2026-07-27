# Worker Tab Ownership Recovery Acceptance

- Branch: `codex/fix-worker-tab-ownership-layout`
- Automated suite: `npm test` — PASS

  ```text
  # tests 960
  # pass 960
  # fail 0
  # duration_ms 6097.300208
  ```

- Syntax checks: PASS
- Console Chrome acceptance: PASS at 1440 / 1024 / 640
- Extension Chrome acceptance: PASS, observed maximum concurrency 3,
  configured concurrency 3, local targets 5
- Closed target: index 0
- Replacement target: index 3
- Forwarded/completed third-party egress during real-extension recovery: 0
- Unknown-origin blocked third-party attempts in the focused round-2 GREEN:
  26 (`www.google.com`; denied by the local proxy)
- Bootstrap functional attribution: unavailable; network enforcement only
- Monitored service-worker restart through context close: ready, closed,
  console errors 0, worker errors 0, page errors 0
- Real-extension recovery comments submitted: 0
- Legacy local-fixture phase comments submitted: 6
- Whole-command local-fixture comments submitted: 6
- Whole-command page errors: 0

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

The zero-submission statement above is scoped only to the real-extension
recovery leg. The earlier legacy fixture phase intentionally submits five
comments and one same-assignment retry, for six local fixture submissions.
The command preserves both ledgers and reports a whole-command total of six.

The temporary unpacked copy adds only `http://127.0.0.1/*` to its generated
manifest host permissions, removes optional host permissions, and narrows its
content-script and web-accessible-resource matches to that same local pattern.
This lets headless Chromium load the local targets without an interactive
optional-permission prompt while preventing the temporary extension from
addressing third-party hosts. The tracked production manifest is not changed.

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

## Review Fix Round 1

The review assertions were added before the accounting implementation.

RED command:

```bash
npm run test:chrome:multi-assignment
```

RED exit: `1`. The existing result exposed configuration value `3` as
`maxConcurrency`, but the new observed-lifecycle and ledger fields failed as
missing:

```text
configuredConcurrency: undefined
openedUrlIndices: undefined
openedUrlIndexCounts: undefined
workerTabsAfterStop: undefined
networkAuditScope: post-launch-page-lifetime
legacyPhaseCommentsSubmitted: undefined
recoveryCommentsSubmitted: undefined
wholeCommandCommentsSubmitted: undefined
commentsSubmittedScope: undefined
```

GREEN command:

```bash
npm run test:chrome:multi-assignment
```

GREEN exit: `0`. Exact lifecycle evidence:

```text
openedUrlIndices: [0, 1, 2, 3]
openedUrlIndexCounts: {"0":1,"1":1,"2":1,"3":1}
maxConcurrency: 3
workerTabsAfterStop: 0
activeWorkerTabsAtFinalization: 0
```

The continuous ledger recorded:

```text
open 0 (active 1)
open 1 (active 2)
open 2 (active 3)
close 0 (active 2)
open 3 (active 3)
close 1 (active 2)
close 2 (active 1)
close 3 (active 0)
```

This proves the observed maximum rather than repeating the configured value.
It also proves index 0 opened exactly once, index 3 opened only after index 0
closed, no transient fourth worker appeared, and no retry of index 0 occurred.

Before the batch starts, the runner registers page/request/close observers.
After recovery it checks the full visible batch-page text for
`batch_ownership_active`, activates the real Stop control and confirmation,
waits for status `terminated` and zero worker tabs, closes the batch page and
Chromium context, and only then finalizes lifecycle, request, submission, and
page-error ledgers.

### Pre-launch network boundary

Playwright cannot install request listeners before Chromium launch. The
runner therefore starts a deny-by-default HTTP(S) proxy first and launches
Chromium with:

- the local proxy as its network proxy, including loopback traffic;
- host resolution denied except for the proxy host;
- QUIC disabled;
- Google service bases redirected to the local fixture;
- background, network-time, autofill, and captive-portal features disabled.

The proxy forwards only the exact ephemeral fixture origin. It records every
HTTP request, CONNECT, and upgrade attempt from Chromium launch until after
the context closes. The focused GREEN run reported:

```json
{
  "extensionChromium":
    "pre-launch-to-context-close-local-only-proxy",
  "thirdPartyRequestsScope": "extension-attributed-http(s)",
  "temporaryManifestHostPermissions": ["http://127.0.0.1/*"],
  "temporaryManifestOptionalHostPermissions": [],
  "proxyRequests": 24,
  "allowedFixtureRequests": 8,
  "extensionThirdPartyRequests": 0,
  "forwardedThirdPartyNetworkEgress": 0,
  "blockedChromiumBackgroundAttempts": 16,
  "blockedChromiumBackgroundDestinations": ["www.google.com"]
}
```

Round 1 called those denied `www.google.com` attempts Chromium background
probes. That attribution was based only on hostname and is superseded by
round 2 below. The proxy proves that the attempts were blocked before egress,
but it does not prove which browser or extension component originated them.

## Review Fix Round 2

### Lifecycle mutation RED/GREEN

The regression probe uses a real local page and the sequence:

```text
index 0 target
same-tab reload of index 0
navigate away to about:blank
navigate back to index 0
close page
```

RED command:

```bash
npm run test:chrome:multi-assignment
```

The old mixed request/navigation ledger ignored the reload and leave-return:

```text
AssertionError: 1 !== 3
actual index 0 opens: 1
expected index 0 opens: 3
```

GREEN evidence:

```json
{
  "openedUrlIndexCounts": {"0": 3},
  "closedUrlIndexCounts": {"0": 3}
}
```

The final ledger has one authoritative source: committed main-frame
`framenavigated` events. Every main-frame navigation first closes any active
page/index mapping, then opens a new mapping only when the destination is one
of the five recovery targets. A reload therefore records close/open, a
navigation away records close, and a return records a new open. Page close
remains the final close source.

The production recovery scenario still records exactly:

```text
open 0, open 1, open 2, close 0, open 3, close 1, close 2, close 3
```

Its observed maximum remains three and each opened index has count one, so a
same-tab reload, leave-return, transient fourth tab, or retry fails.

### Monitored functional-error boundary

The second round-2 assertion RED showed these fields missing and the old
request scope overstated:

```text
bootstrapFunctionalAttribution: undefined
monitoredReloadReady: undefined
monitoredWorkerClosed: undefined
monitoredWorkerConsoleErrors: undefined
monitoredPageErrors: undefined
thirdPartyRequestsScope: extension-attributed-http(s)
```

Playwright observers cannot see events that occur before
`launchPersistentContext` returns. The final evidence therefore has two
explicit boundaries:

- Bootstrap: the pre-launch proxy enforces local-only egress, but request
  origin and functional page/service-worker errors are unobserved.
- Monitored window: after request, page-error, service-worker console, CDP
  service-worker error/version, and close listeners attach, the runner stops
  the current service worker, observes the restarted service-worker version
  running, reloads the batch page, waits for `BATCH_SESSION_GET`, runs
  recovery, stops the batch, and keeps observers active through context
  close.

Chromium reuses the Playwright Worker object for this stop/start. The
deduplicated CDP version sequence proves the restart:

```text
running → stopping → stopped → starting → running
```

Focused GREEN functional evidence:

```json
{
  "bootstrap": "network-enforced-functional-signals-unobserved",
  "monitoredScope":
    "observer-attached-service-worker-restart-through-context-close",
  "monitoredReloadReady": true,
  "monitoredWorkerClosed": true,
  "monitoredWorkerConsoleErrors": [],
  "monitoredWorkerErrors": [],
  "monitoredPageErrors": []
}
```

The close signal above is emitted by the monitored Playwright worker when the
context closes. CDP `workerErrorReported` and error-level worker console
messages remain empty through that close.

### Network scope

The proxy remains active from before browser launch through context close.
All 26 non-fixture attempts in the focused GREEN are reported as
`unknownOriginBlockedThirdPartyAttempts`; the `www.google.com` destination
does not imply browser or extension attribution. The proxy denied every one.

```json
{
  "thirdPartyRequests": 0,
  "thirdPartyRequestsScope":
    "forwarded-completed-third-party-egress",
  "bootstrapRequestAttribution":
    "unknown-origin-proxy-enforced-only",
  "monitoredRequestScope":
    "observer-attached-service-worker-restart-through-context-close",
  "monitoredWindowThirdPartyRequests": 0,
  "forwardedCompletedThirdPartyEgress": 0,
  "unknownOriginBlockedThirdPartyAttempts": 26,
  "unknownOriginBlockedThirdPartyDestinations": ["www.google.com"]
}
```

`thirdPartyRequests: 0` means only that zero third-party requests were
forwarded/completed beyond the local proxy. It does not claim bootstrap
origin attribution. The temporary manifest remains loopback-only, and the
monitored reload-through-close request window independently contains zero
third-party HTTP(S) requests.

### Final verification

The final natural acceptance run repeated the focused behavior. Its
whole-process proxy ledger contained 37 requests: 12 allowed loopback fixture
requests and 25 denied, unknown-origin attempts to `www.google.com`. None of
the denied attempts were forwarded or completed.

```json
{
  "openedUrlIndexCounts": {"0": 1, "1": 1, "2": 1, "3": 1},
  "closedUrlIndex": 0,
  "replacementUrlIndex": 3,
  "maxConcurrency": 3,
  "workerTabsAfterStop": 0,
  "mutationProbe": {
    "openedUrlIndexCounts": {"0": 3},
    "closedUrlIndexCounts": {"0": 3}
  },
  "monitoredReloadReady": true,
  "monitoredWorkerClosed": true,
  "monitoredWorkerConsoleErrors": [],
  "monitoredWorkerErrors": [],
  "monitoredPageErrors": [],
  "forwardedCompletedThirdPartyEgress": 0,
  "monitoredWindowThirdPartyRequests": 0,
  "unknownOriginBlockedThirdPartyAttempts": 25
}
```

The final service-worker transition remained:

```text
running → stopping → stopped → starting → running
```

The console acceptance also passed at 1440 and 1024 in table mode and at 640
in card mode, with no horizontal overflow, page errors, or third-party
requests.

## Final Review Fix Wave

The final review wave closed all eight remaining findings:

1. `closing` is now an uncertain submission phase and terminalizes as
   `manual_required/submission_uncertain`.
2. Durable opening reservations disable replacement-batch creation.
3. A rejected `batch_ownership_active` command publishes its authoritative
   checkpoint before surfacing the error.
4. Ownership rejection closes the stale wizard, adopts the owned batch and
   file, restores the correct command controls, and focuses an actionable
   error alert outside hidden/inert content.
5. Page-first and background-first removal ordering both converge; the
   page-first recovery clears its transient error and refills exactly once.
6. Removed-tab checkpoint adoption rejects equal-time regressions in
   unrelated tasks, results, and opening reservations.
7. Real-Chrome lifecycle events are bound to durable task identity and actual
   Chrome `tabId`/`windowId`; all eight open/close events belong to the
   console window.
8. Functional-error and submission evidence now covers every legacy page,
   the monitored service-worker identity/version through context close, and
   explicitly scoped local-fixture submissions.

Production RED evidence was captured before each implementation. The focused
GREEN gate passed `265/265` tests. The tightened Chrome acceptance first
failed because the new ownership, service-worker identity, legacy-page, and
submission-scope fields were absent, then passed after the observations were
implemented.

Final verification:

```text
node --check background.js                                      PASS
node --check batch.js                                           PASS
node --check lib/batch-runtime-controller.mjs                   PASS
node --check lib/batch-worker-runtime.mjs                       PASS
node --check lib/batch-page-composition.mjs                     PASS
node --check lib/batch-console-view.mjs                         PASS
node --check scripts/run-multi-assignment-chrome-acceptance.mjs PASS
npm test                                                        PASS 960/960
npm run test:chrome:console                                     PASS
npm run test:chrome:multi-assignment                            PASS
git diff --check                                                PASS
```

The final multi-assignment run observed Chrome `150.0.7871.184` and extension
Chromium `149.0.7827.55`. It opened indices `[0, 1, 2, 3]` exactly once,
closed index `0`, refilled index `3`, held configured/observed concurrency at
`3`, and left `0` worker tabs after stop. Ownership verification passed with
eight identity-bound lifecycle events in the console window. Ten legacy
pages and the whole command reported no page errors. The monitored
service-worker sequence was
`running → stopping → stopped → starting → running`; its exact extension
origin/version identity was verified, its reused Playwright Worker object was
observed through context close, and worker console/errors were empty.
Real-extension recovery submitted `0` comments; the legacy and whole-command
local-fixture counts were both `6`; configured third-party submission
destinations were `0`.

## Safety Review

- All five targets and the promotion site snapshot use the ephemeral
  `127.0.0.1` fixture origin.
- The test uses a generated in-memory CSV payload; it does not read a desktop
  CSV or any user data.
- Automatic generation uses the local fixture model endpoint.
- `autoSubmit` is false, and the scenario checkpoints before any submit
  action.
- The legacy submission count is captured before reset; the real-extension
  ledger remains empty through stop and context close; the reported
  whole-command total is six.
- The real-extension Chromium process is network-restricted and audited from
  launch through context close by the pre-launch local-only proxy.
- The temporary manifest has only the loopback host permission, no optional
  host permissions, and loopback-only content-script/resource matches.
- Bootstrap request origins and functional errors are explicitly unobserved;
  only proxy enforcement covers that interval.
- All non-fixture attempts are labeled unknown-origin and blocked; zero
  third-party egress is forwarded/completed.
- The post-observer service-worker restart through context close reports zero
  monitored third-party HTTP(S) requests and zero functional errors.
- No production extension file, stored user profile, or third-party site is
  mutated.
