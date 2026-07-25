# AutoComment Cloud Sync Worker

This Worker provides the opt-in AutoComment synchronization API. It stores comment history,
allowlisted non-sensitive settings, deletion tombstones, cursors, and idempotency records in
Cloudflare D1. The extension remains local-first: saving a successful comment does not wait for this
service. This project does not use R2.

## Requirements

- Node.js 22 LTS, or Node.js 24 or newer (supported range: `^22.0.0 || >=24.0.0`)
- The root and `cloudflare-sync` dependencies installed with `npm ci`
- Wrangler 4 authenticated to the intended Cloudflare account for remote operations
- A D1 database bound as `DB`
- A stable, private `BOOTSTRAP_CURSOR_SIGNING_KEY` Worker secret
- The exact ID of the unpacked or published Chrome extension

Never commit or print a sync key, the cursor-signing secret, an AI API key, a form password, or
Cloudflare credentials.

## Local development and verification

From the repository root:

```sh
npm ci
npm --prefix cloudflare-sync ci
npm run verify:cloud-sync
```

The combined verification runs the extension tests, Worker runtime/D1 tests, TypeScript checking,
and a dry-run deployment build. Individual commands are:

```sh
npm test
npm run test:sync-worker
npm run typecheck:sync-worker
npm --prefix cloudflare-sync run deploy:dry
```

Apply D1 migrations to Wrangler's local database before manual local API testing:

```sh
npm --prefix cloudflare-sync exec wrangler -- d1 migrations list auto-comment-sync --local
npm --prefix cloudflare-sync exec wrangler -- d1 migrations apply auto-comment-sync --local
npm --prefix cloudflare-sync run dev
```

The automated Worker tests apply the migration in an isolated Workers runtime and do not need the
persistent local Wrangler database.

## Production configuration and deployment

The repository currently targets:

- Worker: `auto-comment-sync`
- Worker URL: `https://auto-comment-sync.yan2010.workers.dev`
- D1 database: `auto-comment-sync`
- D1 database ID: `b182a08b-84ba-49ef-9129-a0354bc7c770`

Before deploying, load the extension from this repository through `chrome://extensions`, copy each
32-letter Chrome extension ID that must sync, and validate that every ID contains only letters `a`
through `p`. Set `ALLOWED_EXTENSION_ORIGINS` in `wrangler.jsonc` to the corresponding exact
`chrome-extension://<validated-extension-id>` origins, separated by commas when more than one
profile has a different unpacked-extension ID. Do not use a wildcard, deploy an example or
placeholder value, or add a generated `key` to `manifest.json`.

Regenerate binding types whenever `wrangler.jsonc` changes:

```sh
npm --prefix cloudflare-sync run types
npm run typecheck:sync-worker
```

For a first deployment, set the bootstrap-cursor signing secret through Wrangler's interactive
prompt. Use a long random value and keep it stable; changing it invalidates in-progress bootstrap
cursors.

```sh
npm --prefix cloudflare-sync exec wrangler -- secret put BOOTSTRAP_CURSOR_SIGNING_KEY
```

Do not pass the secret on the command line or store it in `wrangler.jsonc`. Then verify and deploy:

```sh
npm run verify:cloud-sync
npm --prefix cloudflare-sync exec wrangler -- whoami
npm --prefix cloudflare-sync exec wrangler -- d1 migrations list auto-comment-sync --remote
npm --prefix cloudflare-sync exec wrangler -- d1 migrations apply auto-comment-sync --remote
npm --prefix cloudflare-sync exec wrangler -- deploy
```

Applying a migration and deploying are separate operations. Apply only reviewed, forward-compatible
migrations, and do not delete or recreate the production D1 database during routine deployment.

## Post-deployment checks

Check that the API is live without disclosing a real sync key. An unauthenticated status request
should return a stable JSON authentication error rather than application data:

```sh
curl -i https://auto-comment-sync.yan2010.workers.dev/v1/status
```

Verify CORS with the exact installed extension origin:

```sh
curl -i -X OPTIONS \
  -H 'Origin: chrome-extension://<validated-extension-id>' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://auto-comment-sync.yan2010.workers.dev/v1/status
```

The response must echo the allowed origin. Repeat with a different origin; that response must not
contain `Access-Control-Allow-Origin`:

```sh
curl -i -X OPTIONS \
  -H 'Origin: https://not-allowed.example' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://auto-comment-sync.yan2010.workers.dev/v1/status
```

Retain the successful deployment version ID, request IDs from the smoke checks, and timestamps in
the private deployment handoff. Do not commit credentials or live sync keys as evidence.

## Two-profile end-to-end smoke test

Use two isolated Chrome profiles with the same unpacked extension build:

1. In profile A, set unique local-only password and AI API key sentinel values. Create a cloud vault,
   save its sync key privately, and upload at least one existing successful-comment record.
2. In profile B, set different password and AI API key sentinels, import A's sync key, and verify the
   recent record and allowlisted settings arrive. Confirm neither profile's password or AI API key
   changed.
3. Disconnect profile A from the network, create another successful local comment, reconnect, and
   verify profile B receives it after synchronization.
4. In profile B's history page, permanently delete the first cloud record. Trigger or wait for sync
   in profile A and verify that record is removed there and does not reappear.
5. Delete the cloud vault only if this is a disposable smoke-test vault. Verify subsequent requests
   with its key fail safely.

Record the observed Worker request IDs and successful timestamps outside the repository.

## Key loss and rotation

The sync key is the only user-held credential for a vault. Anyone who receives it can read, change,
and permanently delete that vault's synchronized data. If one connected profile still has the key,
copy it from that profile before disconnecting. If every copy is lost, AutoComment cannot recover
the key or reconnect the vault from a new browser.

Sync-key rotation is not implemented. To move to a different key, create a new vault and upload data
to it; explicitly delete the old vault while its old key is still available. Disabling sync or
uninstalling one browser removes only that browser's local credentials and data—it does not delete
the cloud vault.

## Rollback and incident handling

List deployed versions and roll back Worker code with:

```sh
npm --prefix cloudflare-sync exec wrangler -- versions list
npm --prefix cloudflare-sync exec wrangler -- rollback <version-id>
```

A Worker rollback does not reverse D1 migrations or restore deleted data. Before a schema-changing
release, create a protected D1 export according to the operational backup policy. Prefer a
forward-fix migration when an older Worker version is incompatible with the current schema.

For an incident:

1. Stop further deployment and capture the affected Worker version and request IDs without copying
   authorization headers.
2. Roll back to a known compatible version if doing so is safe for the current D1 schema.
3. Re-run the unauthenticated status and allowed/disallowed CORS checks.
4. Run the two-profile flow before declaring synchronization restored.

Never delete the Worker, D1 database, signing secret, or a user's vault as a rollback mechanism.
