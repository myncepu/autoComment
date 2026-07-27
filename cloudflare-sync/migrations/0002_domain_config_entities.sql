CREATE TABLE sync_profiles (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_mutation_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, entity_id)
);

CREATE TABLE sync_promotion_sites (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  site_name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_mutation_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, entity_id)
);

CREATE TABLE sync_assignment_pairs (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  promotion_site_id TEXT NOT NULL,
  weight INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  accepted_mutation_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, entity_id)
);

CREATE TABLE sync_assignment_policy (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  default_pair_id TEXT,
  quotas_json TEXT NOT NULL CHECK (json_valid(quotas_json)),
  accepted_mutation_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, entity_id),
  CHECK (entity_id = 'default-assignment-policy')
);

CREATE TABLE domain_entity_tombstones (
  vault_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, entity_type, entity_id),
  CHECK (entity_type IN ('profile', 'promotion_site', 'assignment_pair'))
);

ALTER TABLE comment_records ADD COLUMN profile_id TEXT;
ALTER TABLE comment_records ADD COLUMN profile_display_name TEXT;
ALTER TABLE comment_records ADD COLUMN promotion_site_id TEXT;
ALTER TABLE comment_records ADD COLUMN promotion_site_name TEXT;
ALTER TABLE comment_records ADD COLUMN promotion_site_url TEXT;
ALTER TABLE comment_records ADD COLUMN assignment_pair_id TEXT;
ALTER TABLE comment_records ADD COLUMN assignment_source TEXT;
ALTER TABLE comment_records ADD COLUMN config_revision INTEGER;
ALTER TABLE comment_records ADD COLUMN attempt_count INTEGER;
ALTER TABLE comment_records ADD COLUMN error_code TEXT;
ALTER TABLE comment_records ADD COLUMN skip_reason TEXT;

CREATE INDEX idx_changes_vault_entity_seq
  ON sync_changes(vault_id, entity_type, server_seq);
CREATE INDEX idx_comments_vault_profile
  ON comment_records(vault_id, profile_id, submitted_at DESC, record_id DESC);
CREATE INDEX idx_comments_vault_promotion_site
  ON comment_records(
    vault_id,
    promotion_site_id,
    submitted_at DESC,
    record_id DESC
  );
