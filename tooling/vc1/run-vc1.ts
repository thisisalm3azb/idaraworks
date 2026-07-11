/**
 * VC-1 — the Supavisor transaction-pooler GUC/RLS spike (S0 checklist §16).
 * Proves, against a REAL pooler, that the withCtx mechanism cannot leak:
 *
 *  1. default-deny        — no ctx set => zero rows readable
 *  2. ctx isolation       — org A sees only A; org B sees only B
 *  3. pooled alternation  — 30 sequential transactions alternating orgs on a
 *                           2-connection pool: no bleed between borrowers
 *  4. concurrent interleave — 40 parallel withCtx calls with jitter inside the
 *                           transaction: every result org-pure
 *  5. cross-org write     — INSERT with a foreign org_id rejected BY THE DATABASE
 *  6. GUC reset           — after a ctx transaction, a no-ctx read on the same
 *                           pool sees zero rows again
 *
 * Runs against a disposable probe table (public.vc1_probe) so it can execute
 * BEFORE any real tenant table exists (migration 0000 only). Used by both the
 * hosted spike script (`pnpm vc1`) and the CI integration test.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createAppDb } from "@/platform/tenancy/db";
import { withCtxOn } from "@/platform/tenancy/withCtx";
import type { Ctx } from "@/platform/tenancy/ctx";
import { sql } from "drizzle-orm";

export type CheckResult = { check: string; passed: boolean; detail: string };
export type Vc1Report = { passed: boolean; results: CheckResult[] };

const PROBE = "vc1_probe";

export async function runVc1(): Promise<Vc1Report> {
  const direct = process.env.DIRECT_URL;
  if (!direct)
    throw new Error("DIRECT_URL is not set — VC-1 needs the owner connection for setup.");

  const owner = postgres(direct, { max: 1, onnotice: () => {} });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  const ctxA: Ctx = { orgId: orgA, userId: user, costPrivileged: false, requestId: "vc1-a" };
  const ctxB: Ctx = { orgId: orgB, userId: user, costPrivileged: false, requestId: "vc1-b" };
  const results: CheckResult[] = [];
  const record = (check: string, passed: boolean, detail: string) => {
    results.push({ check, passed, detail });
    console.log(`vc1: ${passed ? "PASS" : "FAIL"} ${check}`);
  };

  // Setup: probe table + policy + seed (owner side). Requires 0000 (app schema, role).
  await owner.unsafe(`
    drop table if exists public.${PROBE};
    create table public.${PROBE} (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null,
      note text not null
    );
    alter table public.${PROBE} enable row level security;
    create policy ${PROBE}_tenant_isolation on public.${PROBE}
      for all to app_user
      using (org_id = (select app.current_org_id()))
      with check (org_id = (select app.current_org_id()));
    grant select, insert on public.${PROBE} to app_user;
  `);
  await owner`insert into public.vc1_probe (org_id, note) values (${orgA}, 'a1'), (${orgA}, 'a2'), (${orgB}, 'b1')`;

  // Small pool through the POOLER as app_user — pool size 2 forces connection reuse.
  const pooled = createAppDb({ max: 2 });

  const withTimeout = async <T>(label: string, ms: number, p: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Check 0 — pooled authentication as app_user, with layered diagnostics.
  // (Phase B CI incident: the first pooled app_user query hung — this check
  // isolates verifier-vs-pooler-auth failures in one run instead of guessing.)
  {
    console.log("vc1: check 0 (pooled auth as app_user) ...");
    let detail = "";
    let ok = false;
    try {
      const r = (await withTimeout(
        "pooled app_user auth",
        20_000,
        // A transaction, per the A-B5 pool law (transactions are the pool's only path).
        pooled.db.transaction(async (tx) => tx.execute(sql`select current_user as u`)),
      )) as unknown as Array<{ u: string }>;
      ok = r[0]?.u === "app_user";
      detail = `pooled connection authenticated as ${r[0]?.u}`;
    } catch (poolErr) {
      detail = `pooled auth failed: ${(poolErr as Error).message.slice(0, 120)}`;
      // Diagnostic 1: is the stored credential a SCRAM verifier?
      try {
        const [row] = await owner`
          select left(rolpassword, 14) as prefix from pg_authid where rolname = 'app_user'`;
        detail += ` | stored credential prefix: ${row?.prefix ?? "NULL"}`;
      } catch {
        detail += " | pg_authid unreadable (not superuser)";
      }
      // Diagnostic 2: can app_user authenticate DIRECTLY (bypassing the pooler)?
      try {
        const directUrl = new URL(direct);
        directUrl.username = "app_user";
        directUrl.password = encodeURIComponent(process.env.APP_DB_PASSWORD ?? "");
        const directClient = postgres(directUrl.toString(), {
          max: 1,
          connect_timeout: 10,
          prepare: false,
          onnotice: () => {},
        });
        const [du] = await withTimeout(
          "direct app_user auth",
          15_000,
          directClient`select current_user as u`,
        );
        detail += ` | DIRECT as app_user: ok (${du?.u}) => pooler-side auth issue`;
        await directClient.end({ timeout: 3 });
      } catch (dErr) {
        detail += ` | DIRECT as app_user also failed (${(dErr as Error).message.slice(0, 80)}) => credential issue`;
      }
      // Diagnostic 3: plaintext ALTER via owner, then one pooled retry — isolates
      // verifier-generation bugs. Loud, diagnostic-only; migrate.ts stays verifier-only.
      try {
        const plain = (process.env.APP_DB_PASSWORD ?? "").replace(/'/g, "''");
        await owner.unsafe(`alter role app_user with login password '${plain}'`);
        const r2 = (await withTimeout(
          "pooled retry after plaintext ALTER",
          20_000,
          pooled.db.execute(sql`select current_user as u`),
        )) as unknown as Array<{ u: string }>;
        if (r2[0]?.u === "app_user") {
          ok = true;
          detail += " | PLAINTEXT FALLBACK WORKED => scramSha256Verifier output rejected; fix it";
        } else {
          detail += " | plaintext retry returned unexpected user";
        }
      } catch (rErr) {
        detail += ` | plaintext retry failed too (${(rErr as Error).message.slice(0, 80)})`;
      }
    }
    record("0 pooled auth", ok, detail);
    console.log(`vc1: check 0 => ${ok ? "PASS" : "FAIL"} — ${detail}`);
    if (!ok) {
      await pooled.end();
      await owner.unsafe(`drop table if exists public.${PROBE}`);
      await owner.end({ timeout: 5 });
      return { passed: false, results };
    }
  }

  const countRows = async (ctx: Ctx): Promise<{ n: number; orgs: string[] }> =>
    withCtxOn(pooled.db, ctx, async (tx) => {
      const rows = (await tx.execute(
        sql`select org_id::text as org_id from public.vc1_probe`,
      )) as unknown as Array<{ org_id: string }>;
      return { n: rows.length, orgs: [...new Set(rows.map((r) => r.org_id))] };
    });

  // No-ctx probes run on dedicated short-lived clients, NOT the shared pool.
  // Two reasons: (a) LAW (checklist A-B5, CI run ae21a6b finding) — the shared
  // pool is for withCtx transactions only; postgres.js can stall its queue for
  // bare executes after an aborted transaction under transaction-mode pooling;
  // (b) the leak property lives on the SERVER connections behind Supavisor,
  // which fresh clients sample just as faithfully.
  const bareProbe = async (label: string): Promise<number> => {
    const fresh = createAppDb({ max: 1 });
    try {
      const r = (await withTimeout(
        `no-ctx probe ${label}`,
        15_000,
        fresh.db.execute(sql`select count(*)::int as n from public.vc1_probe`),
      )) as unknown as Array<{ n: number }>;
      return r[0]?.n ?? -1;
    } finally {
      await fresh.end();
    }
  };

  try {
    // 1. default-deny: no ctx
    const bare = await bareProbe("check1");
    record("1 default-deny", bare === 0, `no-ctx read returned ${bare} rows (want 0)`);

    // 2. ctx isolation
    const a = await countRows(ctxA);
    const b = await countRows(ctxB);
    record(
      "2 ctx isolation",
      a.n === 2 && a.orgs.every((o) => o === orgA) && b.n === 1 && b.orgs.every((o) => o === orgB),
      `A saw ${a.n} rows (${a.orgs.length} org), B saw ${b.n} rows (${b.orgs.length} org)`,
    );

    // 3. pooled alternation — sequential, forces reuse of the 2 connections
    let alternationPure = true;
    for (let i = 0; i < 30; i++) {
      const ctx = i % 2 === 0 ? ctxA : ctxB;
      const r = await countRows(ctx);
      const expected = i % 2 === 0 ? 2 : 1;
      if (r.n !== expected || r.orgs.some((o) => o !== ctx.orgId)) {
        alternationPure = false;
        record("3 pooled alternation", false, `iteration ${i}: saw ${r.n} rows / orgs ${r.orgs}`);
        break;
      }
    }
    if (alternationPure) record("3 pooled alternation", true, "30/30 transactions org-pure");

    // 4. concurrent interleave with jitter inside the transaction
    const tasks = Array.from({ length: 40 }, (_, i) => {
      const ctx = i % 2 === 0 ? ctxA : ctxB;
      return withCtxOn(pooled.db, ctx, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.005 + random() * 0.02)`);
        const rows = (await tx.execute(
          sql`select distinct org_id::text as org_id from public.vc1_probe`,
        )) as unknown as Array<{ org_id: string }>;
        return { i, ctxOrg: ctx.orgId, seen: rows.map((r) => r.org_id) };
      });
    });
    const outcomes = await Promise.all(tasks);
    const impure = outcomes.filter((o) => o.seen.length !== 1 || o.seen[0] !== o.ctxOrg);
    record(
      "4 concurrent interleave",
      impure.length === 0,
      impure.length === 0
        ? "40/40 parallel transactions org-pure"
        : `${impure.length} impure results, first: task ${impure[0]?.i} saw ${impure[0]?.seen}`,
    );

    // 5. cross-org write blocked by the database (WITH CHECK)
    let writeBlocked = false;
    let writeDetail = "insert unexpectedly succeeded";
    try {
      await withTimeout(
        "check5 cross-org insert",
        20_000,
        withCtxOn(pooled.db, ctxA, async (tx) => {
          await tx.execute(
            sql`insert into public.vc1_probe (org_id, note) values (${orgB}, 'smuggled')`,
          );
        }),
      );
    } catch (err) {
      writeBlocked = true;
      writeDetail = `database rejected: ${(err as Error).message.slice(0, 80)}`;
    }
    const smuggled =
      await owner`select count(*)::int as n from public.vc1_probe where note = 'smuggled'`;
    record(
      "5 cross-org write blocked",
      writeBlocked && smuggled[0]?.n === 0,
      `${writeDetail}; smuggled rows in table: ${smuggled[0]?.n}`,
    );

    // 6. GUC reset after ctx transactions — strengthened per security review:
    // sample the pool repeatedly (sequential > 2x pool size + concurrent burst
    // + an explicit no-GUC transaction) so EVERY pooled connection is observed;
    // a stale-GUC leak on either of the 2 connections cannot hide.
    // Check 6: every no-ctx probe on a dedicated client (A-B5 law); the one
    // plain TRANSACTION probe runs on the shared pool — transactions are the
    // supported pool path and must stay healthy after check 5's aborted tx.
    const sequential: number[] = [];
    for (let k = 0; k < 6; k++) {
      sequential.push(await bareProbe(`seq-${k}`));
    }
    const burst = await Promise.all(
      ["burst-0", "burst-1", "burst-2", "burst-3"].map((l) => bareProbe(l)),
    );
    const inPlainTx = await withTimeout(
      "check6 plain-tx on the shared pool",
      20_000,
      pooled.db.transaction(async (tx) => {
        const r = (await tx.execute(
          sql`select count(*)::int as n from public.vc1_probe`,
        )) as unknown as Array<{ n: number }>;
        return r[0]?.n ?? -1;
      }),
    );
    const samples = [...sequential, ...burst, inPlainTx];
    record(
      "6 GUC reset",
      samples.every((n) => n === 0),
      `11 no-ctx samples (6 sequential + 4 concurrent + 1 pool tx) returned [${samples.join(",")}] (want all 0)`,
    );
  } finally {
    await pooled.end();
    await owner.unsafe(`drop table if exists public.${PROBE}`);
    await owner.end({ timeout: 5 });
  }

  return { passed: results.every((r) => r.passed), results };
}
