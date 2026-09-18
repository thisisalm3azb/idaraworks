/**
 * The brand law: the H33 Pilot Lab is byte-for-byte itself, and the demo brand
 * shares nothing with it that could be mistaken for H33 in production.
 */
import { describe, expect, it } from "vitest";
import {
  H33_BRAND,
  brandNow,
  isMarkerOf,
  makeMarkerFor,
  personaEmailFor,
  setActiveBrand,
} from "../../tooling/pilot-lab/brand";
import {
  CHECKPOINT_PREFIX,
  EMAIL_DOMAIN,
  MARKER_KEY,
  SEED_VERSION,
  isLabMarker,
  makeMarker,
} from "../../tooling/pilot-lab/marker";
import { H33_NAMESPACE, id as labId } from "../../tooling/pilot-lab/ids";
import { personaEmail } from "../../tooling/pilot-lab/companies";
import { DEMO_BRAND, DB_CEILING_BYTES } from "../../tooling/demo-company/brand";
import { RIMAL } from "../../tooling/demo-company/company";
import { productionPhrase } from "../../tooling/demo-company/guard";
import { cleanupPhrase, emailPatternOf } from "../../tooling/demo-company/manifest";
import { uuidv5 } from "../../tooling/simulation/rng";

describe("the H33 brand is the lab, exactly", () => {
  it("carries the lab's own constants", () => {
    expect(H33_BRAND.markerKey).toBe(MARKER_KEY);
    expect(H33_BRAND.checkpointPrefix).toBe(CHECKPOINT_PREFIX);
    expect(H33_BRAND.seedVersion).toBe(SEED_VERSION);
    expect(H33_BRAND.emailDomain).toBe(EMAIL_DOMAIN);
    expect(H33_BRAND.idNamespace).toBe(H33_NAMESPACE);
  });
  it("mints the same persona addresses and the same marker as the lab", () => {
    expect(personaEmailFor(H33_BRAND, "gulfbuild", "owner")).toBe(
      personaEmail("gulfbuild", "owner"),
    );
    const m = makeMarkerFor(H33_BRAND, "gulfbuild", "2026-09-05T00:00:00Z");
    expect(isLabMarker(m)).toBe(true);
    expect(m).toEqual(makeMarker("gulfbuild", "2026-09-05T00:00:00Z"));
  });
  it("is the process default: nothing ever sets it and every family reads H33", () => {
    expect(brandNow()).toBe(H33_BRAND);
  });
  it("ids under the H33 brand are the lab's ids", () => {
    const viaBrand = uuidv5(
      `${H33_BRAND.idPrefix}:${H33_BRAND.seedVersion}:gulfbuild:setup:pay_period:2024-01-01`,
      H33_BRAND.idNamespace,
    );
    expect(viaBrand).toBe(labId("gulfbuild", "setup", "pay_period", "2024-01-01"));
  });
});

describe("the demo brand shares nothing with H33 that production could mistake", () => {
  const h33ish = /h33|pilot/i;
  it("has no h33 or pilot in any key, prefix, domain or wording", () => {
    for (const [k, v] of Object.entries(DEMO_BRAND))
      if (typeof v === "string") expect(v, k).not.toMatch(h33ish);
  });
  it("uses a different marker, namespace, prefixes and login domain", () => {
    expect(DEMO_BRAND.markerKey).not.toBe(H33_BRAND.markerKey);
    expect(DEMO_BRAND.markerFlag).not.toBe(H33_BRAND.markerFlag);
    expect(DEMO_BRAND.idNamespace).not.toBe(H33_BRAND.idNamespace);
    expect(DEMO_BRAND.checkpointPrefix.startsWith("h33")).toBe(false);
    expect(DEMO_BRAND.settingPrefix.startsWith("h33")).toBe(false);
    expect(DEMO_BRAND.emailDomain).not.toBe(H33_BRAND.emailDomain);
    expect(DEMO_BRAND.emailDomain.endsWith(".invalid")).toBe(true);
    expect(DEMO_BRAND.markerKey).not.toBe("demo.simulation");
  });
  it("its marker is not the lab's marker and the lab's is not its", () => {
    const demo = makeMarkerFor(DEMO_BRAND, "rimal", "2026-09-18T00:00:00Z");
    expect(isLabMarker(demo)).toBe(false);
    expect(isMarkerOf(DEMO_BRAND, demo)).toBe(true);
    expect(isMarkerOf(DEMO_BRAND, makeMarker("gulfbuild", "2026-09-05T00:00:00Z"))).toBe(false);
    expect(isMarkerOf(H33_BRAND, demo)).toBe(false);
  });
  it("an id minted under it can never equal an H33 id for the same ordinal", () => {
    const a = uuidv5(
      `${DEMO_BRAND.idPrefix}:${DEMO_BRAND.seedVersion}:rimal:setup:x:1`,
      DEMO_BRAND.idNamespace,
    );
    const b = uuidv5(
      `${H33_BRAND.idPrefix}:${H33_BRAND.seedVersion}:rimal:setup:x:1`,
      H33_BRAND.idNamespace,
    );
    expect(a).not.toBe(b);
  });
  it("the fictional personas live on the reserved domain; the owner may not", () => {
    expect(personaEmailFor(DEMO_BRAND, "rimal", "manager")).toBe(
      "demo.rimal.manager@rimal-demo.invalid",
    );
    expect(emailPatternOf(DEMO_BRAND, "rimal")).toBe("demo.rimal.%@rimal-demo.invalid");
  });
  it("its phrases name the operation and the project, and differ from the lab's", () => {
    expect(productionPhrase("anhgeeutrwftsvuzfinf")).toBe(
      "seed-demo-showcase-into-anhgeeutrwftsvuzfinf",
    );
    expect(cleanupPhrase("anhgeeutrwftsvuzfinf")).toBe(
      "delete-the-demo-showcase-company-in-anhgeeutrwftsvuzfinf",
    );
    expect(cleanupPhrase("x")).not.toContain("h33");
  });
  it("its production ceiling is well under the free tier and below the lab's", () => {
    expect(DB_CEILING_BYTES.production).toBeLessThan(500 * 1024 * 1024);
    expect(DB_CEILING_BYTES.production).toBeLessThan(DB_CEILING_BYTES.test);
  });
});

describe("the demo company", () => {
  it("is labelled a demo where a reader will see it", () => {
    expect(RIMAL.legalNameEn).toMatch(/demo/i);
    expect(RIMAL.legalNameEn).toMatch(/fictional/i);
  });
  it("has nine personas with distinct fictional names on a construction template", () => {
    expect(RIMAL.personas).toHaveLength(9);
    expect(new Set(RIMAL.personas.map((p) => p.fullName)).size).toBe(9);
    expect(RIMAL.templateKey).toBe("construction_v1");
    expect(RIMAL.key).toBe("rimal");
  });
  it("spans roughly two years to its own today", () => {
    const days = (Date.parse(RIMAL.history.asOf) - Date.parse(RIMAL.history.from)) / 86_400_000;
    expect(days).toBeGreaterThan(18 * 30);
    expect(days).toBeLessThan(24 * 31);
  });
  it("enables both lots and serials", () => {
    expect(RIMAL.profile.enables.lots).toBe(true);
    expect(RIMAL.profile.enables.serials).toBe(true);
  });
});

describe("the active brand switch", () => {
  it("defaults to H33 and follows the last setter", () => {
    expect(brandNow().key).toBe("h33");
    setActiveBrand(DEMO_BRAND);
    expect(brandNow().key).toBe("demo");
    setActiveBrand(H33_BRAND);
    expect(brandNow().key).toBe("h33");
  });
});
