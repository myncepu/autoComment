import {
  ACTIVE_VAULT_WRITE_SOURCE,
  executeActiveVaultWrite,
  type AuthenticatedVault
} from './auth';
import { fail, json } from './http';
import {
  boundedQueryInteger,
  boundedQueryString,
  rejectUnknownQuery
} from './validation';
import { CLOUD_SYNC_SETTING_KEYS } from '../../lib/cloud-sync-protocol.mjs';

const MAX_DEVICE_ID_LENGTH = 128;
const MAX_PULL_LIMIT = 100;
const MAX_BOOTSTRAP_CURSOR_LENGTH = 4_096;
const BOOTSTRAP_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const SETTING_ALLOWLIST_PLACEHOLDERS = CLOUD_SYNC_SETTING_KEYS
  .map(() => '?')
  .join(', ');

interface StoredCommentRow {
  record_id: string | null;
  batch_id: string | null;
  url_index: number | null;
  submitted_at: number | null;
  archive_month: string | null;
  target_page_url: string | null;
  target_domain: string | null;
  promoted_website_url: string | null;
  promoted_domain: string | null;
  comment_html: string | null;
  comment_text: string | null;
  submit_status: string | null;
  source: string | null;
  created_at: number | null;
  updated_at: number | null;
  revision_captured_at: number | null;
  revision_recorded_at: number | null;
  revision_sequence: number | null;
  revision_id: string | null;
  anchors_json: string | null;
}

interface PullRow extends StoredCommentRow {
  high_watermark: number;
  server_seq: number | null;
  entity_type: string | null;
  entity_id: string | null;
  operation: string | null;
  setting_value_json: string | null;
  tombstone_deleted_at: number | null;
}

interface BootstrapCursor {
  serverCursor: number;
  serverNow: number;
  submittedAt: number;
  id: string;
}

interface SettingRow {
  setting_key: string;
  value_json: string;
}

interface TombstoneRow {
  record_id: string;
  deleted_at: number;
}

interface StoredAnchor {
  id: string;
  commentId: string;
  position: number;
  anchorText: string;
  anchorTextNormalized: string;
  hrefRaw: string;
  hrefResolved: string;
  hrefDomain: string;
}

export interface MaterializedChange {
  serverSeq: number;
  entityType: 'comment' | 'comment_delete' | 'setting';
  entityId: string;
  operation: 'upsert' | 'delete';
  value?: unknown;
  record?: {
    comment: Record<string, unknown>;
    anchors: StoredAnchor[];
  };
  recordId?: string;
  deletedAt?: number;
}

interface CommentBundle {
  comment: Record<string, unknown>;
  anchors: StoredAnchor[];
}

function requiredString(value: string | null): string {
  if (value === null) fail('INTERNAL_ERROR', 500, true);
  return value;
}

function requiredNumber(value: number | null): number {
  if (value === null) fail('INTERNAL_ERROR', 500, true);
  return value;
}

function parseStoredJson(value: string | null): unknown {
  if (value === null) fail('INTERNAL_ERROR', 500, true);
  try {
    return JSON.parse(value);
  } catch {
    fail('INTERNAL_ERROR', 500, true);
  }
}

function tombstoneChange(
  row: PullRow,
  serverSeq: number,
  entityId: string
): MaterializedChange {
  return {
    serverSeq,
    entityType: 'comment_delete',
    entityId,
    operation: 'delete',
    recordId: entityId,
    deletedAt: requiredNumber(row.tombstone_deleted_at)
  };
}

function materializeComment(row: StoredCommentRow): CommentBundle {
  const anchors = parseStoredJson(row.anchors_json);
  if (!Array.isArray(anchors)) fail('INTERNAL_ERROR', 500, true);

  return {
    comment: {
      id: requiredString(row.record_id),
      batchId: requiredString(row.batch_id),
      urlIndex: requiredNumber(row.url_index),
      submittedAt: requiredNumber(row.submitted_at),
      archiveMonth: requiredString(row.archive_month),
      targetPageUrl: requiredString(row.target_page_url),
      targetDomain: requiredString(row.target_domain),
      promotedWebsiteUrl: requiredString(row.promoted_website_url),
      promotedDomain: requiredString(row.promoted_domain),
      commentHtml: requiredString(row.comment_html),
      commentText: requiredString(row.comment_text),
      submitStatus: requiredString(row.submit_status),
      source: requiredString(row.source),
      createdAt: requiredNumber(row.created_at),
      updatedAt: requiredNumber(row.updated_at),
      historyRevision: {
        capturedAt: requiredNumber(row.revision_captured_at),
        recordedAt: requiredNumber(row.revision_recorded_at),
        sequence: requiredNumber(row.revision_sequence),
        id: requiredString(row.revision_id)
      }
    },
    anchors: anchors as StoredAnchor[]
  };
}

