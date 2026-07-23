# Local Comment History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every plugin-confirmed successful comment in browser-local IndexedDB, expose a searchable history page, and require export plus explicit confirmation before deleting records older than 90 days.

**Architecture:** `content.js` captures the actual comment value and parsed anchors immediately before submission. A focused background history service is the only IndexedDB writer and exposes message-based query, retry, export, retention, and deletion operations to extension pages. A new `history.html` page renders paginated results, streams CSV parts, and owns all user confirmations.

**Tech Stack:** Chrome Manifest V3, native IndexedDB, Chrome Storage/Alarms/Notifications APIs, ES modules, Node test runner, `jsdom` for DOM capture tests, `fake-indexeddb` for repository tests.

## Global Constraints

- Only `result === "success"` creates comment history; all other batch outcomes remain outside the history database.
- The persisted body is the actual editor value captured immediately before submission, not the originally generated AI text.
- Record ID is exactly `${batchId}:${urlIndex}` and all writes are idempotent UPSERTs.
- Browser retention is a rolling 90 days; notify at ages 80, 87, and 90 days, then every 7 overdue days.
- No record may be deleted by an alarm or without explicit user confirmation.
- A CSV part contains at most 50,000 comment rows and uses UTF-8 BOM.
- Never persist passwords, email addresses, cookies, authentication data, or full page HTML.
- Stored comment HTML must only be rendered as text.
- Existing user-owned `.DS_Store` changes must remain untouched.

---

## File Structure

### New production files

- `lib/comment-history-capture.js`: classic content-script helper for reading the real editor value, producing plain text, and parsing all anchors.
- `lib/comment-history-record.mjs`: validates and normalizes history payloads, stable IDs, domains, dates, and legacy records.
- `lib/comment-history-db.mjs`: native IndexedDB schema and repository; the only module that knows object-store/index names.
- `lib/comment-history-service.mjs`: successful-write orchestration, `chrome.storage.local` retry items, legacy migration, queries, and confirmed deletion.
- `lib/comment-history-message-listener.mjs`: validates internal extension messages and maps history message types to the service.
- `lib/comment-history-retention.mjs`: pure retention classification/reminder schedule plus Chrome alarm/notification installation.
- `lib/comment-history-csv.mjs`: safe CSV cell encoding, formula-injection protection, row building, and 50,000-row part naming.
- `history.html`: comment history layout.
- `history.js`: history-page controller, paginated queries, filters, CSV chunk export, and delete confirmation.

### Modified production files

- `manifest.json`: load capture helper and add `unlimitedStorage`, `alarms`, and `notifications`.
- `content.js`: capture actual submission payload, persist it across reload, and include it in success confirmations.
- `background.js`: install the history service, history message listener, retention scheduler, and save status on `BATCH_CONFIRMED`.
- `batch.js`: display `saved`, `queued`, and `failed` history-save states and load retention banner state.
- `batch.html`: add history entry link, retention banner, and history-save status column/copy.
- `options.html`: add a “评论历史” entry.
- `options.js`: open `history.html`.
- `index.html`: update local-data, retention, and permission privacy disclosures.
- `package.json`, `package-lock.json`: add `fake-indexeddb` as a development-only dependency.

### New tests

- `tests/comment-history-capture.test.js`
- `tests/comment-history-record.test.mjs`
- `tests/comment-history-db.test.mjs`
- `tests/comment-history-service.test.mjs`
- `tests/comment-history-message-listener.test.mjs`
- `tests/comment-history-retention.test.mjs`
- `tests/comment-history-csv.test.mjs`
- `tests/comment-history-page.test.mjs`

---

### Task 1: Capture and normalize actual submitted comments

**Files:**
- Create: `lib/comment-history-capture.js`
- Create: `lib/comment-history-record.mjs`
- Create: `tests/comment-history-capture.test.js`
- Create: `tests/comment-history-record.test.mjs`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces global `AutoCommentHistoryCapture.captureSubmission({ editor, pageUrl, promotedWebsiteUrl, now })`.
- Produces `buildCommentHistoryRecord(payload, { now })`, `buildLegacyCommentHistoryRecord(entry, batchId)`, `makeCommentHistoryId(batchId, urlIndex)`, and `normalizeDomain(value)`.
- `captureSubmission` returns `{ submittedAt, targetPageUrl, promotedWebsiteUrl, commentHtml, commentText, anchors }`.

