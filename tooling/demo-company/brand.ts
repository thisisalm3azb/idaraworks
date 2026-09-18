/**
 * The demo brand: what this importer writes under.
 *
 * Its own marker (`demo.showcase`, beside the older `demo.simulation` the 006A
 * factory used), its own uuid namespace so nothing can collide with anything,
 * its own reserved login domain for the fictional staff, and demo wording — so
 * production never carries an H33 marker, the H33 residue proof stays at zero,
 * and the H33 cleanup (which counts `h33.pilot_lab` markers) never sees this
 * company.
 */
import type { Brand } from "../pilot-lab/brand";

export const DEMO_BRAND: Brand = {
  key: "demo",
  title: "Demo showcase",
  markerKey: "demo.showcase",
  markerFlag: "is_demo_showcase",
  checkpointPrefix: "demo.showcase.checkpoint.",
  settingPrefix: "demo.showcase.",
  idPrefix: "demo",
  idNamespace: "8f2e4b6a-1c3d-5e7f-9a0b-2d4c6e8f0a1b",
  seedVersion: "1.0.0",
  emailDomain: "rimal-demo.invalid",
  emailPrefix: "demo",
  userMetaFlag: "demo_showcase",
  fixtureLabel: "Demo company — fictional sample data, no real business, TRN or bank details",
  fixtureShort: "Demo",
};

/** Local state directory (checkpoint mirror, manifest, perf runs). Gitignored. */
export const LOCAL_DIR = ".demo-showcase";

/**
 * Absolute database ceiling checked after every family. Production sits at
 * ~48 MB and one company adds ~25 MB; 160 MB stops a runaway long before the
 * free tier's 500 MB. The test project (~180 MB with the five lab companies)
 * gets the lab's own 300 MB ceiling.
 */
export const DB_CEILING_BYTES: Record<"test" | "production", number> = {
  test: 300 * 1024 * 1024,
  production: 160 * 1024 * 1024,
};
