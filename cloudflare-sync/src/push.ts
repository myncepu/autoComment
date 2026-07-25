import {
  normalizeCommentRevision,
  normalizeSyncMutation
} from '../../lib/cloud-sync-protocol.mjs';
import {
  type AuthenticatedVault
} from './auth';
import { fail, json } from './http';
import {
  isJsonObject,
  readBoundedJson
} from './validation';

const MAX_PUSH_BODY_BYTES = 512_000;
const MAX_MUTATIONS = 100;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const MAX_BATCH_ID_LENGTH = 256;
// TextEncoder emits at most three UTF-8 bytes per UTF-16 code unit:
// surrogate pairs use four bytes for two units and lone surrogates become
// the three-byte replacement character. Hex uses two ASCII characters per
// byte, so this covers every legacy fallback for a 512-unit record ID.
const MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3;
const HEX_CHARACTERS_PER_BYTE = 2;
const LEGACY_REVISION_PREFIX_LENGTH = 'legacy:utf8hex-'.length;
const LEGACY_REVISION_SEPARATOR_LENGTH = 1;
const MAX_TIMESTAMP_TEXT_LENGTH =
  String(Number.MAX_SAFE_INTEGER).length;
const MAX_REVISION_ID_LENGTH =
  LEGACY_REVISION_PREFIX_LENGTH +
  MAX_ID_LENGTH *
    MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT *
    HEX_CHARACTERS_PER_BYTE +
  LEGACY_REVISION_SEPARATOR_LENGTH +
  MAX_TIMESTAMP_TEXT_LENGTH;
const MAX_URL_LENGTH = 8_192;
const MAX_DOMAIN_LENGTH = 253;
const MAX_COMMENT_HTML_LENGTH = 200_000;
const MAX_COMMENT_TEXT_LENGTH = 100_000;
const MAX_STATUS_LENGTH = 64;
const MAX_ANCHOR_TEXT_LENGTH = 10_000;
const MAX_ANCHORS = 1_000;
const MAX_SETTING_VALUE_JSON_BYTES = 64 * 1_024;

const MAX_D1_QUERY_BUDGET = 1_000;
const AUTH_QUERY_COST = 1;
const MISSING_RECEIPT_DIAGNOSTIC_RESERVE = 1;
const RECEIPT_READ_QUERY_COST = 1;
const COMMENT_FIXED_BATCH_STATEMENTS = 4;
const COMMENT_DELETE_BATCH_STATEMENTS = 6;
const SETTING_BATCH_STATEMENTS = 4;

const COMMENT_KEYS = [
  'id',
  'batchId',
  'urlIndex',
  'submittedAt',
  'archiveMonth',
  'targetPageUrl',
  'targetDomain',
  'promotedWebsiteUrl',
  'promotedDomain',
  'commentHtml',
  'commentText',
  'submitStatus',
  'source',
  'createdAt',
  'updatedAt',
  'historyRevision'
] as const;

const ANCHOR_KEYS = [
  'id',
  'commentId',
  'position',
  'anchorText',
  'anchorTextNormalized',
  'hrefRaw',
  'hrefResolved',
  'hrefDomain'
] as const;

class MutationValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'MutationValidationError';
    this.code = code;
  }
}

interface CommentRevision {
  capturedAt: number;
  recordedAt: number;
  sequence: number;
  id: string;
}

interface CommentRecord {
  id: string;
  batchId: string;
  urlIndex: number;
  submittedAt: number;
  archiveMonth: string;
  targetPageUrl: string;
  targetDomain: string;
  promotedWebsiteUrl: string;
  promotedDomain: string;
  commentHtml: string;
  commentText: string;
  submitStatus: string;
  source: 'legacy' | 'live';
  createdAt: number;
  updatedAt: number;
  revision: CommentRevision;
}

interface CommentAnchor {
  id: string;
  commentId: string;
  position: number;
  anchorText: string;
  anchorTextNormalized: string;
  hrefRaw: string;
  hrefResolved: string;
  hrefDomain: string;
}

export interface CommentMutation {
  mutationId: string;
  entityType: 'comment';
  entityId: string;
  operation: 'upsert';
  payload: {
    comment: CommentRecord;
    anchors: CommentAnchor[];
  };
  createdAt: number;
}

export interface CommentDeleteMutation {
  mutationId: string;
  entityType: 'comment_delete';
  entityId: string;
  operation: 'delete';
  payload: {
    deletedAt: number;
  };
  createdAt: number;
}

export interface SettingMutation {
  mutationId: string;
  entityType: 'setting';
  entityId: string;
  operation: 'upsert';
  payload: {
    value: unknown;
  };
  createdAt: number;
}

type IncomingMutation =
  | CommentMutation
  | CommentDeleteMutation
  | SettingMutation;

type ApplicableMutation =
  | CommentMutation
  | CommentDeleteMutation
  | SettingMutation;

