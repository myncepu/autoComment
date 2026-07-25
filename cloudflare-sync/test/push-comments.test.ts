import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';

import {
  authHeaders,
  seedVault,
  VALID_VAULT_ID
} from './fixtures';
import { requireVault } from '../src/auth';
import { pushMutations } from '../src/push';

const ALLOWED_ORIGIN = 'chrome-extension://allowed-extension';

interface AnchorInput {
  position: number;
  anchorText: string;
  hrefDomain: string;
  id?: string;
  commentId?: string;
}

interface CommentMutationOptions {
  mutationId: string;
  recordId?: string;
  revisionId?: string;
  capturedAt?: number;
  recordedAt?: number;
  sequence?: number;
  commentText?: string;
  batchId?: string;
  urlIndex?: number;
  source?: 'legacy' | 'live';
  includeHistoryRevision?: boolean;
  anchors?: AnchorInput[];
}

interface PushResult {
  mutationId: string;
  status: 'applied' | 'duplicate' | 'stale' | 'rejected';
  serverSeq?: number | null;
  errorCode?: string;
}

interface PushResponse {
  ok: boolean;
  results: PushResult[];
  requestId: string;
}

function commentMutation({
  mutationId,
  recordId,
  revisionId = 'revision-1',
  capturedAt = 100,
  recordedAt = capturedAt,
  sequence = 0,
  commentText = 'exact body',
  batchId = 'batch-a',
  urlIndex = 1,
  source = 'live',
  includeHistoryRevision = true,
  anchors = []
}: CommentMutationOptions) {
  const effectiveRecordId = recordId ?? `${batchId}:${urlIndex}`;
  return {
    mutationId,
    entityType: 'comment',
    entityId: effectiveRecordId,
    operation: 'upsert',
    payload: {
      comment: {
        id: effectiveRecordId,
        batchId,
        urlIndex,
        submittedAt: 1_721_000_000_000,
        archiveMonth: '2024-07',
        targetPageUrl: 'https://target.test/post',
        targetDomain: 'target.test',
        promotedWebsiteUrl: 'https://promoted.test/',
        promotedDomain: 'promoted.test',
        commentHtml: `<p>${commentText}</p>`,
        commentText,
        submitStatus: 'submitted',
        source,
        createdAt: 1_721_000_000_001,
        updatedAt: 1_721_000_000_002,
        ...(includeHistoryRevision
          ? {
              historyRevision: {
                capturedAt,
                recordedAt,
                sequence,
                id: revisionId
              }
            }
          : {})
      },
      anchors: anchors.map((anchor) => ({
        id: anchor.id ?? `${effectiveRecordId}:${anchor.position}`,
        commentId: anchor.commentId ?? effectiveRecordId,
        position: anchor.position,
        anchorText: anchor.anchorText,
        anchorTextNormalized: anchor.anchorText.toLowerCase(),
        hrefRaw: `https://${anchor.hrefDomain}/raw`,
        hrefResolved: `https://${anchor.hrefDomain}/raw`,
        hrefDomain: anchor.hrefDomain
      }))
    },
    createdAt: 1_721_000_000_003
  };
}

function mutationAnchors(
  mutationIndex: number,
  count: number
): AnchorInput[] {
  return Array.from({ length: count }, (_, position) => ({
    position,
    anchorText: `Anchor ${mutationIndex}-${position}`,
    hrefDomain: `anchor-${mutationIndex}-${position}.test`
  }));
}

function commentDeleteMutation(
  mutationId: string,
  recordId = 'batch-a:1',
  deletedAt = 1_721_000_000_004
) {
  return {
    mutationId,
    entityType: 'comment_delete',
    entityId: recordId,
    operation: 'delete',
    payload: { deletedAt },
    createdAt: deletedAt
  };
}

function pushResponse(
  mutations: unknown[],
  bodyOverrides: Record<string, unknown> = {}
): Promise<Response> {
  return SELF.fetch(
    'https://worker.test/v1/sync/push',
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        Origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({
        deviceId: 'device-push-comments',
        mutations,
        ...bodyOverrides
      })
    }
  );
}

