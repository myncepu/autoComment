CREATE TABLE sync_vaults (
  vault_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE sync_devices (
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_successful_sync_at INTEGER,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
);

CREATE TABLE comment_records (
  vault_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  url_index INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  archive_month TEXT NOT NULL,
  target_page_url TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  promoted_website_url TEXT NOT NULL,
  promoted_domain TEXT NOT NULL,
  comment_html TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  submit_status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision_source_rank INTEGER NOT NULL,
  revision_captured_at INTEGER NOT NULL,
  revision_recorded_at INTEGER NOT NULL,
  revision_sequence INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  accepted_mutation_id TEXT NOT NULL,
  cloud_created_at INTEGER NOT NULL,
  cloud_updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, record_id),
  UNIQUE (vault_id, batch_id, url_index)
);

CREATE TABLE comment_anchors (
  vault_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  anchor_text TEXT NOT NULL,
  anchor_text_normalized TEXT NOT NULL,
  href_raw TEXT NOT NULL,
  href_resolved TEXT NOT NULL,
  href_domain TEXT NOT NULL,
  PRIMARY KEY (vault_id, comment_id, position),
  UNIQUE (vault_id, anchor_id)
);

CREATE TABLE synced_settings (
  vault_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  accepted_mutation_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, setting_key)
);

CREATE TABLE sync_mutations (
  vault_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  result_status TEXT NOT NULL,
  server_seq INTEGER,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, mutation_id)
);

CREATE TABLE sync_changes (
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (vault_id, mutation_id)
);

CREATE TABLE comment_tombstones (
  vault_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  server_seq INTEGER,
  PRIMARY KEY (vault_id, record_id)
);

CREATE INDEX idx_changes_vault_seq
  ON sync_changes(vault_id, server_seq);
CREATE INDEX idx_comments_vault_submitted
  ON comment_records(vault_id, submitted_at DESC, record_id DESC);
CREATE INDEX idx_comments_vault_target
  ON comment_records(vault_id, target_domain, submitted_at DESC, record_id DESC);
CREATE INDEX idx_comments_vault_promoted
  ON comment_records(vault_id, promoted_domain, submitted_at DESC, record_id DESC);
CREATE INDEX idx_anchors_vault_text
  ON comment_anchors(vault_id, anchor_text_normalized, comment_id);
CREATE INDEX idx_anchors_vault_href
  ON comment_anchors(vault_id, href_domain, comment_id);