export type MutationReceipt =
  | {
      mutationId: string;
      status: 'applied';
      serverSeq: number;
    }
  | {
      mutationId: string;
      status: 'duplicate';
      serverSeq: number | null;
    }
  | {
      mutationId: string;
      status: 'stale';
      serverSeq: number | null;
    }
  | {
      mutationId: string;
      status: 'rejected';
      errorCode: string;
    };

interface StoredReceipt {
  result_status: string;
  server_seq: number | null;
}

type PreparedMutation =
  | {
      kind: 'apply';
      mutation: ApplicableMutation;
    }
  | {
      kind: 'rejected';
      receipt: {
        mutationId: string;
        status: 'rejected';
        errorCode: string;
      };
    };

function invalid(code: string): never {
  throw new MutationValidationError(code);
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  code: string
): Record<string, unknown> {
  if (!isJsonObject(value)) invalid(code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(code);
  return value;
}

function stringValue(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  code: string,
  trim = false
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    (trim && value.trim() !== value)
  ) {
    invalid(code);
  }
  return value;
}

function printableAsciiValue(
  value: unknown,
  maximumLength: number,
  code: string
): string {
  const string = stringValue(
    value,
    1,
    maximumLength,
    code,
    true
  );
  if (!/^[\x20-\x7e]+$/u.test(string)) invalid(code);
  return string;
}

function integerValue(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(code);
  }
  return value;
}

function normalizeRevision(comment: Record<string, unknown>): CommentRevision {
  if (Object.hasOwn(comment, 'historyRevision')) {
    const explicit = exactObject(
      comment.historyRevision,
      ['capturedAt', 'recordedAt', 'sequence', 'id'],
      'INVALID_COMMENT_REVISION'
    );
    integerValue(
      explicit.capturedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    );
    integerValue(
      explicit.recordedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    );
    integerValue(
      explicit.sequence,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    );
    printableAsciiValue(
      explicit.id,
      MAX_ID_LENGTH,
      'INVALID_COMMENT_REVISION'
    );
  }
  const normalized: unknown = normalizeCommentRevision(comment);
  const revision = exactObject(
    normalized,
    ['capturedAt', 'recordedAt', 'sequence', 'id'],
    'INVALID_COMMENT_REVISION'
  );
  return {
    capturedAt: integerValue(
      revision.capturedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    ),
    recordedAt: integerValue(
      revision.recordedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    ),
    sequence: integerValue(
      revision.sequence,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT_REVISION'
    ),
    id: printableAsciiValue(
      revision.id,
      MAX_REVISION_ID_LENGTH,
      'INVALID_COMMENT_REVISION'
    )
  };
}

function parseComment(
  value: unknown,
  entityId: string
): CommentRecord {
  const comment = exactObject(value, COMMENT_KEYS, 'INVALID_COMMENT');
  const id = stringValue(
    comment.id,
    1,
    MAX_ID_LENGTH,
    'INVALID_COMMENT',
    true
  );
  const batchId = stringValue(
    comment.batchId,
    1,
    MAX_BATCH_ID_LENGTH,
    'INVALID_COMMENT',
    true
  );
  const urlIndex = integerValue(
    comment.urlIndex,
    0,
    Number.MAX_SAFE_INTEGER,
    'INVALID_COMMENT'
  );
  if (id !== entityId) {
    invalid('INVALID_COMMENT');
  }

  const archiveMonth = stringValue(
    comment.archiveMonth,
    7,
    7,
    'INVALID_COMMENT'
  );
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(archiveMonth)) {
    invalid('INVALID_COMMENT');
  }
  const source = comment.source;
  if (source !== 'legacy' && source !== 'live') invalid('INVALID_COMMENT');

  return {
    id,
    batchId,
    urlIndex,
    submittedAt: integerValue(
      comment.submittedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT'
    ),
    archiveMonth,
    targetPageUrl: stringValue(
      comment.targetPageUrl,
      1,
      MAX_URL_LENGTH,
      'INVALID_COMMENT'
    ),
    targetDomain: stringValue(
      comment.targetDomain,
      0,
      MAX_DOMAIN_LENGTH,
      'INVALID_COMMENT'
    ),
    promotedWebsiteUrl: stringValue(
      comment.promotedWebsiteUrl,
      0,
      MAX_URL_LENGTH,
      'INVALID_COMMENT'
    ),
    promotedDomain: stringValue(
      comment.promotedDomain,
      0,
      MAX_DOMAIN_LENGTH,
      'INVALID_COMMENT'
    ),
    commentHtml: stringValue(
      comment.commentHtml,
      0,
      MAX_COMMENT_HTML_LENGTH,
      'INVALID_COMMENT'
    ),
    commentText: stringValue(
      comment.commentText,
      0,
      MAX_COMMENT_TEXT_LENGTH,
      'INVALID_COMMENT'
    ),
    submitStatus: stringValue(
      comment.submitStatus,
      1,
      MAX_STATUS_LENGTH,
      'INVALID_COMMENT',
      true
    ),
    source,
    createdAt: integerValue(
      comment.createdAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT'
    ),
    updatedAt: integerValue(
      comment.updatedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_COMMENT'
    ),
    revision: normalizeRevision(comment)
  };
}