async function push(mutations: unknown[]): Promise<PushResponse> {
  const response = await pushResponse(mutations);
  expect(response.status).toBe(200);
  return response.json<PushResponse>();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM comment_anchors'),
    env.DB.prepare('DELETE FROM comment_records'),
    env.DB.prepare('DELETE FROM synced_settings'),
    env.DB.prepare('DELETE FROM comment_tombstones'),
    env.DB.prepare('DELETE FROM sync_devices'),
    env.DB.prepare('DELETE FROM sync_changes'),
    env.DB.prepare('DELETE FROM sync_mutations'),
    env.DB.prepare('DELETE FROM sync_vaults'),
    env.DB.prepare(
      "DELETE FROM sqlite_sequence WHERE name = 'sync_changes'"
    )
  ]);
  await seedVault();
});

test('applies one exact comment atomically and makes its mutation replay idempotent', async () => {
  const mutation = commentMutation({
    mutationId: 'comment-mutation-1',
    recordId: 'batch-a:1',
    revisionId: 'revision-1',
    commentText: 'exact body',
    anchors: [
      { position: 0, anchorText: 'One', hrefDomain: 'one.test' },
      { position: 1, anchorText: 'Two', hrefDomain: 'two.test' }
    ]
  });

  const first = await push([mutation]);
  expect(first.results).toEqual([
    {
      mutationId: 'comment-mutation-1',
      status: 'applied',
      serverSeq: 1
    }
  ]);

  const comment = await env.DB.prepare(
    `SELECT record_id, batch_id, url_index, submitted_at, archive_month,
       target_page_url, target_domain, promoted_website_url, promoted_domain,
       comment_html, comment_text, submit_status, source, created_at, updated_at,
       revision_source_rank, revision_captured_at, revision_recorded_at,
       revision_sequence, revision_id, accepted_mutation_id
     FROM comment_records
     WHERE vault_id = ? AND record_id = ?`
  )
    .bind(VALID_VAULT_ID, 'batch-a:1')
    .first();
  expect(comment).toEqual({
    record_id: 'batch-a:1',
    batch_id: 'batch-a',
    url_index: 1,
    submitted_at: 1_721_000_000_000,
    archive_month: '2024-07',
    target_page_url: 'https://target.test/post',
    target_domain: 'target.test',
    promoted_website_url: 'https://promoted.test/',
    promoted_domain: 'promoted.test',
    comment_html: '<p>exact body</p>',
    comment_text: 'exact body',
    submit_status: 'submitted',
    source: 'live',
    created_at: 1_721_000_000_001,
    updated_at: 1_721_000_000_002,
    revision_source_rank: 1,
    revision_captured_at: 100,
    revision_recorded_at: 100,
    revision_sequence: 0,
    revision_id: 'revision-1',
    accepted_mutation_id: 'comment-mutation-1'
  });

  const anchors = await env.DB.prepare(
    `SELECT anchor_id, comment_id, position, anchor_text,
       anchor_text_normalized, href_raw, href_resolved, href_domain
     FROM comment_anchors
     WHERE vault_id = ? AND comment_id = ?
     ORDER BY position`
  )
    .bind(VALID_VAULT_ID, 'batch-a:1')
    .all();
  expect(anchors.results).toEqual([
    {
      anchor_id: 'batch-a:1:0',
      comment_id: 'batch-a:1',
      position: 0,
      anchor_text: 'One',
      anchor_text_normalized: 'one',
      href_raw: 'https://one.test/raw',
      href_resolved: 'https://one.test/raw',
      href_domain: 'one.test'
    },
    {
      anchor_id: 'batch-a:1:1',
      comment_id: 'batch-a:1',
      position: 1,
      anchor_text: 'Two',
      anchor_text_normalized: 'two',
      href_raw: 'https://two.test/raw',
      href_resolved: 'https://two.test/raw',
      href_domain: 'two.test'
    }
  ]);

  const second = await push([mutation]);
  expect(second.results).toEqual([
    {
      mutationId: 'comment-mutation-1',
      status: 'duplicate',
      serverSeq: 1
    }
  ]);

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ? AND record_id = ?) AS comments,
       (SELECT COUNT(*) FROM comment_anchors
          WHERE vault_id = ? AND comment_id = ?) AS anchors,
       (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ? AND mutation_id = ?) AS changes,
       (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ? AND mutation_id = ?) AS receipts`
  )
    .bind(
      VALID_VAULT_ID,
      'batch-a:1',
      VALID_VAULT_ID,
      'batch-a:1',
      VALID_VAULT_ID,
      'comment-mutation-1',
      VALID_VAULT_ID,
      'comment-mutation-1'
    )
    .first();
  expect(counts).toEqual({
    comments: 1,
    anchors: 2,
    changes: 1,
    receipts: 1
  });
});

test('replaces the complete anchor set only for a strictly fresher comment', async () => {
  await push([
    commentMutation({
      mutationId: 'replacement-old',
      capturedAt: 100,
      commentText: 'old body',
      anchors: [
        { position: 0, anchorText: 'Old One', hrefDomain: 'old-one.test' },
        { position: 1, anchorText: 'Old Two', hrefDomain: 'old-two.test' }
      ]
    })
  ]);

  const replacement = await push([
    commentMutation({
      mutationId: 'replacement-new',
      revisionId: 'revision-new',
      capturedAt: 200,
      commentText: 'new body',
      anchors: [
        { position: 0, anchorText: 'New', hrefDomain: 'new.test' }
      ]
    })
  ]);
  expect(replacement.results).toEqual([
    {
      mutationId: 'replacement-new',
      status: 'applied',
      serverSeq: 2
    }
  ]);

  const stale = await push([
    commentMutation({
      mutationId: 'replacement-stale',
      revisionId: 'revision-stale',
      capturedAt: 150,
      commentText: 'stale body',
      anchors: [
        { position: 0, anchorText: 'Stale', hrefDomain: 'stale.test' }
      ]
    })
  ]);
  expect(stale.results).toEqual([
    {
      mutationId: 'replacement-stale',
      status: 'stale',
      serverSeq: 2
    }
  ]);

  const stored = await env.DB.prepare(
    `SELECT comment_text, accepted_mutation_id
     FROM comment_records
     WHERE vault_id = ? AND record_id = ?`
  )
    .bind(VALID_VAULT_ID, 'batch-a:1')
    .first();
  expect(stored).toEqual({
    comment_text: 'new body',
    accepted_mutation_id: 'replacement-new'
  });
  const anchors = await env.DB.prepare(
    `SELECT anchor_text, href_domain
     FROM comment_anchors
     WHERE vault_id = ? AND comment_id = ?
     ORDER BY position`
  )
    .bind(VALID_VAULT_ID, 'batch-a:1')
    .all();
  expect(anchors.results).toEqual([
    { anchor_text: 'New', href_domain: 'new.test' }
  ]);

  const staleReplay = await push([
    commentMutation({
      mutationId: 'replacement-stale',
      revisionId: 'revision-stale',
      capturedAt: 150,
      commentText: 'stale body'
    })
  ]);
  expect(staleReplay.results).toEqual([
    {
      mutationId: 'replacement-stale',
      status: 'duplicate',
      serverSeq: 2
    }
  ]);
});

test('uses source, captured time, recorded time, sequence, and revision id in one freshness order', async () => {
  const receipts = [];
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-live',
          revisionId: 'revision-a',
          capturedAt: 10,
          recordedAt: 10,
          sequence: 0,
          commentText: 'live'
        })
      ])
    ).results[0]
  );
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-legacy',
          revisionId: 'revision-legacy',
          capturedAt: 999,
          recordedAt: 999,
          sequence: 999,
          commentText: 'legacy',
          source: 'legacy'
        })
      ])
    ).results[0]
  );
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-recorded',
          revisionId: 'revision-a',
          capturedAt: 10,
          recordedAt: 11,
          sequence: 0,
          commentText: 'recorded'
        })
      ])
    ).results[0]
  );
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-sequence',
          revisionId: 'revision-a',
          capturedAt: 10,
          recordedAt: 11,
          sequence: 1,
          commentText: 'sequence'
        })
      ])
    ).results[0]
  );
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-id',
          revisionId: 'revision-z',
          capturedAt: 10,
          recordedAt: 11,
          sequence: 1,
          commentText: 'revision id'
        })
      ])
    ).results[0]
  );
  receipts.push(
    (
      await push([
        commentMutation({
          mutationId: 'freshness-equal',
          revisionId: 'revision-z',
          capturedAt: 10,
          recordedAt: 11,
          sequence: 1,
          commentText: 'must not replace'
        })
      ])
    ).results[0]
  );

  expect(receipts.map((receipt) => receipt?.status)).toEqual([
    'applied',
    'stale',
    'applied',
    'applied',
    'applied',
    'stale'
  ]);
  expect(
    (
      await env.DB.prepare(
        `SELECT comment_text FROM comment_records
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'batch-a:1')
        .first<{ comment_text: string }>()
    )?.comment_text
  ).toBe('revision id');
});

