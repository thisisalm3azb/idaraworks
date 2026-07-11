/**
 * The ONLY place in src/ where database clients are constructed
 * (phase2/10 #3 — enforced by ESLint outside this directory).
 *
 * The app pool connects as `app_user` (NOBYPASSRLS) through the Supavisor
 * transaction-mode pooler. `prepare: false` is REQUIRED: named prepared
 * statements break under transaction-mode pooling because consecutive
 * statements may hit different server connections.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { appDatabaseUrl } from "./env";

export type AppDb = PostgresJsDatabase<Record<string, never>>;

export function createAppDb(options: { max?: number; url?: string } = {}): {
  db: AppDb;
  end: () => Promise<void>;
} {
  const client = postgres(options.url ?? appDatabaseUrl(), {
    max: options.max ?? Number(process.env.APP_DB_POOL_MAX ?? 10),
    prepare: false, // transaction-mode pooling law — do not change
    connect_timeout: 15, // fail fast, never hang a CI job (Phase B incident)
    onnotice: () => {},
  });
  return { db: drizzle(client), end: () => client.end({ timeout: 5 }) };
}

let shared: { db: AppDb; end: () => Promise<void> } | undefined;

/**
 * Shared app pool (lazy). LAW (checklist A-B5, proven in CI run ae21a6b):
 * this pool is for withCtx TRANSACTIONS only. Bare `.execute()` on the pool is
 * banned — postgres.js can stall its dispatch queue for non-transaction queries
 * queued beyond pool size after an aborted transaction under transaction-mode
 * pooling (server connections idle, client queue dead). One-off unscoped needs
 * (health checks, probes) use a dedicated `createAppDb({ max: 1 })` client.
 * A lint guard lands with Phase C's health endpoint.
 */
export function appDb(): AppDb {
  shared ??= createAppDb();
  return shared.db;
}

/** Test/shutdown hook. */
export async function closeAppDb(): Promise<void> {
  if (shared) {
    await shared.end();
    shared = undefined;
  }
}