- [ ] **Step 1: Install the DOM test adapter**

Run: `npm install --save-dev jsdom@24.1.3`

Expected: `package.json` and `package-lock.json` contain `jsdom` under development dependencies while the project remains compatible with Node 18.

- [ ] **Step 2: Add failing capture tests**

Test textarea HTML, a `contenteditable` editor, multiple anchors, a newline in `href`, relative URLs, invalid URLs, empty anchor text, and plain text:

```js
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://host.test/post' });
const capture = loadCaptureHelper(dom.window);
const { document } = dom.window;
const editor = document.createElement('textarea');
editor.value = 'Hello <a href="/go">First</a> <a href="bad url">Second</a>';
const result = capture.captureSubmission({
  editor,
  pageUrl: 'https://host.test/post',
  promotedWebsiteUrl: 'https://promo.test/',
  now: 1721000000000
});
assert.equal(result.commentHtml, editor.value);
assert.equal(result.commentText, 'Hello First Second');
assert.deepEqual(result.anchors.map(({ anchorText, hrefRaw, hrefResolved }) => ({
  anchorText, hrefRaw, hrefResolved
})), [
  { anchorText: 'First', hrefRaw: '/go', hrefResolved: 'https://host.test/go' },
  { anchorText: 'Second', hrefRaw: 'bad url', hrefResolved: 'https://host.test/bad%20url' }
]);
```

- [ ] **Step 3: Run capture tests and verify failure**

Run: `node --test tests/comment-history-capture.test.js`

Expected: FAIL because `lib/comment-history-capture.js` does not exist.

- [ ] **Step 4: Implement the classic content helper**

Implement a browser-global IIFE. `readEditorHtml` must use `editor._realElement.innerHTML` for wpDiscuz wrappers, `editor.innerHTML` for `contenteditable`, and `editor.value` otherwise. Parse with a detached `<template>`, never attach stored HTML to the page:

```js
(function installCommentHistoryCapture(root) {
  function normalizeSpace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function readEditorHtml(editor) {
    const real = editor && editor._realElement;
    if (real) return real.innerHTML || real.textContent || '';
    if (editor && editor.getAttribute && editor.getAttribute('contenteditable') === 'true') {
      return editor.innerHTML || editor.textContent || '';
    }
    return editor && typeof editor.value === 'string' ? editor.value : '';
  }

  function parseHtml(documentImpl, html, pageUrl) {
    const template = documentImpl.createElement('template');
    template.innerHTML = String(html || '');
    const anchors = Array.from(template.content.querySelectorAll('a')).map((link, position) => {
      const hrefRaw = link.getAttribute('href') || '';
      let hrefResolved = '';
      let hrefDomain = '';
      try {
        const parsed = new URL(hrefRaw, pageUrl);
        hrefResolved = parsed.href;
        hrefDomain = parsed.hostname.toLowerCase();
      } catch (_) {}
      return {
        position,
        anchorText: normalizeSpace(link.textContent),
        hrefRaw,
        hrefResolved,
        hrefDomain
      };
    });
    return {
      commentText: normalizeSpace(template.content.textContent),
      anchors
    };
  }

  function captureSubmission({ editor, pageUrl, promotedWebsiteUrl, now = Date.now() }) {
    const commentHtml = readEditorHtml(editor);
    const parsed = parseHtml(root.document, commentHtml, pageUrl);
    return {
      submittedAt: now,
      targetPageUrl: String(pageUrl || ''),
      promotedWebsiteUrl: String(promotedWebsiteUrl || ''),
      commentHtml,
      commentText: parsed.commentText,
      anchors: parsed.anchors
    };
  }

  root.AutoCommentHistoryCapture = { captureSubmission, readEditorHtml };
})(globalThis);
```

- [ ] **Step 5: Add failing record-normalization tests**

Cover stable IDs, domain normalization, browser-local `archiveMonth`, anchor IDs, invalid required fields, and legacy success/non-success conversion:

