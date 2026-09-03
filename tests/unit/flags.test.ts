/**
 * H22F — the release gate defaults to CLOSED.
 *
 * Small file, load-bearing property. A flag that is on by default anywhere —
 * development included — is a flag nobody notices is still off in production,
 * and one that accepts several spellings of "on" is a flag that turns itself on
 * when somebody writes `true` in an environment variable and moves on.
 *
 * The whole H22 instruction is that inventory stays unavailable until the system
 * is verified end to end. This is the single line of code enforcing it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  stockSurfacesEnabled,
  hrSurfacesEnabled,
  financeSurfacesEnabled,
  managementStudioEnabled,
  documentStudioEnabled,
  revenueStudioEnabled,
  idaraEnabled,
} from "@/platform/flags";

/** H26 — the Document Studio gate obeys exactly the same law. */
describe("the document studio release gate", () => {
  const orig = process.env.FEATURE_DOCUMENT_STUDIO;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_DOCUMENT_STUDIO;
    else process.env.FEATURE_DOCUMENT_STUDIO = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_DOCUMENT_STUDIO;
    expect(documentStudioEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_DOCUMENT_STUDIO = value;
      expect(documentStudioEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_DOCUMENT_STUDIO = "1";
    expect(documentStudioEnabled()).toBe(true);
  });
});

/** H27 — the Revenue Growth Studio gate obeys exactly the same law. */
describe("the revenue studio release gate", () => {
  const orig = process.env.FEATURE_REVENUE_STUDIO;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_REVENUE_STUDIO;
    else process.env.FEATURE_REVENUE_STUDIO = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_REVENUE_STUDIO;
    expect(revenueStudioEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_REVENUE_STUDIO = value;
      expect(revenueStudioEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_REVENUE_STUDIO = "1";
    expect(revenueStudioEnabled()).toBe(true);
  });
});

const original = process.env.FEATURE_STOCK_SURFACES;

afterEach(() => {
  if (original === undefined) delete process.env.FEATURE_STOCK_SURFACES;
  else process.env.FEATURE_STOCK_SURFACES = original;
});

describe("the stock and asset release gate", () => {
  it("is off when nothing is set", () => {
    delete process.env.FEATURE_STOCK_SURFACES;
    expect(stockSurfacesEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    /*
     * Deliberately strict. Accepting "true" as well would look friendlier and
     * would mean a deployment that sets FEATURE_STOCK_SURFACES=false — an
     * entirely reasonable way to write "off" — is indistinguishable from one
     * that meant it, in whichever direction the parser happened to guess.
     */
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_STOCK_SURFACES = value;
      expect(stockSurfacesEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_STOCK_SURFACES = "1";
    expect(stockSurfacesEnabled()).toBe(true);
  });
});

/** H23G — the HR gate obeys exactly the same law. */
describe("the HR surfaces release gate", () => {
  const orig = process.env.FEATURE_HR_SURFACES;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_HR_SURFACES;
    else process.env.FEATURE_HR_SURFACES = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_HR_SURFACES;
    expect(hrSurfacesEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_HR_SURFACES = value;
      expect(hrSurfacesEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_HR_SURFACES = "1";
    expect(hrSurfacesEnabled()).toBe(true);
  });
});

/** H24K — the finance gate obeys exactly the same law. */
describe("the finance surfaces release gate", () => {
  const orig = process.env.FEATURE_FINANCE_SURFACES;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_FINANCE_SURFACES;
    else process.env.FEATURE_FINANCE_SURFACES = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_FINANCE_SURFACES;
    expect(financeSurfacesEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_FINANCE_SURFACES = value;
      expect(financeSurfacesEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_FINANCE_SURFACES = "1";
    expect(financeSurfacesEnabled()).toBe(true);
  });
});

/** H25 — the Studio gate obeys exactly the same law. */
describe("the Management Studio release gate", () => {
  const orig = process.env.FEATURE_MANAGEMENT_STUDIO;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_MANAGEMENT_STUDIO;
    else process.env.FEATURE_MANAGEMENT_STUDIO = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_MANAGEMENT_STUDIO;
    expect(managementStudioEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_MANAGEMENT_STUDIO = value;
      expect(managementStudioEnabled(), `"${value}" turned the surfaces on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_MANAGEMENT_STUDIO = "1";
    expect(managementStudioEnabled()).toBe(true);
  });
});

/** H28 — the Idara Intelligence gate obeys exactly the same law. */
describe("the idara intelligence release gate", () => {
  const orig = process.env.FEATURE_IDARA_INTELLIGENCE;
  afterEach(() => {
    if (orig === undefined) delete process.env.FEATURE_IDARA_INTELLIGENCE;
    else process.env.FEATURE_IDARA_INTELLIGENCE = orig;
  });

  it("is off when nothing is set", () => {
    delete process.env.FEATURE_IDARA_INTELLIGENCE;
    expect(idaraEnabled()).toBe(false);
  });

  it("is off for every near-miss spelling", () => {
    for (const value of ["", "0", "false", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      process.env.FEATURE_IDARA_INTELLIGENCE = value;
      expect(idaraEnabled(), `"${value}" turned the dock on`).toBe(false);
    }
  });

  it("is on for exactly one value", () => {
    process.env.FEATURE_IDARA_INTELLIGENCE = "1";
    expect(idaraEnabled()).toBe(true);
  });
});
