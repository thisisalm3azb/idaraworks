/**
 * The demo/simulation marker — the ONLY thing that authorises the factory (and
 * the cleanup) to touch an organization. Stored in the typed per-org key/value
 * store `public.app_settings` (no new column), invisible to feature code, and
 * checked before every mutating or destructive operation. An org without this
 * exact marker is treated as real production data and is never touched.
 */

/** app_settings key holding the simulation provenance record. */
export const DEMO_MARKER_KEY = "demo.simulation";

/** Bumped when the scenario shape changes; recorded in each org's marker. */
export const SIM_VERSION = "1.0.0";

export type DemoMarker = {
  is_demo: true;
  sim_version: string;
  generated_at: string; // ISO — the real execution timestamp
  scenario: string; // scenario key (e.g. "coffee_catering")
  as_of: string; // YYYY-MM-DD simulation date
};

/** The hosted Supabase project this factory is allowed to run against. Any other
 * project reference is refused (guards.ts) so a mis-pointed .env can't seed the
 * wrong database. Derived from NEXT_PUBLIC_SUPABASE_URL at audit time. */
export const EXPECTED_PROJECT_REF = "anhgeeutrwftsvuzfinf";

export function isDemoMarker(v: unknown): v is DemoMarker {
  // Tolerate a JSON-string-encoded marker as well as a proper object, so cleanup
  // can still recognise (and remove) a marker written by an older/misencoded run.
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
    (obj as { is_demo?: unknown }).is_demo === true &&
    typeof (obj as { scenario?: unknown }).scenario === "string"
  );
}