```js
assert.equal(makeCommentHistoryId('batch-a', 7), 'batch-a:7');
const record = buildCommentHistoryRecord({
  batchId: 'batch-a',
  urlIndex: 7,
  history: captured
}, { now: 1721000000100 });
assert.equal(record.comment.id, 'batch-a:7');
assert.equal(record.comment.targetDomain, 'host.test');
assert.equal(record.anchors[0].id, 'batch-a:7:0');
assert.equal(buildLegacyCommentHistoryRecord({ result: 'fail' }, 'batch-a'), null);
```

- [ ] **Step 6: Run record tests and verify failure**

Run: `node --test tests/comment-history-record.test.mjs`

Expected: FAIL because `lib/comment-history-record.mjs` does not exist.

- [ ] **Step 7: Implement record normalization and manifest loading**

Implement strict required-field checks for `batchId`, integer `urlIndex`, non-empty `targetPageUrl`, numeric `submittedAt`, and string `commentHtml`. Normalize domains with `new URL`, derive local `YYYY-MM`, and add anchor IDs. Add `lib/comment-history-capture.js` immediately before `content.js` in `manifest.json`.

- [ ] **Step 8: Run focused tests**

Run: `node --test tests/comment-history-capture.test.js tests/comment-history-record.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add manifest.json package.json package-lock.json lib/comment-history-capture.js lib/comment-history-record.mjs tests/comment-history-capture.test.js tests/comment-history-record.test.mjs
git commit -m "feat: capture submitted comment history"
```

---

### Task 2: IndexedDB repository and atomic anchor storage

**Files:**
- Create: `lib/comment-history-db.mjs`
- Create: `tests/comment-history-db.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes normalized `{ comment, anchors }` from Task 1.
- Produces `openCommentHistoryDb(options)` returning:
  - `upsertRecord(bundle): Promise<void>`
  - `getRecord(id): Promise<{ comment, anchors } | null>`
  - `queryRecords(filter): Promise<{ records, nextCursor }>`
  - `countRecords(filter): Promise<number>`
  - `getRetentionSummary(now): Promise<object>`
  - `getExportChunk(filter): Promise<{ records, nextCursor }>`
  - `deleteConfirmed(criteria, archiveEvent): Promise<number>`
  - `listArchiveEvents(): Promise<object[]>`
  - `getMeta(key)` / `setMeta(key, value)`

- [ ] **Step 1: Install the IndexedDB test adapter**

Run: `npm install --save-dev fake-indexeddb`

Expected: `package.json` and `package-lock.json` contain `fake-indexeddb` under development dependencies.

- [ ] **Step 2: Write failing schema and atomicity tests**

Use a unique database name per test and `IDBFactory` from `fake-indexeddb`. Verify all required stores/indexes, UPSERT replacement of anchors, pagination in descending time order, target/promoted-domain filters, anchor-text-prefix and anchor-domain filters, retention counts, criteria-based confirmed deletion, and rollback when an anchor write is invalid:

```js
const repo = await openCommentHistoryDb({ indexedDBImpl, dbName });
await repo.upsertRecord(bundle);
await repo.upsertRecord({ ...bundle, anchors: [replacementAnchor] });
const saved = await repo.getRecord(bundle.comment.id);
assert.deepEqual(saved.anchors, [replacementAnchor]);
const page = await repo.queryRecords({ limit: 50 });
assert.equal(page.records[0].id, bundle.comment.id);
```

- [ ] **Step 3: Run repository tests and verify failure**

Run: `node --test tests/comment-history-db.test.mjs`

Expected: FAIL because `openCommentHistoryDb` is not defined.

- [ ] **Step 4: Implement version 1 schema**

Create stores and indexes exactly as the design:

```js
const stores = {
  comments: 'comment_records',
  anchors: 'comment_anchors',
  archives: 'archive_events',
  meta: 'history_meta'
};