function materializeChange(row: PullRow): MaterializedChange {
  const serverSeq = requiredNumber(row.server_seq);
  const entityId = requiredString(row.entity_id);

  if (row.operation === 'delete') {
    return tombstoneChange(row, serverSeq, entityId);
  }
  if (row.operation !== 'upsert') {
    fail('INTERNAL_ERROR', 500, true);
  }
  if (row.entity_type === 'setting') {
    return {
      serverSeq,
      entityType: 'setting',
      entityId,
      operation: 'upsert',
      value: parseStoredJson(row.setting_value_json)
    };
  }
  if (row.entity_type !== 'comment') {
    fail('INTERNAL_ERROR', 500, true);
  }
  if (row.record_id === null) {
    if (row.tombstone_deleted_at !== null) {
      return tombstoneChange(row, serverSeq, entityId);
    }
    fail('INTERNAL_ERROR', 500, true);
  }

  return {
    serverSeq,
    entityType: 'comment',
    entityId,
    operation: 'upsert',
    record: materializeComment(row)
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail('INVALID_REQUEST', 400);
  const paddingLength = (4 - (value.length % 4)) % 4;
  if (paddingLength === 3) fail('INVALID_REQUEST', 400);
  try {
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') +
        '='.repeat(paddingLength)
    );
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );
    if (encodeBase64Url(bytes) !== value) fail('INVALID_REQUEST', 400);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    fail('INVALID_REQUEST', 400);
  }
}

function encodeBootstrapCursor(cursor: BootstrapCursor): string {
  return encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({
      v: 1,
      s: cursor.serverCursor,
      n: cursor.serverNow,
      t: cursor.submittedAt,
      i: cursor.id
    }))
  );
}

function parseBootstrapCursor(value: string): BootstrapCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false
      }).decode(
        decodeBase64Url(value)
      )
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    fail('INVALID_REQUEST', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('INVALID_REQUEST', 400);
  }
  const cursor = parsed as Record<string, unknown>;
  const keys = Object.keys(cursor);
  if (
    keys.length !== 5 ||
    keys.some((key) => !['v', 's', 'n', 't', 'i'].includes(key)) ||
    cursor.v !== 1 ||
    !Number.isSafeInteger(cursor.s) ||
    (cursor.s as number) < 0 ||
    !Number.isSafeInteger(cursor.n) ||
    (cursor.n as number) < 0 ||
    !Number.isSafeInteger(cursor.t) ||
    (cursor.t as number) < 0 ||
    typeof cursor.i !== 'string' ||
    cursor.i.length < 1 ||
    cursor.i.length > 512 ||
    cursor.i.trim() !== cursor.i
  ) {
    fail('INVALID_REQUEST', 400);
  }
  return {
    serverCursor: cursor.s as number,
    serverNow: cursor.n as number,
    submittedAt: cursor.t as number,
    id: cursor.i
  };
}

export async function currentHighWatermark(
  database: D1Database,
  vaultId: string
): Promise<number> {
  const row = await database.prepare(
    `SELECT COALESCE(MAX(server_seq), 0) AS high_watermark
     FROM sync_changes
     WHERE vault_id = ?`
  )
    .bind(vaultId)
    .first<{ high_watermark: number }>();
  return row?.high_watermark ?? 0;
}

