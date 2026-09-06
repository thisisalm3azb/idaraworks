/**
 * H33 Pilot Lab — the orchestrator.
 *
 *   npx tsx tooling/pilot-lab/run.ts dry-run                 # counts and bytes, no writes
 *   npx tsx tooling/pilot-lab/run.ts seed --confirm          # provision + every family, resumable
 *   npx tsx tooling/pilot-lab/run.ts seed --confirm --only=gulfbuild --family=customers
 *   npx tsx tooling/pilot-lab/run.ts verify                  # every family's checks, no writes
 *   npx tsx tooling/pilot-lab/run.ts status                  # what exists, what is checkpointed
 *
 * Cleanup is a separate tool (cleanup.ts) with its own phrase, on purpose.
 *
 * Order of operations per company: provision → families in dependency order,
 * skipping any family whose checkpoint is present, checking the capacity ceiling
 * after every family, writing the manifest after every family. A crash anywhere
 * leaves a resumable state; a second complete run writes nothing new.
 */
import { loadLabEnv } from "./guard";
import {
  openOwner,
  assertUnderBudget,
  dbSizeBytes,
  liveRowCounts,
  insertBatch,
  type Sql,
} from "./db";
import { COMPANIES, personaEmail } from "./companies";
import { provisionCompany, adminClient, findLabOrg } from "./provision";
import { getCheckpoint, setCheckpoint, listCheckpoints } from "./checkpoint";
import {
  readManifest,
  writeManifest,
  emptyCompanyManifest,
  recordPlan,
  recordReport,
  checksumOf,
  cleanupPhrase,
  type Manifest,
} from "./manifest";
import { FAMILIES } from "./families";
import { Rng } from "../simulation/rng";
import { SimClock } from "../simulation/dates";
import { id as labId } from "./ids";
import { SEED_VERSION, EMAIL_DOMAIN } from "./marker";
import type { Company, Family, FamilyPlan, FamilyReport, LabContext, PersonaKey } from "./types";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";

const argv = process.argv.slice(2);
const MODE = argv[0] ?? "status";
const CONFIRM = argv.includes("--confirm");
const only = argv.find((a) => a.startsWith("--only="))?.slice(7);
const onlyFamily = argv.find((a) => a.startsWith("--family="))?.slice(9);

/** The test-only capabilities the lab switches on (deploy flags, exported by the launcher). */
export const ENABLED_TEST_CAPABILITIES = [
  "FEATURE_STOCK_SURFACES",
  "FEATURE_HR_SURFACES",
  "FEATURE_FINANCE_SURFACES",
  "FEATURE_MANAGEMENT_STUDIO",
  "FEATURE_DOCUMENT_STUDIO",
  "FEATURE_REVENUE_STUDIO",
  "FEATURE_BRANDED_COMPANY_APPS",
  "FEATURE_GUIDED_ONBOARDING",
];

