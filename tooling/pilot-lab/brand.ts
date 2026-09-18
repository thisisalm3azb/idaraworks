/**
 * What a seed writes UNDER — the brand.
 *
 * The generator families are generic: they take a company definition and a
 * context. Everything that made the H33 Pilot Lab specifically H33 — its
 * marker key, the prefixes on every `app_settings` key it writes, the uuid
 * namespace every id is minted in, the reserved login domain, the wording on
 * documents — is one `Brand`. A family reads `ctx.brand ?? H33_BRAND`, so
 * the lab's own orchestrator (which sets no brand) behaves exactly as before,
 * and a different importer can hand the same families a different brand.
 *
 * This module knows nothing about environments. Which project a brand may be
 * written to is the importer's business and its guard's.
 */
import { CHECKPOINT_PREFIX, EMAIL_DOMAIN, MARKER_KEY, SEED_VERSION } from "./marker";
import { H33_NAMESPACE } from "./ids";

export type Brand = {
  key: "h33" | "demo";
  /** Short human title for console output. */
  title: string;
  /** The `app_settings` key that alone authorises a write or a delete. */
  markerKey: string;
  /** The boolean field inside the marker JSON that names this brand. */
  markerFlag: string;
  /** `app_settings` key prefix for per-family checkpoints. */
  checkpointPrefix: string;
  /** `app_settings` key prefix for every other key a family writes (service progress). */
  settingPrefix: string;
  /** Prefix and uuidv5 namespace for every generated id, hash and RNG seed. */
  idPrefix: string;
  idNamespace: string;
  seedVersion: string;
  /** Reserved, undeliverable login domain for the fictional personas (RFC 2606). */
  emailDomain: string;
  /** `<emailPrefix>.<company>.<persona>@<emailDomain>` */
  emailPrefix: string;
  /** `auth.users.raw_user_meta_data` flag set on logins this brand creates. */
  userMetaFlag: string;
  /** Wording that reaches documents, file descriptions and app metadata. */
  fixtureLabel: string;
  fixtureShort: string;
};

export const H33_BRAND: Brand = {
  key: "h33",
  title: "H33 Pilot Lab",
  markerKey: MARKER_KEY,
  markerFlag: "is_h33_pilot_lab",
  checkpointPrefix: CHECKPOINT_PREFIX,
  settingPrefix: "h33.",
  idPrefix: "h33",
  idNamespace: H33_NAMESPACE,
  seedVersion: SEED_VERSION,
  emailDomain: EMAIL_DOMAIN,
  emailPrefix: "h33",
  userMetaFlag: "h33_pilot_lab",
  fixtureLabel: "Fictional pilot company — no real business, TRN or bank details",
  fixtureShort: "Pilot Lab",
};

/*
 * The brand a process is writing under. The lab never sets it, so every lab
 * run reads H33 here; an importer sets it ONCE at startup, before any family
 * runs. Families read it at the sites that used to hold an "h33" literal —
 * a progress key, an idempotency key, a document footer — where no context
 * is in scope and threading one through a dozen pure builders would touch
 * far more of the lab than the wording is worth.
 */
let activeBrand: Brand = H33_BRAND;

export function setActiveBrand(brand: Brand): void {
  activeBrand = brand;
}

/** The brand this process writes under (H33 unless an importer said otherwise). */
export function brandNow(): Brand {
  return activeBrand;
}

/** `<prefix>.<company>.<persona>@<domain>` — the same shape for every brand. */
export function personaEmailFor(brand: Brand, company: string, persona: string): string {
  return `${brand.emailPrefix}.${company}.${persona}@${brand.emailDomain}`;
}

export type BrandMarker = Record<string, unknown> & {
  seed_version: string;
  company_key: string;
  generated_at: string;
};

export function makeMarkerFor(brand: Brand, companyKey: string, generatedAt: string): BrandMarker {
  return {
    [brand.markerFlag]: true,
    seed_version: brand.seedVersion,
    company_key: companyKey,
    generated_at: generatedAt,
  };
}

export function isMarkerOf(brand: Brand, v: unknown): v is BrandMarker {
  let obj: unknown = v;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return false;
    }
  }
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o[brand.markerFlag] === true &&
    typeof o.seed_version === "string" &&
    typeof o.company_key === "string"
  );
}
