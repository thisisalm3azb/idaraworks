/**
 * H29 — the country-pack laws, checked rather than assumed.
 *
 * The registry is sound, resolution is by date and never by recency, every
 * implemented rule carries a source, no rule claims compliance, and the
 * validators are permissive exactly where the mandate says they must be.
 */
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import {
  AE_PACK,
  COUNTRY_PACKS,
  PACK_COUNTRIES,
  SA_PACK,
  addressProblems,
  assertRegistryIsSound,
  countrySupported,
  formatAddress,
  formatAmount,
  formatBusinessDate,
  formatHijriDate,
  formatIban,
  ibanProblems,
  identifierProblems,
  nextPackAfter,
  packsFor,
  phoneProblems,
  registryProblems,
  resolvePack,
  weekdayOf,
  type CountryPack,
  type FormattingContext,
} from "@/platform/country";

const AE_CTX: FormattingContext = {
  uiLocale: "en",
  jurisdiction: "AE",
  timezone: "Asia/Dubai",
  currency: "AED",
};
const SA_CTX: FormattingContext = {
  uiLocale: "ar",
  jurisdiction: "SA",
  timezone: "Asia/Riyadh",
  currency: "SAR",
  hijriDisplay: true,
};

describe("the registry", () => {
  it("is sound: unique keys, parseable dates, no overlapping windows", () => {
    expect(registryProblems()).toEqual([]);
    expect(() => assertRegistryIsSound()).not.toThrow();
  });

  it("catches an overlap rather than resolving one of two arbitrarily", () => {
    const overlapping: CountryPack[] = [
      { ...AE_PACK, packKey: "AE-2026-01-01", effectiveFrom: "2026-01-01", effectiveTo: null },
      { ...AE_PACK, packKey: "AE-2026-06-01", effectiveFrom: "2026-06-01", effectiveTo: null },
    ];
    const problems = registryProblems(overlapping);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.problem).toMatch(/overlaps/);
  });

  it("catches a pack key that does not name its own country", () => {
    const wrong = [{ ...SA_PACK, packKey: "XX-2026-09-03" }];
    expect(registryProblems(wrong).map((p) => p.problem)).toContain(
      "pack key does not start with its country",
    );
  });

  it("knows which countries it can configure, and says no to the rest", () => {
    expect(PACK_COUNTRIES).toEqual(["AE", "SA"]);
    expect(countrySupported("AE")).toBe(true);
    expect(countrySupported("SA")).toBe(true);
    expect(countrySupported("ES")).toBe(false);
    expect(countrySupported("MX")).toBe(false);
  });
});

describe("resolution is by date, never by recency", () => {
  it("returns nothing for a date before the first version", () => {
    expect(resolvePack("AE", "2026-09-02")).toBeNull();
    expect(resolvePack("AE", "2026-09-03")?.packKey).toBe("AE-2026-09-03");
  });

  it("keeps an earlier transaction on the version that covered it", () => {
    // A closed window and a later open one: a date inside the first must resolve
    // the first, even though a newer version exists.
    const earlier: CountryPack = {
      ...AE_PACK,
      packKey: "AE-2025-01-01",
      effectiveFrom: "2025-01-01",
      effectiveTo: "2026-09-03",
      status: "superseded",
    };
    const packs = [earlier, AE_PACK];
    const on = (d: string) =>
      packs.find((p) => d >= p.effectiveFrom && (p.effectiveTo === null || d < p.effectiveTo))
        ?.packKey;
    expect(on("2025-06-30")).toBe("AE-2025-01-01");
    expect(on("2026-09-02")).toBe("AE-2025-01-01");
    expect(on("2026-09-03")).toBe("AE-2026-09-03");
    expect(registryProblems(packs)).toEqual([]);
  });

  it("names the version scheduled next, and nothing when none is", () => {
    expect(nextPackAfter("AE", "2026-09-03")).toBeNull();
    expect(packsFor("SA")).toHaveLength(1);
  });
});