/** Topological order over the registered families; a missing dep is a build error. */
export function orderedFamilies(all: Family[]): Family[] {
  const byKey = new Map(all.map((f) => [f.key, f]));
  for (const f of all)
    for (const d of f.deps)
      if (!byKey.has(d)) throw new Error(`family ${f.key} depends on unknown family ${d}`);
  const out: Family[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (f: Family) => {
    const s = state.get(f.key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`family dependency cycle at ${f.key}`);
    state.set(f.key, "visiting");
    for (const d of f.deps) visit(byKey.get(d)!);
    state.set(f.key, "done");
    out.push(f);
  };
  for (const f of all) visit(f);
  return out;
}

function makeCtx(input: {
  sql: Sql;
  admin: ReturnType<typeof adminClient>;
  company: Company;
  orgId: string;
  users: Record<PersonaKey, string>;
  handoffs: Record<string, Record<string, unknown>>;
  dryRun: boolean;
  log: (m: string) => void;
}): LabContext {
  const { company } = input;
  const employees: LabContext["employees"] = {};
  return {
    sql: input.sql,
    admin: input.admin,
    company,
    orgId: input.orgId,
    users: input.users,
    employees,
    ctxFor: (persona): Ctx => {
      const p = company.personas.find((x) => x.key === persona)!;
      const privileged = p.roleKey === "owner" || p.roleKey === "admin" || p.roleKey === "accounts";
      return {
        orgId: input.orgId,
        userId: input.users[persona],
        costPrivileged: privileged,
        pricePrivileged: privileged,
        requestId: `h33-${company.key}-${persona}`,
      };
    },
    archetypeOf: (persona) => company.personas.find((x) => x.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: (table, rows, conflict) =>
      input.dryRun
        ? Promise.resolve({ attempted: rows.length, inserted: 0 })
        : insertBatch(input.sql, table, rows, { conflict }),
    handoff: <T>(family: string) => {
      const h = input.handoffs[family];
      // A live seed insists: a missing handoff means a family is about to
      // build against nothing, and silently writing fewer rows is exactly the
      // failure this lab must not have. A dry run is only an estimate, and a
      // family whose build could not complete offline (one that reads
      // installed presets, say) should cost the estimate that family's
      // detail, not the whole run.
      if (!h && !input.dryRun)
        throw new Error(`no handoff from family ${family} (is it a declared dependency?)`);
      return (h ?? {}) as T;
    },
    log: input.log,
    dryRun: input.dryRun,
  };
}

async function main() {
  const env = loadLabEnv();
  console.log(`H33 Pilot Lab — ${MODE} — test project ${env.ref}`);
  const sql = openOwner(env);
  const admin = adminClient(env);
  const now = new Date().toISOString();
  const companies = only ? COMPANIES.filter((c) => c.key === only) : COMPANIES;
  if (only && companies.length === 0) throw new Error(`unknown company ${only}`);
  const families = orderedFamilies(FAMILIES);

  try {
    const before = await dbSizeBytes(sql);
    console.log(
      `database: ${(before / 1048576).toFixed(1)} MB before; ${families.length} families registered`,
    );

    // ── status ─────────────────────────────────────────────────────────────
    if (MODE === "status") {
      for (const c of companies) {
        const orgId = await findLabOrg(sql, c.key);
        if (!orgId) {
          console.log(`  ${c.key.padEnd(10)} not provisioned`);
          continue;
        }
        const cps = await listCheckpoints(sql, orgId);
        const done = families.filter((f) => f.appliesTo(c) && cps[f.key]).length;
        const applicable = families.filter((f) => f.appliesTo(c)).length;
        console.log(`  ${c.key.padEnd(10)} ${orgId}  families ${done}/${applicable} done`);
      }
      return;
    }

    if (MODE === "seed" && !CONFIRM) {
      throw new Error("seed writes to the test project; pass --confirm (or use dry-run)");
    }
    const dryRun = MODE === "dry-run";
    const verifyOnly = MODE === "verify";
    if (!["dry-run", "seed", "verify"].includes(MODE)) throw new Error(`unknown mode ${MODE}`);

    const manifest: Manifest = readManifest() ?? {
      seed_version: SEED_VERSION,
      generated_at: now,
      data_range: { from: COMPANIES[0]!.history.from, as_of: COMPANIES[0]!.history.asOf },
      test_project_ref: env.ref,
      email_domain: EMAIL_DOMAIN,
      enabled_test_capabilities: ENABLED_TEST_CAPABILITIES,
      companies: [],
      totals: { rows: 0, db_bytes_before: before, db_bytes_after: before, storage_bytes: 0 },
      completeness_checksum: "",
      cleanup: {
        marker_key: "h33.pilot_lab",
        seed_version: SEED_VERSION,
        org_ids: [],
        user_email_pattern: `h33.<company>.<persona>@${EMAIL_DOMAIN}`,
        phrase: cleanupPhrase(env.ref),
      },
    };
    if (manifest.seed_version !== SEED_VERSION)
      throw new Error(
        `manifest is for seed ${manifest.seed_version}; this build is ${SEED_VERSION}`,
      );

    let projectedRows = 0;
    const allChecks: Array<{
      company: string;
      family: string;
      name: string;
      ok: boolean;
      detail?: string;
    }> = [];

    for (const company of companies) {
      const log = (m: string) => console.log(`  [${company.key}] ${m}`);
      console.log(`\n${company.nameEn} (${company.key})`);

      // Provision (never in dry-run: a dry run writes nothing at all).
      let orgId: string;
      let users: Record<PersonaKey, string>;
      if (dryRun) {
        orgId = (await findLabOrg(sql, company.key)) ?? "00000000-0000-0000-0000-000000000000";
        users = Object.fromEntries(
          company.personas.map((p) => [p.key, "00000000-0000-0000-0000-000000000000"]),
        ) as Record<PersonaKey, string>;
      } else if (verifyOnly) {
        const found = await findLabOrg(sql, company.key);
        if (!found) {
          log("not provisioned — nothing to verify");
          continue;
        }
        orgId = found;
        const rows =
          (await sql`select u.email, u.id::text as id from auth.users u where u.email like ${`h33.${company.key}.%@${EMAIL_DOMAIN}`}`) as unknown as Array<{
            email: string;
            id: string;
          }>;
        users = Object.fromEntries(
          company.personas.map((p) => [
            p.key,
            rows.find((r) => r.email === personaEmail(company.key, p.key))?.id ?? "",
          ]),
        ) as Record<PersonaKey, string>;
      } else {
        const p = await provisionCompany(env, sql, company, now, log);
        orgId = p.orgId;
        users = p.users;
      }

      let cm = manifest.companies.find((c) => c.key === company.key);
      if (!cm) {
        cm = emptyCompanyManifest({
          key: company.key,
          name_en: company.nameEn,
          name_ar: company.nameAr,
          org_id: orgId,
          created_at: now,
          personas: company.personas.map((p) => ({
            key: p.key,
            role: p.roleKey,
            email: personaEmail(company.key, p.key),
          })),
        });
        manifest.companies.push(cm);
      }
      cm.org_id = orgId;

      const handoffs: Record<string, Record<string, unknown>> = {};
      const cps = dryRun ? {} : await listCheckpoints(sql, orgId);
      // Handoffs of already-checkpointed families are restored from their reports.
      for (const [fam, cp] of Object.entries(cps))
        if (cp.report.handoff) handoffs[fam] = cp.report.handoff;

      for (const family of families) {
        if (!family.appliesTo(company)) continue;
        if (onlyFamily && family.key !== onlyFamily) continue;
        const ctx = makeCtx({ sql, admin, company, orgId, users, handoffs, dryRun, log });

        if (verifyOnly) {
          if (!family.verify) continue;
          if (!cps[family.key]) {
            allChecks.push({
              company: company.key,
              family: family.key,
              name: "seeded",
              ok: false,
              detail: "no checkpoint",
            });
            continue;
          }
          const checks = await family.verify(ctx);
          for (const c of checks)
            allChecks.push({ company: company.key, family: family.key, ...c });
          const bad = checks.filter((c) => !c.ok).length;
          log(
            `${family.key.padEnd(18)} ${checks.length - bad}/${checks.length} checks ok${
              bad
                ? "  ← " +
                  checks
                    .filter((c) => !c.ok)
                    .map((c) => c.name)
                    .join(", ")
                : ""
            }`,
          );
          continue;
        }

        let plan: FamilyPlan;
        try {
          plan = family.plan(ctx);
        } catch (e) {
          if (!dryRun) throw e;
          log(
            `${family.key.padEnd(18)} could not be estimated: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          continue;
        }
        recordPlan(cm, plan);
        const planned = Object.values(plan.expected).reduce((a, b) => a + b, 0);
        projectedRows += planned;

        if (dryRun) {
          log(
            `${family.key.padEnd(18)} would write ~${planned.toLocaleString()} rows  ${Object.entries(
              plan.expected,
            )
              .map(([t, n]) => `${t}=${n}`)
              .join(" ")}`,
          );
          /*
           * A dry run still has to BUILD each family, because the next one
           * plans against its handoff — the ids of the warehouses, jobs and
           * invoices it would create. `insert` is a no-op while dryRun is set
           * and every family skips its service calls, so this writes nothing;
           * it exists so that the estimate covers all fifteen rather than
           * stopping at the first family with a dependency. A build that
           * throws is reported and the run continues: an estimate is not a
           * gate, and the families that follow simply lose that handoff.
           */
          try {
            const report = await family.seed(ctx);
            if (report.handoff) handoffs[family.key] = report.handoff;
          } catch (e) {
            log(
              `${family.key.padEnd(18)} could not build for the estimate: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          continue;
        }

        const existing = cps[family.key] ?? (await getCheckpoint(sql, orgId, family.key));
        if (existing) {
          log(`${family.key.padEnd(18)} checkpointed — skipped`);
          if (existing.report.handoff) handoffs[family.key] = existing.report.handoff;
          recordReport(cm, existing.report);
          continue;
        }

        const t0 = Date.now();
        const report: FamilyReport = await family.seed(ctx);
        const written = Object.values(report.counts).reduce((a, b) => a + b, 0);
        if (report.handoff) handoffs[family.key] = report.handoff;
        await setCheckpoint(sql, orgId, family.key, report, new Date().toISOString());
        recordReport(cm, report);
        const bytes = await assertUnderBudget(sql, `${company.key}/${family.key}`);
        log(
          `${family.key.padEnd(18)} ${written.toLocaleString().padStart(8)} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s   db ${(bytes / 1048576).toFixed(0)} MB${report.notes?.length ? "  " + report.notes.join("; ") : ""}`,
        );
        writeManifest(finalize(manifest, before, await dbSizeBytes(sql)));
      }

      if (!dryRun) cm.live_rows_by_table = await liveRowCounts(sql, [orgId]);
    }

    if (dryRun) {
      const perRow = 1200;
      console.log(
        `\nDRY RUN: ~${projectedRows.toLocaleString()} rows projected ≈ ${((projectedRows * perRow) / 1048576).toFixed(0)} MB at ~${perRow} B/row incl. indexes; database now ${(before / 1048576).toFixed(0)} MB; ceiling 300 MB.`,
      );
      return;
    }
    if (verifyOnly) {
      const bad = allChecks.filter((c) => !c.ok);
      console.log(`\nVERIFY: ${allChecks.length - bad.length}/${allChecks.length} checks ok`);
      for (const b of bad)
        console.log(
          `  FAIL ${b.company}/${b.family}: ${b.name}${b.detail ? " — " + b.detail : ""}`,
        );
      if (bad.length) process.exitCode = 1;
      return;
    }

    const after = await dbSizeBytes(sql);
    const final = finalize(manifest, before, after);
    writeManifest(final);
    console.log(
      `\nSEED complete: ${final.totals.rows.toLocaleString()} live rows across ${final.companies.length} companies; database ${(after / 1048576).toFixed(0)} MB; checksum ${final.completeness_checksum.slice(0, 12)}…`,
    );
  } finally {
    await sql.end();
    await closeAppDb().catch(() => {});
  }
}

function finalize(m: Manifest, before: number, after: number): Manifest {
  m.totals.db_bytes_before = Math.min(m.totals.db_bytes_before || before, before);
  m.totals.db_bytes_after = after;
  m.totals.rows = m.companies.reduce(
    (n, c) => n + Object.values(c.live_rows_by_table).reduce((a, b) => a + b, 0),
    0,
  );
  m.cleanup.org_ids = m.companies
    .map((c) => c.org_id)
    .filter((x) => x && !x.startsWith("00000000"));
  const { completeness_checksum: _drop, ...rest } = m;
  void _drop;
  m.completeness_checksum = checksumOf(rest);
  return m;
}

/*
 * Run the orchestrator ONLY when this file is the script being executed.
 *
 * Without this guard, importing anything from here — the unit test imports
 * `orderedFamilies` to check the registry — runs the whole seeder as a side
 * effect of the import. In CI, where there is no test-project env, it threw and
 * called process.exit(1), failing the unit-test job from inside a test that had
 * nothing to do with it. Locally it was worse and quieter: the env WAS present,
 * so every unit-test run silently opened a connection to the test project and
 * listed its organisations. A unit test must touch no database at all.
 *
 * Same shape as tooling/scripts/migrate.ts, which learned this the same way.
 */
const isDirect = process.argv[1]?.replace(/\\/g, "/").endsWith("tooling/pilot-lab/run.ts");
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