function parseAnchors(
  value: unknown,
  commentId: string
): CommentAnchor[] {
  if (!Array.isArray(value) || value.length > MAX_ANCHORS) {
    invalid('INVALID_COMMENT_ANCHORS');
  }
  return value.map((input, index) => {
    const anchor = exactObject(
      input,
      ANCHOR_KEYS,
      'INVALID_COMMENT_ANCHOR'
    );
    const position = integerValue(
      anchor.position,
      0,
      MAX_ANCHORS - 1,
      'INVALID_COMMENT_ANCHOR'
    );
    const id = stringValue(
      anchor.id,
      1,
      MAX_ID_LENGTH,
      'INVALID_COMMENT_ANCHOR',
      true
    );
    const storedCommentId = stringValue(
      anchor.commentId,
      1,
      MAX_ID_LENGTH,
      'INVALID_COMMENT_ANCHOR',
      true
    );
    if (
      position !== index ||
      storedCommentId !== commentId ||
      id !== `${commentId}:${position}`
    ) {
      invalid('INVALID_COMMENT_ANCHOR');
    }

    const anchorText = stringValue(
      anchor.anchorText,
      0,
      MAX_ANCHOR_TEXT_LENGTH,
      'INVALID_COMMENT_ANCHOR'
    );
    const anchorTextNormalized = stringValue(
      anchor.anchorTextNormalized,
      0,
      MAX_ANCHOR_TEXT_LENGTH,
      'INVALID_COMMENT_ANCHOR'
    );
    if (anchorTextNormalized !== anchorText.toLowerCase()) {
      invalid('INVALID_COMMENT_ANCHOR');
    }
    return {
      id,
      commentId: storedCommentId,
      position,
      anchorText,
      anchorTextNormalized,
      hrefRaw: stringValue(
        anchor.hrefRaw,
        0,
        MAX_URL_LENGTH,
        'INVALID_COMMENT_ANCHOR'
      ),
      hrefResolved: stringValue(
        anchor.hrefResolved,
        0,
        MAX_URL_LENGTH,
        'INVALID_COMMENT_ANCHOR'
      ),
      hrefDomain: stringValue(
        anchor.hrefDomain,
        0,
        MAX_DOMAIN_LENGTH,
        'INVALID_COMMENT_ANCHOR'
      )
    };
  });
}

function protocolErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'INVALID_MUTATION';
}

function parseMutation(input: unknown): IncomingMutation {
  let normalized: unknown;
  try {
    normalized = normalizeSyncMutation(input);
  } catch (error) {
    invalid(protocolErrorCode(error));
  }

  const mutation = exactObject(
    normalized,
    [
      'mutationId',
      'entityType',
      'entityId',
      'operation',
      'payload',
      'createdAt'
    ],
    'INVALID_MUTATION'
  );
  const mutationId = stringValue(
    mutation.mutationId,
    1,
    MAX_ID_LENGTH,
    'INVALID_MUTATION_ID',
    true
  );
  const entityId = stringValue(
    mutation.entityId,
    1,
    MAX_ID_LENGTH,
    'INVALID_ENTITY_ID',
    true
  );
  integerValue(
    mutation.createdAt,
    0,
    Number.MAX_SAFE_INTEGER,
    'INVALID_MUTATION_TIMESTAMP'
  );

  if (mutation.entityType === 'setting') {
    if (mutation.operation !== 'upsert') {
      invalid('INVALID_MUTATION_OPERATION');
    }
    const payload = exactObject(
      mutation.payload,
      ['value'],
      'INVALID_MUTATION_PAYLOAD'
    );
    if (!Object.hasOwn(payload, 'value')) {
      invalid('INVALID_MUTATION_PAYLOAD');
    }
    if (
      new TextEncoder().encode(canonicalJson(payload.value)).byteLength >
      MAX_SETTING_VALUE_JSON_BYTES
    ) {
      invalid('SETTING_VALUE_TOO_LARGE');
    }
    return {
      mutationId,
      entityType: 'setting',
      entityId,
      operation: 'upsert',
      payload: {
        value: payload.value
      },
      createdAt: integerValue(
        mutation.createdAt,
        0,
        Number.MAX_SAFE_INTEGER,
        'INVALID_MUTATION_TIMESTAMP'
      )
    };
  }
  if (mutation.entityType === 'comment_delete') {
    if (mutation.operation !== 'delete') {
      invalid('INVALID_MUTATION_OPERATION');
    }
    const payload = exactObject(
      mutation.payload,
      ['deletedAt'],
      'INVALID_MUTATION_PAYLOAD'
    );
    const createdAt = integerValue(
      mutation.createdAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_MUTATION_TIMESTAMP'
    );
    return {
      mutationId,
      entityType: 'comment_delete',
      entityId,
      operation: 'delete',
      payload: {
        deletedAt: Object.hasOwn(payload, 'deletedAt')
          ? integerValue(
              payload.deletedAt,
              0,
              Number.MAX_SAFE_INTEGER,
              'INVALID_MUTATION_TIMESTAMP'
            )
          : createdAt
      },
      createdAt
    };
  }
  if (mutation.entityType !== 'comment') {
    invalid('INVALID_ENTITY_TYPE');
  }
  if (mutation.operation !== 'upsert') {
    invalid('INVALID_MUTATION_OPERATION');
  }
  const payload = exactObject(
    mutation.payload,
    ['comment', 'anchors'],
    'INVALID_MUTATION_PAYLOAD'
  );
  const comment = parseComment(payload.comment, entityId);
  return {
    mutationId,
    entityType: 'comment',
    entityId,
    operation: 'upsert',
    payload: {
      comment,
      anchors: parseAnchors(payload.anchors, comment.id)
    },
    createdAt: integerValue(
      mutation.createdAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_MUTATION_TIMESTAMP'
    )
  };
}

