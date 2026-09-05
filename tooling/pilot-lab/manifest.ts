/**
 * H33 Pilot Lab — the machine-readable manifest.
 *
 * One file, `.pilot-lab/manifest.json` (gitignored; a redacted copy is published
 * as docs/H33-DATA-MANIFEST.md), holding what the mandate asks for: the seed
 * version, the five organisation ids, the markers, expected and actual counts by
 * family and table, timestamps, the data date range, the test-only capabilities
 * that were on, a checksum that detects incomplete seeding, and the evidence the
 * cleanup will need.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DIR } from "./checkpoint";
import { MARKER_KEY, SEED_VERSION, EMAIL_DOMAIN } from "./marker";
import type { CompanyKey, FamilyPlan, FamilyReport } from "./types";

const MANIFEST_PATH = join(LOCAL_DIR, "manifest.json");

export type CompanyManifest = {
  key: CompanyKey;
  name_en: string;
  name_ar: string;
  org_id: string;
  marker_key: string;
  seed_version: string;
  created_at: string;
  personas: Array<{ key: string; role: string; email: string }>;
  expected: Record<string, Record<string, number>>; // family → table → rows
  actual: Record<string, Record<string, number>>; // family → table → rows
  families_done: string[];
  live_rows_by_table: Record<string, number>;
};

export type Manifest = {
  seed_version: string;
  generated_at: string;
  data_range: { from: string; as_of: string };
  test_project_ref: string;
  email_domain: string;
  enabled_test_capabilities: string[];
  companies: CompanyManifest[];
  totals: { rows: number; db_bytes_before: number; db_bytes_after: number; storage_bytes: number };
  /** sha256 over (seed_version, org ids, families_done per org, actual counts). */
  completeness_checksum: string;
  cleanup: {
    marker_key: string;
    seed_version: string;
    org_ids: string[];
    user_email_pattern: string;
    phrase: string;
  };
};

export function cleanupPhrase(ref: string): string {
  return `delete-the-five-h33-companies-in-${ref}`;
}

export function checksumOf(m: Omit<Manifest, "completeness_checksum">): string {
  const h = createHash("sha256");
  h.update(m.seed_version);
  for (const c of m.companies) {
    h.update(c.org_id);
    h.update(c.families_done.slice().sort().join(","));
    h.update(JSON.stringify(c.actual));
  }
  return h.digest("hex");
}

export function readManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

export function writeManifest(m: Manifest): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

export function emptyCompanyManifest(input: {
  key: CompanyKey;
  name_en: string;
  name_ar: string;
  org_id: string;
  created_at: string;
  personas: CompanyManifest["personas"];
}): CompanyManifest {
  return {
    ...input,
    marker_key: MARKER_KEY,
    seed_version: SEED_VERSION,
    expected: {},
    actual: {},
    families_done: [],
    live_rows_by_table: {},
  };
}

export function recordPlan(c: CompanyManifest, plan: FamilyPlan): void {
  c.expected[plan.family] = plan.expected;
}

export function recordReport(c: CompanyManifest, report: FamilyReport): void {
  c.actual[report.family] = report.counts;
  if (!c.families_done.includes(report.family)) c.families_done.push(report.family);
}

export function totalRows(companies: CompanyManifest[]): number {
  let n = 0;
  for (const c of companies) for (const v of Object.values(c.live_rows_by_table)) n += v;
  return n;
}

export const EMAIL_PATTERN = `h33.<company>.<persona>@${EMAIL_DOMAIN}`;
