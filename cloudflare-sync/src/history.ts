import { type AuthenticatedVault } from './auth';
import { fail, json } from './http';
import {
  applyCommentDeleteMutation,
  type CommentDeleteMutation
} from './push';
import {
  boundedString,
  readBoundedJson,
  rejectUnknownQuery,
  requireJsonObject
} from './validation';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const MAX_ID_LENGTH = 512;
const MAX_DOMAIN_LENGTH = 253;
const MAX_ANCHOR_TEXT_LENGTH = 10_000;
const MAX_DELETE_BODY_BYTES = 4_096;

const HISTORY_QUERY_NAMES = [
  'targetDomain',
  'promotedDomain',
  'anchorTextPrefix',
  'hrefDomain',
  'from',
  'to',
  'cursorSubmittedAt',
  'cursorId',
  'limit'
] as const;

interface HistoryCursor {
  submittedAt: number;
  id: string;
}

interface HistoryQuery {
  targetDomain?: string;
  promotedDomain?: string;
  anchorTextPrefix?: string;
  hrefDomain?: string;
  from?: number;
  to?: number;
  cursor: HistoryCursor | null;
  limit: number;
}

interface StoredHistoryRow {
  record_id: string;
  batch_id: string;
  url_index: number;
  submitted_at: number;
  archive_month: string;
  target_page_url: string;
  target_domain: string;
  promoted_website_url: string;
  promoted_domain: string;
  comment_html: string;
  comment_text: string;
  submit_status: string;
  source: string;
  created_at: number;
  updated_at: number;
  revision_captured_at: number;
  revision_recorded_at: number;
  revision_sequence: number;
  revision_id: string;
  anchors_json: string;
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

function queryValues(url: URL, name: string): string[] {
  return url.searchParams.getAll(name);
}

function optionalQueryString(
  url: URL,
  name: string,
  maximumLength: number
): string | undefined {
  const values = queryValues(url, name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) fail('INVALID_REQUEST', 400);
  const value = boundedString(values[0], 1, maximumLength);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_REQUEST', 400);
  }
  return value;
}

function optionalQueryInteger(
  url: URL,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  const values = queryValues(url, name);
  if (values.length === 0) return undefined;
  if (
    values.length !== 1 ||
    !/^(?:0|[1-9]\d*)$/u.test(values[0] ?? '')
  ) {
    fail('INVALID_REQUEST', 400);
  }
  const value = Number(values[0]);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail('INVALID_REQUEST', 400);
  }
  return value;
}

function normalizedDomain(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (
    normalized.length > MAX_DOMAIN_LENGTH ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(
      normalized
    )
  ) {
    fail('INVALID_REQUEST', 400);
  }
  return normalized;
}