function sourceRank(source: CommentRecord['source']): number {
  return source === 'legacy' ? 0 : 1;
}

function mutationBatchStatementCount(
  mutation: ApplicableMutation
): number {
  if (mutation.entityType === 'comment') {
    return COMMENT_FIXED_BATCH_STATEMENTS + mutation.payload.anchors.length;
  }
  return mutation.entityType === 'setting'
    ? SETTING_BATCH_STATEMENTS
    : COMMENT_DELETE_BATCH_STATEMENTS;
}

function mutationQueryCost(
  mutation: ApplicableMutation
): number {
  return (
    mutationBatchStatementCount(mutation) +
    RECEIPT_READ_QUERY_COST
  );
}

function pushQueryCost(prepared: PreparedMutation[]): number {
  let cost =
    AUTH_QUERY_COST + MISSING_RECEIPT_DIAGNOSTIC_RESERVE;
  for (const item of prepared) {
    if (item.kind === 'apply') {
      cost += mutationQueryCost(item.mutation);
    }
  }
  return cost;
}

function assertBatchStatementCount(
  mutation: ApplicableMutation,
  statements: D1PreparedStatement[]
): void {
  if (
    statements.length !== mutationBatchStatementCount(mutation)
  ) {
    fail('INTERNAL_ERROR', 500, true);
  }
}

function commentUpsertStatement(
  env: Env,
  vaultId: string,
  mutation: CommentMutation,
  now: number
): D1PreparedStatement {
  const comment = mutation.payload.comment;
  const revision = comment.revision;
  return env.DB.prepare(
    `INSERT INTO comment_records (
       vault_id, record_id, batch_id, url_index, submitted_at, archive_month,
       target_page_url, target_domain, promoted_website_url, promoted_domain,
       comment_html, comment_text, submit_status, source, created_at, updated_at,
       revision_source_rank, revision_captured_at, revision_recorded_at,
       revision_sequence, revision_id, accepted_mutation_id, cloud_created_at,
       cloud_updated_at
     )
     SELECT active_vault.vault_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM comment_tombstones
         WHERE vault_id = ? AND record_id = ?
       )
     ON CONFLICT(vault_id, record_id) DO UPDATE SET
       batch_id = excluded.batch_id,
       url_index = excluded.url_index,
       submitted_at = excluded.submitted_at,
       archive_month = excluded.archive_month,
       target_page_url = excluded.target_page_url,
       target_domain = excluded.target_domain,
       promoted_website_url = excluded.promoted_website_url,
       promoted_domain = excluded.promoted_domain,
       comment_html = excluded.comment_html,
       comment_text = excluded.comment_text,
       submit_status = excluded.submit_status,
       source = excluded.source,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       accepted_mutation_id = excluded.accepted_mutation_id,
       revision_source_rank = excluded.revision_source_rank,
       revision_captured_at = excluded.revision_captured_at,
       revision_recorded_at = excluded.revision_recorded_at,
       revision_sequence = excluded.revision_sequence,
       revision_id = excluded.revision_id,
       cloud_updated_at = excluded.cloud_updated_at
     WHERE
       excluded.revision_source_rank > comment_records.revision_source_rank
       OR (
         excluded.revision_source_rank = comment_records.revision_source_rank
         AND excluded.revision_captured_at >
           comment_records.revision_captured_at
       )
       OR (
         excluded.revision_source_rank = comment_records.revision_source_rank
         AND excluded.revision_captured_at =
           comment_records.revision_captured_at
         AND excluded.revision_recorded_at >
           comment_records.revision_recorded_at
       )
       OR (
         excluded.revision_source_rank = comment_records.revision_source_rank
         AND excluded.revision_captured_at =
           comment_records.revision_captured_at
         AND excluded.revision_recorded_at =
           comment_records.revision_recorded_at
         AND excluded.revision_sequence > comment_records.revision_sequence
       )
       OR (
         excluded.revision_source_rank = comment_records.revision_source_rank
         AND excluded.revision_captured_at =
           comment_records.revision_captured_at
         AND excluded.revision_recorded_at =
           comment_records.revision_recorded_at
         AND excluded.revision_sequence =
           comment_records.revision_sequence
         AND excluded.revision_id > comment_records.revision_id
       )`
  ).bind(
    comment.id,
    comment.batchId,
    comment.urlIndex,
    comment.submittedAt,
    comment.archiveMonth,
    comment.targetPageUrl,
    comment.targetDomain,
    comment.promotedWebsiteUrl,
    comment.promotedDomain,
    comment.commentHtml,
    comment.commentText,
    comment.submitStatus,
    comment.source,
    comment.createdAt,
    comment.updatedAt,
    sourceRank(comment.source),
    revision.capturedAt,
    revision.recordedAt,
    revision.sequence,
    revision.id,
    mutation.mutationId,
    now,
    now,
    vaultId,
    vaultId,
    mutation.mutationId,
    vaultId,
    mutation.entityId
  );
}