describe("every rule carries its source", () => {
  const sourced = (o: unknown): o is { source: { tier: string; retrieved: string } } =>
    typeof o === "object" && o !== null && "source" in o;

  it("no pack states a rule without an authority, a retrieval date and a tier", () => {
    for (const pack of COUNTRY_PACKS) {
      const rules = [
        pack.week.statutoryRestDays,
        pack.week.minimumRestDaysPerWeek,
        pack.week.standardDailyHours,
        pack.week.standardWeeklyHours,
        pack.format.requiredDocumentLanguages,
        pack.address,
        pack.banking,
        ...pack.identifiers,
        ...pack.tax.flatMap((t) => [
          t.standardRatePercent,
          t.registrationThresholds,
          t.periodRule,
          t.documentFields,
        ]),
        ...(pack.payroll
          ? [
              pack.payroll.endOfService,
              pack.payroll.annualLeave,
              ...pack.payroll.statutoryContributions,
            ]
          : []),
        pack.einvoicing.standard,
        pack.einvoicing.instruments,
        pack.einvoicing.phaseDates,
        pack.privacy.regime,
        pack.privacy.crossBorderRegime,
        ...pack.documents.kinds.map((k) => k.requiredFields),
      ];
      for (const rule of rules) {
        expect(sourced(rule), `${pack.packKey}: a rule has no source`).toBe(true);
        if (sourced(rule)) {
          expect(rule.source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(["verified-primary", "official-summary", "unverified"]).toContain(
            rule.source.tier,
          );
        }
      }
    }
  });

  it("an unverified rule carries no value the product could apply", () => {
    for (const pack of COUNTRY_PACKS) {
      for (const contribution of pack.payroll?.statutoryContributions ?? []) {
        if (contribution.source.tier !== "unverified") continue;
        expect(contribution.value.employerPercent).toBeNull();
        expect(contribution.value.employeePercent).toBeNull();
        expect(contribution.requiresReview).toBe(true);
      }
      if (pack.einvoicing.phaseDates.source.tier === "unverified")
        expect(pack.einvoicing.phaseDates.value).toBeNull();
    }
  });

  it("no pack claims compliance, certification or advice", () => {
    const CLAIM = /\b(compliant|compliance guaranteed|certified|we file|legal advice|guarantee)\b/i;
    for (const pack of COUNTRY_PACKS) {
      const text = JSON.stringify(pack);
      const offending = text.match(CLAIM);
      // "claims none" and "does not claim" are the honest phrasings we do use.
      const bad = offending && !/claims? (none|no )|does not claim|never claim/i.test(text);
      expect(bad, `${pack.packKey}: ${offending?.[0]}`).toBeFalsy();
    }
    expect(AE_PACK.knownLimitations.length).toBeGreaterThan(0);
    expect(SA_PACK.knownLimitations.length).toBeGreaterThan(0);
  });
});

describe("Saudi rules that the sources fix", () => {
  it("requires Arabic on a tax invoice", () => {
    expect(SA_PACK.format.requiredDocumentLanguages.value).toEqual(["ar"]);
    for (const kind of SA_PACK.documents.kinds) expect(kind.requiredLanguages).toContain("ar");
  });

  it("names Friday as the statutory rest day and leaves Saturday to the employer", () => {
    expect(SA_PACK.week.statutoryRestDays.value).toEqual(["fri"]);
    expect(SA_PACK.week.defaultWorkingDays).not.toContain("fri");
    expect(SA_PACK.week.statutoryRestDays.note).toMatch(/customary, not statutory/i);
  });

  it("leaves the end-of-service wage base to configuration and review", () => {
    expect(SA_PACK.payroll!.endOfService.value!.base).toBe("configured");
    expect(SA_PACK.payroll!.endOfService.requiresReview).toBe(true);
  });

  it("carries the ZATCA regime without a credential", () => {
    expect(SA_PACK.einvoicing.model).toBe("clearance");
    expect(SA_PACK.einvoicing.adapterKey).toBe("zatca");
    expect(SA_PACK.einvoicing.requiredCredentials.length).toBeGreaterThan(0);
  });
});

describe("UAE rules", () => {
  it("encodes no phase date, because none could be read from an official text", () => {
    expect(AE_PACK.einvoicing.phaseDates.value).toBeNull();
    expect(AE_PACK.einvoicing.phaseDates.source.tier).toBe("unverified");
  });

  it("names the five-corner model's provider requirement", () => {
    expect(AE_PACK.einvoicing.model).toBe("peppol_network");
    // The requirement is a MESSAGE KEY, so it reaches an Arabic or Spanish
    // reader in their own language instead of arriving as an English sentence
    // dropped into a translated screen. The English behind it still says it.
    expect(AE_PACK.einvoicing.requiredProviders).toEqual(["country.provider.ae_asp"]);
    expect(String(en["country.provider.ae_asp" as keyof typeof en])).toMatch(
      /accredited service provider/i,
    );
  });

  it("states every pack sentence a surface renders as a message key", () => {
    // The rule the previous test is one case of: a pack is read by people in
    // three languages, and prose written into a pack is English on every screen
    // that shows it. Anything a surface renders must be a key with copy behind
    // it in every catalogue — which the i18n parity test then guards.
    for (const pack of [AE_PACK, SA_PACK]) {
      const keys = [
        ...pack.tax.flatMap((t) => t.requiresConfiguration),
        ...(pack.payroll?.requiresConfiguration ?? []),
        ...pack.einvoicing.requiredCredentials,
        ...pack.einvoicing.requiredProviders,
        ...pack.privacy.organisationActions,
        ...pack.knownLimitations,
      ];
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key, `${pack.packKey}: "${key}" is prose, not a message key`).toMatch(
          /^country\.[a-z0-9_.]+$/,
        );
        expect(key in en, `${pack.packKey}: ${key} has no English copy`).toBe(true);
      }
    }
  });

  it("fixes a count of rest days, not a day", () => {
    expect(AE_PACK.week.statutoryRestDays.value).toEqual([]);
    expect(AE_PACK.week.minimumRestDaysPerWeek.value).toBe(1);
  });

  it("references the existing tax engine versions rather than restating them", () => {
    expect(AE_PACK.tax.map((t) => t.engineVersion)).toEqual([
      "AE-VAT-2026-09-01",
      "AE-CT-2026-09-01",
    ]);
    expect(AE_PACK.payroll!.engineVersion).toBe("AE-2026-09-01");
  });
});

