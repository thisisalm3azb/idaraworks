/**
 * Tenancy connection environment (S0 checklist §10, AR-2).
 *
 * Contract:
 * - DATABASE_URL  = the Supabase "Transaction pooler" URI exactly as shown in the
 *   dashboard (any user). The app NEVER uses those credentials directly.
 * - APP_DB_PASSWORD = password of the `app_user` role (created by migration 0000,
 *   password set by the migration runner).
 * - appDatabaseUrl() derives the app's pooled connection string by swapping the
 *   username's first segment to `app_user` (preserving Supavisor's
 *   `<user>.<project-ref>` suffix on hosted; plain `<user>` locally) and the password.
 * - DIRECT_URL is used ONLY by the migration runner / integration-test seeding —
 *   never imported by app code (phase2/10 #1).
 */

export class TenancyEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyEnvError";
  }
}

export function appDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!base) {
    throw new TenancyEnvError(
      "DATABASE_URL is not set. Fill .env.local with the Supabase Transaction-pooler URI.",
    );
  }
  if (!password) {
    throw new TenancyEnvError(
      "APP_DB_PASSWORD is not set. Generate one, put it in .env.local, and run `pnpm db:migrate` so the runner sets it on the app_user role.",
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TenancyEnvError("DATABASE_URL is not a valid URL.");
  }
  const segments = decodeURIComponent(url.username).split(".");
  segments[0] = "app_user";
  url.username = encodeURIComponent(segments.join("."));
  url.password = encodeURIComponent(password);
  return url.toString();
}
