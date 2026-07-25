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
const MAX_URL_LENGTH = 8_192;
const MAX_DOMAIN_LENGTH = 253;
const MAX_COMMENT_HTML_LENGTH = 200_000;
const MAX_COMMENT_TEXT_LENGTH = 100_000;
const MAX_STATUS_LENGTH = 64;
const MAX_ANCHOR_TEXT_LENGTH = 10_000;
const MAX_ANCHORS = 1_000;

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

interface UnsupportedMutation {
  mutationId: string;
  entityType: 'setting';
}

type IncomingMutation =
  | CommentMutation
  | CommentDeleteMutation
  | UnsupportedMutation;

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
      MAX_ID_LENGTH,
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
  if (id !== entityId || id !== `${batchId}:${urlIndex}`) {
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
    return {
      mutationId,
      entityType: 'setting'
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

function batchError(
  code: string,
  requestId: string
): Response {
  const messages: Record<string, string> = {
    INVALID_MUTATION_BATCH: 'The mutation batch is invalid.',
    DUPLICATE_MUTATION_ID:
      'Mutation identifiers must be unique within one request.',
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

  const results: MutationReceipt[] = [];
  for (const input of rawBody.mutations) {
    try {
      const mutation = parseMutation(input);
      if (mutation.entityType === 'setting') {
        results.push({
          mutationId: mutation.mutationId,
          status: 'rejected',
          errorCode: 'UNSUPPORTED_ENTITY_TYPE'
        });
      } else if (mutation.entityType === 'comment_delete') {
        results.push(
          await applyCommentDeleteMutation(
            env,
            vault.vaultId,
            mutation,
            Date.now()
          )
        );
      } else {
        results.push(
          await applyCommentMutation(
            env,
            vault.vaultId,
            mutation,
            Date.now()
          )
        );
      }
    } catch (error) {
      if (!(error instanceof MutationValidationError)) throw error;
      results.push({
        mutationId: rejectedMutationId(input),
        status: 'rejected',
        errorCode: error.code
      });
    }
  }

  return json({
    ok: true,
    results,
    requestId
  });
}
