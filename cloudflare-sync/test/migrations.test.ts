import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';

test('creates the complete initial sync schema', async () => {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all<{ name: string }>();

  expect(tables.results.map(({ name }) => name)).toEqual([
    'comment_anchors',
    'comment_records',
    'comment_tombstones',
    'domain_entity_tombstones',
    'sync_assignment_pairs',
    'sync_assignment_policy',
    'sync_changes',
    'sync_devices',
    'sync_mutations',
    'sync_profiles',
    'sync_promotion_sites',
    'sync_vaults',
    'synced_settings'
  ]);

  const commentColumns = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('comment_records') ORDER BY cid"
  ).all<{ name: string }>();
  expect(commentColumns.results.map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      'profile_id',
      'profile_display_name',
      'promotion_site_id',
      'promotion_site_name',
      'promotion_site_url',
      'assignment_pair_id',
      'assignment_source',
      'config_revision',
      'attempt_count',
      'error_code',
      'skip_reason'
    ])
  );
});
