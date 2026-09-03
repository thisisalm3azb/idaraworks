/**
 * H29 — the closed country-pack registry and its effective-dated resolution
 * (ADR-66, ADR-68).
 *
 * Resolution is always by (country, date). Nothing anywhere asks for "the
 * latest pack": a transaction dated in an earlier period resolves the version
 * whose validity window contains that date, which is what keeps a pack update
 * from rewriting history.
 *
 * Validity windows are [effectiveFrom, effectiveTo), half-open, so two versions
 * can meet on a date without overlapping. `assertRegistryIsSound` proves that
 * and is asserted by a unit test rather than trusted.
 */
import { AE_PACK } from "./packs/ae";
import { SA_PACK } from "./packs/sa";
import type { CountryPack, PackStatus } from "./types";

/** Every pack version the platform knows. Closed: a new country lands here. */
export const COUNTRY_PACKS: readonly CountryPack[] = [AE_PACK, SA_PACK] as const;

/** Countries with at least one pack, in a stable order. */
export const PACK_COUNTRIES: readonly string[] = [
  ...new Set(COUNTRY_PACKS.map((p) => p.country)),
].sort();

/** Statuses a pack may be resolved under. Draft and review never apply to work. */
const RESOLVABLE: ReadonlySet<PackStatus> = new Set<PackStatus>([
  "active",
  "approved",
  "retired",
  "superseded",
]);

export function getPack(packKey: string): CountryPack | null {
  return COUNTRY_PACKS.find((p) => p.packKey === packKey) ?? null;
}

/** Every version for a country, oldest first. */
export function packsFor(country: string): CountryPack[] {
  return COUNTRY_PACKS.filter((p) => p.country === country).sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
}

function covers(pack: CountryPack, on: string): boolean {
  if (on < pack.effectiveFrom) return false;
  return pack.effectiveTo === null || on < pack.effectiveTo;
}

/**
 * The pack that applies to `country` on the ISO date `on`, or null when the
 * country has no pack covering that date. A retired or superseded version still
 * resolves for a date inside its own window — that is historical reproducibility.
 */
export function resolvePack(country: string, on: string): CountryPack | null {
  return packsFor(country).find((p) => RESOLVABLE.has(p.status) && covers(p, on)) ?? null;
}

/** The version that will apply next after `on`, when one is scheduled. */
export function nextPackAfter(country: string, on: string): CountryPack | null {
  return packsFor(country).find((p) => p.effectiveFrom > on && RESOLVABLE.has(p.status)) ?? null;
}

/** True when the country can be configured at all. */
export function countrySupported(country: string): boolean {
  return PACK_COUNTRIES.includes(country);
}

// ── soundness ───────────────────────────────────────────────────────────────

export type RegistryProblem = { packKey: string; problem: string };

/**
 * The registry's own laws, checked rather than assumed: unique keys, a country
 * that matches the key, dates that parse, a window that is not inverted, no two
 * resolvable versions covering the same day, and a supersession that points at a
 * version that exists.
 */
export function registryProblems(packs: readonly CountryPack[] = COUNTRY_PACKS): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seen = new Set<string>();
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  for (const p of packs) {
    if (seen.has(p.packKey)) problems.push({ packKey: p.packKey, problem: "duplicate pack key" });
    seen.add(p.packKey);
    if (!p.packKey.startsWith(`${p.country}-`))
      problems.push({ packKey: p.packKey, problem: "pack key does not start with its country" });
    if (!isDate(p.effectiveFrom))
      problems.push({ packKey: p.packKey, problem: "effectiveFrom is not an ISO date" });
    if (p.effectiveTo !== null && !isDate(p.effectiveTo))
      problems.push({ packKey: p.packKey, problem: "effectiveTo is not an ISO date" });
    if (p.effectiveTo !== null && p.effectiveTo <= p.effectiveFrom)
      problems.push({ packKey: p.packKey, problem: "effectiveTo is not after effectiveFrom" });
    if (p.supersedes !== null && !packs.some((q) => q.packKey === p.supersedes))
      problems.push({ packKey: p.packKey, problem: `supersedes an unknown pack ${p.supersedes}` });
    if (p.format.currency.length !== 3)
      problems.push({ packKey: p.packKey, problem: "currency is not a three-letter code" });
  }

  for (const country of [...new Set(packs.map((p) => p.country))]) {
    const versions = packs
      .filter((p) => p.country === country && RESOLVABLE.has(p.status))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    for (let i = 1; i < versions.length; i++) {
      const previous = versions[i - 1]!;
      const current = versions[i]!;
      if (previous.effectiveTo === null || previous.effectiveTo > current.effectiveFrom)
        problems.push({
          packKey: current.packKey,
          problem: `overlaps ${previous.packKey}: the earlier version does not end before this one starts`,
        });
    }
  }
  return problems;
}

export function assertRegistryIsSound(packs: readonly CountryPack[] = COUNTRY_PACKS): void {
  const problems = registryProblems(packs);
  if (problems.length)
    throw new Error(
      `country pack registry is unsound:\n${problems.map((p) => `  ${p.packKey}: ${p.problem}`).join("\n")}`,
    );
}