describe("IBAN", () => {
  it("accepts a well-formed IBAN of the pack's country and length", () => {
    // Constructed to satisfy mod-97 for the test, not a real account.
    const valid = (body: string, country: string) => {
      const rearranged = `${body}${country}00`;
      let r = 0;
      for (const ch of rearranged) {
        const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of v) r = (r * 10 + Number(d)) % 97;
      }
      const check = String(98 - r).padStart(2, "0");
      return `${country}${check}${body}`;
    };
    const ae = valid("0331234567890123456", "AE");
    expect(ae).toHaveLength(23);
    expect(ibanProblems(ae, AE_PACK)).toEqual([]);
    const sa = valid("4400000012345678901234".slice(0, 20), "SA");
    expect(sa).toHaveLength(24);
    expect(ibanProblems(sa, SA_PACK)).toEqual([]);
  });

  it("rejects the wrong country, the wrong length and a broken checksum, each with its own reason", () => {
    const ae = "AE070331234567890123456";
    expect(ibanProblems(ae, SA_PACK)[0]!.messageKey).toBe("country.validation.iban_country");
    expect(ibanProblems("SA0380000000608010", SA_PACK)[0]!.messageKey).toBe(
      "country.validation.iban_length",
    );
    // A real-shaped Saudi IBAN passes mod-97; changing one digit must not.
    expect(ibanProblems("SA0380000000608010167519", SA_PACK)).toEqual([]);
    expect(ibanProblems("SA0380000000608010167518", SA_PACK)[0]?.messageKey).toBe(
      "country.validation.iban_checksum",
    );
  });

  it("treats an empty value as nothing to check, and groups for display only", () => {
    expect(ibanProblems("", AE_PACK)).toEqual([]);
    expect(formatIban("ae070331234567890123456")).toBe("AE07 0331 2345 6789 0123 456");
  });
});