test('rejects revision ids whose JavaScript and SQLite byte orders disagree', async () => {
  const result = await push([
    commentMutation({
      mutationId: 'unicode-revision-supplementary',
      revisionId: 'revision-\u{10000}',
      capturedAt: 100,
      recordedAt: 100,
      sequence: 0,
      commentText: 'supplementary revision'
    }),
    commentMutation({
      mutationId: 'unicode-revision-private-use',
      revisionId: 'revision-\ue000',
      capturedAt: 100,
      recordedAt: 100,
      sequence: 0,
      commentText: 'private-use revision'
    })
  ]);

  expect(result.results).toEqual([
    {
      mutationId: 'unicode-revision-supplementary',
      status: 'rejected',
      errorCode: 'INVALID_COMMENT_REVISION'
    },
    {
      mutationId: 'unicode-revision-private-use',
      status: 'rejected',
      errorCode: 'INVALID_COMMENT_REVISION'
    }
  ]);
  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ?) AS comments,
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ?) AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ?) AS receipts`
    )
      .bind(VALID_VAULT_ID, VALID_VAULT_ID, VALID_VAULT_ID)
      .first()
  ).toEqual({
    comments: 0,
    changes: 0,
    receipts: 0
  });
});

test('accepts bounded ASCII legacy revisions for long non-ASCII comment ids', async () => {
  const longBatchId = '界'.repeat(130);
  const longRecordId = `${longBatchId}:1`;
  const maximumRecordId = '界'.repeat(512);

  const result = await push([
    commentMutation({
      mutationId: 'legacy-long-non-ascii',
      batchId: longBatchId,
      urlIndex: 1,
      includeHistoryRevision: false,
      commentText: 'long legacy id'
    }),
    commentMutation({
      mutationId: 'legacy-maximum-record-id',
      recordId: maximumRecordId,
      batchId: 'maximum-record-batch',
      urlIndex: 1,
      includeHistoryRevision: false,
      commentText: 'maximum legacy id'
    })
  ]);
  expect(result.results).toEqual([
    {
      mutationId: 'legacy-long-non-ascii',
      status: 'applied',
      serverSeq: 1
    },
    {
      mutationId: 'legacy-maximum-record-id',
      status: 'applied',
      serverSeq: 2
    }
  ]);

  for (const recordId of [longRecordId, maximumRecordId]) {
    const stored = await env.DB.prepare(
      `SELECT revision_id FROM comment_records
       WHERE vault_id = ? AND record_id = ?`
    )
      .bind(VALID_VAULT_ID, recordId)
      .first<{ revision_id: string }>();
    expect(stored?.revision_id).toMatch(/^[\x20-\x7e]+$/u);
    expect(stored?.revision_id.length).toBeLessThanOrEqual(3_104);
  }
});

test('keeps the freshest body when different revisions arrive concurrently', async () => {
  await Promise.all([
    push([
      commentMutation({
        mutationId: 'interleaved-old',
        revisionId: 'interleaved-revision-old',
        capturedAt: 100,
        commentText: 'old interleaved body'
      })
    ]),
    push([
      commentMutation({
        mutationId: 'interleaved-new',
        revisionId: 'interleaved-revision-new',
        capturedAt: 200,
        commentText: 'new interleaved body'
      })
    ])
  ]);

  expect(
    (
      await env.DB.prepare(
        `SELECT comment_text FROM comment_records
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'batch-a:1')
        .first<{ comment_text: string }>()
    )?.comment_text
  ).toBe('new interleaved body');
});

