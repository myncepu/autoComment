import { fail } from './http';

export type DomainEntityType =
  | 'profile'
  | 'promotion_site'
  | 'assignment_pair'
  | 'assignment_policy';

export interface DomainMutation {
  mutationId: string;
  entityType: DomainEntityType;
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  createdAt: number;
}

export type DomainMutationReceipt =
  | {
      mutationId: string;
      status: 'applied';
      serverSeq: number;
    }
  | {
      mutationId: string;
      status: 'duplicate' | 'stale';
      serverSeq: number | null;
    }
  | {
      mutationId: string;
      status: 'rejected';
      errorCode: string;
    };

interface EntitySqlConfig {
  table: string;
  wrapper: string;
  columns: string[];
  values(entity: Record<string, unknown>): unknown[];
}

interface StoredReceipt {
  entity_type: string;
  entity_id: string;
  result_status: string;
  server_seq: number | null;
}

const ENTITY_SQL: Record<DomainEntityType, EntitySqlConfig> = {
  profile: {
    table: 'sync_profiles',
    wrapper: 'profile',
    columns: [
      'display_name',
      'profile_name',
      'email',
      'created_at',
      'updated_at'
    ],
    values: (entity) => [
      entity.displayName,
      entity.name,
      entity.email,
      entity.createdAt,
      entity.updatedAt
    ]
  },
  promotion_site: {
    table: 'sync_promotion_sites',
    wrapper: 'promotionSite',
    columns: [
      'site_name',
      'site_url',
      'content',
      'enabled',
      'created_at',
      'updated_at'
    ],
    values: (entity) => [
      entity.name,
      entity.url,
      entity.content,
      entity.enabled ? 1 : 0,
      entity.createdAt,
      entity.updatedAt
    ]
  },
  assignment_pair: {
    table: 'sync_assignment_pairs',
    wrapper: 'assignmentPair',
    columns: [
      'profile_id',
      'promotion_site_id',
      'weight',
      'enabled'
    ],
    values: (entity) => [
      entity.profileId,
      entity.promotionSiteId,
      entity.weight,
      entity.enabled ? 1 : 0
    ]
  },
  assignment_policy: {
    table: 'sync_assignment_policy',
    wrapper: 'assignmentPolicy',
    columns: ['default_pair_id', 'quotas_json'],
    values: (entity) => [
      entity.defaultPairId,
      JSON.stringify(entity.quotas)
    ]
  }
};