function deleteAcceptedAnchorsStatement(
  env: Env,
  vaultId: string,
  mutation: CommentMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM comment_anchors
     WHERE vault_id = ? AND comment_id = ?
       AND EXISTS (
         SELECT 1
         FROM sync_vaults AS active_vault
         JOIN comment_records AS accepted_comment
           ON accepted_comment.vault_id = active_vault.vault_id
          AND accepted_comment.record_id = ?
          AND accepted_comment.accepted_mutation_id = ?
         WHERE active_vault.vault_id = ?
           AND active_vault.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM sync_mutations
             WHERE vault_id = ? AND mutation_id = ?
           )
       )`
  ).bind(
    vaultId,
    mutation.entityId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    vaultId,
    mutation.mutationId
  );
}

function insertAcceptedAnchorStatement(
  env: Env,
  vaultId: string,
  mutation: CommentMutation,
  anchor: CommentAnchor
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO comment_anchors (
       vault_id, anchor_id, comment_id, position, anchor_text,
       anchor_text_normalized, href_raw, href_resolved, href_domain
     )
     SELECT active_vault.vault_id, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sync_vaults AS active_vault
     JOIN comment_records AS accepted_comment
       ON accepted_comment.vault_id = active_vault.vault_id
      AND accepted_comment.record_id = ?
      AND accepted_comment.accepted_mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    anchor.id,
    anchor.commentId,
    anchor.position,
    anchor.anchorText,
    anchor.anchorTextNormalized,
    anchor.hrefRaw,
    anchor.hrefResolved,
    anchor.hrefDomain,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    vaultId,
    mutation.mutationId
  );
}

function insertCommentChangeStatement(
  env: Env,
  vaultId: string,
  mutation: CommentMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_changes (
       vault_id, mutation_id, entity_type, entity_id, operation, created_at
     )
     SELECT active_vault.vault_id, ?, 'comment', ?, 'upsert', ?
     FROM sync_vaults AS active_vault
     JOIN comment_records AS accepted_comment
       ON accepted_comment.vault_id = active_vault.vault_id
      AND accepted_comment.record_id = ?
      AND accepted_comment.accepted_mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    now,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    vaultId,
    mutation.mutationId
  );
}

function insertCommentReceiptStatement(
  env: Env,
  vaultId: string,
  mutation: CommentMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_mutations (
       vault_id, mutation_id, entity_type, entity_id, result_status,
       server_seq, processed_at
     )
     SELECT active_vault.vault_id, ?, 'comment', ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM sync_changes
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       ) THEN 'applied' ELSE 'stale' END,
       COALESCE(
         (
           SELECT server_seq FROM sync_changes
           WHERE vault_id = active_vault.vault_id AND mutation_id = ?
         ),
         (
           SELECT accepted_change.server_seq
           FROM comment_records AS current_comment
           JOIN sync_changes AS accepted_change
             ON accepted_change.vault_id = current_comment.vault_id
            AND accepted_change.mutation_id =
              current_comment.accepted_mutation_id
           WHERE current_comment.vault_id = active_vault.vault_id
             AND current_comment.record_id = ?
         ),
         (
           SELECT server_seq FROM comment_tombstones
           WHERE vault_id = active_vault.vault_id AND record_id = ?
         )
       ),
       ?
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    mutation.mutationId,
    mutation.mutationId,
    mutation.entityId,
    mutation.entityId,
    now,
    vaultId,
    mutation.mutationId
  );
}

async function readStoredReceipt(
  env: Env,
  vaultId: string,
  mutationId: string
): Promise<StoredReceipt | null> {
  return env.DB.prepare(
    `SELECT stored_mutation.result_status, stored_mutation.server_seq
     FROM sync_mutations AS stored_mutation
     JOIN sync_vaults AS active_vault
       ON active_vault.vault_id = stored_mutation.vault_id
      AND active_vault.deleted_at IS NULL
     WHERE stored_mutation.vault_id = ?
       AND stored_mutation.mutation_id = ?`
  )
    .bind(vaultId, mutationId)
    .first<StoredReceipt>();
}

async function failForMissingReceipt(
  env: Env,
  vaultId: string
): Promise<never> {
  const vault = await env.DB.prepare(
    `SELECT deleted_at FROM sync_vaults WHERE vault_id = ?`
  )
    .bind(vaultId)
    .first<{ deleted_at: number | null }>();
  if (!vault || vault.deleted_at !== null) fail('VAULT_DELETED', 403);
  fail('INTERNAL_ERROR', 500, true);
}

function mutationReceipt(
  mutationId: string,
  stored: StoredReceipt,
  inserted: boolean
): MutationReceipt {
  if (!inserted) {
    return {
      mutationId,
      status: 'duplicate',
      serverSeq: stored.server_seq
    };
  }
  if (stored.result_status === 'applied') {
    if (stored.server_seq === null) fail('INTERNAL_ERROR', 500, true);
    return {
      mutationId,
      status: 'applied',
      serverSeq: stored.server_seq
    };
  }
  if (stored.result_status !== 'stale') {
    fail('INTERNAL_ERROR', 500, true);
  }
  return {
    mutationId,
    status: 'stale',
    serverSeq: stored.server_seq
  };
}

export async function applyCommentMutation(
  env: Env,
  vaultId: string,
  mutation: CommentMutation,
  now: number
): Promise<MutationReceipt> {
  const statements: D1PreparedStatement[] = [
    commentUpsertStatement(env, vaultId, mutation, now),
    deleteAcceptedAnchorsStatement(env, vaultId, mutation),
    ...mutation.payload.anchors.map((anchor) =>
      insertAcceptedAnchorStatement(env, vaultId, mutation, anchor)
    ),
    insertCommentChangeStatement(env, vaultId, mutation, now)
  ];
  const receiptIndex = statements.length;
  statements.push(
    insertCommentReceiptStatement(env, vaultId, mutation, now)
  );
  assertBatchStatementCount(mutation, statements);

  const batch = await env.DB.batch(statements);
  const inserted =
    batch[receiptIndex]?.meta.changes === 1;
  const stored = await readStoredReceipt(
    env,
    vaultId,
    mutation.mutationId
  );
  if (!stored) return failForMissingReceipt(env, vaultId);
  return mutationReceipt(mutation.mutationId, stored, inserted);
}

function insertTombstoneStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO comment_tombstones (
       vault_id, record_id, mutation_id, deleted_at, server_seq
     )
     SELECT active_vault.vault_id, ?, ?, ?, NULL
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM comment_tombstones
         WHERE vault_id = active_vault.vault_id AND record_id = ?
       )`
  ).bind(
    mutation.entityId,
    mutation.mutationId,
    mutation.payload.deletedAt,
    vaultId,
    mutation.mutationId,
    mutation.entityId
  );
}

function deleteTombstonedAnchorsStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM comment_anchors
     WHERE vault_id = ? AND comment_id = ?
       AND EXISTS (
         SELECT 1
         FROM sync_vaults AS active_vault
         JOIN comment_tombstones AS accepted_tombstone
           ON accepted_tombstone.vault_id = active_vault.vault_id
          AND accepted_tombstone.record_id = ?
          AND accepted_tombstone.mutation_id = ?
         WHERE active_vault.vault_id = ?
           AND active_vault.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM sync_mutations
             WHERE vault_id = active_vault.vault_id AND mutation_id = ?
           )
       )`
  ).bind(
    vaultId,
    mutation.entityId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
}

function deleteTombstonedCommentStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM comment_records
     WHERE vault_id = ? AND record_id = ?
       AND EXISTS (
         SELECT 1
         FROM sync_vaults AS active_vault
         JOIN comment_tombstones AS accepted_tombstone
           ON accepted_tombstone.vault_id = active_vault.vault_id
          AND accepted_tombstone.record_id = ?
          AND accepted_tombstone.mutation_id = ?
         WHERE active_vault.vault_id = ?
           AND active_vault.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM sync_mutations
             WHERE vault_id = active_vault.vault_id AND mutation_id = ?
           )
       )`
  ).bind(
    vaultId,
    mutation.entityId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
}

function insertDeleteChangeStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_changes (
       vault_id, mutation_id, entity_type, entity_id, operation, created_at
     )
     SELECT active_vault.vault_id, ?, 'comment_delete', ?, 'delete', ?
     FROM sync_vaults AS active_vault
     JOIN comment_tombstones AS accepted_tombstone
       ON accepted_tombstone.vault_id = active_vault.vault_id
      AND accepted_tombstone.record_id = ?
      AND accepted_tombstone.mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    now,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
}

function updateTombstoneSequenceStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE comment_tombstones
     SET server_seq = (
       SELECT server_seq FROM sync_changes
       WHERE vault_id = ? AND mutation_id = ?
     )
     WHERE vault_id = ? AND record_id = ? AND mutation_id = ?
       AND EXISTS (
         SELECT 1 FROM sync_vaults AS active_vault
         WHERE active_vault.vault_id = ?
           AND active_vault.deleted_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    vaultId,
    mutation.mutationId,
    vaultId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    vaultId,
    mutation.mutationId
  );
}

function insertDeleteReceiptStatement(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_mutations (
       vault_id, mutation_id, entity_type, entity_id, result_status,
       server_seq, processed_at
     )
     SELECT active_vault.vault_id, ?, 'comment_delete', ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM sync_changes
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       ) THEN 'applied' ELSE 'stale' END,
       COALESCE(
         (
           SELECT server_seq FROM sync_changes
           WHERE vault_id = active_vault.vault_id AND mutation_id = ?
         ),
         (
           SELECT server_seq FROM comment_tombstones
           WHERE vault_id = active_vault.vault_id AND record_id = ?
         )
       ),
       ?
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    mutation.mutationId,
    mutation.mutationId,
    mutation.entityId,
    now,
    vaultId,
    mutation.mutationId
  );
}

export async function applyCommentDeleteMutation(
  env: Env,
  vaultId: string,
  mutation: CommentDeleteMutation,
  now: number
): Promise<MutationReceipt> {
  const statements = [
    insertTombstoneStatement(env, vaultId, mutation),
    deleteTombstonedAnchorsStatement(env, vaultId, mutation),
    deleteTombstonedCommentStatement(env, vaultId, mutation),
    insertDeleteChangeStatement(env, vaultId, mutation, now),
    updateTombstoneSequenceStatement(env, vaultId, mutation)
  ];
  const receiptIndex = statements.length;
  statements.push(
    insertDeleteReceiptStatement(env, vaultId, mutation, now)
  );
  assertBatchStatementCount(mutation, statements);

  const batch = await env.DB.batch(statements);
  const inserted = batch[receiptIndex]?.meta.changes === 1;
  const stored = await readStoredReceipt(
    env,
    vaultId,
    mutation.mutationId
  );
  if (!stored) return failForMissingReceipt(env, vaultId);
  return mutationReceipt(mutation.mutationId, stored, inserted);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail('INTERNAL_ERROR', 500, true);
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )
    .join(',')}}`;
}

function upsertSettingStatement(
  env: Env,
  vaultId: string,
  mutation: SettingMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO synced_settings (
       vault_id, setting_key, value_json, accepted_mutation_id,
       server_updated_at, server_seq
     )
     SELECT active_vault.vault_id, ?, ?, ?, ?, NULL
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )
     ON CONFLICT(vault_id, setting_key) DO UPDATE SET
       value_json = excluded.value_json,
       accepted_mutation_id = excluded.accepted_mutation_id,
       server_updated_at = excluded.server_updated_at,
       server_seq = NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_mutations
       WHERE vault_id = excluded.vault_id AND mutation_id = ?
     )`
  ).bind(
    mutation.entityId,
    canonicalJson(mutation.payload.value),
    mutation.mutationId,
    now,
    vaultId,
    mutation.mutationId,
    mutation.mutationId
  );
}

function insertSettingChangeStatement(
  env: Env,
  vaultId: string,
  mutation: SettingMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_changes (
       vault_id, mutation_id, entity_type, entity_id, operation, created_at
     )
     SELECT active_vault.vault_id, ?, 'setting', ?, 'upsert', ?
     FROM sync_vaults AS active_vault
     JOIN synced_settings AS accepted_setting
       ON accepted_setting.vault_id = active_vault.vault_id
      AND accepted_setting.setting_key = ?
      AND accepted_setting.accepted_mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    now,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
}

function updateSettingSequenceStatement(
  env: Env,
  vaultId: string,
  mutation: SettingMutation
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE synced_settings
     SET server_seq = (
       SELECT accepted_change.server_seq
       FROM sync_changes AS accepted_change
       WHERE accepted_change.vault_id = ?
         AND accepted_change.mutation_id = ?
     )
     WHERE vault_id = ? AND setting_key = ?
       AND accepted_mutation_id = ?
       AND EXISTS (
         SELECT 1 FROM sync_vaults AS active_vault
         WHERE active_vault.vault_id = ?
           AND active_vault.deleted_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    vaultId,
    mutation.mutationId,
    vaultId,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    vaultId,
    mutation.mutationId
  );
}

function insertSettingReceiptStatement(
  env: Env,
  vaultId: string,
  mutation: SettingMutation,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sync_mutations (
       vault_id, mutation_id, entity_type, entity_id, result_status,
       server_seq, processed_at
     )
     SELECT active_vault.vault_id, ?, 'setting', ?, 'applied',
       accepted_change.server_seq, ?
     FROM sync_vaults AS active_vault
     JOIN sync_changes AS accepted_change
       ON accepted_change.vault_id = active_vault.vault_id
      AND accepted_change.mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityId,
    now,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
}