comments.createIndex('by_submitted_at', 'submittedAt');
comments.createIndex('by_archive_month', 'archiveMonth');
comments.createIndex('by_target_domain', 'targetDomain');
comments.createIndex('by_promoted_domain', 'promotedDomain');
comments.createIndex('by_batch_task', ['batchId', 'urlIndex'], { unique: true });
anchors.createIndex('by_comment_id', 'commentId');
anchors.createIndex('by_anchor_text', 'anchorTextNormalized');
anchors.createIndex('by_href_domain', 'hrefDomain');
```

Wrap `IDBRequest` and transaction completion in small Promises. `upsertRecord` must delete prior anchors through `by_comment_id` and write the main record plus all replacement anchors in one transaction. Query cursors must never call `getAll()` without a bounded count.

- [ ] **Step 5: Implement query, retention, export, and confirmed-delete methods**

Choose the most selective supported index:

- `anchorTextPrefix` → anchor store `by_anchor_text` with `IDBKeyRange.bound(prefix, prefix + "\uffff")`, then join unique `commentId` values to comments
- `hrefDomain` → anchor store `by_href_domain`, then join unique `commentId` values to comments
- `targetDomain` → `by_target_domain`
- `promotedDomain` → `by_promoted_domain`
- otherwise `by_submitted_at`

Apply date bounds and `updatedAt <= exportedBefore` snapshots while iterating, return at most `limit`, and encode a normal cursor as `{ submittedAt, id }` or an anchor cursor as `{ anchorKey, anchorPrimaryKey }`. For confirmed deletion, open one transaction over comments, anchors, and archives; delete every record matching the exact export criteria, delete anchors by `commentId`, and add the archive event before committing.

- [ ] **Step 6: Run repository tests**

Run: `node --test tests/comment-history-db.test.mjs`

Expected: PASS with no open-handle warnings.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/comment-history-db.mjs tests/comment-history-db.test.mjs
git commit -m "feat: add comment history indexeddb repository"
```

---

### Task 3: Background service, retry queue, legacy migration, and messages

**Files:**
- Create: `lib/comment-history-service.mjs`
- Create: `lib/comment-history-message-listener.mjs`
- Create: `tests/comment-history-service.test.mjs`
- Create: `tests/comment-history-message-listener.test.mjs`
- Modify: `background.js`

**Interfaces:**
- Consumes the Task 1 record builder and Task 2 repository.
- Produces `createCommentHistoryService({ repository, storageLocal, now })`.
- Produces `installCommentHistoryMessageListener(chromeApi, service)`.
- History messages:
  - `HISTORY_SUMMARY`
  - `HISTORY_LIST`
  - `HISTORY_ANCHORS`
  - `HISTORY_EXPORT_START`
  - `HISTORY_EXPORT_CHUNK`
  - `HISTORY_EXPORT_FINISH`
  - `HISTORY_RETENTION_STATUS`
  - `HISTORY_DELETE_CONFIRMED`
  - `HISTORY_ARCHIVE_EVENTS`
  - `HISTORY_RETRY_PENDING`

- [ ] **Step 1: Write failing service tests**

Verify:

- success stores exactly one bundle;
- non-success skips history;
- repository failure writes key `historyPending:batch-a:7`;
- queued retry removes its key only after repository success;
- both failures return `failed`;
- legacy migration reads both old result shapes, migrates only success, and writes `legacyMigrationV1`;
- migration restart is idempotent.