function upsertEntityStatements(
  env: Env,
  vaultId: string,
  mutation: DomainMutation,
  now: number
): D1PreparedStatement[] {
  const config = ENTITY_SQL[mutation.entityType];
  const entity = mutation.payload[config.wrapper] as Record<string, unknown>;
  const columns = config.columns.join(', ');
  const placeholders = config.columns.map(() => '?').join(', ');
  const updates = config.columns.map(
    (column) => `${column} = excluded.${column}`
  ).join(', ');
  const tombstoneGuard = mutation.entityType === 'assignment_policy'
    ? ''
    : `AND NOT EXISTS (
         SELECT 1 FROM domain_entity_tombstones
         WHERE vault_id = active_vault.vault_id
           AND entity_type = ?
           AND entity_id = ?
       )`;
  const conflictTombstoneGuard =
    mutation.entityType === 'assignment_policy'
      ? ''
      : `AND NOT EXISTS (
           SELECT 1 FROM domain_entity_tombstones
           WHERE vault_id = excluded.vault_id
             AND entity_type = ?
             AND entity_id = excluded.entity_id
         )`;
  const entityValues = config.values(entity);
  const tombstoneBindings = mutation.entityType === 'assignment_policy'
    ? []
    : [mutation.entityType, mutation.entityId];
  const conflictTombstoneBindings =
    mutation.entityType === 'assignment_policy'
      ? []
      : [mutation.entityType];
  const relationGuard = mutation.entityType === 'assignment_pair'
    ? `AND EXISTS (
         SELECT 1 FROM sync_profiles
         WHERE vault_id = active_vault.vault_id AND entity_id = ?
       )
       AND EXISTS (
         SELECT 1 FROM sync_promotion_sites
         WHERE vault_id = active_vault.vault_id AND entity_id = ?
       )`
    : mutation.entityType === 'assignment_policy'
      ? `AND (
           ? IS NULL OR EXISTS (
             SELECT 1 FROM sync_assignment_pairs
             WHERE vault_id = active_vault.vault_id AND entity_id = ?
           )
         )`
      : '';
  const relationBindings = mutation.entityType === 'assignment_pair'
    ? [entity.profileId, entity.promotionSiteId]
    : mutation.entityType === 'assignment_policy'
      ? [entity.defaultPairId, entity.defaultPairId]
      : [];
  const conflictRelationGuard = mutation.entityType === 'assignment_pair'
    ? `AND EXISTS (
         SELECT 1 FROM sync_profiles
         WHERE vault_id = excluded.vault_id AND entity_id = ?
       )
       AND EXISTS (
         SELECT 1 FROM sync_promotion_sites
         WHERE vault_id = excluded.vault_id AND entity_id = ?
       )`
    : mutation.entityType === 'assignment_policy'
      ? `AND (
           ? IS NULL OR EXISTS (
             SELECT 1 FROM sync_assignment_pairs
             WHERE vault_id = excluded.vault_id AND entity_id = ?
           )
         )`
      : '';
  const conflictRelationBindings = relationBindings;

  const upsert = env.DB.prepare(
    `INSERT INTO ${config.table} (
       vault_id, entity_id, ${columns}, accepted_mutation_id,
       server_updated_at, server_seq
     )
     SELECT active_vault.vault_id, ?, ${placeholders}, ?, ?, NULL
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )
       ${tombstoneGuard}
       ${relationGuard}
     ON CONFLICT(vault_id, entity_id) DO UPDATE SET
       ${updates},
       accepted_mutation_id = excluded.accepted_mutation_id,
       server_updated_at = excluded.server_updated_at,
       server_seq = NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_mutations
       WHERE vault_id = excluded.vault_id AND mutation_id = ?
     )
       ${conflictTombstoneGuard}
       ${conflictRelationGuard}`
  ).bind(
    mutation.entityId,
    ...entityValues,
    mutation.mutationId,
    now,
    vaultId,
    mutation.mutationId,
    ...tombstoneBindings,
    ...relationBindings,
    mutation.mutationId,
    ...conflictTombstoneBindings,
    ...conflictRelationBindings
  );

  const change = env.DB.prepare(
    `INSERT INTO sync_changes (
       vault_id, mutation_id, entity_type, entity_id, operation, created_at
     )
     SELECT active_vault.vault_id, ?, ?, ?, 'upsert', ?
     FROM sync_vaults AS active_vault
     JOIN ${config.table} AS accepted_entity
       ON accepted_entity.vault_id = active_vault.vault_id
      AND accepted_entity.entity_id = ?
      AND accepted_entity.accepted_mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityType,
    mutation.entityId,
    now,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );

  const sequence = env.DB.prepare(
    `UPDATE ${config.table}
     SET server_seq = (
       SELECT server_seq FROM sync_changes
       WHERE vault_id = ? AND mutation_id = ?
     )
     WHERE vault_id = ? AND entity_id = ?
       AND accepted_mutation_id = ?
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
    mutation.mutationId
  );

  const staleSequence = mutation.entityType === 'assignment_policy'
    ? `(SELECT server_seq FROM ${config.table}
        WHERE vault_id = active_vault.vault_id AND entity_id = ?)`
    : `COALESCE(
        (SELECT server_seq FROM domain_entity_tombstones
         WHERE vault_id = active_vault.vault_id
           AND entity_type = ? AND entity_id = ?),
        (SELECT server_seq FROM ${config.table}
         WHERE vault_id = active_vault.vault_id AND entity_id = ?)
      )`;
  const staleBindings = mutation.entityType === 'assignment_policy'
    ? [mutation.entityId]
    : [mutation.entityType, mutation.entityId, mutation.entityId];
  const receipt = env.DB.prepare(
    `INSERT INTO sync_mutations (
       vault_id, mutation_id, entity_type, entity_id, result_status,
       server_seq, processed_at
     )
     SELECT active_vault.vault_id, ?, ?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM sync_changes
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       ) THEN 'applied' ELSE 'stale' END,
       COALESCE(
         (SELECT server_seq FROM sync_changes
          WHERE vault_id = active_vault.vault_id AND mutation_id = ?),
         ${staleSequence}
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
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    mutation.mutationId,
    ...staleBindings,
    now,
    vaultId,
    mutation.mutationId
  );
  return [upsert, change, sequence, receipt];
}

function deleteEntityStatements(
  env: Env,
  vaultId: string,
  mutation: DomainMutation,
  now: number
): D1PreparedStatement[] {
  const config = ENTITY_SQL[mutation.entityType];
  const deletedAt = mutation.payload.deletedAt;
  const referenceGuard = mutation.entityType === 'profile'
    ? `AND NOT EXISTS (
         SELECT 1 FROM sync_assignment_pairs
         WHERE vault_id = active_vault.vault_id AND profile_id = ?
       )`
    : mutation.entityType === 'promotion_site'
      ? `AND NOT EXISTS (
           SELECT 1 FROM sync_assignment_pairs
           WHERE vault_id = active_vault.vault_id AND promotion_site_id = ?
         )`
      : `AND NOT EXISTS (
           SELECT 1 FROM sync_assignment_policy
           WHERE vault_id = active_vault.vault_id AND default_pair_id = ?
         )`;
  const tombstone = env.DB.prepare(
    `INSERT INTO domain_entity_tombstones (
       vault_id, entity_type, entity_id, mutation_id, deleted_at, server_seq
     )
     SELECT active_vault.vault_id, ?, ?, ?, ?, NULL
     FROM sync_vaults AS active_vault
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )
       ${referenceGuard}
       AND NOT EXISTS (
         SELECT 1 FROM domain_entity_tombstones
         WHERE vault_id = active_vault.vault_id
           AND entity_type = ? AND entity_id = ?
       )`
  ).bind(
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    deletedAt,
    vaultId,
    mutation.mutationId,
    mutation.entityId,
    mutation.entityType,
    mutation.entityId
  );
  const deletion = env.DB.prepare(
    `DELETE FROM ${config.table}
     WHERE vault_id = ? AND entity_id = ?
       AND EXISTS (
         SELECT 1 FROM domain_entity_tombstones
         WHERE vault_id = ? AND entity_type = ? AND entity_id = ?
           AND mutation_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    vaultId,
    mutation.entityId,
    vaultId,
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
  const change = env.DB.prepare(
    `INSERT INTO sync_changes (
       vault_id, mutation_id, entity_type, entity_id, operation, created_at
     )
     SELECT active_vault.vault_id, ?, ?, ?, 'delete', ?
     FROM sync_vaults AS active_vault
     JOIN domain_entity_tombstones AS accepted_tombstone
       ON accepted_tombstone.vault_id = active_vault.vault_id
      AND accepted_tombstone.entity_type = ?
      AND accepted_tombstone.entity_id = ?
      AND accepted_tombstone.mutation_id = ?
     WHERE active_vault.vault_id = ?
       AND active_vault.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       )`
  ).bind(
    mutation.mutationId,
    mutation.entityType,
    mutation.entityId,
    now,
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
  const sequence = env.DB.prepare(
    `UPDATE domain_entity_tombstones
     SET server_seq = (
       SELECT server_seq FROM sync_changes
       WHERE vault_id = ? AND mutation_id = ?
     )
     WHERE vault_id = ? AND entity_type = ? AND entity_id = ?
       AND mutation_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM sync_mutations
         WHERE vault_id = ? AND mutation_id = ?
       )`
  ).bind(
    vaultId,
    mutation.mutationId,
    vaultId,
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    vaultId,
    mutation.mutationId
  );
  const receipt = env.DB.prepare(
    `INSERT INTO sync_mutations (
       vault_id, mutation_id, entity_type, entity_id, result_status,
       server_seq, processed_at
     )
     SELECT active_vault.vault_id, ?, ?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM sync_changes
         WHERE vault_id = active_vault.vault_id AND mutation_id = ?
       ) THEN 'applied' ELSE 'stale' END,
       (SELECT server_seq FROM domain_entity_tombstones
        WHERE vault_id = active_vault.vault_id
          AND entity_type = ? AND entity_id = ?),
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
    mutation.entityType,
    mutation.entityId,
    mutation.mutationId,
    mutation.entityType,
    mutation.entityId,
    now,
    vaultId,
    mutation.mutationId
  );
  return [tombstone, deletion, change, sequence, receipt];
}

async function storedReceipt(
  env: Env,
  vaultId: string,
  mutation: DomainMutation,
  inserted: boolean
): Promise<DomainMutationReceipt> {
  const stored = await env.DB.prepare(
    `SELECT entity_type, entity_id, result_status, server_seq
     FROM sync_mutations
     WHERE vault_id = ? AND mutation_id = ?`
  ).bind(vaultId, mutation.mutationId).first<StoredReceipt>();
  if (!stored) fail('INTERNAL_ERROR', 500, true);
  if (
    stored.entity_type !== mutation.entityType
    || stored.entity_id !== mutation.entityId
  ) {
    return {
      mutationId: mutation.mutationId,
      status: 'rejected',
      errorCode: 'MUTATION_ID_CONFLICT'
    };
  }
  if (!inserted) {
    return {
      mutationId: mutation.mutationId,
      status: 'duplicate',
      serverSeq: stored.server_seq
    };
  }
  if (stored.result_status === 'applied') {
    if (stored.server_seq === null) fail('INTERNAL_ERROR', 500, true);
    return {
      mutationId: mutation.mutationId,
      status: 'applied',
      serverSeq: stored.server_seq
    };
  }
  return {
    mutationId: mutation.mutationId,
    status: 'stale',
    serverSeq: stored.server_seq
  };
}

export function domainMutationStatementCount(
  mutation: DomainMutation
): number {
  return mutation.operation === 'delete' ? 5 : 4;
}

export async function applyDomainMutation(
  env: Env,
  vaultId: string,
  mutation: DomainMutation,
  now: number
): Promise<DomainMutationReceipt> {
  const statements = mutation.operation === 'delete'
    ? deleteEntityStatements(env, vaultId, mutation, now)
    : upsertEntityStatements(env, vaultId, mutation, now);
  const receiptIndex = statements.length - 1;
  const batch = await env.DB.batch(statements);
  return storedReceipt(
    env,
    vaultId,
    mutation,
    batch[receiptIndex]?.meta.changes === 1
  );
}