test('concurrent pushes of one mutation produce one applied and one duplicate receipt', async () => {
  const mutation = commentMutation({
    mutationId: 'concurrent-identical-mutation',
    commentText: 'concurrent exact body',
    anchors: [
      { position: 0, anchorText: 'One', hrefDomain: 'one.test' },
      { position: 1, anchorText: 'Two', hrefDomain: 'two.test' }
    ]
  });

  const [first, second] = await Promise.all([
    push([mutation]),
    push([mutation])
  ]);
  const receipts = [
    first.results[0],
    second.results[0]
  ];
  expect(receipts.map((receipt) => receipt?.status).sort()).toEqual([
    'applied',
    'duplicate'
  ]);
  expect(receipts.map((receipt) => receipt?.serverSeq)).toEqual([1, 1]);

  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ? AND record_id = 'batch-a:1') AS comments,
         (SELECT COUNT(*) FROM comment_anchors
          WHERE vault_id = ? AND comment_id = 'batch-a:1') AS anchors,
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ?
            AND mutation_id = 'concurrent-identical-mutation') AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ?
            AND mutation_id = 'concurrent-identical-mutation') AS receipts`
    )
      .bind(
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID
      )
      .first()
  ).toEqual({
    comments: 1,
    anchors: 2,
    changes: 1,
    receipts: 1
  });
  expect(
    (
      await env.DB.prepare(
        `SELECT comment_text FROM comment_records
         WHERE vault_id = ? AND record_id = 'batch-a:1'`
      )
        .bind(VALID_VAULT_ID)
        .first<{ comment_text: string }>()
    )?.comment_text
  ).toBe('concurrent exact body');
});

test('rejects one malformed item without partially writing it or blocking a valid sibling', async () => {
  const invalid = commentMutation({
    mutationId: 'invalid-anchor',
    batchId: 'batch-invalid',
    urlIndex: 1,
    anchors: [
      {
        position: 0,
        anchorText: 'Invalid',
        hrefDomain: 'invalid.test',
        id: 'wrong-anchor-id'
      }
    ]
  });
  const valid = commentMutation({
    mutationId: 'valid-sibling',
    batchId: 'batch-valid',
    urlIndex: 2,
    commentText: 'valid sibling'
  });

  const result = await push([invalid, valid]);
  expect(result.results).toEqual([
    {
      mutationId: 'invalid-anchor',
      status: 'rejected',
      errorCode: 'INVALID_COMMENT_ANCHOR'
    },
    {
      mutationId: 'valid-sibling',
      status: 'applied',
      serverSeq: 1
    }
  ]);
  const invalidCounts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_records
        WHERE vault_id = ? AND record_id = 'batch-invalid:1') AS comments,
       (SELECT COUNT(*) FROM comment_anchors
        WHERE vault_id = ? AND comment_id = 'batch-invalid:1') AS anchors,
       (SELECT COUNT(*) FROM sync_changes
        WHERE vault_id = ? AND mutation_id = 'invalid-anchor') AS changes,
       (SELECT COUNT(*) FROM sync_mutations
        WHERE vault_id = ? AND mutation_id = 'invalid-anchor') AS receipts`
  )
    .bind(
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID
    )
    .first();
  expect(invalidCounts).toEqual({
    comments: 0,
    anchors: 0,
    changes: 0,
    receipts: 0
  });
});