```js
const result = await service.saveConfirmedSuccess(message);
assert.deepEqual(result, { historySaveStatus: 'saved' });
repository.upsertRecord = async () => { throw new Error('db down'); };
const queued = await service.saveConfirmedSuccess(message);
assert.equal(queued.historySaveStatus, 'queued');
assert.ok(storageData['historyPending:batch-a:7']);
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `node --test tests/comment-history-service.test.mjs`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement service orchestration**

`saveConfirmedSuccess(message)` returns `not_applicable` unless the effective result is `success`. On success, normalize the message and call `repository.upsertRecord`. On failure, persist one independent retry key:

```js
const pendingKey = `historyPending:${bundle.comment.id}`;
await storageLocal.set({ [pendingKey]: message });
return { historySaveStatus: 'queued' };
```

`retryPendingWrites()` obtains storage keys, filters by `historyPending:`, retries sequentially, and removes only successful keys. `migrateLegacyResults()` reads both legacy result containers and derives the wrapper `batchId` for `batchLocalResults`.

- [ ] **Step 4: Write failing listener tests**

Verify only internal extension senders are allowed, unknown types return `false`, list/filter payloads are normalized, and delete rejects missing `confirmed: true`:

```js
const response = await dispatch({
  type: 'HISTORY_DELETE_CONFIRMED',
  confirmed: false,
  exportSessionId: 'export-session-a'
});
assert.equal(response.ok, false);
assert.equal(response.error.code, 'CONFIRMATION_REQUIRED');
```

- [ ] **Step 5: Implement the message listener**

Route the exact message types above to service methods. Reject external senders by comparing `sender.id` with `chrome.runtime.id`. Return structured `{ ok: true, data }` or `{ ok: false, error: { code, message } }`; never expose raw stack traces to pages.

- [ ] **Step 6: Integrate the service in `background.js`**

Open the repository once through a lazy Promise, install the listener, run legacy migration and retry on startup, and call `saveConfirmedSuccess` inside the existing `BATCH_HANDLE_CONFIRM` path before emitting `BATCH_CONFIRMED`. Include `historySaveStatus` in both the runtime event and `sendResponse`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/comment-history-service.test.mjs tests/comment-history-message-listener.test.mjs tests/llm-message-listener.test.mjs tests/action-click-handler.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add background.js lib/comment-history-service.mjs lib/comment-history-message-listener.mjs tests/comment-history-service.test.mjs tests/comment-history-message-listener.test.mjs
git commit -m "feat: persist confirmed comments in background"
```

---

### Task 4: Carry actual submission data across click, refresh, and confirmation

**Files:**
- Modify: `content.js`
- Modify: `batch.js`
- Modify: `batch.html`
- Create: `tests/comment-history-submit-flow.test.js`
- Modify: `tests/batch-submit-order.test.js`

**Interfaces:**
- Consumes global `AutoCommentHistoryCapture.captureSubmission`.
- Produces `message.history` on successful `BATCH_HANDLE_CONFIRM`.
- Produces `historySaveStatus` handling in `handleTabConfirmed`.

- [ ] **Step 1: Add failing static and fixture tests**

Assert that capture occurs after the final form-fill validation but before `persistBatchSubmitContext` and before the synthetic click. Assert that the same `history` payload appears in persisted submit context, restored confirmation, direct confirmation, and automatic-panel confirmation:

```js
const captureIndex = flow.indexOf('captureCurrentCommentHistory');
const contextIndex = flow.indexOf('persistBatchSubmitContext');
const clickIndex = flow.indexOf('clickCommentSubmitButton');
assert.ok(captureIndex < contextIndex);
assert.ok(contextIndex < clickIndex);
assert.match(content, /history:\s*ctx\.history/);
```

- [ ] **Step 2: Run submit-flow tests and verify failure**

Run:

```bash
node --test tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js
```

Expected: FAIL because the history payload is not captured or forwarded.

- [ ] **Step 3: Implement one capture function in `content.js`**

Add:

```js
async function captureCurrentCommentHistory(editor, pageUrl) {
  const promotedWebsiteUrl = await getWebsiteUrl();
  return globalThis.AutoCommentHistoryCapture.captureSubmission({
    editor,
    pageUrl: pageUrl || location.href,
    promotedWebsiteUrl,
    now: Date.now()
  });
}
```

Immediately before the existing pending result/context writes, reacquire the real editor, capture it, and pass `history` through `persistBatchSubmitContext`. Extend every success call to `reportSuccessToBatch` with a pre-click payload; never recapture after a form may have been cleared.

- [ ] **Step 4: Forward capture through every success recovery path**

Add `history` to:

- `batchSubmitCtx`;
- `confirmRestoredBatchSubmit`;
- normal `BATCH_HANDLE_CONFIRM`;
- `reportSuccessToBatch`.

Non-success paths omit it. Old persisted contexts without `history` keep their existing batch behavior but return `historySaveStatus = "not_applicable"` rather than fabricating actual content.

- [ ] **Step 5: Render save state in batch results**

Extend `handleTabConfirmed(urlIndex, result, aiContent, errorMessage, historySaveStatus)` and result entries with `historySaveStatus`. Show:

