/**
 * Writes the PRIVATE artifacts of a simulation run OUTSIDE the git repo: the
 * owner-facing credentials file and the cleanup/recovery manifest. Passwords are
 * written to the file only — never returned to stdout or logs. On Windows the
 * files are locked down to the current user via icacls (best-effort).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProvisionResult } from "./provision";

export const PRIVATE_DIR = "C:\\Users\\abdul\\Desktop\\IdaraWorks Private";
export const LOGIN_URL = "https://idaraworks.vercel.app/login";

function lockdown(path: string): void {
  try {
    // Remove inheritance and grant only the current user full control.
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
      stdio: "ignore",
    });
  } catch {
    // Non-fatal: the file still lives outside the repo and is git-ignored.
  }
}

export function ensurePrivateDir(dir = PRIVATE_DIR): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write the human-readable credentials file. Contains passwords → private only. */
export function writeCredentialsFile(
  results: ProvisionResult[],
  meta: { asOf: string; generatedAt: string },
  dir = PRIVATE_DIR,
): string {
  ensurePrivateDir(dir);
  const path = join(dir, "simulation-accounts.txt");
  const lines: string[] = [
    "IdaraWorks — Simulation Accounts (PRIVATE — do not share or commit)",
    "=================================================================",
    `Generated: ${meta.generatedAt}`,
    `Simulation as-of date: ${meta.asOf}`,
    `Login URL: ${LOGIN_URL}`,
    "",
    "These are TEMPORARY simulation/demo accounts with fictional data. Rotate the",
    "passwords or delete the accounts (sim-cleanup) before any broader public launch.",
    "",
  ];
  results.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.displayName}`,
      `   Login email : ${r.email}`,
      `   Password    : ${r.password}`,
      `   Language    : ${r.locale === "ar" ? "Arabic (RTL)" : "English"}`,
      `   Login URL   : ${LOGIN_URL}`,
      "",
    );
  });
  writeFileSync(path, lines.join("\r\n"), { encoding: "utf8" });
  lockdown(path);
  return path;
}

/** Write the cleanup/recovery manifest (ids only — NO passwords). */
export function writeManifest(
  results: ProvisionResult[],
  meta: {
    asOf: string;
    generatedAt: string;
    projectRef: string;
    preSeedCounts?: Record<string, number>;
  },
  dir = PRIVATE_DIR,
): string {
  ensurePrivateDir(dir);
  const path = join(dir, "sim-manifest.json");
  const manifest = {
    kind: "idaraworks-simulation-manifest",
    version: 1,
    projectRef: meta.projectRef,
    asOf: meta.asOf,
    generatedAt: meta.generatedAt,
    preSeedCounts: meta.preSeedCounts ?? null,
    accounts: results.map((r) => ({
      scenario: r.scenarioKey,
      displayName: r.displayName,
      orgId: r.orgId,
      ownerUserId: r.ownerUserId,
      email: r.email,
      locale: r.locale,
    })),
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2), { encoding: "utf8" });
  lockdown(path);
  return path;
}