function parseHistoryQuery(url: URL): HistoryQuery {
  rejectUnknownQuery(url, HISTORY_QUERY_NAMES);
  const targetDomain = normalizedDomain(
    optionalQueryString(url, 'targetDomain', MAX_DOMAIN_LENGTH)
  );
  const promotedDomain = normalizedDomain(
    optionalQueryString(url, 'promotedDomain', MAX_DOMAIN_LENGTH)
  );
  const hrefDomain = normalizedDomain(
    optionalQueryString(url, 'hrefDomain', MAX_DOMAIN_LENGTH)
  );
  const rawPrefix = optionalQueryString(
    url,
    'anchorTextPrefix',
    MAX_ANCHOR_TEXT_LENGTH
  );
  const anchorTextPrefix = rawPrefix?.toLowerCase();
  if (
    anchorTextPrefix !== undefined &&
    anchorTextPrefix.length > MAX_ANCHOR_TEXT_LENGTH
  ) {
    fail('INVALID_REQUEST', 400);
  }

  const from = optionalQueryInteger(
    url,
    'from',
    0,
    Number.MAX_SAFE_INTEGER
  );
  const to = optionalQueryInteger(
    url,
    'to',
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (from !== undefined && to !== undefined && from > to) {
    fail('INVALID_REQUEST', 400);
  }

  const cursorSubmittedAt = optionalQueryInteger(
    url,
    'cursorSubmittedAt',
    0,
    Number.MAX_SAFE_INTEGER
  );
  const cursorId = optionalQueryString(url, 'cursorId', MAX_ID_LENGTH);
  if ((cursorSubmittedAt === undefined) !== (cursorId === undefined)) {
    fail('INVALID_REQUEST', 400);
  }

  return {
    ...(targetDomain === undefined ? {} : { targetDomain }),
    ...(promotedDomain === undefined ? {} : { promotedDomain }),
    ...(anchorTextPrefix === undefined ? {} : { anchorTextPrefix }),
    ...(hrefDomain === undefined ? {} : { hrefDomain }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    cursor:
      cursorSubmittedAt === undefined || cursorId === undefined
        ? null
        : { submittedAt: cursorSubmittedAt, id: cursorId },
    limit:
      optionalQueryInteger(url, 'limit', 1, MAX_HISTORY_LIMIT) ??
      DEFAULT_HISTORY_LIMIT
  };
}

function prefixUpperBound(prefix: string): string | null {
  const scalars = Array.from(prefix);
  for (let index = scalars.length - 1; index >= 0; index -= 1) {
    const scalar = scalars[index]!;
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined) fail('INTERNAL_ERROR', 500, true);
    if (codePoint < 0x10ffff) {
      return (
        scalars.slice(0, index).join('') +
        String.fromCodePoint(codePoint + 1)
      );
    }
  }
  return null;
}

async function readHistoryPage(
  database: D1Database,
  vaultId: string,
  query: HistoryQuery
): Promise<StoredHistoryRow[]> {
  const clauses = ['comment.vault_id = ?'];
  const bindings: unknown[] = [vaultId];

  if (query.targetDomain !== undefined) {
    clauses.push('comment.target_domain = ?');
    bindings.push(query.targetDomain);
  }
  if (query.promotedDomain !== undefined) {
    clauses.push('comment.promoted_domain = ?');
    bindings.push(query.promotedDomain);
  }
  if (query.from !== undefined) {
    clauses.push('comment.submitted_at >= ?');
    bindings.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push('comment.submitted_at <= ?');
    bindings.push(query.to);
  }
  if (query.cursor) {
    clauses.push(
      `(comment.submitted_at < ? OR (
         comment.submitted_at = ? AND comment.record_id < ?
       ))`
    );
    bindings.push(
      query.cursor.submittedAt,
      query.cursor.submittedAt,
      query.cursor.id
    );
  }

  if (
    query.anchorTextPrefix !== undefined ||
    query.hrefDomain !== undefined
  ) {
    const anchorClauses = [
      'anchor.vault_id = comment.vault_id',
      'anchor.comment_id = comment.record_id'
    ];
    if (query.anchorTextPrefix !== undefined) {
      const upperBound = prefixUpperBound(query.anchorTextPrefix);
      anchorClauses.push('anchor.anchor_text_normalized >= ?');
      bindings.push(query.anchorTextPrefix);
      if (upperBound !== null) {
        anchorClauses.push('anchor.anchor_text_normalized < ?');
        bindings.push(upperBound);
      }
      anchorClauses.push(
        `substr(anchor.anchor_text_normalized, 1, length(?)) = ?`
      );
      bindings.push(query.anchorTextPrefix, query.anchorTextPrefix);
    }
    if (query.hrefDomain !== undefined) {
      anchorClauses.push('anchor.href_domain = ?');
      bindings.push(query.hrefDomain);
    }
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM comment_anchors AS anchor
         WHERE ${anchorClauses.join('\n           AND ')}
       )`
    );
  }

  bindings.unshift(vaultId);
  bindings.push(query.limit + 1);
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
     WHERE ${clauses.join('\n       AND ')}
     ORDER BY comment.submitted_at DESC, comment.record_id DESC
     LIMIT ?`
  )
    .bind(...bindings)
    .all<StoredHistoryRow>();
  return result.results;
}

