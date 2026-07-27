import {
  ACTIVE_VAULT_WRITE_SOURCE,
  executeActiveVaultWrite,
  type AuthenticatedVault
} from './auth';
import { fail, json } from './http';
import {
  boundedQueryInteger,
  boundedQueryString,
  protocolVersionFromQuery,
  rejectUnknownQuery
} from './validation';
import { CLOUD_SYNC_SETTING_KEYS } from '../../lib/cloud-sync-protocol.mjs';

const MAX_DEVICE_ID_LENGTH = 128;
const MAX_PULL_LIMIT = 100;
const MAX_BOOTSTRAP_CURSOR_LENGTH = 4_096;
const BOOTSTRAP_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_BOOTSTRAP_SIGNING_KEY_BYTES = 32;
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
  profile_id: string | null;
  profile_display_name: string | null;
  promotion_site_id: string | null;
  promotion_site_name: string | null;
  promotion_site_url: string | null;
  assignment_pair_id: string | null;
  assignment_source: string | null;
  config_revision: number | null;
  attempt_count: number | null;
  error_code: string | null;
  skip_reason: string | null;
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
  domain_payload_json: string | null;
}

interface BootstrapCommentCursor {
  serverCursor: number;
  serverNow: number;
  phase: 'comments';
  submittedAt: number;
  id: string;
  tombstoneId: null;
}

interface BootstrapTombstoneCursor {
  serverCursor: number;
  serverNow: number;
  phase: 'tombstones';
  submittedAt: null;
  id: null;
  tombstoneId: string;
}

interface BootstrapDomainCursor {
  serverCursor: number;
  serverNow: number;
  phase: 'domains';
  domainKey: string;
  submittedAt: null;
  id: null;
  tombstoneId: null;
}

type BootstrapCursor =
  | BootstrapCommentCursor
  | BootstrapTombstoneCursor
  | BootstrapDomainCursor;

interface SettingRow {
  setting_key: string;
  value_json: string;
}

interface TombstoneRow {
  record_id: string;
  deleted_at: number;
}

