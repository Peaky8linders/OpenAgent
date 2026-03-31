/**
 * Store factory — creates the appropriate LcmStore based on config.
 *
 * Usage:
 *   const store = createStore({ driver: 'sqlite', path: ':memory:' });
 *   await store.initialize();
 */
import type { LcmStore } from './lcm-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { PgStoreOptions } from './pg-store.js';

export interface StoreConfig {
  driver: 'sqlite' | 'postgres';
  // SQLite options
  path?: string;
  // PostgreSQL options
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
  embeddingDimensions?: number;
}

export async function createStore(config: StoreConfig): Promise<LcmStore> {
  if (config.driver === 'postgres') {
    // Dynamic import to avoid requiring pg when using sqlite
    const { PgStore } = await import('./pg-store.js');
    const opts: PgStoreOptions = {
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      maxConnections: config.maxConnections,
      embeddingDimensions: config.embeddingDimensions,
    };
    const store = new PgStore(opts);
    await store.initialize();
    return store;
  }

  const store = new SqliteStore({ path: config.path ?? ':memory:' });
  await store.initialize();
  return store;
}