export async function applySettingMutation(
  env: Env,
  vaultId: string,
  mutation: SettingMutation,
  now: number
): Promise<MutationReceipt> {
  const statements = [
    upsertSettingStatement(env, vaultId, mutation, now),
    insertSettingChangeStatement(env, vaultId, mutation, now),
    updateSettingSequenceStatement(env, vaultId, mutation)
  ];
  const receiptIndex = statements.length;
  statements.push(
    insertSettingReceiptStatement(env, vaultId, mutation, now)
  );
  assertBatchStatementCount(mutation, statements);

  const batch = await env.DB.batch(statements);
  const inserted = batch[receiptIndex]?.meta.changes === 1;
  const stored = await readStoredReceipt(
    env,
    vaultId,
    mutation.mutationId
  );
  if (!stored) return failForMissingReceipt(env, vaultId);
  return mutationReceipt(mutation.mutationId, stored, inserted);
}

function rejectedMutationId(input: unknown): string {
  if (
    isJsonObject(input) &&
    typeof input.mutationId === 'string'
  ) {
    return input.mutationId;
  }
  return '';
}

function prepareMutation(input: unknown): PreparedMutation {
  try {
    const mutation = parseMutation(input);
    return {
      kind: 'apply',
      mutation
    };
  } catch (error) {
    if (!(error instanceof MutationValidationError)) throw error;
    return {
      kind: 'rejected',
      receipt: {
        mutationId: rejectedMutationId(input),
        status: 'rejected',
        errorCode: error.code
      }
    };
  }
}

function batchError(
  code: string,
  requestId: string
): Response {
  const messages: Record<string, string> = {
    INVALID_MUTATION_BATCH: 'The mutation batch is invalid.',
    DUPLICATE_MUTATION_ID:
      'Mutation identifiers must be unique within one request.',
    MUTATION_QUERY_BUDGET_EXCEEDED:
      'The mutation batch exceeds the database query budget.',
    INVALID_DEVICE_ID: 'The device identifier is invalid.',
    INVALID_REQUEST: 'The request is invalid.'
  };
  return json(
    {
      ok: false,
      error: {
        code,
        message: messages[code] ?? messages.INVALID_REQUEST,
        retryable: false
      },
      requestId
    },
    { status: 400 }
  );
}

export async function pushMutations(
  request: Request,
  env: Env,
  vault: AuthenticatedVault,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const rawBody = await readBoundedJson(request, MAX_PUSH_BODY_BYTES);
  if (!isJsonObject(rawBody)) {
    return batchError('INVALID_REQUEST', requestId);
  }
  if (
    Object.keys(rawBody).some(
      (key) => key !== 'deviceId' && key !== 'mutations'
    )
  ) {
    return batchError('INVALID_REQUEST', requestId);
  }
  if (
    typeof rawBody.deviceId !== 'string' ||
    rawBody.deviceId.length < 1 ||
    rawBody.deviceId.length > MAX_DEVICE_ID_LENGTH ||
    rawBody.deviceId.trim() !== rawBody.deviceId
  ) {
    return batchError('INVALID_DEVICE_ID', requestId);
  }
  if (
    !Array.isArray(rawBody.mutations) ||
    rawBody.mutations.length < 1 ||
    rawBody.mutations.length > MAX_MUTATIONS
  ) {
    return batchError('INVALID_MUTATION_BATCH', requestId);
  }

  const batchIds = rawBody.mutations.flatMap((mutation) => {
    if (
      isJsonObject(mutation) &&
      typeof mutation.mutationId === 'string'
    ) {
      return [mutation.mutationId];
    }
    return [];
  });
  if (new Set(batchIds).size !== batchIds.length) {
    return batchError('DUPLICATE_MUTATION_ID', requestId);
  }

  const prepared = rawBody.mutations.map(prepareMutation);
  if (pushQueryCost(prepared) > MAX_D1_QUERY_BUDGET) {
    return batchError(
      'MUTATION_QUERY_BUDGET_EXCEEDED',
      requestId
    );
  }

  const results: MutationReceipt[] = [];
  for (const item of prepared) {
    if (item.kind === 'rejected') {
      results.push(item.receipt);
    } else if (item.mutation.entityType === 'comment_delete') {
      results.push(
        await applyCommentDeleteMutation(
          env,
          vault.vaultId,
          item.mutation,
          Date.now()
        )
      );
    } else if (item.mutation.entityType === 'setting') {
      results.push(
        await applySettingMutation(
          env,
          vault.vaultId,
          item.mutation,
          Date.now()
        )
      );
    } else {
      results.push(
        await applyCommentMutation(
          env,
          vault.vaultId,
          item.mutation,
          Date.now()
        )
      );
    }
  }

  return json({
    ok: true,
    results,
    requestId
  });
}
