# Extension package and acceptance-source audit

Date: 2026-07-28

## Package boundary

`npm run build:extension` is the single source for the production unpacked
extension. The audited top-level whitelist contains only the manifest,
background/content/page code, local libraries, icons, and styles required by
the extension. The builder excludes every hidden path segment, `.env` file,
source map, `.key`/`.pem` file, `node_modules`, and repository metadata.

Both real-extension Chrome runners now call that same builder into a temporary
directory and then narrow only the temporary manifest's loopback permissions
and matches. They no longer maintain broader, runner-specific copy lists. The
multi-assignment ordinary-page phase also reads its production content-script
order from `manifest.json`, so a manifest order change cannot silently leave
that phase on a stale script list.

The package contract test independently freezes the expected top-level set,
verifies every manifest-declared local resource exists in the built tree,
injects nested sensitive-artifact fixtures and proves they are absent, and
guards both acceptance runners against reintroducing local copy lists.

## Permission and early-injection decision

`activeTab` was removed because production code does not use it. The `tabs`
permission remains necessary for worker-tab identity, ownership, lifecycle,
and messaging.

The static content script deliberately retains `<all_urls>` with
`run_at: document_start`. Its minimal bootstrap must answer the background
worker while a newly opened batch tab is still loading; delaying registration
would weaken that readiness and ownership handshake. This is a broad page
access/privacy surface, so it remains an explicit manifest and privacy-policy
disclosure rather than being disguised as `activeTab`.

## Evidence labels

- `test:chrome:content-start` loads the production package and proves the
  static content-script handshake while the target tab is still loading.
- `test:chrome:multi-assignment` remains the real-extension MV3 lifecycle
  proof. It loads the production package and observes worker-tab refill plus
  the service-worker sequence
  `running → stopping → stopped → starting → running`.
- `test:chrome:auto-submit-30` is an ordinary-page production-content-flow
  load acceptance with a test Chrome/runtime adapter. It proves 30 local form
  flows, but it does not load the manifest or MV3 service worker and is not
  labelled MV3 extension E2E.

The real-extension recovery phase intentionally reports zero submitted
comments; the multi-assignment command's six local submissions belong to its
separately labelled ordinary-page fixture phase.

## Verification

The packaging change passed:

- focused package/CSP/bootstrap/dispatch unit tests: 18/18;
- production extension build;
- content-start Chrome acceptance: Chromium `149.0.7827.55`, tab status
  `loading`, handshake in 110 ms, no page errors;
- multi-assignment Chrome acceptance: installed Chrome `150.0.7871.187` and
  extension Chromium `149.0.7827.55`, configured/observed concurrency 3,
  worker refill verified, service-worker restart verified, no page errors,
  no completed third-party egress, and zero real-extension submissions.
