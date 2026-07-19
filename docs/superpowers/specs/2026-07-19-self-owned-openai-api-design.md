# Self-Owned OpenAI-Compatible API Design

**Date:** 2026-07-19

## Goal

Convert the browser extension from the author's points-backed Qwen service into a self-contained extension that calls the user's own OpenAI-compatible API. OpenRouter is the default provider, `qwen/qwen-plus` is the default model, and the model field remains editable so any OpenRouter model ID can be used.

## Current-State Findings

The existing model path is coupled to the author's service in several places:

- `options.html` and `options.js` require an administrator-assigned user ID and query points and purchase status from `jieyunsang.cn`.
- `content.js` checks the author's points balance before posting page content and the generated prompt to the author's `/api/generate-copy` endpoint.
- The author's backend deducts points and calls DashScope with a server-side `DASHSCOPE_API_KEY` and `qwen-plus`.
- Batch failures call the author's refund endpoint, and the batch UI derives validation information from points differences.
- The batch page also uploads run statistics to the author's service.
- `manifest.json` grants access to the author's domains instead of a user-configurable OpenAI-compatible provider.

Changing only the generation URL would leave the user-ID, points, refund, batch, permission, and credential flows broken. The extension-facing path must be replaced end to end.

## Selected Approach

The Manifest V3 background service worker will be the only component allowed to call the model API. Page content scripts send a typed generation message to the service worker. The service worker loads locally stored credentials, constructs an OpenAI-compatible chat-completions request, performs the cross-origin request, validates the response, and returns only the generated text or a safe error.

This approach was selected over direct content-script requests because it keeps credentials out of the page-facing execution path and centralizes permissions and error handling. A self-hosted proxy was rejected because it would preserve an unnecessary backend deployment requirement.

## Components and Responsibilities

### OpenAI-Compatible Client

A focused client module will:

- normalize an API base URL and append `/chat/completions` exactly once;
- build a non-streaming request with `model` and `messages`;
- support arbitrary OpenRouter model IDs without provider-specific branching;
- parse `choices[0].message.content` and reject empty or malformed responses;
- map common HTTP and network failures to stable extension error codes;
- avoid logging API keys, authorization headers, or complete provider responses.

The defaults are:

- API base URL: `https://openrouter.ai/api/v1`
- model: `qwen/qwen-plus`

The defaults are conveniences only. Users can replace the model with any valid OpenRouter model slug or replace the base URL with another OpenAI-compatible service.

### Background Service Worker

`background.js` will handle two extension-internal message types:

- configuration connection test;
- promotion-copy generation.

It will validate the sender, message shape, and input size before calling the client. It will read the API key from local extension storage at request time. The service worker will not expose an externally connectable API.

### Content Script

`content.js` will keep the existing page extraction, prompt construction, form detection, form filling, cooldown, and batch orchestration behavior. The generation function will stop reading a user ID or points balance and will stop calling `jieyunsang.cn`. It will send the system prompt and page-derived user prompt to the background service worker and record cooldown state only after successful generation.

Batch failures will report the model error as a normal failed result. They will not call a points-refund endpoint.

### Options Page

The author account, points balance, purchase status, CSV purchase, and contact-author areas will be removed from the self-use settings experience. A new model configuration section will provide:

- editable API base URL;
- masked API key field;
- editable model ID;
- save action;
- real connection-test action with visible success or failure status.

Website profile and automatic form-fill settings remain unchanged.

### Batch Page

The batch page will remove points balance, expected point cost, user-ID loading, points-difference checks, and author-hosted run-stat uploads. Starting a batch will require a valid saved model configuration rather than an administrator user ID. Existing local CSV parsing, tab sequencing, result collection, and local export behavior remain in scope.

## Configuration Storage and Export

- The API key is stored only in `chrome.storage.local`.
- The API key is never stored in `chrome.storage.sync`.
- Base URL and model ID may be stored in synchronized extension settings.
- Configuration export includes the base URL and model ID but excludes the API key.
- Configuration import never invents or clears an existing local API key. Imported provider settings require a later save/test action if new host permission is needed.
- No secret is committed to Git, printed to logs, included in fixtures, or sent through the chat.

## Host Permissions

