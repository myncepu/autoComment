# SDD ledger — plan: docs/superpowers/plans/2026-07-26-batch-operations-console.md

Merge base: f6f927b
Branch start before implementation: e324f1c
Pre-flight review: clean; no plan/global-constraint conflicts found.
Baseline: `npm ci` completed; `npm test` passed 243/243 with 0 failures.
Task 1: complete (commits e324f1c..28b7603, review clean)
Task 2: complete (commits 28b7603..d9678ec, review approved)
Task 2 deferred minor: add focused coverage for decodeBatchCsv/parseBatchCsv BOM, parser failure, empty CSV, and immutability contracts.
Scope addition from user: automated concurrency must use tabs in one browser window, not one Chrome window per worker; diagnose and fix `setStatus is not defined` and `content.js 就绪超时` with regression coverage and real-Chrome verification.
Task 3 review round 1: changes requested — forbid retry in terminal batch states; return orphanTabIds rather than orphanWindowIds; fill deterministic legacy error codes.
Task 3 review round 2: production findings resolved; add explicit duplicate-tab and missing-errorCode regression coverage, and correct report attribution.
Task 3: complete (commits d9678ec..7bf0233, review approved after 2 fix rounds)
Task 4 review round 1: changes requested — reject missing confirmation attempt before every untracked early return.
Task 4: complete (commits 7bf0233..765078e, review approved after 1 fix round)
Task 4 deferred minor: explicitly assert `BATCH_CONFIRMED.attempt` in fallback and final `BATCH_REPORT_RESULT` listener fixtures.
Task 5 review round 1: changes requested — make pending results attempt/errorCode-aware; reject stale/incomplete submit-context saves; remove runtime attempt=1 fallbacks.
Task 5 review round 2: reject incomplete result identities before storage mutation; prevent stale attempts from evicting newer attempts at capacity.
Task 5: complete (commits 765078e..9b43f93, review approved after 2 fix rounds)
Task 6: complete (commits 9b43f93..a1ca588, review clean)
Task 7 review round 1: blocked — repair legacy bootstrap compatibility, finalizer/attempt ownership, supersede/dispose cleanup, sensitive URL redaction, uncertain-close semantics, hard readiness deadline, adapter failure recovery, and durable confirmation validation.
Task 7 review round 2: serialize pending-create persistence/cleanup and lifecycle entry points; close late-success deadline race; expand secret redaction through checkpoint/history.
Task 7 review round 3: fix escaped JSON authorization redaction and ensure every checkpoint success/error boundary returns only sanitized data.
Task 7: complete (commits a1ca588..7c16c79, approved after 3 fix rounds; full suite 347/347)
Task 8 review round 1: compensate persisted-running state when worker side effects fail; validate manual eligibility before opening and close on update race failure.
Task 8 review round 2: expose a local `paused_recovery`/`persistencePending` projection and block resume when the recovery pause itself cannot be persisted.
Task 10–14 strategy update: production app-shell/wizard/console view modules must run as ordinary web modules with no import/render-time `chrome.*`; a fixture-only adapter injects deterministic fake application/controller/checkpoints. Use a local HTTP server and real Chrome ordinary tabs for 1440/1024/640 interaction acceptance. Task 12 composes the same modules into the extension via thin runtime/storage/tabs adapters; no production global test backdoors. Extension-host-only MV3/sender/tabs/storage/alarms/power checks remain thin integration/smoke coverage.
Task 8: complete (commits 7c16c79..23d98c9, approved after 2 fix rounds; full suite 378/378)
Task 9: complete (commits 23d98c9..712dece, review approved)
Task 9 deferred minor for Task 10: add the mobile viewport meta to `options.html`.
Task 10 review round 1: sanitize preflight rows/headers before draft callbacks, normalize inclusion and summary, and preserve modal focus/inert fallback across rerenders.
Task 10 review round 2: sanitize restored preflight URL, reason diagnostics, and sensitive header labels before DOM or callbacks.
Task 10 review round 3: close the raw diagnostic `token=#secret` sanitizer bypass without breaking safe URL fragments or idempotency.
Task 10: complete (commits 712dece..5fda063, approved after 3 fix rounds; full suite 402/402)
Task 11 review round 1: close the real snapshot producer/view contract, nested layer and search-focus failures; stabilize live regions, Escape semantics, and 40px action targets.
Task 11: complete (commits 5fda063..1d112c0, approved after 1 fix round; full suite 425/425)
Task 12 review round 1: add durable production teardown, offline preemption/start gate, stop close-failure safety, reachable legacy export, singleton boot, background-only confirmation sender validation, and restored race integration coverage.
Task 12 review round 2: move page teardown durability to background ownership, retain UI/ownership on failures, ignore ordinary visibility-hidden, prevent CSV formula injection, rebroadcast trusted phase updates, and replace aspirational race-map claims with exact tests.
Task 12 review round 3: accept only real batch-page teardown senders and move automatic tab creation into a serialized background create-and-checkpoint operation so unload cannot orphan pending tabs; add exact running-replacement and deferred-Start teardown tests.
Task 12 review rounds 4–7: make worker creation replay-safe; replace undiscoverable blank tabs with a canonical extension pending page; strictly validate task/reservation ownership identities and legacy migration; reject forged cleanup ownership and untrusted ACTIVE senders; prove live ownership before cleanup.
Task 12 review round 8: introduce Chrome 102+ trusted `storage.session` ownership journals, random non-secret ownership epochs, browser-maintained opener identity, journaled pending creation, and remove-first/clear-last teardown. Browser restart without the session journal fails closed into manual recovery.
Task 12 review rounds 9–11: serialize proof-bound result/history/context hooks; bind every persistence ingress and submit-context mutation to exact checkpoint/sender/journal/live ownership; remove content-side batch result/history fallbacks; add bounded identical-payload retry; unify terminal and recovery proof and bind recovery targets.
Task 12 review round 12: preflight canonical terminal payloads and reducer candidates before hooks, tab removal, journal clearing, or persistence; reject invalid result/error/index/status/internal-marker attempts with zero side effects.
Task 12: complete and independently approved (commits 1d112c0..fc546e4; final review no findings, mergeable YES; focused 133/133, affected 242/242, full suite 522/522).
Integration note: downstream multi-profile work uses canonical `profileId` and will adapt this branch's v2 contracts to v3 after merge. Never persist or transmit passwords in checkpoint, BATCH_HANDLE, or history. Report the mergeable Task 12 commit explicitly.
Coordination gate: multi-profile branch `codex/multi-identity-promotion-batch` is clean at `09e761e`. At the first mergeable Task 12 UI baseline, report commit/modules/integration notes and notify Codex task `019f9a05-b1a2-71b1-bdce-0c6b5bdff8dc` to resume. Do not merge multi-profile scheduling early.
