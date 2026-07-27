# Unified configuration bundle Chrome acceptance

Date: 2026-07-27

Chrome: `150.0.7871.184`

Host: macOS, installed Google Chrome, headless ordinary browser tab

Fixture: dynamic `http://127.0.0.1:<port>/options-config-bundle/`

## Scope and safety

The acceptance runner opens an ordinary localhost page and imports
`examples/autocomment-local-dry-run-config.json` through the browser file
chooser. The page uses the production configuration bundle parser, controller,
and view with fixture-only in-memory repositories.

The preset keeps automatic submission disabled. The fixture has no comment
submission surface, never opens a target website, loads no remote resources,
and asserts that every browser request remains on its own dynamic localhost
origin.

## TDD evidence

The server route test was added before the fixture route existed:

```text
node --test tests/fixture-server.test.js
tests 13
pass 12
fail 1
AssertionError: /options-config-bundle/
404 !== 200
```

After adding the exact fixture and production-module routes:

```text
node --test tests/fixture-server.test.js
tests 13
pass 13
fail 0
```

## Chrome command and result

Command:

```bash
npm run test:chrome:config-bundle
```

The runner reported Chrome `150.0.7871.184` and emitted:

```json
{
  "ok": true,
  "profiles": 3,
  "promotionSites": 3,
  "pairs": 3,
  "autoGenerate": true,
  "autoSubmit": false,
  "concurrency": 3,
  "timeoutSeconds": 120,
  "repeatImport": "updates_without_duplicates",
  "rollback": "content_restored",
  "pageErrors": [],
  "thirdPartyRequests": 0
}
```

This covers preview counts and the no-write-before-apply boundary, explicit
apply, safe batch defaults, a second import that updates the same stable IDs
without duplicates, deterministic export, and a simulated settings-save
failure whose domain write is rolled back.

## Full verification

| Command | Result |
| --- | --- |
| `npm test` | PASS — 918/918 |
| `npm run test:sync-worker` | PASS — 99/99 across 7 files |
| `npm run typecheck:sync-worker` | PASS |
| `npm --prefix cloudflare-sync run deploy:dry` | PASS — Wrangler 4.114.0 dry run |
| `npm run test:chrome:config-bundle` | PASS — result JSON above |
| `npm run test:chrome:console` | PASS — 1440/1024 table and 640 card layouts, no page errors or third-party requests |
| `node --check` for every tracked `.js` and `.mjs` file | PASS |
| `git diff --check` | PASS |

## Extension-host limitation

This ordinary-page acceptance intentionally does not require
`chrome://extensions` and cannot prove extension-host-only behavior such as
Manifest V3 service-worker lifecycle, sender identity, or real
`chrome.storage` wiring. The user must reload the unpacked extension and
manually open their local `chrome-extension://…/options.html` settings page for
the final extension-host smoke test.
