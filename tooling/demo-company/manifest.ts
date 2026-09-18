/**
 * Demo company importer — the manifest: what exists, counted, and how to undo it.
 *
 * Written after every family so an interruption leaves an accurate record.
 * Every figure comes from the importer's own counts; nothing is typed by hand.
 * Lives in the gitignored local state directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brand } from "../pilot-lab/brand";
import type { FamilyPlan, FamilyReport } from "../pilot-lab/types";
import { LOCAL_DIR } from "./brand";

const MANIFEST_PATH = join(LOCAL_DIR, "manifest.json");

export type DemoManifest = {
  brand_key: string;
  marker_key: string;
  seed_version: string;
  generated_at: string;
  env: "test" | "production";
  project_ref: string;
  company_key: string;
  name_en: string;
  name_ar: string;
  org_id: string;
  data_range: { from: string; as_of: string };
  /** The fictional personas' addresses; the owner's real address is never written here. */
  personas: Array<{ key: string; role: string; email: string }>;
  expected: Record<string, Record<string, number>>; // family → table → rows
  actual: Record<string, Record<string, number>>; // family → table → rows
  families_done: string[];
  live_rows_by_table: Record<string, number>;
  totals: { rows: number; db_bytes_before: number; db_bytes_after: number };
  completeness_checksum: string;
  cleanup: { phrase: string; email_pattern: string };
};

/** The phrase a cleanup must be handed. It names the operation and the project. */
export function cleanupPhrase(ref: string): string {
  return `delete-the-demo-showcase-company-in-${ref}`;
}

export function emailPatternOf(brand: Brand, companyKey: string): string {
  return `${brand.emailPrefix}.${companyKey}.%@${brand.emailDomain}`;
}

export function readManifest(): DemoManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as DemoManifest;
}

export function writeManifest(m: DemoManifest): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

export function recordPlan(m: DemoManifest, plan: FamilyPlan): void {
  m.expected[plan.family] = plan.expected;
}

export function recordReport(m: DemoManifest, report: FamilyReport): void {
  m.actual[report.family] = report.counts;
  if (!m.families_done.includes(report.family)) m.families_done.push(report.family);
}

export function finalize(m: DemoManifest, before: number, after: number): DemoManifest {
  m.totals.db_bytes_before = Math.min(m.totals.db_bytes_before || before, before);
  m.totals.db_bytes_after = after;
  m.totals.rows = Object.values(m.live_rows_by_table).reduce((a, b) => a + b, 0);
  const h = createHash("sha256");
  h.update(m.seed_version);
  h.update(m.org_id);
  h.update(m.families_done.slice().sort().join(","));
  h.update(JSON.stringify(m.actual));
  m.completeness_checksum = h.digest("hex");
  return m;
}