function materializeHistoryRow(row: StoredHistoryRow): {
  comment: Record<string, unknown>;
  anchors: StoredAnchor[];
} {
  let anchors: unknown;
  try {
    anchors = JSON.parse(row.anchors_json);
  } catch {
    fail('INTERNAL_ERROR', 500, true);
  }
  if (!Array.isArray(anchors)) fail('INTERNAL_ERROR', 500, true);
  return {
    comment: {
      id: row.record_id,
      batchId: row.batch_id,
      urlIndex: row.url_index,
      submittedAt: row.submitted_at,
      archiveMonth: row.archive_month,
      targetPageUrl: row.target_page_url,
      targetDomain: row.target_domain,
      promotedWebsiteUrl: row.promoted_website_url,
      promotedDomain: row.promoted_domain,
      commentHtml: row.comment_html,
      commentText: row.comment_text,
      submitStatus: row.submit_status,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      historyRevision: {
        capturedAt: row.revision_captured_at,
        recordedAt: row.revision_recorded_at,
        sequence: row.revision_sequence,
        id: row.revision_id
      }
    },
    anchors: anchors as StoredAnchor[]
  };
}

export async function queryHistory(
  request: Request,
  env: Env,
  vault: AuthenticatedVault,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const query = parseHistoryQuery(new URL(request.url));
  const rows = await readHistoryPage(
    env.DB,
    vault.vaultId,
    query
  );
  const pageRows = rows.slice(0, query.limit);
  const records = pageRows.map(materializeHistoryRow);
  const hasMore = rows.length > query.limit;
  const last = pageRows.at(-1);

  return json({
    ok: true,
    records,
    nextCursor:
      hasMore && last
        ? { submittedAt: last.submitted_at, id: last.record_id }
        : null,
    hasMore,
    requestId
  });
}

function recordIdFromPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const prefix = '/v1/history/';
  if (!pathname.startsWith(prefix)) fail('INVALID_REQUEST', 400);
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes('/')) fail('INVALID_REQUEST', 400);

  let recordId: string;
  try {
    recordId = decodeURIComponent(encodedId);
  } catch {
    fail('INVALID_REQUEST', 400);
  }
  if (
    encodeURIComponent(recordId) !== encodedId ||
    /%[0-9a-f]{2}/iu.test(recordId) ||
    /[\u0000-\u001f\u007f]/u.test(recordId)
  ) {
    fail('INVALID_REQUEST', 400);
  }
  return boundedString(recordId, 1, MAX_ID_LENGTH);
}

export async function deleteHistory(
  request: Request,
  env: Env,
  vault: AuthenticatedVault,
  requestId = crypto.randomUUID()
): Promise<Response> {
  const recordId = recordIdFromPath(request);
  const body = requireJsonObject(
    await readBoundedJson(request, MAX_DELETE_BODY_BYTES),
    ['mutationId']
  );
  const mutationId = boundedString(
    body.mutationId,
    1,
    MAX_ID_LENGTH
  );
  if (/[\u0000-\u001f\u007f]/u.test(mutationId)) {
    fail('INVALID_REQUEST', 400);
  }
  const now = Date.now();
  const mutation: CommentDeleteMutation = {
    mutationId,
    entityType: 'comment_delete',
    entityId: recordId,
    operation: 'delete',
    payload: { deletedAt: now },
    createdAt: now
  };
  const receipt = await applyCommentDeleteMutation(
    env,
    vault.vaultId,
    mutation,
    now
  );
  if (
    receipt.status === 'rejected' &&
    receipt.errorCode === 'MUTATION_ID_CONFLICT'
  ) {
    return json(
      {
        ok: false,
        error: {
          code: 'MUTATION_ID_CONFLICT',
          message:
            'The mutation identifier belongs to another entity.',
          retryable: false
        },
        requestId
      },
      { status: 409 }
    );
  }
  return json({
    ok: true,
    ...receipt,
    requestId
  });
}
