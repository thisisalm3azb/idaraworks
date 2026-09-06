/**
 * H33 Pilot Lab — render the performance harness's measurements into the
 * owner-facing report.
 *
 *   npx tsx tooling/pilot-lab/perf-report.ts                 # newest run
 *   npx tsx tooling/pilot-lab/perf-report.ts perf-2026-…json # a specific one
 *
 * Reads `.pilot-lab/perf-*.json` and writes docs/H33-PERFORMANCE-REPORT.md.
 * Every figure comes from the harness; nothing here is typed by hand, for the
 * same reason the data manifest is generated — two sets of numbers that have to
 * be kept in step are one set of numbers and one liability.
 *
 * Read-only: no database, no environment, no guard needed.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DIR } from "./checkpoint";

type Sample = { ms: number; requests: number; status: number | null; bytes: number };
type Result = {
  company: string;
  persona: string;
  surface: string;
  path: string;
  cold: Sample;
  median: number;
  slowest: number;
  requestsMedian: number;
  note?: string;
};
type Run = {
  base: string;
  mobile: boolean;
  locale: string;
  persona: string;
  results: Result[];
};

const OUT = "docs/H33-PERFORMANCE-REPORT.md";
const ms = (n: number) => `${n.toLocaleString("en-US")} ms`;

/** The slowest run wins the summary: a median hides the one page that hurts. */
function worst(results: Result[], by: (r: Result) => number): Result | undefined {
  return results.slice().sort((a, b) => by(b) - by(a))[0];
}

function main() {
  const named = process.argv[2];
  const files = existsSync(LOCAL_DIR)
    ? readdirSync(LOCAL_DIR)
        .filter((f) => /^perf-.*\.json$/.test(f))
        .sort()
    : [];
  const file = named ?? files[files.length - 1];
  if (!file) throw new Error(`no perf run in ${LOCAL_DIR} — run npm run lab:perf first`);
  const run = JSON.parse(readFileSync(join(LOCAL_DIR, file), "utf8")) as Run;
  const rs = run.results;
  if (!rs.length) throw new Error(`${file} holds no measurements`);

  const companies = [...new Set(rs.map((r) => r.company))];
  const surfaces = [...new Set(rs.map((r) => r.surface))];
  const medians = rs.map((r) => r.median).sort((a, b) => a - b);
  const p50 = medians[Math.floor(medians.length / 2)]!;
  const p95 = medians[Math.floor(medians.length * 0.95)]!;
  const over3s = rs.filter((r) => r.median > 3000);
  const errors = rs.filter((r) => (r.cold.status ?? 200) >= 400);

  const out: string[] = [];
  const p = (s = "") => out.push(s);

  p("# H33 — Pilot Lab performance report");
  p();
  p(`Generated from \`${LOCAL_DIR}/${file}\` by \`npx tsx tooling/pilot-lab/perf-report.ts\`.`);
  p();
  p("## What was measured, and what it is not");
  p();
  p("Each surface was opened three times with a real browser as a signed-in");
  p("persona, and timed from navigation start to network idle. The first run is");
  p("reported separately as **cold**, because the development server compiles a");
  p("route on its first hit and that compile is not a product characteristic.");
  p("The **median** of the three is the figure to read.");
  p();
  p("This is a development server on a laptop, talking to a database in another");
  p("region. It is not production, and the absolute numbers should not be quoted");
  p("as such. What it is good for is comparison — which surfaces are heavy, which");
  p("companies' volumes hurt, and whether anything is pathological.");
  p();
  p(
    `- **Where** \`${run.base}\` · ${run.mobile ? "mobile viewport" : "desktop"} · locale \`${run.locale}\``,
  );
  p(`- **Persona** \`${run.persona}\``);
  p(
    `- **Coverage** ${surfaces.length} surfaces × ${companies.length} companies = ${rs.length} measurements`,
  );
  p();

  p("## Summary");
  p();
  p("| | |");
  p("| --- | --- |");
  p(`| Median across every surface | **${ms(p50)}** |`);
  p(`| 95th percentile | ${ms(p95)} |`);
  p(`| Surfaces over 3 s (median) | ${over3s.length} |`);
  p(`| Responses that were not 2xx/3xx | ${errors.length} |`);
  const wm = worst(rs, (r) => r.median);
  if (wm) p(`| Slowest surface | \`${wm.company}/${wm.surface}\` at ${ms(wm.median)} |`);
  const wc = worst(rs, (r) => r.cold.ms);
  if (wc) p(`| Slowest cold compile | \`${wc.company}/${wc.surface}\` at ${ms(wc.cold.ms)} |`);
  p();

  if (errors.length) {
    p("### Responses that were not successful");
    p();
    p("| Company | Surface | Path | Status |");
    p("| --- | --- | --- | --- |");
    for (const e of errors)
      p(`| ${e.company} | ${e.surface} | \`${e.path}\` | **${e.cold.status}** |`);
    p();
    if (errors.some((e) => e.cold.status === 404)) {
      p(
        "A **404** here is far more often a stale `.next` development cache than " +
          "a missing feature: a damaged route manifest serves some routes and " +
          "refuses others. Delete `.next`, restart the app and measure again " +
          "before reading anything into it. It cost this phase two wrong " +
          "diagnoses.",
      );
      p();
    }
  }

  if (over3s.length) {
    p("### Over three seconds");
    p();
    p("| Company | Surface | Median | Slowest | Requests |");
    p("| --- | --- | ---: | ---: | ---: |");
    for (const r of over3s.sort((a, b) => b.median - a.median))
      p(
        `| ${r.company} | ${r.surface} | **${ms(r.median)}** | ${ms(r.slowest)} | ${r.requestsMedian} |`,
      );
    p();
  } else {
    p("No surface had a median over three seconds.");
    p();
  }

  p("## Every surface, by company");
  p();
  p(`| Surface | ${companies.join(" | ")} |`);
  p(`| --- | ${companies.map(() => "---:").join(" | ")} |`);
  for (const s of surfaces) {
    const cells = companies.map((c) => {
      const r = rs.find((x) => x.company === c && x.surface === s);
      return r ? `${r.median.toLocaleString("en-US")}` : "—";
    });
    p(`| ${s} | ${cells.join(" | ")} |`);
  }
  p();
  p("Figures are medians in milliseconds.");
  p();

  p("## Cold versus warm");
  p();
  p("The gap between the two is the development server compiling, not the");
  p("product thinking. It is reported so nobody reads a first-hit number as a");
  p("product characteristic.");
  p();
  p("| Company | Cold (median of surfaces) | Warm (median) | Difference |");
  p("| --- | ---: | ---: | ---: |");
  for (const c of companies) {
    const own = rs.filter((r) => r.company === c);
    const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const cold = mid(own.map((r) => r.cold.ms));
    const warm = mid(own.map((r) => r.median));
    p(`| ${c} | ${ms(cold)} | ${ms(warm)} | ${ms(cold - warm)} |`);
  }
  p();

  writeFileSync(OUT, out.join("\n") + "\n");
  console.log(`wrote ${OUT}: ${rs.length} measurements from ${file}`);
}

main();
