/**
 * Migration runner (S0 checklist §3).
 * - Applies supabase/migrations/*.sql in filename order over DIRECT_URL,
 *   each file in one transaction, tracked in app.migrations (owner-only table).
 * - Post-step: sets the app_user password from APP_DB_PASSWORD (never stored in SQL).
 * - `--to <prefix>` applies migrations up to and including the given filename prefix
 *   (used by VC-1 to apply 0000 only, before any real table exists).
 *
 * Forward-only (BUILD_BIBLE §4.14). Never run against prod outside the release process.
 */
import "./load-env";
import { readdirSync, readFileSync } from "node:fs";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import path from "node:path";
import postgres from "postgres";

/** RFC 5802/7677 SCRAM-SHA-256 verifier — Postgres accepts it in ALTER ROLE PASSWORD. */
function scramSha256Verifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function runMigrations(options: { to?: string } = {}): Promise<MigrateResult> {
  const direct = process.env.DIRECT_URL;
  if (!direct) {
    throw new Error("DIRECT_URL is not set (fill .env.local). Migrations refuse to guess.");
  }
  const sql = postgres(direct, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await sql`create schema if not exists app`;
    await sql`
      create table if not exists app.migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const done = new Set(
      (await sql`select filename from app.migrations`).map((r) => r.filename as string),
    );

    for (const file of files) {
      if (options.to && file.slice(0, options.to.length) > options.to) {
        skipped.push(file);
        continue;
      }
      if (done.has(file)) {
        continue;
      }
      const body = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into app.migrations (filename) values (${file})`;
      });
      applied.push(file);
    }

    // Post-step: app_user credential from env. Security review fixes:
    // (a) empty-but-present APP_DB_PASSWORD is an error, never a silent skip;
    // (b) send a SCRAM-SHA-256 VERIFIER, not the plaintext — the observable
    //     statement (pg_stat_statements, DDL logs) then contains no recoverable
    //     password.
    const password = process.env.APP_DB_PASSWORD;
    if (password !== undefined) {
      if (password.length === 0) {
        throw new Error("APP_DB_PASSWORD is set but empty — refusing to leave app_user unset.");
      }
      const verifier = scramSha256Verifier(password);
      // Verifier charset is [A-Za-z0-9+/=$:] — no quoting hazard; %L via format()
      // as belt-and-braces, with the verifier passed as a bound parameter.
      const [row] = await sql`
        select format('alter role app_user with login password %L', ${verifier}::text) as q`;
      await sql.unsafe((row as { q: string }).q);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { applied, skipped };
}

// CLI entry
const isDirect = process.argv[1]?.replace(/\\/g, "/").endsWith("tooling/scripts/migrate.ts");
if (isDirect) {
  const toFlag = process.argv.indexOf("--to");
  const to = toFlag >= 0 ? process.argv[toFlag + 1] : undefined;
  runMigrations({ to })
    .then((r) => {
      console.log(
        `migrations: applied [${r.applied.join(", ") || "none"}]` +
          (r.skipped.length ? ` · held back by --to: [${r.skipped.join(", ")}]` : ""),
      );
    })
    .catch((err) => {
      console.error("migration failed:", err.message ?? err);
      process.exit(1);
    });
}