- `saved` → “历史已保存”
- `queued` → “历史待重试”
- `failed` → “历史保存失败”
- absent/non-success → “—”

Add a warning banner when at least one result is queued or failed.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js tests/fixture-server.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add content.js batch.js batch.html tests/comment-history-submit-flow.test.js tests/batch-submit-order.test.js
git commit -m "feat: carry actual comment data through submission"
```

---

### Task 5: Retention alarms, reminders, and explicit deletion

**Files:**
- Create: `lib/comment-history-retention.mjs`
- Create: `tests/comment-history-retention.test.mjs`
- Modify: `background.js`
- Modify: `manifest.json`

**Interfaces:**
- Consumes repository retention summary and service deletion.
- Produces `classifyRetentionAge(submittedAt, now)`.
- Produces `shouldNotifyRetention({ oldestSubmittedAt, lastReminderAt, now })`.
- Produces `installCommentHistoryRetention(chromeApi, service)`.

- [ ] **Step 1: Write failing boundary tests**

Freeze `now` and cover 79, 80, 86, 87, 89, 90, 96, and 97 days. Verify no deletion method is called from the alarm:

```js
assert.equal(classifyRetentionAge(daysAgo(79), now), 'active');
assert.equal(classifyRetentionAge(daysAgo(80), now), 'due_soon');
assert.equal(classifyRetentionAge(daysAgo(90), now), 'expired_pending_confirmation');
```

- [ ] **Step 2: Run retention tests and verify failure**

Run: `node --test tests/comment-history-retention.test.mjs`

Expected: FAIL because the retention module does not exist.

- [ ] **Step 3: Implement pure scheduling**

Use exact 24-hour milliseconds for rolling age. Notify at day 80, day 87, day 90, and when at least 7 days have elapsed since the most recent overdue notification. Store reminder timestamps in `history_meta`; notification body includes count and oldest date.

- [ ] **Step 4: Install Chrome alarms and notifications**

Add manifest permissions:

```json
"permissions": [
  "activeTab",
  "storage",
  "unlimitedStorage",
  "alarms",
  "notifications"
]
```

Create one alarm named `comment-history-retention-check` with `periodInMinutes: 1440`. Run the same check at service startup. Clicking the notification opens `history.html?filter=expired`. The alarm handler may query and notify only; it must not call deletion.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/comment-history-retention.test.mjs tests/comment-history-service.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add manifest.json background.js lib/comment-history-retention.mjs tests/comment-history-retention.test.mjs
git commit -m "feat: remind before comment history cleanup"
```

---

### Task 6: Paginated comment history page

**Files:**
- Create: `history.html`
- Create: `history.js`
- Create: `tests/comment-history-page.test.mjs`
- Modify: `options.html`
- Modify: `options.js`
- Modify: `batch.html`
- Modify: `batch.js`

**Interfaces:**
- Consumes Task 3 history messages.
- Produces a history page with summary, filters, 50/100-row pagination, anchors, retention banner, and archive-event table.

- [ ] **Step 1: Write failing controller tests**

Test query construction, date-to-epoch conversion, escaped text rendering, next-page cursor handling, notification query string handling, and confirmed-delete request shape:

```js
assert.deepEqual(buildHistoryFilter({
  dateFrom: '2026-07-01',
  dateTo: '2026-07-31',
  targetDomain: 'EXAMPLE.COM'
}), {
  from: localDayStart('2026-07-01'),
  to: localDayEnd('2026-07-31'),
  targetDomain: 'example.com',
  limit: 50
});
```

- [ ] **Step 2: Run page tests and verify failure**

Run: `node --test tests/comment-history-page.test.mjs`

Expected: FAIL because the page controller helpers do not exist.

- [ ] **Step 3: Build the history layout**

Add:

- summary cards for total, last 24 hours, due soon, expired, and estimated storage;
- persistent due-soon/expired banner;
- date, target-domain, promoted-domain, anchor-text, and anchor-domain filters;
- 50/100 page-size selector;
- results table whose comment and link cells are populated with `textContent`;
- previous/next controls;
- archive-event table;
- export and confirmed-delete controls.