interface DomainBootstrapRow {
  sort_key: string;
  entity_type: string;
  entity_id: string;
  operation: 'upsert' | 'delete';
  payload_json: string;
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
  entityType:
    | 'comment'
    | 'comment_delete'
    | 'setting'
    | 'profile'
    | 'promotion_site'
    | 'assignment_pair'
    | 'assignment_policy';
  entityId: string;
  operation: 'upsert' | 'delete';
  value?: unknown;
  record?: {
    comment: Record<string, unknown>;
    anchors: StoredAnchor[];
  };
  recordId?: string;
  deletedAt?: number;
  payload?: Record<string, unknown>;
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

function materializeComment(
  row: StoredCommentRow,
  includeAssignment = true
): CommentBundle {
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
      ...(includeAssignment && row.profile_id !== null
        ? {
            profileId: row.profile_id,
            profileDisplayName: requiredString(row.profile_display_name),
            promotionSiteId: requiredString(row.promotion_site_id),
            promotionSiteName: requiredString(row.promotion_site_name),
            promotionSiteUrl: requiredString(row.promotion_site_url),
            assignmentPairId: requiredString(row.assignment_pair_id),
            assignmentSource: requiredString(row.assignment_source),
            configRevision: requiredNumber(row.config_revision),
            attemptCount: requiredNumber(row.attempt_count),
            errorCode: row.error_code,
            skipReason: row.skip_reason
          }
        : {}),
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

function materializeChange(
  row: PullRow,
  protocolVersion: 1 | 2
): MaterializedChange {
  const serverSeq = requiredNumber(row.server_seq);
  const entityId = requiredString(row.entity_id);

  if ([
    'profile',
    'promotion_site',
    'assignment_pair',
    'assignment_policy'
  ].includes(requiredString(row.entity_type))) {
    const payload = parseStoredJson(row.domain_payload_json);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      fail('INTERNAL_ERROR', 500, true);
    }
    return {
      serverSeq,
      entityType: row.entity_type as MaterializedChange['entityType'],
      entityId,
      operation: row.operation as 'upsert' | 'delete',
      payload: payload as Record<string, unknown>
    };
  }
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
    record: materializeComment(row, protocolVersion >= 2)
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

async function bootstrapSigningKey(env: Env): Promise<CryptoKey> {
  const value = env.BOOTSTRAP_CURSOR_SIGNING_KEY;
  if (typeof value !== 'string') {
    fail('INTERNAL_ERROR', 500, true);
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < MIN_BOOTSTRAP_SIGNING_KEY_BYTES) {
    fail('INTERNAL_ERROR', 500, true);
  }
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bootstrapCursorPayload(
  vaultId: string,
  cursor: BootstrapCursor,
  protocolVersion: 1 | 2
): Uint8Array {
  if (protocolVersion === 2) {
    return new TextEncoder().encode(JSON.stringify({
      v: 3,
      q: 2,
      u: vaultId,
      s: cursor.serverCursor,
      n: cursor.serverNow,
      p: cursor.phase,
      t: cursor.submittedAt,
      i: cursor.id,
      r: cursor.tombstoneId,
      d: cursor.phase === 'domains' ? cursor.domainKey : null
    }));
  }
  return new TextEncoder().encode(JSON.stringify({
    v: 2,
    u: vaultId,
    s: cursor.serverCursor,
    n: cursor.serverNow,
    p: cursor.phase,
    t: cursor.submittedAt,
    i: cursor.id,
    r: cursor.tombstoneId
  }));
}

async function encodeBootstrapCursor(
  key: CryptoKey,
  vaultId: string,
  cursor: BootstrapCursor,
  protocolVersion: 1 | 2
): Promise<string> {
  const payload = bootstrapCursorPayload(vaultId, cursor, protocolVersion);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return `${encodeBase64Url(payload)}.${encodeBase64Url(
    new Uint8Array(signature)
  )}`;
}

async function parseBootstrapCursor(
  value: string,
  key: CryptoKey,
  vaultId: string,
  protocolVersion: 1 | 2
): Promise<BootstrapCursor> {
  const parts = value.split('.');
  if (parts.length !== 2) fail('INVALID_REQUEST', 400);
  const payloadBytes = decodeBase64Url(parts[0] ?? '');
  const signatureBytes = decodeBase64Url(parts[1] ?? '');
  if (
    signatureBytes.byteLength !== 32 ||
    !await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      payloadBytes
    )
  ) {
    fail('INVALID_REQUEST', 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false
      }).decode(
        payloadBytes
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
  if (protocolVersion === 2) {
    if (
      keys.length !== 10
      || keys.some((keyName) => ![
        'v', 'q', 'u', 's', 'n', 'p', 't', 'i', 'r', 'd'
      ].includes(keyName))
      || cursor.v !== 3
      || cursor.q !== 2
      || cursor.u !== vaultId
      || !Number.isSafeInteger(cursor.s)
      || (cursor.s as number) < 0
      || !Number.isSafeInteger(cursor.n)
      || (cursor.n as number) < 0
      || !['domains', 'comments', 'tombstones'].includes(
        String(cursor.p)
      )
    ) {
      fail('INVALID_REQUEST', 400);
    }
    const common = {
      serverCursor: cursor.s as number,
      serverNow: cursor.n as number
    };
    if (cursor.p === 'domains') {
      if (
        cursor.t !== null
        || cursor.i !== null
        || cursor.r !== null
        || typeof cursor.d !== 'string'
        || cursor.d.length < 1
        || cursor.d.length > 1_024
      ) {
        fail('INVALID_REQUEST', 400);
      }
      return {
        ...common,
        phase: 'domains',
        domainKey: cursor.d,
        submittedAt: null,
        id: null,
        tombstoneId: null
      };
    }
    if (cursor.d !== null) fail('INVALID_REQUEST', 400);
    if (cursor.p === 'comments') {
      if (
        !Number.isSafeInteger(cursor.t)
        || (cursor.t as number) < 0
        || typeof cursor.i !== 'string'
        || cursor.i.length < 1
        || cursor.i.length > 512
        || cursor.i.trim() !== cursor.i
        || cursor.r !== null
      ) {
        fail('INVALID_REQUEST', 400);
      }
      return {
        ...common,
        phase: 'comments',
        submittedAt: cursor.t as number,
        id: cursor.i,
        tombstoneId: null
      };
    }
    if (
      cursor.t !== null
      || cursor.i !== null
      || typeof cursor.r !== 'string'
      || cursor.r.length < 1
      || cursor.r.length > 512
      || cursor.r.trim() !== cursor.r
    ) {
      fail('INVALID_REQUEST', 400);
    }
    return {
      ...common,
      phase: 'tombstones',
      submittedAt: null,
      id: null,
      tombstoneId: cursor.r
    };
  }
  if (
    keys.length !== 8 ||
    keys.some((key) => ![
      'v',
      'u',
      's',
      'n',
      'p',
      't',
      'i',
      'r'
    ].includes(key)) ||
    cursor.v !== 2 ||
    cursor.u !== vaultId ||
    !Number.isSafeInteger(cursor.s) ||
    (cursor.s as number) < 0 ||
    !Number.isSafeInteger(cursor.n) ||
    (cursor.n as number) < 0 ||
    (cursor.p !== 'comments' && cursor.p !== 'tombstones')
  ) {
    fail('INVALID_REQUEST', 400);
  }
  const common = {
    serverCursor: cursor.s as number,
    serverNow: cursor.n as number
  };
  if (cursor.p === 'comments') {
    if (
      !Number.isSafeInteger(cursor.t) ||
      (cursor.t as number) < 0 ||
      typeof cursor.i !== 'string' ||
      cursor.i.length < 1 ||
      cursor.i.length > 512 ||
      cursor.i.trim() !== cursor.i ||
      cursor.r !== null
    ) {
      fail('INVALID_REQUEST', 400);
    }
    return {
      ...common,
      phase: 'comments',
      submittedAt: cursor.t as number,
      id: cursor.i,
      tombstoneId: null
    };
  }
  if (
    cursor.t !== null ||
    cursor.i !== null ||
    typeof cursor.r !== 'string' ||
    cursor.r.length < 1 ||
    cursor.r.length > 512 ||
    cursor.r.trim() !== cursor.r
  ) {
    fail('INVALID_REQUEST', 400);
  }
  return {
    ...common,
    phase: 'tombstones',
    submittedAt: null,
    id: null,
    tombstoneId: cursor.r
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
       CASE
         WHEN page.entity_type = 'profile' AND page.operation = 'upsert'
           THEN json_object('profile', json_object(
             'id', profile.entity_id,
             'displayName', profile.display_name,
             'name', profile.profile_name,
             'email', profile.email,
             'createdAt', profile.created_at,
             'updatedAt', profile.updated_at
           ))
         WHEN page.entity_type = 'promotion_site' AND page.operation = 'upsert'
           THEN json_object('promotionSite', json_object(
             'id', site.entity_id,
             'name', site.site_name,
             'url', site.site_url,
             'content', site.content,
             'enabled', json(CASE WHEN site.enabled = 1 THEN 'true' ELSE 'false' END),
             'createdAt', site.created_at,
             'updatedAt', site.updated_at
           ))
         WHEN page.entity_type = 'assignment_pair' AND page.operation = 'upsert'
           THEN json_object('assignmentPair', json_object(
             'id', pair.entity_id,
             'profileId', pair.profile_id,
             'promotionSiteId', pair.promotion_site_id,
             'weight', pair.weight,
             'enabled', json(CASE WHEN pair.enabled = 1 THEN 'true' ELSE 'false' END)
           ))
         WHEN page.entity_type = 'assignment_policy'
           THEN json_object('assignmentPolicy', json_object(
             'id', policy.entity_id,
             'defaultPairId', policy.default_pair_id,
             'quotas', json(policy.quotas_json)
           ))
         WHEN page.entity_type IN (
           'profile', 'promotion_site', 'assignment_pair'
         ) AND page.operation = 'delete'
           THEN json_object('deletedAt', domain_tombstone.deleted_at)
         ELSE NULL
       END AS domain_payload_json,
       comment.record_id, comment.batch_id, comment.url_index,
       comment.submitted_at, comment.archive_month,
       comment.target_page_url, comment.target_domain,
       comment.promoted_website_url, comment.promoted_domain,
       comment.comment_html, comment.comment_text, comment.submit_status,
       comment.source, comment.created_at, comment.updated_at,
       comment.revision_captured_at, comment.revision_recorded_at,
       comment.revision_sequence, comment.revision_id,
       comment.profile_id, comment.profile_display_name,
       comment.promotion_site_id, comment.promotion_site_name,
       comment.promotion_site_url, comment.assignment_pair_id,
       comment.assignment_source, comment.config_revision,
       comment.attempt_count, comment.error_code, comment.skip_reason,
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
     LEFT JOIN sync_profiles AS profile
       ON profile.vault_id = ?
      AND profile.entity_id = page.entity_id
      AND page.entity_type = 'profile'
     LEFT JOIN sync_promotion_sites AS site
       ON site.vault_id = ?
      AND site.entity_id = page.entity_id
      AND page.entity_type = 'promotion_site'
     LEFT JOIN sync_assignment_pairs AS pair
       ON pair.vault_id = ?
      AND pair.entity_id = page.entity_id
      AND page.entity_type = 'assignment_pair'
     LEFT JOIN sync_assignment_policy AS policy
       ON policy.vault_id = ?
      AND policy.entity_id = page.entity_id
      AND page.entity_type = 'assignment_policy'
     LEFT JOIN domain_entity_tombstones AS domain_tombstone
       ON domain_tombstone.vault_id = ?
      AND domain_tombstone.entity_type = page.entity_type
      AND domain_tombstone.entity_id = page.entity_id
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
      vaultId,
      vaultId,
      vaultId,
      vaultId,
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
  serverCursor: number,
  cursor: BootstrapCommentCursor | null,
  limit: number
): Promise<StoredCommentRow[]> {
  const cursorClause = cursor
    ? `AND (
         comment.submitted_at < ? OR (
           comment.submitted_at = ? AND comment.record_id < ?
         )
       )`
    : '';
  const bindings: unknown[] = [
    vaultId,
    serverCursor,
    vaultId,
    cutoff
  ];
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
       comment.profile_id, comment.profile_display_name,
       comment.promotion_site_id, comment.promotion_site_name,
       comment.promotion_site_url, comment.assignment_pair_id,
       comment.assignment_source, comment.config_revision,
       comment.attempt_count, comment.error_code, comment.skip_reason,
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
     JOIN sync_changes AS accepted_change
       ON accepted_change.vault_id = comment.vault_id
      AND accepted_change.mutation_id = comment.accepted_mutation_id
      AND accepted_change.entity_type = 'comment'
      AND accepted_change.server_seq <= ?
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

async function readBootstrapDomainEntities(
  database: D1Database,
  vaultId: string,
  serverCursor: number,
  afterKey: string | null,
  limit: number
): Promise<DomainBootstrapRow[]> {
  const result = await database.prepare(
    `WITH domain_entities AS (
       SELECT '1:' || profile.entity_id AS sort_key,
         'profile' AS entity_type, profile.entity_id, 'upsert' AS operation,
         json_object('profile', json_object(
           'id', profile.entity_id,
           'displayName', profile.display_name,
           'name', profile.profile_name,
           'email', profile.email,
           'createdAt', profile.created_at,
           'updatedAt', profile.updated_at
         )) AS payload_json
       FROM sync_profiles AS profile
       WHERE profile.vault_id = ? AND profile.server_seq <= ?
       UNION ALL
       SELECT '2:' || site.entity_id,
         'promotion_site', site.entity_id, 'upsert',
         json_object('promotionSite', json_object(
           'id', site.entity_id,
           'name', site.site_name,
           'url', site.site_url,
           'content', site.content,
           'enabled', json(CASE WHEN site.enabled = 1 THEN 'true' ELSE 'false' END),
           'createdAt', site.created_at,
           'updatedAt', site.updated_at
         ))
       FROM sync_promotion_sites AS site
       WHERE site.vault_id = ? AND site.server_seq <= ?
       UNION ALL
       SELECT '3:' || pair.entity_id,
         'assignment_pair', pair.entity_id, 'upsert',
         json_object('assignmentPair', json_object(
           'id', pair.entity_id,
           'profileId', pair.profile_id,
           'promotionSiteId', pair.promotion_site_id,
           'weight', pair.weight,
           'enabled', json(CASE WHEN pair.enabled = 1 THEN 'true' ELSE 'false' END)
         ))
       FROM sync_assignment_pairs AS pair
       WHERE pair.vault_id = ? AND pair.server_seq <= ?
       UNION ALL
       SELECT '4:' || policy.entity_id,
         'assignment_policy', policy.entity_id, 'upsert',
         json_object('assignmentPolicy', json_object(
           'id', policy.entity_id,
           'defaultPairId', policy.default_pair_id,
           'quotas', json(policy.quotas_json)
         ))
       FROM sync_assignment_policy AS policy
       WHERE policy.vault_id = ? AND policy.server_seq <= ?
       UNION ALL
       SELECT '5:' || tombstone.entity_type || ':' || tombstone.entity_id,
         tombstone.entity_type, tombstone.entity_id, 'delete',
         json_object('deletedAt', tombstone.deleted_at)
       FROM domain_entity_tombstones AS tombstone
       WHERE tombstone.vault_id = ? AND tombstone.server_seq <= ?
     )
     SELECT sort_key, entity_type, entity_id, operation, payload_json
     FROM domain_entities
     WHERE (? IS NULL OR sort_key > ?)
     ORDER BY sort_key ASC
     LIMIT ?`
  ).bind(
    vaultId, serverCursor,
    vaultId, serverCursor,
    vaultId, serverCursor,
    vaultId, serverCursor,
    vaultId, serverCursor,
    afterKey, afterKey,
    limit + 1
  ).all<DomainBootstrapRow>();
  return result.results;
}

function materializeBootstrapDomain(row: DomainBootstrapRow) {
  const payload = parseStoredJson(row.payload_json);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('INTERNAL_ERROR', 500, true);
  }
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    payload
  };
}

async function readBootstrapSettings(
  database: D1Database,
  vaultId: string,
  serverCursor: number
): Promise<Array<{ key: string; value: unknown }>> {
  const result = await database.prepare(
    `SELECT setting.setting_key, setting.value_json
     FROM synced_settings AS setting
     JOIN sync_changes AS accepted_change
       ON accepted_change.vault_id = setting.vault_id
      AND accepted_change.mutation_id = setting.accepted_mutation_id
      AND accepted_change.entity_type = 'setting'
      AND accepted_change.server_seq <= ?
     WHERE setting.vault_id = ?
       AND setting.setting_key IN (${SETTING_ALLOWLIST_PLACEHOLDERS})
     ORDER BY setting.setting_key ASC`
  )
    .bind(serverCursor, vaultId, ...CLOUD_SYNC_SETTING_KEYS)
    .all<SettingRow>();
  return result.results.map((row) => ({
    key: row.setting_key,
    value: parseStoredJson(row.value_json)
  }));
}

async function readBootstrapTombstones(
  database: D1Database,
  vaultId: string,
  serverCursor: number,
  afterRecordId: string | null,
  limit: number
): Promise<TombstoneRow[]> {
  const cursorClause = afterRecordId === null
    ? ''
    : 'AND tombstone.record_id > ?';
  const bindings: unknown[] = [serverCursor, vaultId];
  if (afterRecordId !== null) bindings.push(afterRecordId);
  bindings.push(limit + 1);
  const result = await database.prepare(
    `SELECT tombstone.record_id, tombstone.deleted_at
     FROM comment_tombstones AS tombstone
     JOIN sync_changes AS accepted_change
       ON accepted_change.vault_id = tombstone.vault_id
      AND accepted_change.mutation_id = tombstone.mutation_id
      AND accepted_change.entity_type = 'comment_delete'
      AND accepted_change.server_seq <= ?
     WHERE tombstone.vault_id = ?
       ${cursorClause}
     ORDER BY tombstone.record_id ASC
     LIMIT ?`
  )
    .bind(...bindings)
    .all<TombstoneRow>();
  return result.results;
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
  rejectUnknownQuery(url, [
    'cursor',
    'limit',
    'deviceId',
    'protocolVersion'
  ]);
  const protocolVersion = protocolVersionFromQuery(url);
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
  if (cursor > page.highWatermark) fail('INVALID_REQUEST', 400);
  const pageRows = page.rows.slice(0, limit);
  const changes = pageRows
    .filter((row) => (
      protocolVersion >= 2
      || ![
        'profile',
        'promotion_site',
        'assignment_pair',
        'assignment_policy'
      ].includes(requiredString(row.entity_type))
    ))
    .map((row) => materializeChange(row, protocolVersion));
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
  rejectUnknownQuery(url, [
    'cursor',
    'limit',
    'deviceId',
    'protocolVersion'
  ]);
  const protocolVersion = protocolVersionFromQuery(url);
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
  const signingKey = await bootstrapSigningKey(env);
  const cursor = cursorValues.length === 1
    ? await parseBootstrapCursor(
        boundedQueryString(
          url,
          'cursor',
          1,
          MAX_BOOTSTRAP_CURSOR_LENGTH
        ),
        signingKey,
        vault.vaultId,
        protocolVersion
      )
    : null;
  const requestNow = Date.now();
  const highWatermark = await currentHighWatermark(
    env.DB,
    vault.vaultId
  );
  if (
    cursor &&
    (
      cursor.serverNow > requestNow ||
      cursor.serverCursor > highWatermark
    )
  ) {
    fail('INVALID_REQUEST', 400);
  }
  const serverNow = cursor?.serverNow ?? requestNow;
  const serverCursor = cursor?.serverCursor ?? highWatermark;
  if (
    protocolVersion === 2
    && (cursor === null || cursor.phase === 'domains')
  ) {
    const domainRows = await readBootstrapDomainEntities(
      env.DB,
      vault.vaultId,
      serverCursor,
      cursor?.phase === 'domains' ? cursor.domainKey : null,
      limit
    );
    const pageDomainRows = domainRows.slice(0, limit);
    const lastDomain = pageDomainRows.at(-1);
    if (lastDomain) {
      const nextCursor = await encodeBootstrapCursor(
        signingKey,
        vault.vaultId,
        {
          serverCursor,
          serverNow,
          phase: 'domains',
          domainKey: lastDomain.sort_key,
          submittedAt: null,
          id: null,
          tombstoneId: null
        },
        protocolVersion
      );
      return json({
        ok: true,
        comments: [],
        settings: cursor
          ? []
          : await readBootstrapSettings(
              env.DB,
              vault.vaultId,
              serverCursor
            ),
        tombstones: [],
        domainEntities: pageDomainRows.map(materializeBootstrapDomain),
        nextCursor,
        hasMore: true,
        serverCursor,
        serverNow,
        requestId
      });
    }
  }
  const historyCursor = cursor?.phase === 'domains' ? null : cursor;
  const cutoff = serverNow - BOOTSTRAP_RETENTION_MS;
  const commentRows = historyCursor?.phase === 'tombstones'
    ? []
    : await readBootstrapComments(
        env.DB,
        vault.vaultId,
        cutoff,
        serverCursor,
        historyCursor,
        limit
      );
  const pageRows = commentRows.slice(0, limit);
  const commentsHaveMore = commentRows.length > limit;
  const tombstoneRows = commentsHaveMore
    ? []
    : await readBootstrapTombstones(
        env.DB,
        vault.vaultId,
        serverCursor,
        historyCursor?.phase === 'tombstones'
          ? historyCursor.tombstoneId
          : null,
        limit
      );
  const pageTombstoneRows = tombstoneRows.slice(0, limit);
  const tombstonesHaveMore = tombstoneRows.length > limit;
  const hasMore = commentsHaveMore || tombstonesHaveMore;
  let nextCursor: string | null = null;
  const lastComment = pageRows.at(-1);
  const lastTombstone = pageTombstoneRows.at(-1);
  if (commentsHaveMore && lastComment) {
    nextCursor = await encodeBootstrapCursor(
      signingKey,
      vault.vaultId,
      {
        serverCursor,
        serverNow,
        phase: 'comments',
        submittedAt: requiredNumber(lastComment.submitted_at),
        id: requiredString(lastComment.record_id),
        tombstoneId: null
      },
      protocolVersion
    );
  } else if (tombstonesHaveMore && lastTombstone) {
    nextCursor = await encodeBootstrapCursor(
      signingKey,
      vault.vaultId,
      {
        serverCursor,
        serverNow,
        phase: 'tombstones',
        submittedAt: null,
        id: null,
        tombstoneId: lastTombstone.record_id
      },
      protocolVersion
    );
  }
  const settings = cursor
    ? []
    : await readBootstrapSettings(
        env.DB,
        vault.vaultId,
        serverCursor
      );
  const tombstones = pageTombstoneRows.map((row) => ({
    recordId: row.record_id,
    deletedAt: row.deleted_at
  }));

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
    comments: pageRows.map((row) => (
      materializeComment(row, protocolVersion >= 2)
    )),
    settings,
    tombstones,
    ...(protocolVersion === 2 ? { domainEntities: [] } : {}),
    nextCursor,
    hasMore,
    serverCursor,
    serverNow,
    requestId
  });
}
