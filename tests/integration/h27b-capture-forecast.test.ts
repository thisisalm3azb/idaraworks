/**
 * H27B — capture, consent, campaigns, targets and forecasting on the TEST
 * project: a form-sourced lead is quarantined and cannot convert until a
 * person trusts it; duplicates are surfaced and a second customer is not
 * created without acknowledgement; conversion is idempotent; consent and
 * suppression decide contactability at send time and marketing fails closed
 * without a provider; attribution names its model; targets show progress with
 * a stated basis; the forecast is deterministic, a snapshot freezes it, an
 * overlay changes nothing live, and applying a scenario replays through the
 * governed commands.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import {
  applyOverlay,
  applyScenario,
  attribute,
  attributionReport,
  canContact,
  captureForecastSnapshot,
  captureLead,
  computeForecast,
  convertLeadSafely,
  createCampaign,
  forecastAccuracy,
  getOpportunity,
  leadPage,
  listScenarios,
  matchTerritory,
  previewMarketingSend,
  recordConsent,
  recordTouch,
  reviewQuarantine,
  saveScenario,
  sendMarketingMessage,
  setTarget,
  summarise,
  targetProgress,
  updateCommercial,
  winOpportunity,
  createTerritory,
} from "@/modules/crm/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h27b",
});
const plus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h27b-owner-${run}@example.invalid`}, '{"full_name":"Owner"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H27B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h27b", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end();
  await closeAppDb();
});

describe("pure rules", () => {
  it("attribution splits by model; territories match by rules; overlays never mutate input", () => {
    const won = [
      {
        opportunityId: "o1",
        valueMinor: 300,
        touches: [
          { campaignId: "a", at: "2026-01-01" },
          { campaignId: "b", at: "2026-02-01" },
          { campaignId: "c", at: "2026-03-01" },
        ],
      },
    ];
    expect(attribute("first_touch", won).get("a")?.minor).toBe(300);
    expect(attribute("last_touch", won).get("c")?.minor).toBe(300);
    expect(attribute("linear", won).get("b")?.minor).toBe(100);
    expect(
      matchTerritory([{ id: "t1", active: true, rules: { countries: ["AE"] } }], {
        country: "AE",
        tags: [],
        segment: null,
      }),
    ).toBe("t1");
    expect(
      matchTerritory([{ id: "t1", active: true, rules: { countries: ["AE"], tags: ["vip"] } }], {
        country: "AE",
        tags: [],
        segment: null,
      }),
    ).toBeNull();
    const rows = [
      {
        id: "x",
        name: "X",
        customerName: null,
        ownerUserId: null,
        ownerName: null,
        territoryId: null,
        campaignId: null,
        source: null,
        kind: "new_business" as const,
        stageKey: "s",
        category: "pipeline" as const,
        valueMinor: 1000,
        probability: 50,
        probabilitySource: "stage" as const,
        weightedMinor: 500,
        expectedCloseDate: "2026-01-31",
        stageAgeDays: 1,
        createdAt: "",
      },
    ];
    const out = applyOverlay(rows, {
      slips: [{ opportunityId: "x", months: 1 }],
      excludes: [],
      probabilities: [{ opportunityId: "x", probability: 80 }],
      categories: [],
    });
    expect(out[0]!.expectedCloseDate).toBe("2026-02-28");
    expect(out[0]!.weightedMinor).toBe(800);
    expect(rows[0]!.weightedMinor).toBe(500);
    expect(summarise(out).month[0]!.key).toBe("2026-02");
  });
});

describe("capture, consent, campaigns", () => {
  let campaignId = "";
  let leadId = "";
  let customerId = "";
  let oppId = "";

  it("a form lead is quarantined, duplicates are surfaced, conversion is safe and idempotent", async () => {
    campaignId = (
      await createCampaign(A(), "owner", {
        name: `Boat show ${run}`,
        channel: "event",
        costMinor: 500000,
        currency: "AED",
        status: "active",
      })
    ).id;
    const existing = await createCustomer(A(), "owner", {
      name: `Gulf Pearl ${run}`,
      email: `pearl-${run}@example.invalid`,
      country: "AE",
    });
    customerId = existing.id;
    const cap = await captureLead(A(), "owner", {
      name: `Gulf Pearl ${run}`,
      email: `pearl-${run}@example.invalid`,
      sourceKind: "form",
      campaignId,
      consent: [{ channel: "email", evidence: "ticked on the enquiry form" }],
    });
    leadId = cap.lead.id;
    expect(cap.quarantined).toBe(true);
    expect(cap.duplicates.some((d) => d.kind === "customer" && d.id === customerId)).toBe(true);
    await expect(
      convertLeadSafely(A(), "owner", { leadId, createCustomer: true }),
    ).rejects.toMatchObject({ code: "state" });
    await reviewQuarantine(A(), "owner", { id: leadId, decision: "trust" });
    await expect(
      convertLeadSafely(A(), "owner", { leadId, createCustomer: true }),
    ).rejects.toMatchObject({ code: "duplicates" });
    const conv = await convertLeadSafely(A(), "owner", {
      leadId,
      customerId,
      opportunityName: `Pearl refit ${run}`,
      estimatedValueMinor: 5_000_000,
    });
    expect(conv.customerId).toBe(customerId);
    oppId = conv.opportunityId;
    const again = await convertLeadSafely(A(), "owner", { leadId, customerId });
    expect(again.opportunityId).toBe(oppId);
    expect(again.deduped).toBe(true);
    const page = await leadPage(A(), "owner", { status: "converted" });
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.rows.find((r) => r.id === leadId)?.sourceKind).toBe("form");
    // Only one customer with that name exists.
    const n =
      (await owner`select count(*)::int as n from public.customer where org_id = ${orgA} and name = ${`Gulf Pearl ${run}`}`) as unknown as Array<{
        n: number;
      }>;
    expect(Number(n[0]!.n)).toBe(1);
  });

  it("consent decides contactability at send time; suppression outranks; marketing fails closed", async () => {
    const before = await canContact(A(), "owner", { leadId }, "email");
    expect(before.allowed).toBe(true);
    expect(before.reason).toBe("granted");
    const w = await recordConsent(A(), "owner", {
      leadId,
      channel: "email",
      status: "withdrawn",
      source: "unsubscribe",
      evidence: "clicked stop",
    });
    expect(w.suppressed).toBe(true);
    const after = await canContact(A(), "owner", { leadId }, "email");
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe("suppressed");
    // A later grant cannot override the suppression.
    await recordConsent(A(), "owner", {
      leadId,
      channel: "email",
      status: "granted",
      source: "verbal",
    });
    expect((await canContact(A(), "owner", { leadId }, "email")).reason).toBe("suppressed");
    const preview = await previewMarketingSend(A(), "owner", {
      campaignId,
      channel: "email",
      subject: "Hello",
      body: "Offer",
      recipients: [{ leadId }, { customerId }],
      confirmed: true,
    });
    // The customer shares the lead's address: suppression is by address, so both are blocked.
    expect(preview.blocked.map((b) => b.reason)).toEqual(["suppressed", "suppressed"]);
    const providerOff = !process.env.RESEND_API_KEY;
    if (providerOff) {
      await expect(
        sendMarketingMessage(A(), "owner", {
          campaignId,
          channel: "email",
          subject: "Hello",
          body: "Offer",
          recipients: [{ leadId }],
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      const sent =
        (await owner`select count(*)::int as n from public.sales_activity where org_id = ${orgA} and kind = 'message'`) as unknown as Array<{
          n: number;
        }>;
      expect(Number(sent[0]!.n)).toBe(0);
    }
  });

  it("attribution names its model and counts the won opportunity for the campaign that sourced it", async () => {
    await recordTouch(A(), "owner", { campaignId, opportunityId: oppId, kind: "reply" });
    const o = await getOpportunity(A(), "owner", oppId);
    expect(o).not.toBeNull();
    await winOpportunity(A(), "owner", oppId);
    const first = await attributionReport(A(), "owner", "first_touch");
    const row = first.find((r) => r.campaignId === campaignId)!;
    expect(row.model).toBe("first_touch");
    expect(row.wonOpportunities).toBe(1);
    expect(row.attributedMinor).toBe(5_000_000);
    expect(row.returnRatio).toBe(10);
  });

  it("targets compute progress with a stated basis; territories apply by rule", async () => {
    const t = await createTerritory(A(), "owner", {
      key: "uae",
      name: { en: "UAE", ar: "الإمارات" },
      rules: { countries: ["AE"] },
    });
    expect(t.id).toBeTruthy();
    await setTarget(A(), "owner", {
      scopeKind: "org",
      metric: "bookings",
      periodStart: plus(-30),
      periodEnd: plus(30),
      amountMinor: 10_000_000,
      currency: "AED",
    });
    await setTarget(A(), "owner", {
      scopeKind: "org",
      metric: "new_customers",
      periodStart: plus(-30),
      periodEnd: plus(30),
      countTarget: 4,
    });
    const progress = await targetProgress(A(), "owner");
    const bookings = progress.find((p) => p.metric === "bookings")!;
    expect(bookings.actualMinor).toBe(5_000_000);
    expect(bookings.progressPct).toBe(50);
    expect(bookings.basis).toContain("won");
    const nc = progress.find((p) => p.metric === "new_customers")!;
    expect(nc.actualCount).toBeGreaterThanOrEqual(1);
  });
});

describe("forecast", () => {
  let oppA = "";
  let oppB = "";
  it("is deterministic, snapshots freeze it, overlays change nothing live, applying replays through governed commands", async () => {
    const c = await createCustomer(A(), "owner", { name: `Forecast Co ${run}`, country: "AE" });
    const mk = async (
      name: string,
      value: number,
      close: string,
      category: "pipeline" | "commit",
    ) => {
      const cap = await captureLead(A(), "owner", { name, sourceKind: "manual" });
      const conv = await convertLeadSafely(A(), "owner", {
        leadId: cap.lead.id,
        customerId: c.id,
        opportunityName: name,
        estimatedValueMinor: value,
        expectedCloseDate: close,
      });
      const o = await getOpportunity(A(), "owner", conv.opportunityId);
      await updateCommercial(A(), "owner", {
        id: conv.opportunityId,
        rowVersion: 1,
        forecastCategory: category,
        probability: 50,
      });
      void o;
      return conv.opportunityId;
    };
    oppA = await mk(`Deal A ${run}`, 2_000_000, plus(10), "commit");
    oppB = await mk(`Deal B ${run}`, 4_000_000, plus(40), "pipeline");
    const f = await computeForecast(A(), "owner", {});
    expect(f.totals.pipelineMinor).toBe(6_000_000);
    expect(f.totals.weightedMinor).toBe(3_000_000);
    expect(f.totals.commitMinor).toBe(2_000_000);
    expect(f.rows.find((r) => r.id === oppA)?.probabilitySource).toBe("opportunity");
    const twice = await computeForecast(A(), "owner", {});
    expect(twice.totals).toEqual(f.totals);
    const blind = await computeForecast({ ...A(), pricePrivileged: false }, "owner", {});
    expect(blind.redacted).toBe(true);
    expect(blind.totals.pipelineMinor).toBe(0);
    const period = plus(10).slice(0, 7);
    const snap = await captureForecastSnapshot(A(), "owner", { periodKey: period });
    expect(snap.periodKey).toBe(period);
    const acc = await forecastAccuracy(A(), "owner");
    expect(acc[0]!.predicted.count).toBeGreaterThanOrEqual(1);
    expect(acc[0]!.actual.stillOpen).toBeGreaterThanOrEqual(1);
    // Overlay: slip B by a month, exclude A — live rows untouched.
    const over = applyOverlay(f.rows, {
      slips: [{ opportunityId: oppB, months: 1 }],
      excludes: [oppA],
      probabilities: [],
      categories: [],
    });
    expect(summarise(over).count).toBe(1);
    expect((await getOpportunity(A(), "owner", oppB))?.expectedCloseDate).toBe(plus(40));
    const s = await saveScenario(A(), "owner", {
      name: "Slip B",
      overlay: {
        slips: [{ opportunityId: oppB, months: 1 }],
        excludes: [],
        probabilities: [],
        categories: [{ opportunityId: oppA, category: "best_case" }],
      },
      assumptions: "B's approval meeting moved",
    });
    const applied = await applyScenario(A(), "owner", {
      id: s.id,
      reason: "Reviewed with the team",
    });
    expect(applied.applied).toBe(2);
    const b = await getOpportunity(A(), "owner", oppB);
    expect(b?.expectedCloseDate).not.toBe(plus(40));
    expect((await listScenarios(A(), "owner"))[0]!.status).toBe("applied");
    await expect(applyScenario(A(), "owner", { id: s.id, reason: "again" })).rejects.toThrow(
      /already applied/,
    );
  });
});