Keep CSS inside `history.html` to match current extension pages and avoid adding a global style system.

- [ ] **Step 4: Implement message-driven pagination**

Export pure helpers for Node tests, guard DOM boot with `if (typeof document !== 'undefined')`, and send `HISTORY_LIST` with one cursor at a time. Fetch anchors only when a user expands a row so the initial page does not read all child records.

- [ ] **Step 5: Add navigation entry points and batch banner**

Add “评论历史” buttons to `options.html` and `batch.html`; open `history.html` with `chrome.tabs.create`. On batch-page load request `HISTORY_RETENTION_STATUS`; render a persistent link if records are due soon or expired.

- [ ] **Step 6: Run page and existing option tests**

Run:

```bash
node --test tests/comment-history-page.test.mjs tests/llm-options-controller.test.mjs tests/privacy-policy.test.js
```

Expected: page/controller tests PASS; privacy tests remain unchanged at this task.

- [ ] **Step 7: Commit**

```bash
git add history.html history.js options.html options.js batch.html batch.js tests/comment-history-page.test.mjs
git commit -m "feat: add local comment history page"
```

---

### Task 7: Chunked CSV export and confirmed cleanup UX

**Files:**
- Create: `lib/comment-history-csv.mjs`
- Create: `tests/comment-history-csv.test.mjs`
- Modify: `lib/comment-history-message-listener.mjs`
- Modify: `lib/comment-history-service.mjs`
- Modify: `history.js`
- Modify: `history.html`

**Interfaces:**
- Consumes `HISTORY_EXPORT_CHUNK` pages of at most 500 database records.
- Produces `escapeCsvCell(value)`, `buildCommentCsvRow(record, anchors)`, and `buildCsvPartName(range, part)`.
- One file contains at most 50,000 rows.

- [ ] **Step 1: Write failing CSV tests**

Cover UTF-8 BOM, commas, quotes, CR/LF, Chinese, anchor JSON arrays, formula prefixes `=`, `+`, `-`, `@`, stable column order, part numbering, and the 50,000-row boundary:

```js
assert.equal(escapeCsvCell('=cmd()'), "'=cmd()");
assert.equal(escapeCsvCell('a,\"b\"'), '"a,""b"""');
assert.equal(buildCsvPartName({
  from: Date.UTC(2026, 6, 1),
  to: Date.UTC(2026, 6, 31),
  part: 2
}), 'comment-history-20260701-20260731-part-002.csv');
```

- [ ] **Step 2: Run CSV tests and verify failure**

Run: `node --test tests/comment-history-csv.test.mjs`

Expected: FAIL because the CSV module does not exist.

- [ ] **Step 3: Implement safe CSV helpers**

Define one fixed header. JSON-stringify anchor texts, raw hrefs, and resolved hrefs in separate cells. Prefix dangerous spreadsheet values with `'` before standard CSV quoting. Format submission timestamps as local ISO-like strings with timezone offset.

- [ ] **Step 4: Implement chunk export**

`history.js` repeatedly requests 500 rows, writes rows into the current part, triggers a Blob download at 50,000 rows, releases that Blob URL, and continues with the next part. Show processed count and part count. Never retain prior completed parts in memory.

At export start, request `HISTORY_EXPORT_START`. The service stores a compact export descriptor in
`history_meta` containing a random `exportSessionId`, normalized filters, `exportedBefore`,
expected record count, and start time. Every chunk request carries only that session ID and cursor.

After the last part, send `HISTORY_EXPORT_FINISH` with the session ID and filenames, then reveal
“我已完成归档，确认删除”. The delete button sends:

```js
{
  type: 'HISTORY_DELETE_CONFIRMED',
  confirmed: true,
  exportSessionId
}
```

- [ ] **Step 5: Enforce server-side deletion guards**

The service loads the finalized export descriptor and independently verifies:

- `confirmed === true`;
- every matching record is at least 90 days old;
- every matching record has `updatedAt <= exportedBefore`;
- the current matching count equals the exported count;
- the session has filenames and has not already been consumed.

