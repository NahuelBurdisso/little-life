import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, initSchema } from './index';

migrate(db, { migrationsFolder: './server/db/migrations' });

// The `import './index'` above already ran initSchema() at module load — i.e.
// before any table existed on a fresh DB, so every perf index and additive
// column was skipped and nothing re-ran it. Re-run it now that the tables are
// there; every statement in it is idempotent.
initSchema();

console.log('Migrations complete.');
