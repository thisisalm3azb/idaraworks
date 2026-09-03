/**
 * H29A/E — establishments, effective-dated rule versions and the readiness
 * centre, against the real database.
 *
 * The claims under attack here are the mandate's own:
 *
 *  - an organisation is not one country, one branch or one registration;
 *  - a transaction dated in an earlier period keeps resolving through the rule
 *    version that applied on ITS date, whatever is adopted afterwards;
 *  - a casual dropdown change cannot reinterpret history;
 *  - the simulator writes nothing;
 *  - legal readiness is six independent facts, never one number;
 *  - nothing leaks across tenants, and nothing leaks between establishments of
 *    the same tenant that a person is not looking at.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { createOrgForUser } from "@/platform/auth/identity";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { AE_PACK, COUNTRY_PACKS, SA_PACK, resolvePack } from "@/platform/country";
import {
  adoptPack,
  createEstablishment,
  effectiveConfig,
  establishmentReadiness,
  getEstablishment,
  listAdoptions,
  listEstablishments,
  listPrivacyEntries,
  previewAdoption,
  reviewPrivacyEntry,
  setPrivacyEntry,
  setRegistration,
  updateEstablishment,
} from "@/modules/country/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
const userV = randomUUID();
let orgA = "";
let orgB = "";
let dubai = "";
let riyadh = "";
let foreign = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h29a",
});
const A = () => ctxOf(orgA, userA);
const B = () => ctxOf(orgB, userB);

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} :: ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "H29A Owner A"],
    [userB, "H29A Owner B"],
    [userV, "H29A Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h29a-${id.slice(0, 8)}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, {
    name: `H29A A ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: `H29A B ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h29a", run);
  await markFixtureOrg(owner, orgB, "h29a", run);

  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userV}, 'H29A Viewer', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
}, 600_000);

afterAll(async () => {
  // wipeOrgs discovers every table carrying an org_id and clears them with
  // foreign-key triggers disabled, so establishments, registrations and
  // adoptions go with the organisation. It removes the users in the right
  // order too — the profile references the auth row.
  await wipeOrgs(owner, [orgA, orgB], [userA, userB, userV]);
  await owner.end();
  await closeAppDb();
});

describe("an organisation is not one country", () => {
  it("holds establishments in different countries at once", async () => {
    const one = await createEstablishment(A(), "owner", {
      code: "DXB",
      legalName: `Dubai Works ${run}`,
      legalNameLocal: "أعمال دبي",
      country: "AE",
      timezone: "Asia/Dubai",
      baseCurrency: "AED",
      isPrimary: true,
    });
    const two = await createEstablishment(A(), "owner", {
      code: "RUH",
      legalName: `Riyadh Works ${run}`,
      legalNameLocal: "أعمال الرياض",
      country: "SA",
      timezone: "Asia/Riyadh",
      baseCurrency: "SAR",
    });
    dubai = one.id;
    riyadh = two.id;
    const rows = await listEstablishments(A());
    expect(rows.map((r) => r.country).sort()).toEqual(["AE", "SA"]);
  });

  it("keeps a name in the script it was entered in", async () => {
    const row = await getEstablishment(A(), riyadh);
    // Not transliterated, not normalised, not folded to Latin.
    expect(row!.legalNameLocal).toBe("أعمال الرياض");
    expect(row!.legalName).toBe(`Riyadh Works ${run}`);
  });

  it("allows only one primary establishment", async () => {
    expect(
      await refusal(
        () => owner`update public.establishment set is_primary = true where id = ${riyadh}`,
      ),
    ).toMatch(/establishment_one_primary/);
  });

  it("refuses a country with no pack", async () => {
    expect(
      await refusal(() =>
        createEstablishment(A(), "owner", {
          code: "ZZZ",
          legalName: "Nowhere",
          country: "ZZ",
          timezone: "UTC",
          baseCurrency: "USD",
        }),
      ),
    ).toMatch(/no country pack/i);
  });
});

describe("a dropdown cannot reinterpret history", () => {
  it("country is not in the update grant, so no application path can change it", async () => {
    const rows = await owner`
      select column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'establishment'
         and grantee = 'app_user' and privilege_type = 'UPDATE'`;
    const updatable = rows.map((r) => r.column_name);
    expect(updatable).not.toContain("country");
    // The things that legitimately change are there, so this is a deliberate
    // omission rather than a missing grant.
    expect(updatable).toContain("legal_name");
    expect(updatable).toContain("timezone");
  });

  it("the module offers no way to ask for a different country", async () => {
    // Passing one is not an error the caller can exploit — it is simply not a
    // field the input shape has, so it is dropped before the write.
    await updateEstablishment(A(), "owner", { id: riyadh, country: "AE" } as never);
    expect((await getEstablishment(A(), riyadh))!.country).toBe("SA");
  });
});

describe("the registry and the database agree about what versions exist", () => {
  it("every registry pack has a row, with the same window and status", async () => {
    // A pack version is a two-part release: the registry entry and its row
    // (migration 0133). Forgetting the row makes adoption fail on a foreign key
    // at the customer, so the drift is caught here instead.
    const rows = await owner`
      select pack_key, country, status, effective_from::text as effective_from,
             effective_to::text as effective_to, currency, default_timezone
        from public.country_pack order by pack_key`;
    const byKey = new Map(rows.map((r) => [String(r.pack_key), r]));
    for (const pack of COUNTRY_PACKS) {
      const row = byKey.get(pack.packKey);
      expect(row, `no country_pack row for ${pack.packKey}`).toBeTruthy();
      expect(row!.country).toBe(pack.country);
      expect(row!.status).toBe(pack.status);
      expect(row!.effective_from).toBe(pack.effectiveFrom);
      expect(row!.effective_to).toBe(pack.effectiveTo);
      expect(row!.currency).toBe(pack.format.currency);
      expect(row!.default_timezone).toBe(pack.format.defaultTimezone);
    }
  });
});

describe("rule versions are effective-dated, and history is not rewritten", () => {
  it("two resolvable versions cannot both cover one day", async () => {
    // The registry ships non-overlapping windows; the database refuses an
    // overlap outright rather than letting a resolver pick one at random.
    expect(
      await refusal(
        () => owner`
          insert into public.country_pack (pack_key, country, jurisdiction, version, status,
                                           effective_from, effective_to, currency, default_timezone)
          values ('AE-2030-01-01', 'AE', 'Overlap probe', 'probe', 'approved',
                  ${AE_PACK.effectiveFrom}::date, null, 'AED', 'Asia/Dubai')`,
      ),
    ).toMatch(/country_pack_no_overlap|exclusion|conflicting key/i);
  });

  it("an adoption applies from its own date and not before", async () => {
    // Dates are on or after the version's own effective date: a version cannot
    // be applied from before it exists, which the next test proves separately.
    const from = "2026-10-01";
    await adoptPack(A(), "owner", {
      establishmentId: dubai,
      packKey: AE_PACK.packKey,
      effectiveFrom: from,
      note: `h29a ${run}`,
    });
    const before = (
      await owner`
      select app.establishment_pack_on(${dubai}::uuid, '2026-09-30'::date) as k`
    )[0]!.k;
    const on = (
      await owner`
      select app.establishment_pack_on(${dubai}::uuid, ${from}::date) as k`
    )[0]!.k;
    const after = (
      await owner`
      select app.establishment_pack_on(${dubai}::uuid, '2027-01-01'::date) as k`
    )[0]!.k;
    expect(before).toBeNull();
    expect(on).toBe(AE_PACK.packKey);
    expect(after).toBe(AE_PACK.packKey);
  });

  it("a later adoption does not change what an earlier date resolves to", async () => {
    // The heart of the mandate's reproducibility rule: adopting something in
    // December must not silently re-answer a question about October.
    const octoberBefore = (
      await owner`
      select app.establishment_pack_on(${dubai}::uuid, '2026-10-15'::date) as k`
    )[0]!.k;
    await adoptPack(A(), "owner", {
      establishmentId: dubai,
      packKey: AE_PACK.packKey,
      effectiveFrom: "2026-12-01",
      note: `h29a later ${run}`,
    });
    const octoberAfter = (
      await owner`
      select app.establishment_pack_on(${dubai}::uuid, '2026-10-15'::date) as k`
    )[0]!.k;
    expect(octoberAfter).toBe(octoberBefore);
    expect(octoberAfter).toBe(AE_PACK.packKey);
  });

  it("the effective configuration answers for the date it was asked about", async () => {
    const may = await effectiveConfig(A(), { establishmentId: dubai, on: "2026-05-01" });
    const july = await effectiveConfig(A(), { establishmentId: dubai, on: "2026-11-01" });
    expect(may.packKey).toBeNull();
    expect(july.packKey).toBe(AE_PACK.packKey);
    // Either way the establishment's own settings are returned, so a surface
    // asking before a pack exists still gets a timezone and a currency.
    expect(may.timezone).toBe("Asia/Dubai");
    expect(may.currency).toBe("AED");
  });

  it("adoptions are insert-only: an applied one cannot be edited or deleted", async () => {
    const rows = await owner`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'establishment_pack_adoption'
         and grantee = 'app_user'`;
    const grants = rows.map((r) => r.privilege_type).sort();
    expect(grants).toContain("INSERT");
    expect(grants).toContain("SELECT");
    expect(grants).not.toContain("DELETE");
    const updatable = (
      await owner`
        select column_name from information_schema.column_privileges
         where table_schema = 'public' and table_name = 'establishment_pack_adoption'
           and grantee = 'app_user' and privilege_type = 'UPDATE'`
    ).map((r) => r.column_name);
    // Only the pointer that marks one superseded may ever move.
    expect(updatable).toEqual(["superseded_by"]);
  });

  it("a version the registry does not have cannot be adopted", async () => {
    expect(
      await refusal(() =>
        adoptPack(A(), "owner", {
          establishmentId: riyadh,
          packKey: "SA-1999-01-01",
          effectiveFrom: "2026-10-01",
        }),
      ),
    ).toMatch(/unknown pack/i);
  });

  it("a version cannot be applied from before it exists", async () => {
    expect(
      await refusal(() =>
        adoptPack(A(), "owner", {
          establishmentId: riyadh,
          packKey: SA_PACK.packKey,
          effectiveFrom: "2000-01-01",
        }),
      ),
    ).toMatch(/cannot apply before it exists/i);
  });

  it("the adoption history pages instead of returning everything", async () => {
    const first = await listAdoptions(A(), dubai, { limit: 1, offset: 0 });
    const second = await listAdoptions(A(), dubai, { limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).not.toBe(second[0]!.id);
    // Newest effective date first, so page one is the current arrangement.
    expect(first[0]!.effectiveFrom > second[0]!.effectiveFrom).toBe(true);
  });
});

describe("the simulator writes nothing", () => {
  it("a preview leaves the adoption count and the establishment untouched", async () => {
    const before = await listAdoptions(A(), riyadh, { limit: 200, offset: 0 });
    const snapshot = await getEstablishment(A(), riyadh);
    const preview = await previewAdoption(A(), "owner", {
      establishmentId: riyadh,
      packKey: SA_PACK.packKey,
      effectiveFrom: "2026-10-01",
    });
    expect(preview.toPackKey).toBe(SA_PACK.packKey);
    const after = await listAdoptions(A(), riyadh, { limit: 200, offset: 0 });
    expect(after).toHaveLength(before.length);
    expect(await getEstablishment(A(), riyadh)).toEqual(snapshot);
  });

  it("a preview reports what it cannot touch, with real counts", async () => {
    const preview = await previewAdoption(A(), "owner", {
      establishmentId: riyadh,
      packKey: SA_PACK.packKey,
      effectiveFrom: "2026-10-01",
    });
    expect(preview.unchanged.map((u) => u.kind).sort()).toEqual([
      "invoice",
      "journal_entry",
      "pay_run",
    ]);
    for (const u of preview.unchanged) expect(Number.isFinite(u.count)).toBe(true);
  });

  it("a preview refuses a pack from the wrong country", async () => {
    expect(
      await refusal(() =>
        previewAdoption(A(), "owner", {
          establishmentId: riyadh,
          packKey: AE_PACK.packKey,
          effectiveFrom: "2026-10-01",
        }),
      ),
    ).toMatch(/is for AE, not SA/);
  });
});

describe("readiness is six facts, not one number", () => {
  it("reports each state independently and does not claim a legal review", async () => {
    const r = await establishmentReadiness(A(), riyadh, "2026-10-01");
    expect(r).not.toBeNull();
    const states = r!.states;
    expect(Object.keys(states).sort()).toEqual([
      "generally_available",
      "legally_reviewed",
      "pilot_ready",
      "provider_connected",
      "reviewed_internally",
      "technically_configured",
    ]);
    // Nothing in this repository records a professional review of the Saudi
    // pack, so the product must not say one happened.
    expect(states.legally_reviewed).toBe(false);
    expect(states.generally_available).toBe(false);
    expect(r!.externalActions.join(" ")).toMatch(/professional/i);
  });

  it("names what is missing rather than only scoring it", async () => {
    const r = await establishmentReadiness(A(), riyadh, "2026-10-01");
    const checks = r!.areas.flatMap((a) => a.checks);
    expect(checks.length).toBeGreaterThan(0);
    // Every check states a reason as a message key, so it renders in the
    // reader's own language rather than as an English sentence in the database.
    for (const c of checks) expect(c.labelKey).toMatch(/^country\./);
  });

  it("a recorded registration is kept against the country's own identifier", async () => {
    // The key is the pack's, not a name this test made up: Saudi Arabia calls it
    // `vat_number`, the UAE calls its equivalent `trn`, and neither is a
    // "tax id" field the product invented.
    const spec = resolvePack("SA", "2026-10-01")!.identifiers.find((i) => i.key === "vat_number")!;
    expect(spec.pattern).toBe("^3[0-9]{13}3$");
    const row = await setRegistration(A(), "owner", {
      establishmentId: riyadh,
      identifierKey: "vat_number",
      // Structurally valid: 15 digits, leading and trailing 3 (ZATCA's shape).
      value: "300000000000003",
      issuedOn: "2026-01-01",
    });
    expect(row.value).toBe("300000000000003");
    expect(row.authority).toBe(spec.authority);
    // Matching a published shape is not verification. Nothing here contacted an
    // authority or saw a document, so the number stays unverified until a person
    // checks it against the paper and says so.
    expect(row.verificationState).toBe("unverified");
  });

  it("a registration that does not match the country's published shape is refused", async () => {
    expect(
      await refusal(() =>
        setRegistration(A(), "owner", {
          establishmentId: riyadh,
          identifierKey: "vat_number",
          value: "123",
        }),
      ),
    ).toMatch(/does not match its published shape/i);
  });

  it("an identifier the country does not have is refused by name", async () => {
    // The UAE's TRN is not a Saudi identifier, and the refusal says so rather
    // than storing it in a generic "tax number" column.
    expect(
      await refusal(() =>
        setRegistration(A(), "owner", {
          establishmentId: riyadh,
          identifierKey: "trn",
          value: "100000000000003",
        }),
      ),
    ).toMatch(/no identifier called trn/);
  });
});

describe("the privacy register describes, and never asserts", () => {
  it("records a data category and leaves it unread until a person reads it", async () => {
    const entry = await setPrivacyEntry(A(), "owner", {
      establishmentId: riyadh,
      dataCategory: "employee records",
      purpose: "Payroll and attendance",
      provider: "IdaraWorks",
      processingRegion: "Saudi Arabia",
      retention: "Seven years after the end of employment",
    });
    expect(entry.dataCategory).toBe("employee records");
    // Recording something is not the same as anyone having read it.
    expect(entry.reviewedAt).toBeNull();
    expect(entry.reviewedBy).toBeNull();
  });

  it("refuses a transfer out of the country with no stated basis", async () => {
    // Otherwise the register would assert a lawful transfer nobody described.
    expect(
      await refusal(() =>
        setPrivacyEntry(A(), "owner", {
          establishmentId: riyadh,
          dataCategory: "customer contacts",
          purpose: "Sending invoices",
          crossBorder: true,
        }),
      ),
    ).toMatch(/cross-border transfer needs a stated basis/i);
  });

  it("accepts the same transfer once its basis is stated", async () => {
    const entry = await setPrivacyEntry(A(), "owner", {
      establishmentId: riyadh,
      dataCategory: "customer contacts",
      purpose: "Sending invoices",
      crossBorder: true,
      transferBasis: "Written agreement with the processor, dated 2026-03-01",
    });
    expect(entry.crossBorder).toBe(true);
    expect(entry.transferBasis).toMatch(/Written agreement/);
  });

  it("a review records who read it and when", async () => {
    const [first] = await listPrivacyEntries(A(), riyadh);
    const reviewed = await reviewPrivacyEntry(A(), "owner", first!.id);
    expect(reviewed.reviewedBy).toBe(userA);
    expect(reviewed.reviewedAt).not.toBeNull();
  });

  it("editing an entry clears its review, because what was read has changed", async () => {
    const [first] = await listPrivacyEntries(A(), riyadh);
    expect(first!.reviewedAt).not.toBeNull();
    const edited = await setPrivacyEntry(A(), "owner", {
      establishmentId: riyadh,
      dataCategory: first!.dataCategory,
      purpose: "Payroll, attendance and end-of-service calculation",
    });
    expect(edited.reviewedAt).toBeNull();
    expect(edited.reviewedBy).toBeNull();
  });

  it("moves the readiness check it belongs to, rather than only listing rows", async () => {
    const privacy = (await establishmentReadiness(A(), riyadh, "2026-10-01"))!.areas.find(
      (a) => a.area === "privacy",
    )!;
    const register = privacy.checks.find((c) => c.key === "privacy.register")!;
    expect(register.state).toBe("ok");
    // Reviewing is a separate fact and stays outstanding until every entry is
    // read: one reviewed entry out of several is not a reviewed register.
    const reviewed = privacy.checks.find((c) => c.key === "privacy.reviewed")!;
    expect(reviewed.state).toBe("missing");
  });

  it("another tenant sees none of it", async () => {
    expect(await listPrivacyEntries(B(), riyadh)).toEqual([]);
  });
});

describe("nothing leaks", () => {
  it("another tenant cannot see, read or change an establishment", async () => {
    foreign = (
      await createEstablishment(B(), "owner", {
        code: "OTHER",
        legalName: `Other Works ${run}`,
        country: "AE",
        timezone: "Asia/Dubai",
        baseCurrency: "AED",
      })
    ).id;
    expect(await getEstablishment(B(), dubai)).toBeNull();
    expect(await getEstablishment(A(), foreign)).toBeNull();
    expect((await listEstablishments(B())).map((r) => r.id)).toEqual([foreign]);
  });

  it("another tenant cannot adopt against an establishment it cannot see", async () => {
    expect(
      await refusal(() =>
        adoptPack(B(), "owner", {
          establishmentId: dubai,
          packKey: AE_PACK.packKey,
          effectiveFrom: "2026-10-01",
        }),
      ),
    ).toMatch(/not found/i);
  });

  it("another tenant's readiness and adoption history are empty, not borrowed", async () => {
    expect(await establishmentReadiness(B(), dubai, "2026-10-01")).toBeNull();
    expect(await listAdoptions(B(), dubai)).toEqual([]);
  });

  it("a viewer may read the configuration and may not change it", async () => {
    const V = ctxOf(orgA, userV);
    const rows = await listEstablishments(V);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      await refusal(() =>
        updateEstablishment(V, "viewer", { id: dubai, legalName: "Renamed by a viewer" }),
      ),
    ).toMatch(/permission|forbidden|country\.manage/i);
    expect((await getEstablishment(A(), dubai))!.legalName).toBe(`Dubai Works ${run}`);
  });

  it("a viewer cannot adopt a version", async () => {
    expect(
      await refusal(() =>
        adoptPack(ctxOf(orgA, userV), "viewer", {
          establishmentId: dubai,
          packKey: AE_PACK.packKey,
          effectiveFrom: "2027-06-01",
        }),
      ),
    ).toMatch(/permission|forbidden|country\.adopt/i);
  });
});