If the set changed, reject with `EXPORT_SET_CHANGED` and require a new export. Otherwise call
`repository.deleteConfirmed(descriptor.criteria, archiveEvent)` and mark the session consumed in
the same completion path. Add service tests for missing confirmation, a non-expired criterion,
changed count, reused session, and successful deletion.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/comment-history-csv.test.mjs tests/comment-history-service.test.mjs tests/comment-history-page.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/comment-history-csv.mjs lib/comment-history-service.mjs lib/comment-history-message-listener.mjs history.js history.html tests/comment-history-csv.test.mjs tests/comment-history-service.test.mjs tests/comment-history-page.test.mjs
git commit -m "feat: export and confirm comment history cleanup"
```

---

### Task 8: Privacy disclosure, full regression, and scale verification

**Files:**
- Modify: `index.html`
- Modify: `tests/privacy-policy.test.js`
- Create: `scripts/benchmark-comment-history.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes all prior tasks.
- Produces updated bilingual privacy disclosures and a reproducible 360,000-row benchmark command.

- [ ] **Step 1: Add failing privacy tests**

Require English and Chinese disclosures for:

- local comment-history fields;
- 90-day rolling retention;
- export plus explicit deletion confirmation;
- uninstall deleting IndexedDB;
- `unlimitedStorage`, `alarms`, and `notifications`.

- [ ] **Step 2: Run privacy tests and verify failure**

Run: `node --test tests/privacy-policy.test.js`

Expected: FAIL until both language sections are updated.

- [ ] **Step 3: Update the privacy policy**

Change the displayed update date to `2026-07-23`. State that successful-comment history remains on device, is not sent to the backend, becomes eligible for cleanup after 90 days, is never deleted by the reminder alarm, and is removed when the user confirms or uninstalls the extension.

- [ ] **Step 4: Add a scale benchmark**

Create a script that uses `fake-indexeddb`, inserts 360,000 compact generated records in batches, then reports:

- total insert time;
- cold and warm first-page query time;
- target-domain filter time;
- promoted-domain filter time;
- 500-row export-cursor time;
- 50,000-row delete preparation time.

Add:

```json
"history:benchmark": "node scripts/benchmark-comment-history.mjs"
```

The script exits non-zero when the median of five indexed first-page/filter queries exceeds 2,000 ms, and prints Node version, OS, CPU model, and memory.

- [ ] **Step 5: Run the complete test suite**

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 6: Run manifest and diff checks**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
git diff --check
```

Expected: `manifest ok` and no diff errors.

- [ ] **Step 7: Run the scale benchmark**

Run: `npm run history:benchmark`

Expected: the script prints 360,000 inserted records and exits 0 with indexed query median at or below 2,000 ms on the recorded environment. If the environment cannot allocate the dataset, record the resource failure and run an additional Chrome fixture benchmark before claiming the performance acceptance criterion.

- [ ] **Step 8: Manual extension verification**

Load the unpacked extension and verify:

1. One normal batch success creates one history row with exact submitted HTML and anchors.
2. Reload during submission recovers one row without duplication.
3. A failed and a skipped task create no history row.
4. History filters and lazy anchor expansion work.
5. A forced repository failure displays queued/failed state and later retries.
6. A synthetic 80-day record produces a reminder.
7. A 90-day record remains after alarm execution.
8. CSV opens correctly in Excel.
9. Canceling delete leaves all records.
10. Confirming delete removes only exported expired records and creates one archive summary.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/privacy-policy.test.js scripts/benchmark-comment-history.mjs package.json
git commit -m "test: verify local comment history feature"
```

---

## Plan Self-Review

- Spec coverage: storage, actual-content capture, anchors, idempotency, retry, migration, history UI, 90-day reminders, explicit deletion, CSV splitting, privacy, and 360,000-row verification each map to a task.
- Scope: all tasks form one end-to-end local-history feature and do not introduce cloud synchronization or unrelated refactors.
- Type consistency: `history` is the content payload; normalized storage is `{ comment, anchors }`; message responses are `{ ok, data }`; save status is `saved | queued | failed | not_applicable`.
- Safety: the alarm never deletes; service deletion independently verifies confirmation and age; saved HTML is rendered as text; CSV cells are formula-safe.