test('rejects forbidden, overlong, and non-finite comment data per item', async () => {
  const forbidden = commentMutation({
    mutationId: 'forbidden-property',
    batchId: 'batch-forbidden',
    urlIndex: 1
  });
  const forbiddenPayload = {
    ...forbidden.payload,
    password: 'must-not-leave'
  };
  const nonFinite = commentMutation({
    mutationId: 'non-finite-revision',
    batchId: 'batch-non-finite',
    urlIndex: 2,
    capturedAt: Number.POSITIVE_INFINITY
  });
  const overlong = commentMutation({
    mutationId: 'overlong-comment',
    batchId: 'batch-overlong',
    urlIndex: 3,
    commentText: 'x'.repeat(100_001)
  });

  const result = await push([
    { ...forbidden, payload: forbiddenPayload },
    nonFinite,
    overlong
  ]);
  expect(result.results).toEqual([
    {
      mutationId: 'forbidden-property',
      status: 'rejected',
      errorCode: 'SENSITIVE_FIELD_NOT_SYNCABLE'
    },
    {
      mutationId: 'non-finite-revision',
      status: 'rejected',
      errorCode: 'INVALID_COMMENT_REVISION'
    },
    {
      mutationId: 'overlong-comment',
      status: 'rejected',
      errorCode: 'INVALID_COMMENT'
    }
  ]);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM comment_records
         WHERE vault_id = ?`
      )
        .bind(VALID_VAULT_ID)
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('rejects invalid batch cardinality and duplicate request mutation ids', async () => {
  const empty = await pushResponse([]);
  expect(empty.status).toBe(400);
  expect(await empty.json()).toMatchObject({
    ok: false,
    error: { code: 'INVALID_MUTATION_BATCH', retryable: false }
  });

  const tooMany = await pushResponse(
    Array.from({ length: 101 }, (_, index) =>
      commentMutation({
        mutationId: `too-many-${index}`,
        batchId: `batch-too-many-${index}`,
        urlIndex: index
      })
    )
  );
  expect(tooMany.status).toBe(400);
  expect(await tooMany.json()).toMatchObject({
    ok: false,
    error: { code: 'INVALID_MUTATION_BATCH', retryable: false }
  });

  const duplicate = commentMutation({
    mutationId: 'duplicate-in-batch'
  });
  const duplicateIds = await pushResponse([duplicate, duplicate]);
  expect(duplicateIds.status).toBe(400);
  expect(await duplicateIds.json()).toMatchObject({
    ok: false,
    error: { code: 'DUPLICATE_MUTATION_ID', retryable: false }
  });
  expect(
    (
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sync_mutations WHERE vault_id = ?'
      )
        .bind(VALID_VAULT_ID)
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('applies exactly 100 valid comment mutations within the Worker D1 request budget', async () => {
  const mutations = Array.from({ length: 100 }, (_, index) =>
    commentMutation({
      mutationId: `limit-mutation-${index}`,
      batchId: `limit-batch-${index}`,
      urlIndex: index,
      revisionId: `limit-revision-${index}`,
      capturedAt: 1_000 + index,
      commentText: `limit body ${index}`
    })
  );

  const result = await push(mutations);
  expect(result.results).toHaveLength(100);
  expect(
    result.results.map(({ status }) => status)
  ).toEqual(Array.from({ length: 100 }, () => 'applied'));
  expect(
    result.results.map(({ serverSeq }) => serverSeq)
  ).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));

  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ?) AS comments,
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ?) AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ?) AS receipts,
         (SELECT COUNT(DISTINCT server_seq) FROM sync_changes
          WHERE vault_id = ?) AS distinct_sequences,
         (SELECT MIN(server_seq) FROM sync_changes
          WHERE vault_id = ?) AS minimum_sequence,
         (SELECT MAX(server_seq) FROM sync_changes
          WHERE vault_id = ?) AS maximum_sequence`
    )
      .bind(
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID
      )
      .first()
  ).toEqual({
    comments: 100,
    changes: 100,
    receipts: 100,
    distinct_sequences: 100,
    minimum_sequence: 1,
    maximum_sequence: 100
  });
  expect(
    await env.DB.prepare(
      `SELECT comment_text, accepted_mutation_id
       FROM comment_records
       WHERE vault_id = ? AND record_id = 'limit-batch-99:99'`
    )
      .bind(VALID_VAULT_ID)
      .first()
  ).toEqual({
    comment_text: 'limit body 99',
    accepted_mutation_id: 'limit-mutation-99'
  });
});

