import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  type D1Migration
} from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The schema assertion intentionally lists application tables only.
await env.DB.exec('DROP TABLE d1_migrations');
