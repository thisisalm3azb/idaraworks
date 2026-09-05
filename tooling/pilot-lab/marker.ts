/**
 * H33 Pilot Lab — the marker that alone authorises a write or a delete.
 *
 * Stored in `public.app_settings` under one org-scoped key, like the demo
 * factory's marker and the integration suites' fixture marker, so nothing in the
 * schema had to change for it. The seeder writes it first; the cleanup reads it
 * first; every other tool checks it before touching an organisation.
 */

export const MARKER_KEY = "h33.pilot_lab";
export const CHECKPOINT_PREFIX = "h33.checkpoint.";

/**
 * Bumped when the generated dataset changes shape. Rows carry it through their
 * deterministic ids (see ids.ts), so two versions can never collide and the
 * cleanup can be asked for exactly one of them.
 */
export const SEED_VERSION = "1.0.0";

/** Every lab login lives under a reserved, undeliverable domain (RFC 2606). */
export const EMAIL_DOMAIN = "pilot-lab.invalid";

export type LabMarker = {
  is_h33_pilot_lab: true;
  seed_version: string;
  company_key: string;
  generated_at: string;
};

export function isLabMarker(v: unknown): v is LabMarker {
  let obj: unknown = v;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return false;
    }
  }
  return (
    !!obj &&
    typeof obj === "object" &&
    (obj as LabMarker).is_h33_pilot_lab === true &&
    typeof (obj as LabMarker).seed_version === "string" &&
    typeof (obj as LabMarker).company_key === "string"
  );
}

export function makeMarker(companyKey: string, generatedAt: string): LabMarker {
  return {
    is_h33_pilot_lab: true,
    seed_version: SEED_VERSION,
    company_key: companyKey,
    generated_at: generatedAt,
  };
}