test('rejects an over-budget 100-by-5-anchor request before its first write', async () => {
  const mutations = Array.from({ length: 100 }, (_, index) =>
    commentMutation({
      mutationId: `over-budget-${index}`,
      batchId: `over-budget-batch-${index}`,
      urlIndex: index,
      revisionId: `over-budget-revision-${index}`,
      anchors: mutationAnchors(index, 5)
    })
  );

  const response = await pushResponse(mutations);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: {
      code: 'MUTATION_QUERY_BUDGET_EXCEEDED',
      retryable: false
    }
  });
  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ?) AS comments,
         (SELECT COUNT(*) FROM comment_anchors
          WHERE vault_id = ?) AS anchors,
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ?) AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ?) AS receipts`
    )
      .bind(
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID
      )
      .first()
  ).toEqual({
    comments: 0,
    anchors: 0,
    changes: 0,
    receipts: 0
  });
});

test('accepts 100 anchor-bearing comments that remain below the D1 query budget', async () => {
  const mutations = Array.from({ length: 100 }, (_, index) =>
    commentMutation({
      mutationId: `within-budget-${index}`,
      batchId: `within-budget-batch-${index}`,
      urlIndex: index,
      revisionId: `within-budget-revision-${index}`,
      anchors: mutationAnchors(index, 4)
    })
  );

  const result = await push(mutations);
  expect(result.results).toHaveLength(100);
  expect(result.results.every(({ status }) => status === 'applied')).toBe(
    true
  );
  expect(
    await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comment_records
          WHERE vault_id = ?) AS comments,
         (SELECT COUNT(*) FROM comment_anchors
          WHERE vault_id = ?) AS anchors,
         (SELECT COUNT(*) FROM sync_changes
          WHERE vault_id = ?) AS changes,
         (SELECT COUNT(*) FROM sync_mutations
          WHERE vault_id = ?) AS receipts`
    )
      .bind(
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID,
        VALID_VAULT_ID
      )
      .first()
  ).toEqual({
    comments: 100,
    anchors: 400,
    changes: 100,
    receipts: 100
  });
});

