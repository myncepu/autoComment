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
    'sync_changes',
    'sync_devices',
    'sync_mutations',
    'sync_vaults',
    'synced_settings'
  ]);
});
