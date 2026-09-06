/**
 * H33 Pilot Lab — render the seeder's manifest into the owner-facing data
 * manifest document.
 *
 *   npx tsx tooling/pilot-lab/report.ts        # writes docs/H33-DATA-MANIFEST.md
 *
 * Every number in that document comes from `.pilot-lab/manifest.json`, which
 * the seeder writes after each family. Nothing here is typed by hand, because a
 * manifest whose figures were copied across by a person is not a manifest — it
 * is a second set of numbers to keep in step.
 *
 * Read-only: no database connection, no environment, no guard needed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DIR } from "./checkpoint";
import type { Manifest } from "./manifest";
import { COMPANIES } from "./companies";

const OUT = "docs/H33-DATA-MANIFEST.md";
const MB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const N = (n: number) => n.toLocaleString("en-US");

function main() {
  const path = join(LOCAL_DIR, "manifest.json");
  if (!existsSync(path)) throw new Error(`no manifest at ${path} — run the seed first`);
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;

  const rowsOf = (c: Manifest["companies"][number]) =>
    Object.values(c.live_rows_by_table).reduce((a, b) => a + b, 0);

  // Every table any company wrote, so the big table is complete rather than
  // the union of whatever the first company happened to touch.
  const tables = [...new Set(m.companies.flatMap((c) => Object.keys(c.live_rows_by_table)))].sort();
  const families = [...new Set(m.companies.flatMap((c) => c.families_done))].sort();

  const out: string[] = [];
  const p = (s = "") => out.push(s);

  p("# H33 — Pilot Lab data manifest");
  p();
  p("Generated from `.pilot-lab/manifest.json` by `npx tsx tooling/pilot-lab/report.ts`.");
  p("Every figure below is counted from the database, not estimated.");
  p();
  p(`- **Seed version** \`${m.seed_version}\``);
  p(`- **Generated** ${m.generated_at}`);
  p(
    `- **Test project** \`${m.test_project_ref}\` (the isolated project; production is refused by construction)`,
  );
  p(`- **Login domain** \`${m.email_domain}\` — reserved, cannot receive mail`);
  p(`- **History** ${m.data_range.from} → ${m.data_range.as_of}`);
  p(`- **Completeness checksum** \`${m.completeness_checksum}\``);
  p();
  p("## Totals");
  p();
  p("| | |");
  p("| --- | --- |");
  p(`| Rows written | **${N(m.totals.rows)}** |`);
  p(`| Database before | ${MB(m.totals.db_bytes_before)} |`);
  p(`| Database after | **${MB(m.totals.db_bytes_after)}** |`);
  p(`| Growth | ${MB(m.totals.db_bytes_after - m.totals.db_bytes_before)} |`);
  p(`| Storage objects | ${MB(m.totals.storage_bytes)} |`);
  p(`| Ceiling | 300.0 MB (the seeder stops rather than pass it) |`);
  p();

  p("## The five companies");
  p();
  p("| Company | Organisation | Rows | Families |");
  p("| --- | --- | --- | --- |");
  for (const c of m.companies) {
    p(
      `| **${c.name_en}** · ${c.name_ar}<br>\`${c.key}\` | \`${c.org_id}\` | ${N(rowsOf(c))} | ${c.families_done.length}/15 |`,
    );
  }
  p();

  p("## Rows by family");
  p();
  p(`| Family | ${m.companies.map((c) => c.key).join(" | ")} | Total |`);
  p(`| --- | ${m.companies.map(() => "---:").join(" | ")} | ---: |`);
  for (const fam of families) {
    const per = m.companies.map((c) =>
      Object.values(c.actual[fam] ?? {}).reduce((a, b) => a + b, 0),
    );
    p(`| \`${fam}\` | ${per.map(N).join(" | ")} | **${N(per.reduce((a, b) => a + b, 0))}** |`);
  }
  p();

  p("## Rows by table");
  p();
  p("<details><summary>Every table the lab wrote, counted live</summary>");
  p();
  p(`| Table | ${m.companies.map((c) => c.key).join(" | ")} | Total |`);
  p(`| --- | ${m.companies.map(() => "---:").join(" | ")} | ---: |`);
  for (const t of tables) {
    const per = m.companies.map((c) => c.live_rows_by_table[t] ?? 0);
    p(`| \`${t}\` | ${per.map(N).join(" | ")} | **${N(per.reduce((a, b) => a + b, 0))}** |`);
  }
  p();
  p("</details>");
  p();

  p("## Logins");
  p();
  p("No password exists for any of these accounts. `npm run lab:open -- <company> <persona>`");
  p("mints a one-time link that dies on first use.");
  p();
  p("| Persona | Role | Email pattern |");
  p("| --- | --- | --- |");
  const sample = m.companies[0];
  if (sample) {
    for (const persona of sample.personas) {
      p(
        `| \`${persona.key}\` | ${persona.role} | \`h33.<company>.${persona.key}@${m.email_domain}\` |`,
      );
    }
  }
  p();

  p("## Volumes the profiles asked for");
  p();
  p("One company crosses the 1,205-row pagination boundary on each major");
  p("surface; the rest stay substantial without paying for it five times over.");
  p();
  p("| Knob | " + COMPANIES.map((c) => c.key).join(" | ") + " |");
  p("| --- | " + COMPANIES.map(() => "---:").join(" | ") + " |");
  const knobs = [
    "customers",
    "suppliers",
    "items",
    "employees",
    "projects",
    "jobs",
    "leads",
    "opportunities",
    "quotes",
    "invoices",
    "purchaseOrders",
    "documents",
    "assets",
  ] as const;
  for (const k of knobs) {
    p(`| ${k} | ` + COMPANIES.map((c) => N(c.profile[k] as number)).join(" | ") + " |");
  }
  p();

  p("## Cleanup");
  p();
  p("The lab is **retained** on purpose. When the owner is finished with it:");
  p();
  p("```bash");
  p("npm run lab:cleanup-preview          # shows exactly what would go");
  p(`npx tsx tooling/pilot-lab/cleanup.ts --confirm "${m.cleanup.phrase}"`);
  p("```");
  p();
  p(`It deletes only organisations carrying \`${m.cleanup.marker_key}\` at seed`);
  p(`version \`${m.cleanup.seed_version}\`, refuses to run unless exactly five are`);
  p("found, and re-checks the marker inside the transaction.");
  p();
  p("Organisation ids it will accept:");
  p();
  for (const id of m.cleanup.org_ids) p(`- \`${id}\``);
  p();

  writeFileSync(OUT, out.join("\n") + "\n");
  console.log(`wrote ${OUT}: ${m.companies.length} companies, ${N(m.totals.rows)} rows`);
}

main();