test('keeps a tombstoned comment deleted and makes a stale replay duplicate', async () => {
  await env.DB.prepare(
    `INSERT INTO comment_tombstones
       (vault_id, record_id, mutation_id, deleted_at, server_seq)
     VALUES (?, 'batch-a:1', 'existing-delete', 100, NULL)`
  )
    .bind(VALID_VAULT_ID)
    .run();
  const mutation = commentMutation({
    mutationId: 'blocked-by-tombstone',
    revisionId: 'future-looking-revision',
    capturedAt: 999_999,
    commentText: 'must stay deleted'
  });

  expect((await push([mutation])).results).toEqual([
    {
      mutationId: 'blocked-by-tombstone',
      status: 'stale',
      serverSeq: null
    }
  ]);
  expect((await push([mutation])).results).toEqual([
    {
      mutationId: 'blocked-by-tombstone',
      status: 'duplicate',
      serverSeq: null
    }
  ]);
  expect(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM comment_records
         WHERE vault_id = ? AND record_id = ?`
      )
        .bind(VALID_VAULT_ID, 'batch-a:1')
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

test('applies an idempotent comment delete tombstone and blocks resurrection', async () => {
  await push([
    commentMutation({
      mutationId: 'comment-before-delete',
      anchors: [
        { position: 0, anchorText: 'Delete Me', hrefDomain: 'delete.test' }
      ]
    })
  ]);
  const deletion = commentDeleteMutation('delete-comment');

  expect((await push([deletion])).results).toEqual([
    {
      mutationId: 'delete-comment',
      status: 'applied',
      serverSeq: 2
    }
  ]);
  expect((await push([deletion])).results).toEqual([
    {
      mutationId: 'delete-comment',
      status: 'duplicate',
      serverSeq: 2
    }
  ]);

  const state = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_records
        WHERE vault_id = ? AND record_id = 'batch-a:1') AS comments,
       (SELECT COUNT(*) FROM comment_anchors
        WHERE vault_id = ? AND comment_id = 'batch-a:1') AS anchors,
       (SELECT COUNT(*) FROM comment_tombstones
        WHERE vault_id = ? AND record_id = 'batch-a:1') AS tombstones,
       (SELECT server_seq FROM comment_tombstones
        WHERE vault_id = ? AND record_id = 'batch-a:1') AS tombstone_seq,
       (SELECT COUNT(*) FROM sync_changes
        WHERE vault_id = ? AND mutation_id = 'delete-comment') AS changes`
  )
    .bind(
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID
    )
    .first();
  expect(state).toEqual({
    comments: 0,
    anchors: 0,
    tombstones: 1,
    tombstone_seq: 2,
    changes: 1
  });

  expect(
    (
      await push([
        commentMutation({
          mutationId: 'resurrection-attempt',
          revisionId: 'resurrection-revision',
          capturedAt: 999_999,
          commentText: 'must not return'
        })
      ])
    ).results
  ).toEqual([
    {
      mutationId: 'resurrection-attempt',
      status: 'stale',
      serverSeq: 2
    }
  ]);
});

