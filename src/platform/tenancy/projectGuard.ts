/**
 * Fail-fast guard against a server that talks to TWO Supabase projects at once
 * (security review 2026-09-20, evening — the accidental production-configured
 * local build).
 *
 * What happened: `next build` inlines every NEXT_PUBLIC_* variable at build
 * time, so a build run against `.env.local` (production) bakes the production
 * auth URL and anon key into the server bundle, while `next start` under the
 * TEST wrapper supplies the TEST DATABASE_URL at runtime. The result is a
 * server whose AUTH calls go to production and whose DATA calls go to TEST.
 * Every sign-in "expired" (TEST tokens are meaningless to production), which
 * is how it was noticed; the production read-only audit found no side
 * effects, but nothing in the code would have stopped a write.
 *
 * The guard: the Supabase project reference is derivable from both sides —
 * the auth URL's host (`<ref>.supabase.co`) and the database URL (either the
 * direct host `db.<ref>.supabase.co` or the pooler user `postgres.<ref>`).
 * When both are hosted projects and the references differ, the server
 * REFUSES TO START. A local stack (127.0.0.1 / localhost / a compose host)
 * on either side is exempt, because CI and development legitimately pair a
 * local database with a local auth service.
 *
 * Pure and unit-tested; `instrumentation.ts` calls it once at server start.
 */

export class SupabaseProjectMismatchError extends Error {
  constructor(
    public readonly authRef: string,
    public readonly databaseRef: string,
  ) {
    super(
      `Supabase project mismatch: the auth client was built for project "${authRef}" but DATABASE_URL points at project "${databaseRef}". ` +
        `Rebuild with the same environment the server runs with (for the TEST project: node .demo-showcase/with-test-env.mjs pnpm build).`,
    );
    this.name = "SupabaseProjectMismatchError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith(".local") || !host.includes(".");
}

/** The project ref from a hosted Supabase URL (`https://<ref>.supabase.co`), or null when local/unknown. */
export function supabaseRefFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (isLocalHost(host)) return null;
  const m = /^([a-z0-9]{20})\.supabase\.(co|in|net)$/.exec(host);
  return m ? m[1]! : null;
}

/**
 * The project ref from a Supabase Postgres URL: the direct host
 * `db.<ref>.supabase.co`, or the pooler user `postgres.<ref>@aws-…pooler.supabase.com`.
 * Null for a local database or an unrecognised host.
 */
export function supabaseRefFromDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (isLocalHost(host)) return null;
  const direct = /^db\.([a-z0-9]{20})\.supabase\.(co|in|net)$/.exec(host);
  if (direct) return direct[1]!;
  if (/pooler\.supabase\.(com|co)$/.test(host)) {
    const user = decodeURIComponent(u.username);
    const m = /^postgres\.([a-z0-9]{20})$/.exec(user);
    return m ? m[1]! : null;
  }
  return null;
}

/**
 * Throws when the auth project and the database project are both hosted and
 * differ. Returns the refs it compared (for a startup log line).
 */
/** Only NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL are read. */
export type ProjectGuardEnv = Record<string, string | undefined>;

export function assertSameSupabaseProject(env: ProjectGuardEnv = process.env): {
  authRef: string | null;
  databaseRef: string | null;
} {
  const authRef = supabaseRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  const databaseRef = supabaseRefFromDatabaseUrl(env.DATABASE_URL);
  if (authRef && databaseRef && authRef !== databaseRef) {
    throw new SupabaseProjectMismatchError(authRef, databaseRef);
  }
  return { authRef, databaseRef };
}