async function readPullPage(
  database: D1Database,
  vaultId: string,
  cursor: number,
  limit: number
): Promise<{ rows: PullRow[]; highWatermark: number }> {
  const result = await database.prepare(
    `WITH watermark AS (
       SELECT COALESCE(MAX(server_seq), 0) AS high_watermark
       FROM sync_changes
       WHERE vault_id = ?
     ),
     page AS (
       SELECT changes.server_seq, changes.entity_type, changes.entity_id,
         changes.operation
       FROM sync_changes AS changes, watermark
       WHERE changes.vault_id = ?
         AND changes.server_seq > ?
         AND changes.server_seq <= watermark.high_watermark
       ORDER BY changes.server_seq ASC
       LIMIT ?
     )
     SELECT watermark.high_watermark,
       page.server_seq, page.entity_type, page.entity_id, page.operation,
       setting.value_json AS setting_value_json,
       tombstone.deleted_at AS tombstone_deleted_at,
       comment.record_id, comment.batch_id, comment.url_index,
       comment.submitted_at, comment.archive_month,
       comment.target_page_url, comment.target_domain,
       comment.promoted_website_url, comment.promoted_domain,
       comment.comment_html, comment.comment_text, comment.submit_status,
       comment.source, comment.created_at, comment.updated_at,
       comment.revision_captured_at, comment.revision_recorded_at,
       comment.revision_sequence, comment.revision_id,
       CASE WHEN page.entity_type = 'comment' THEN (
         SELECT json_group_array(json(anchor_row.anchor_json))
         FROM (
           SELECT json_object(
             'id', anchor.anchor_id,
             'commentId', anchor.comment_id,
             'position', anchor.position,
             'anchorText', anchor.anchor_text,
             'anchorTextNormalized', anchor.anchor_text_normalized,
             'hrefRaw', anchor.href_raw,
             'hrefResolved', anchor.href_resolved,
             'hrefDomain', anchor.href_domain
           ) AS anchor_json
           FROM comment_anchors AS anchor
           WHERE anchor.vault_id = ?
             AND anchor.comment_id = page.entity_id
           ORDER BY anchor.position ASC, anchor.anchor_id ASC
         ) AS anchor_row
       ) ELSE NULL END AS anchors_json
     FROM watermark
     LEFT JOIN page ON TRUE
     LEFT JOIN synced_settings AS setting
       ON setting.vault_id = ?
      AND setting.setting_key = page.entity_id
      AND page.entity_type = 'setting'
      AND setting.setting_key IN (${SETTING_ALLOWLIST_PLACEHOLDERS})
     LEFT JOIN comment_records AS comment
       ON comment.vault_id = ?
      AND comment.record_id = page.entity_id
      AND page.entity_type = 'comment'
     LEFT JOIN comment_tombstones AS tombstone
       ON tombstone.vault_id = ?
      AND tombstone.record_id = page.entity_id
     ORDER BY page.server_seq ASC`
  )
    .bind(
      vaultId,
      vaultId,
      cursor,
      limit + 1,
      vaultId,
      vaultId,
      ...CLOUD_SYNC_SETTING_KEYS,
      vaultId,
      vaultId
    )
    .all<PullRow>();
  const rows = result.results.filter((row) => row.server_seq !== null);
  return {
    rows,
    highWatermark: result.results[0]?.high_watermark ?? 0
  };
}

async function readBootstrapComments(
  database: D1Database,
  vaultId: string,
  cutoff: number,
  cursor: BootstrapCursor | null,
  limit: number
): Promise<StoredCommentRow[]> {
  const cursorClause = cursor
    ? `AND (
         comment.submitted_at < ? OR (
           comment.submitted_at = ? AND comment.record_id < ?
         )
       )`
    : '';
  const bindings: unknown[] = [vaultId, vaultId, cutoff];
  if (cursor) {
    bindings.push(cursor.submittedAt, cursor.submittedAt, cursor.id);
  }
  bindings.push(limit + 1);

  const result = await database.prepare(
    `SELECT comment.record_id, comment.batch_id, comment.url_index,
       comment.submitted_at, comment.archive_month,
       comment.target_page_url, comment.target_domain,
       comment.promoted_website_url, comment.promoted_domain,
       comment.comment_html, comment.comment_text, comment.submit_status,
       comment.source, comment.created_at, comment.updated_at,
       comment.revision_captured_at, comment.revision_recorded_at,
       comment.revision_sequence, comment.revision_id,
       (
         SELECT json_group_array(json(anchor_row.anchor_json))
         FROM (
           SELECT json_object(
             'id', anchor.anchor_id,
             'commentId', anchor.comment_id,
             'position', anchor.position,
             'anchorText', anchor.anchor_text,
             'anchorTextNormalized', anchor.anchor_text_normalized,
             'hrefRaw', anchor.href_raw,
             'hrefResolved', anchor.href_resolved,
             'hrefDomain', anchor.href_domain
           ) AS anchor_json
           FROM comment_anchors AS anchor
           WHERE anchor.vault_id = ?
             AND anchor.comment_id = comment.record_id
           ORDER BY anchor.position ASC, anchor.anchor_id ASC
         ) AS anchor_row
       ) AS anchors_json
     FROM comment_records AS comment
     WHERE comment.vault_id = ?
       AND comment.submitted_at >= ?
       ${cursorClause}
     ORDER BY comment.submitted_at DESC, comment.record_id DESC
     LIMIT ?`
  )
    .bind(...bindings)
    .all<StoredCommentRow>();
  return result.results;
}

async function readBootstrapSettings(
  database: D1Database,
  vaultId: string
): Promise<Array<{ key: string; value: unknown }>> {
  const result = await database.prepare(
    `SELECT setting_key, value_json
     FROM synced_settings
     WHERE vault_id = ?
       AND setting_key IN (${SETTING_ALLOWLIST_PLACEHOLDERS})
     ORDER BY setting_key ASC`
  )
    .bind(vaultId, ...CLOUD_SYNC_SETTING_KEYS)
    .all<SettingRow>();
  return result.results.map((row) => ({
    key: row.setting_key,
    value: parseStoredJson(row.value_json)
  }));
}