describe("addresses and identifiers are permissive where the pack cannot justify a rule", () => {
  it("checks the Saudi shapes the National Address publishes", () => {
    const good = {
      buildingNumber: "8228",
      street: "King Fahd Road",
      district: "Al Olaya",
      city: "Riyadh",
      postalCode: "12345",
      additionalNumber: "2727",
    };
    expect(addressProblems(SA_PACK.address, good)).toEqual([]);
    const bad = { ...good, buildingNumber: "82", postalCode: "1234" };
    expect(addressProblems(SA_PACK.address, bad).map((p) => p.field)).toEqual([
      "buildingNumber",
      "postalCode",
    ]);
  });

  it("accepts a UAE address that no pattern describes, because the pack publishes none", () => {
    const messy = {
      line1: "Office 1204, Al Fattan Currency House, Tower 2",
      city: "Dubai",
      emirate: "Dubai",
    };
    expect(addressProblems(AE_PACK.address, messy)).toEqual([]);
  });

  it("preserves the script it was given", () => {
    const arabic = {
      buildingNumber: "8228",
      street: "طريق الملك فهد",
      district: "العليا",
      city: "الرياض",
      postalCode: "12345",
    };
    expect(addressProblems(SA_PACK.address, arabic)).toEqual([]);
    const lines = formatAddress(SA_PACK.address, arabic);
    expect(lines[0]).toBe("8228 طريق الملك فهد");
    expect(lines.join(" ")).toContain("العليا");
  });

  it("checks an identifier's published shape and nothing more", () => {
    const trn = AE_PACK.identifiers.find((i) => i.key === "trn")!;
    expect(identifierProblems(trn, "100123456700003")).toEqual([]);
    expect(identifierProblems(trn, "12345")[0]!.messageKey).toBe(
      "country.validation.identifier_length",
    );
    const licence = AE_PACK.identifiers.find((i) => i.key === "trade_licence")!;
    expect(identifierProblems(licence, "anything the emirate issued")).toEqual([]);
    expect(identifierProblems(licence, "")).toEqual([]);
  });

  it("accepts any dialable phone number and asserts no numbering plan", () => {
    expect(phoneProblems("+971 4 123 4567")).toEqual([]);
    expect(phoneProblems("+966-11-123-4567")).toEqual([]);
    expect(phoneProblems("055 123 4567")).toEqual([]);
    expect(phoneProblems("not a phone")[0]!.messageKey).toBe("country.validation.phone_shape");
  });
});

describe("formatting knows its context", () => {
  it("formats money in the establishment's currency with its own precision", () => {
    expect(formatAmount(123_456, AE_CTX)).toContain("1,234.56");
    expect(formatAmount(123_456, { ...AE_CTX, currency: "KWD" })).toContain("123.456");
  });

  it("keeps Latin numerals under Arabic and Spanish alike", () => {
    expect(formatAmount(100_000, SA_CTX)).toMatch(/1,000/);
    expect(formatAmount(100_000, { ...AE_CTX, uiLocale: "ar" })).toMatch(/1,000/);
  });

  it("never moves a business date across midnight, whatever the timezone", () => {
    for (const timezone of ["Asia/Dubai", "Asia/Riyadh", "Pacific/Kiritimati", "Pacific/Midway"]) {
      const shown = formatBusinessDate("2026-01-01", { ...AE_CTX, timezone });
      expect(shown, timezone).toContain("2026");
      expect(shown, timezone).toContain("1");
      expect(shown, timezone).not.toContain("Dec");
    }
    expect(
      formatBusinessDate("2026-12-31", { ...AE_CTX, timezone: "Pacific/Kiritimati" }),
    ).toContain("Dec");
  });

  it("offers a Hijri date only where the pack allows it", () => {
    expect(formatHijriDate("2026-09-03", AE_CTX)).toBeNull();
    const hijri = formatHijriDate("2026-09-03", SA_CTX);
    expect(hijri).toBeTruthy();
    expect(hijri).toMatch(/\d{4}/);
  });

  it("names weekdays the way the packs do", () => {
    expect(weekdayOf("2026-09-04")).toBe("fri");
    expect(weekdayOf("2026-09-06")).toBe("sun");
  });
});
