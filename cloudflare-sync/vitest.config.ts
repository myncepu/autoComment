import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cloudflareTest,
  readD1Migrations
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          BOOTSTRAP_CURSOR_SIGNING_KEY:
            'test-only-bootstrap-cursor-signing-key-32-bytes-minimum',
          TEST_MIGRATIONS: await readD1Migrations(path.join(directory, 'migrations'))
        }
      }
    }))
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts']
  }
});