async function readBootstrapTombstones(
  database: D1Database,
  vaultId: string
): Promise<Array<{ recordId: string; deletedAt: number }>> {
  const result = await database.prepare(
    `SELECT record_id, deleted_at
     FROM comment_tombstones
     WHERE vault_id = ?
     ORDER BY record_id ASC`
  )
    .bind(vaultId)
    .all<TombstoneRow>();
  return result.results.map((row) => ({
    recordId: row.record_id,
    deletedAt: row.deleted_at
  }));
}

async function updateDeviceCursor(
  env: Env,
  vaultId: string,
  deviceId: string,
  cursor: number,
  now: number
): Promise<void> {
  await executeActiveVaultWrite(
    env.DB.prepare(
      `INSERT INTO sync_devices (
         vault_id, device_id, display_name, created_at, last_seen_at,
         last_successful_sync_at, last_cursor
       )
       SELECT active_vault.vault_id, ?, NULL, ?, ?, ?, ?
       ${ACTIVE_VAULT_WRITE_SOURCE}
       ON CONFLICT(vault_id, device_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_successful_sync_at = excluded.last_successful_sync_at,
         last_cursor = MAX(sync_devices.last_cursor, excluded.last_cursor)`
    ).bind(deviceId, now, now, now, cursor, vaultId)
  );
}

export async function pullChanges(
  request: Request,
  env: Env,
  vault: AuthenticatedVault,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const url = new URL(request.url);
  rejectUnknownQuery(url, ['cursor', 'limit', 'deviceId']);
  const cursor = boundedQueryInteger(
    url,
    'cursor',
    0,
    Number.MAX_SAFE_INTEGER
  );
  const limit = boundedQueryInteger(url, 'limit', 1, MAX_PULL_LIMIT);
  const deviceId = boundedQueryString(
    url,
    'deviceId',
    1,
    MAX_DEVICE_ID_LENGTH,
    'INVALID_DEVICE_ID'
  );

  const page = await readPullPage(
    env.DB,
    vault.vaultId,
    cursor,
    limit
  );
  const pageRows = page.rows.slice(0, limit);
  const changes = pageRows.map(materializeChange);
  const nextCursor =
    pageRows.at(-1)?.server_seq ?? cursor;
  await updateDeviceCursor(
    env,
    vault.vaultId,
    deviceId,
    nextCursor,
    Date.now()
  );

  return json({
    ok: true,
    changes,
    nextCursor,
    hasMore: page.rows.length > limit,
    highWatermark: page.highWatermark,
    requestId
  });
}

export async function bootstrapSnapshot(
  request: Request,
  env: Env,
  vault: AuthenticatedVault,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const url = new URL(request.url);
  rejectUnknownQuery(url, ['cursor', 'limit', 'deviceId']);
  const limit = boundedQueryInteger(url, 'limit', 1, MAX_PULL_LIMIT);
  const deviceId = boundedQueryString(
    url,
    'deviceId',
    1,
    MAX_DEVICE_ID_LENGTH,
    'INVALID_DEVICE_ID'
  );
  const cursorValues = url.searchParams.getAll('cursor');
  if (cursorValues.length > 1) fail('INVALID_REQUEST', 400);
  const cursor = cursorValues.length === 1
    ? parseBootstrapCursor(
        boundedQueryString(
          url,
          'cursor',
          1,
          MAX_BOOTSTRAP_CURSOR_LENGTH
        )
      )
    : null;
  const serverNow = cursor?.serverNow ?? Date.now();
  const serverCursor = cursor?.serverCursor ?? await currentHighWatermark(
    env.DB,
    vault.vaultId
  );
  const cutoff = serverNow - BOOTSTRAP_RETENTION_MS;
  const rows = await readBootstrapComments(
    env.DB,
    vault.vaultId,
    cutoff,
    cursor,
    limit
  );
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastRow = pageRows.at(-1);
  const nextCursor = hasMore && lastRow
    ? encodeBootstrapCursor({
        serverCursor,
        serverNow,
        submittedAt: requiredNumber(lastRow.submitted_at),
        id: requiredString(lastRow.record_id)
      })
    : null;
  const [settings, tombstones] = cursor
    ? [[], []]
    : await Promise.all([
        readBootstrapSettings(env.DB, vault.vaultId),
        readBootstrapTombstones(env.DB, vault.vaultId)
      ]);

  if (!hasMore) {
    await updateDeviceCursor(
      env,
      vault.vaultId,
      deviceId,
      serverCursor,
      Date.now()
    );
  }

  return json({
    ok: true,
    comments: pageRows.map(materializeComment),
    settings,
    tombstones,
    nextCursor,
    hasMore,
    serverCursor,
    serverNow,
    requestId
  });
}