test('creates a tombstone when deleting a comment that is not present', async () => {
  const result = await push([
    commentDeleteMutation('delete-unknown', 'unknown:1')
  ]);
  expect(result.results).toEqual([
    {
      mutationId: 'delete-unknown',
      status: 'applied',
      serverSeq: 1
    }
  ]);
  expect(
    await env.DB.prepare(
      `SELECT record_id, mutation_id, deleted_at, server_seq
       FROM comment_tombstones
       WHERE vault_id = ? AND record_id = ?`
    )
      .bind(VALID_VAULT_ID, 'unknown:1')
      .first()
  ).toEqual({
    record_id: 'unknown:1',
    mutation_id: 'delete-unknown',
    deleted_at: 1_721_000_000_004,
    server_seq: 1
  });
});

test('does not write after authentication if the vault is deleted before the mutation batch', async () => {
  const mutation = commentMutation({
    mutationId: 'deleted-vault-race'
  });
  const request = new Request(
    'https://worker.test/v1/sync/push',
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        deviceId: 'device-deleted-vault-race',
        mutations: [mutation]
      })
    }
  );
  const authenticatedVault = await requireVault(request, env);
  await env.DB.prepare(
    `UPDATE sync_vaults SET deleted_at = 200 WHERE vault_id = ?`
  )
    .bind(VALID_VAULT_ID)
    .run();

  await expect(
    pushMutations(request, env, authenticatedVault)
  ).rejects.toMatchObject({
    code: 'VAULT_DELETED',
    status: 403
  });
  const state = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_records
        WHERE vault_id = ?) AS comments,
       (SELECT COUNT(*) FROM comment_anchors
        WHERE vault_id = ?) AS anchors,
       (SELECT COUNT(*) FROM sync_changes
        WHERE vault_id = ?) AS changes,
       (SELECT COUNT(*) FROM sync_mutations
        WHERE vault_id = ?) AS receipts`
  )
    .bind(
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID
    )
    .first();
  expect(state).toEqual({
    comments: 0,
    anchors: 0,
    changes: 0,
    receipts: 0
  });
});

test('does not accept an old duplicate receipt after authentication if the vault is deleted', async () => {
  const mutation = commentMutation({
    mutationId: 'deleted-vault-old-receipt'
  });
  await push([mutation]);
  const request = new Request(
    'https://worker.test/v1/sync/push',
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        deviceId: 'device-deleted-vault-old-receipt',
        mutations: [mutation]
      })
    }
  );
  const authenticatedVault = await requireVault(request, env);
  await env.DB.prepare(
    `UPDATE sync_vaults SET deleted_at = 201 WHERE vault_id = ?`
  )
    .bind(VALID_VAULT_ID)
    .run();

  await expect(
    pushMutations(request, env, authenticatedVault)
  ).rejects.toMatchObject({
    code: 'VAULT_DELETED',
    status: 403
  });
  const state = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_records
        WHERE vault_id = ?) AS comments,
       (SELECT COUNT(*) FROM comment_anchors
        WHERE vault_id = ?) AS anchors,
       (SELECT COUNT(*) FROM sync_changes
        WHERE vault_id = ?) AS changes,
       (SELECT COUNT(*) FROM sync_mutations
        WHERE vault_id = ?) AS receipts`
  )
    .bind(
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID,
      VALID_VAULT_ID
    )
    .first();
  expect(state).toEqual({
    comments: 1,
    anchors: 0,
    changes: 1,
    receipts: 1
  });
});

test('answers a push preflight with the bounded CORS contract', async () => {
  const response = await SELF.fetch(
    'https://worker.test/v1/sync/push',
    {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type'
      }
    }
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
    ALLOWED_ORIGIN
  );
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
    'POST, OPTIONS'
  );
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
    'Authorization, Content-Type'
  );
  expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
});