OpenRouter is supported by default. The manifest will include the OpenRouter API origin and remove the author-service origins that are no longer used by active extension code.

To preserve support for other OpenAI-compatible endpoints, the settings page may request the configured HTTP or HTTPS origin as an optional host permission in direct response to the user's save or test action. The requested permission is limited to the configured origin rather than silently granting every host.

## Request Flow

1. The content script extracts the current page title, description, URL, and a bounded body-text excerpt.
2. It combines that page context with the existing promotion-site prompt template.
3. It sends a typed generation message to the background service worker.
4. The service worker loads base URL, model ID, and local API key.
5. The client sends a non-streaming OpenAI-compatible request using Bearer authentication.
6. The service worker returns generated text or a stable error object.
7. On success, the content script fills the local page form and records generation cooldown state.
8. On failure, the UI reports the model error and leaves cooldown state unchanged.

The connection-test flow uses the same configuration, permission, client, and response parser as real generation. It makes a small real model request so successful testing proves the configured provider can generate a valid chat-completions response.

## Error Handling

The user-facing layer distinguishes:

- missing or incomplete local configuration;
- host permission denied;
- invalid API key (`401`);
- insufficient provider credits (`402`);
- forbidden or moderated request (`403`);
- request timeout (`408` or local timeout);
- rate limiting (`429`);
- unavailable model/provider (`502` or `503`);
- malformed JSON, missing completion text, and other protocol errors;
- general network failure.

Provider messages may be displayed in bounded, sanitized form when useful, but secrets and raw headers are never included. Billable generation requests are not automatically retried, preventing duplicate costs after ambiguous network failures.

## Testing Strategy

### Automated Tests

Implementation follows red-green-refactor. Deterministic unit tests cover URL normalization, request construction, response parsing, error mapping, configuration sanitization, export secret exclusion, and background message validation. These are logic tests, not a fake claim that a provider is reachable.

The existing repository suite is run after dependency installation to establish the baseline and again after changes. JavaScript syntax checks cover all changed extension scripts.

### Real Chrome Acceptance Test

The unpacked extension from the feature worktree will be loaded into the user's Chrome browser. The user enters the OpenRouter API key directly into the extension settings page; the key is not shared in chat or copied into source files.

Acceptance steps are:

1. save the default OpenRouter base URL and `qwen/qwen-plus`, then pass the real connection test;
2. reload the settings page and verify the masked key remains locally available;
3. use a locally hosted blog fixture to request a real Qwen-Plus comment and verify automatic form filling;
4. submit once to the local fixture to exercise the extension's automatic-submit path without posting spam to a third-party site;
5. verify the batch page starts without a user ID or points balance and can process the local fixture;
6. verify active extension files do not request `jieyunsang.cn` and exported configuration does not contain the API key.

No test comment will be posted to a public third-party blog.

## Git Workflow

- Development occurs in `.worktrees/codex-self-owned-openai-api` on branch `codex/self-owned-openai-api`.
- The clean baseline is established before production-code changes.
- The design, tests, client, settings integration, content-script integration, and batch cleanup use reviewable commits.
- Full automated verification and Chrome acceptance testing are required before merge.
- Before merging, the primary checkout must be clean and `master` must not contain unreviewed conflicting changes.
- The feature branch is merged locally into `master` with a non-fast-forward merge.
- Full verification is repeated on merged `master`.
- After successful merged verification, the worktree and merged local feature branch are removed.
- Remote push or pull-request creation is outside this task unless separately requested.

## Scope Boundaries

The existing backend and payment source files remain in the repository as historical/server code, but the browser extension no longer loads or calls them. Deleting the entire backend, redesigning CSV acquisition, publishing to the Chrome Web Store, and posting test comments to public sites are outside this change.

## Acceptance Criteria

- A user can configure an OpenRouter API key, base URL, and arbitrary OpenRouter model ID.
- The default configuration uses `qwen/qwen-plus` and successfully generates through OpenRouter with a valid funded key.
- Active extension code has no user-ID, points, purchase, deduction, refund, author-statistics, or other author-service dependency.
- API calls originate only from the extension background service worker.
- API keys remain local and are excluded from configuration export and logs.
- Single-page and batch comment flows work against the local browser fixture.
- Automated tests and post-merge verification pass.
