# Worker Tab Ownership Recovery Acceptance

- Branch: `codex/fix-worker-tab-ownership-layout`
- Automated suite: `npm test` — PASS

  ```text
  # tests 955
  # pass 955
  # fail 0
  # duration_ms 6022.293208
  ```

- Syntax checks: PASS
- Console Chrome acceptance: PASS at 1440 / 1024 / 640
- Extension Chrome acceptance: PASS, observed maximum concurrency 3,
  configured concurrency 3, local targets 5
- Closed target: index 0
- Replacement target: index 3
- Extension-attributed third-party HTTP(S) requests during recovery: 0
- Forwarded third-party network egress during real-extension recovery: 0
- Blocked Chromium background attempts in the recorded verification: 16
  (`www.google.com`; denied by the local proxy)
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

Those 16 browser probes were attempts delivered to and denied by the local
proxy; they did not reach Google. They are not hidden inside the zero:
`thirdPartyRequests: 0` is explicitly scoped to extension-attributed HTTP(S)
requests. The temporary manifest permits only loopback, the context observer
records zero extension third-party requests, and the proxy records zero
forwarded third-party egress. Any denied destination other than the known
Chromium `www.google.com` probe fails the acceptance.

The browser probe count is timing-dependent (16 and 17 in consecutive
verification runs); its separate accounting and sole allowed blocked
destination are invariant.

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
- Context attribution reports zero extension third-party HTTP(S) requests.
- Chromium background probes are separately reported as blocked attempts;
  no third-party network egress is forwarded.
- No production extension file, stored user profile, or third-party site is
  mutated.
