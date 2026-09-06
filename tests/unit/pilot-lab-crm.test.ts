/**
 * H33 — the crm family, pinned without a database.
 *
 * A fake LabContext records every insert in memory, answers the two live
 * queries the family makes (contacts, the merged customers' row images) with
 * phantom rows, and hands over the setup / masters / people handoffs the way
 * the orchestrator would. The family's own services are skipped (they need a
 * database); everything else — the plan, the rows, their states, their
 * cross-links and their arithmetic — is checked here for all five companies.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { computeLine } from "@/modules/crm/dealroom";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Sql } from "../../tooling/pilot-lab/db";
import {
  CRM_TABLES,
  SERVICE_SUBSET,
  SNAPSHOT_MONTHS,
  crm,
  model,
  seedCrm,
  serviceRowsOf,
  type Model,
} from "../../tooling/pilot-lab/families/crm";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { SimClock } from "../../tooling/simulation/dates";
import { Rng } from "../../tooling/simulation/rng";

type Row = Record<string, unknown>;

const PERSONAS: PersonaKey[] = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
  "auditor",
];
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARABIC = /[؀-ۿ]/;

// The pipelines the setup family writes (keys and categories are the contract; ids are phantom).
type StageSpec = [string, "open" | "won" | "lost"];
const DEFAULT_STAGES: StageSpec[] = [
  ["new", "open"],
  ["contacted", "open"],
  ["qualified", "open"],
  ["proposal", "open"],
  ["negotiation", "open"],
  ["won", "won"],
  ["lost", "lost"],
];
const RENEWALS: { key: string; stages: StageSpec[] } = {
  key: "renewals",
  stages: [
    ["rn_due", "open"],
    ["rn_contacted", "open"],
    ["rn_proposed", "open"],
    ["rn_renewed", "won"],
    ["rn_churned", "lost"],
  ],
};
const EXPANSION: { key: string; stages: StageSpec[] } = {
  key: "expansion",
  stages: [
    ["ex_identified", "open"],
    ["ex_proposed", "open"],
    ["ex_won", "won"],
    ["ex_lost", "lost"],
  ],
};
const EXTRA_PIPELINES: Record<string, Array<{ key: string; stages: StageSpec[] }>> = {
  gulfbuild: [],
  tradeline: [EXPANSION],
  saudimfg: [],
  consult: [RENEWALS],
  facilico: [RENEWALS],
};

// Enumerations exactly as the migrations' check constraints spell them.
const OPP_STATUS = new Set(["open", "won", "lost"]);
const LOSS_REASONS = new Set([
  "price",
  "timing",
  "competitor",
  "no_budget",
  "no_response",
  "scope",
  "other",
]);
const FORECAST_CATEGORIES = new Set(["pipeline", "best_case", "commit", "omitted"]);
const OPP_KINDS = new Set(["new_business", "expansion", "renewal"]);
const LEAD_STATUS = new Set(["new", "contacted", "qualified", "disqualified", "converted"]);
const LEAD_SOURCE_KINDS = new Set([
  "manual",
  "form",
  "import",
  "referral",
  "customer",
  "campaign",
  "email",
  "messaging",
  "api",
]);
const QUARANTINE = new Set(["trusted", "quarantined", "spam"]);
const DISQUALIFY = new Set([
  "no_budget",
  "no_need",
  "no_authority",
  "timing",
  "competitor",
  "unresponsive",
  "spam",
  "duplicate",
  "other",
]);
const ACTIVITY_KINDS = new Set([
  "note",
  "call",
  "meeting",
  "email",
  "follow_up",
  "task",
  "message",
  "site_visit",
  "demo",
  "custom",
  "stage_change",
  "quote_created",
  "won",
  "lost",
  "converted",
  "merged",
  "consent",
  "automation",
  "forecast",
  "discount",
  "contract",
  "assigned",
]);
const OUTCOMES = new Set([
  "completed",
  "no_answer",
  "rescheduled",
  "positive",
  "neutral",
  "negative",
  "cancelled",
]);
const ROLE_KINDS = new Set([
  "decision_maker",
  "economic_buyer",
  "influencer",
  "champion",
  "user",
  "procurement",
  "finance",
  "technical",
  "blocker",
  "other",
]);
const CANVAS_KINDS = new Set([
  "stakeholder",
  "decision",
  "risk",
  "document",
  "step",
  "note",
  "competitor",
  "product",
]);
const TOUCH_KINDS = new Set(["exposure", "click", "reply", "visit", "referral", "manual"]);
const TARGET_METRICS = new Set(["revenue", "bookings", "margin", "activities", "new_customers"]);
const TARGET_SCOPES = new Set(["org", "team", "user", "territory"]);
const CAMPAIGN_CHANNELS = new Set([
  "email",
  "sms",
  "whatsapp",
  "social",
  "event",
  "referral",
  "web",
  "ads",
  "phone",
  "other",
]);
const CAMPAIGN_STATUS = new Set(["planned", "active", "paused", "completed", "cancelled"]);
const AUTOMATION_TRIGGERS = new Set([
  "lead_created",
  "lead_unassigned",
  "lead_stale",
  "opportunity_stage_aged",
  "opportunity_stalled",
  "opportunity_close_date_passed",
  "opportunity_stage_entered",
  "renewal_due",
  "customer_at_risk",
  "follow_up_overdue",
]);
const ACTION_KINDS = new Set([
  "assign_owner",
  "create_task",
  "notify",
  "request_approval",
  "flag_risk",
  "set_forecast_category",
]);
const RUN_STATUS = new Set(["matched", "skipped", "applied", "failed"]);
const SIGNAL_KINDS = new Set([
  "satisfaction",
  "onboarding",
  "adoption",
  "success_plan",
  "churn_risk",
  "note",
]);
const SIGNAL_STATUS = new Set(["open", "done", "at_risk", "healthy"]);

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ── the fake context ─────────────────────────────────────────────────────────

type Handoffs = {
  setup: {
    pipelines: Record<
      string,
      { id: string; stages: Record<string, { id: string; category: string }> }
    >;
  };
  masters: {
    customerIds: string[];
    inactiveCustomerIds: string[];
    itemIds: string[];
    items: Record<string, { unit: string }>;
  };
  people: { personaEmployees: Partial<Record<PersonaKey, string>> };
};

function fakeHandoffs(company: Company): Handoffs {
  const cid = (family: string, ...o: Array<string | number>) => labId(company.key, family, ...o);
  const pipelines: Handoffs["setup"]["pipelines"] = {};
  const specs = [
    { key: "default", stages: DEFAULT_STAGES },
    ...(EXTRA_PIPELINES[company.key] ?? []),
  ];
  for (const p of specs) {
    const stages: Record<string, { id: string; category: string }> = {};
    for (const [k, category] of p.stages) stages[k] = { id: cid("pipeline_stage", k), category };
    pipelines[p.key] = { id: cid("crm_pipeline", p.key), stages };
  }
  const customerIds = range(company.profile.customers).map((i) => cid("customer", i));
  const inactiveCustomerIds = customerIds.filter((_, i) => i % 12 === 11);
  const itemIds = range(Math.min(company.profile.items, 300)).map((i) => cid("item", i));
  const items = Object.fromEntries(
    itemIds.map((id, i) => [id, { unit: ["ea", "m", "kg", "set"][i % 4]! }]),
  );
  return {
    setup: { pipelines },
    masters: { customerIds, inactiveCustomerIds, itemIds, items },
    people: {
      personaEmployees: Object.fromEntries(
        (["manager", "hr", "warehouse", "field", "restricted"] as PersonaKey[]).map((p) => [
          p,
          cid("employee", p),
        ]),
      ),
    },
  };
}

/** Contacts per customer exactly as the masters family lays them out: 1 + ((i·7+3) mod 3). */
function phantomContacts(company: Company, customerIds: string[]) {
  return customerIds.flatMap((customer_id, i) =>
    range(1 + ((i * 7 + 3) % 3)).map((j) => ({
      id: labId(company.key, "customer_contact", i, j),
      customer_id,
    })),
  );
}

type Harness = {
  ctx: LabContext;
  written: Record<string, Row[]>;
  statements: Array<{ text: string; values: unknown[] }>;
  handoffs: Handoffs;
  orgId: string;
  users: Record<PersonaKey, string>;
  contacts: Array<{ id: string; customer_id: string }>;
};

function harness(company: Company): Harness {
  const handoffs = fakeHandoffs(company);
  const contacts = phantomContacts(company, handoffs.masters.customerIds);
  const written: Record<string, Row[]> = {};
  const statements: Harness["statements"] = [];
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;

  const answer = (text: string, values: unknown[]): unknown[] => {
    if (text.includes("customer_contact")) return contacts;
    if (text.includes("row_to_json")) {
      const ids = (values.find((v) => Array.isArray(v)) ?? []) as string[];
      return ids.map((id) => ({
        id,
        snapshot: { id, name: `Phantom ${id.slice(0, 8)}`, active: true },
      }));
    }
    return [];
  };
  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    return Promise.resolve(answer(text, values));
  };
  const sql = Object.assign(tagged, {
    unsafe: (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return Promise.resolve([]);
    },
  }) as unknown as Sql;

  const ctx: LabContext = {
    sql,
    admin: {} as LabContext["admin"],
    company,
    orgId,
    users,
    employees: handoffs.people.personaEmployees,
    ctxFor: (persona): Ctx => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona): RoleArchetype =>
      company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      // The batched writer's own laws, mirrored: org_id on every row, no ragged rows.
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]!);
        if (!cols.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
        for (const r of rows) {
          if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
          const keys = Object.keys(r);
          if (keys.length !== cols.length) throw new Error(`${table}: ragged row (missing key)`);
          for (const k of keys)
            if (!cols.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
        }
      }
      written[table] = [...(written[table] ?? []), ...rows];
      return { attempted: rows.length, inserted: rows.length };
    },
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) out[e.table] = await ctx.insert(e.table, e.rows, e.conflict);
      return out;
    },
    handoff: <T>(family: string): T => {
      const h = (handoffs as Record<string, unknown>)[family];
      if (!h) throw new Error(`no handoff from family ${family} (is it a declared dependency?)`);
      return h as T;
    },
    log: () => {},
    dryRun: false,
  };
  return { ctx, written, statements, handoffs, orgId, users, contacts };
}

type Run = {
  company: Company;
  h: Harness;
  m: Model;
  plan: Record<string, number>;
  counts: Record<string, number>;
  report: Awaited<ReturnType<typeof seedCrm>>;
};

async function runFor(company: Company): Promise<Run> {
  const h = harness(company);
  const plan = crm.plan(h.ctx).expected;
  const report = await seedCrm(h.ctx, { services: false });
  return { company, h, m: model(h.ctx), plan, counts: report.counts, report };
}

const RUNS: Run[] = await Promise.all(COMPANIES.map(runFor));

const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);
const byId = (rows: Row[]) => new Map(rows.map((r) => [str(r.id), r]));

// ── the family contract ──────────────────────────────────────────────────────

describe("the crm family contract", () => {
  it("is keyed by its file name, declares its dependencies and applies to every revenue company", () => {
    expect(crm.key).toBe("crm");
    expect(crm.deps).toEqual(["setup", "people", "masters"]);
    for (const c of COMPANIES) expect(crm.appliesTo(c), c.key).toBe(c.profile.enables.revenue);
    expect(COMPANIES.filter((c) => crm.appliesTo(c))).toHaveLength(5);
  });

  it("plan() is pure: it writes nothing and answers the same numbers twice", () => {
    for (const c of COMPANIES) {
      const h = harness(c);
      const a = crm.plan(h.ctx);
      const b = crm.plan(h.ctx);
      expect(a).toEqual(b);
      expect(a.family).toBe("crm");
      expect(Object.keys(h.written)).toHaveLength(0);
      expect(Object.keys(a.expected).sort()).toEqual([...CRM_TABLES].sort());
    }
  });
});

// ── plan vs seed, per company ────────────────────────────────────────────────

describe.each(RUNS.map((r) => [r.company.key, r] as const))("%s", (_key, run) => {
  const { company, h, m, plan, counts } = run;
  const W = h.written;
  const svc = serviceRowsOf(m);
  const stagesByPipelineId = new Map(
    Object.values(h.handoffs.setup.pipelines).map((p) => [
      p.id,
      new Map(Object.entries(p.stages).map(([k, s]) => [k, s.category])),
    ]),
  );
  const activeCustomers = new Set(
    h.handoffs.masters.customerIds.filter(
      (id) => !h.handoffs.masters.inactiveCustomerIds.includes(id),
    ),
  );
  const contactsOf = new Map<string, Set<string>>();
  for (const c of h.contacts)
    contactsOf.set(c.customer_id, new Set([...(contactsOf.get(c.customer_id) ?? []), c.id]));
  const opps = byId(W.opportunity ?? []);
  const leads = byId(W.lead ?? []);
  const oppModel = new Map(m.opps.map((o) => [o.id, o]));
  const asOfEnd = `${company.history.asOf}T23:59:59.999Z`;
  const historyStart = `${company.history.from}T00:00:00.000Z`;

  it("plan() counts equal what seed() inserted, plus exactly the service subset", () => {
    for (const t of CRM_TABLES) {
      expect(W[t]?.length ?? 0, t).toBe(counts[t]);
      expect(plan[t], t).toBe((counts[t] ?? 0) + (svc[t] ?? 0));
    }
    for (const t of Object.keys(W)) expect(CRM_TABLES).toContain(t);
    expect(run.report.family).toBe("crm");
    expect(m.services.convert).toBe(SERVICE_SUBSET.convert);
    expect(m.services.win).toBe(SERVICE_SUBSET.win);
    expect(m.services.lose).toBe(SERVICE_SUBSET.lose);
    expect(m.services.move).toBe(SERVICE_SUBSET.move);
    expect(plan.opportunity).toBe(company.profile.opportunities);
    expect(plan.lead).toBe(company.profile.leads);
  });

  it("every row carries this company's org_id and a deterministic v5 id, unique within its table", () => {
    for (const t of CRM_TABLES) {
      const ids = new Set<string>();
      for (const r of W[t] ?? []) {
        expect(r.org_id, t).toBe(h.orgId);
        expect(str(r.id), t).toMatch(UUID_V5);
        expect(ids.has(str(r.id)), `${t} duplicate id`).toBe(false);
        ids.add(str(r.id));
      }
    }
    expect(W.crm_territory!.map((r) => r.id)).toEqual(
      W.crm_territory!.map((r) => labId(company.key, "crm", "territory", str(r.key))),
    );
  });

  it("a second run produces identical rows (idempotent by construction)", async () => {
    const again = await runFor(company);
    for (const t of CRM_TABLES)
      expect(JSON.stringify(again.h.written[t] ?? []), t).toBe(JSON.stringify(W[t] ?? []));
    expect(again.plan).toEqual(plan);
  });

  it("nothing is dated before the company's first day or after its as-of date", () => {
    // Not every CRM table records a creation time: crm_automation_run keeps
    // ran_at instead, and asserting on created_at there compared undefined to a
    // date. Check the timestamp the row actually carries.
    for (const t of CRM_TABLES)
      for (const r of W[t] ?? []) {
        const stamp = r.created_at ?? r.ran_at ?? r.captured_at ?? r.touched_at;
        if (stamp === undefined || stamp === null) continue;
        const when = str(stamp);
        expect(when >= historyStart, `${t} ${when}`).toBe(true);
        expect(when <= asOfEnd, `${t} ${when}`).toBe(true);
      }
  });

  it("opportunities: legal terminal evidence, a stage of the right category in their own pipeline", () => {
    let arabic = 0;
    for (const o of W.opportunity!) {
      const status = str(o.status);
      expect(OPP_STATUS.has(status)).toBe(true);
      expect(str(o.name).length).toBeGreaterThanOrEqual(1);
      expect(str(o.name).length).toBeLessThanOrEqual(160);
      if (ARABIC.test(str(o.name))) arabic++;
      if (status === "won") {
        expect(o.won_at).toBeTruthy();
        expect(str(o.won_at) >= str(o.created_at)).toBe(true);
      } else expect(o.won_at).toBeNull();
      if (status === "lost") {
        expect(o.lost_at).toBeTruthy();
        expect(LOSS_REASONS.has(str(o.loss_reason))).toBe(true);
      } else {
        expect(o.lost_at).toBeNull();
        expect(o.loss_reason).toBeNull();
      }
      const stages = stagesByPipelineId.get(str(o.pipeline_id));
      expect(stages, "pipeline exists").toBeDefined();
      expect(stages!.get(str(o.stage_key)), `stage ${o.stage_key}`).toBe(status);
      expect(FORECAST_CATEGORIES.has(str(o.forecast_category))).toBe(true);
      expect(OPP_KINDS.has(str(o.kind))).toBe(true);
      expect(o.amount_kind).toBe(o.kind === "renewal" ? "recurring" : "one_time");
      expect(o.recurrence_months).toBe(o.kind === "renewal" ? 12 : null);
      expect(o.estimated_value_minor === null).toBe(o.currency === null);
      if (o.estimated_value_minor !== null) expect(num(o.estimated_value_minor)).toBeGreaterThan(0);
      expect(Number.isInteger(o.probability)).toBe(true);
      expect(num(o.probability)).toBeGreaterThanOrEqual(0);
      expect(num(o.probability)).toBeLessThanOrEqual(100);
      if (o.customer_id !== null) {
        expect(activeCustomers.has(str(o.customer_id))).toBe(true);
        expect(o.customer_id).not.toBe(m.merge.sourceId);
      }
      if (o.lead_id !== null) {
        const lead = leads.get(str(o.lead_id));
        expect(lead?.status).toBe("converted");
        expect(lead?.converted_opportunity_id).toBe(o.id);
        expect(o.created_at).toBe(lead?.converted_at);
      }
      if (o.status !== "open") expect(o.forecast_category).toBe("pipeline");
    }
    expect(arabic).toBeGreaterThan(0);
    // Renewal and expansion work runs in its own pipeline where the company has one.
    const extra = EXTRA_PIPELINES[company.key] ?? [];
    for (const p of extra) {
      const pid = h.handoffs.setup.pipelines[p.key]!.id;
      const kind = p.key === "renewals" ? "renewal" : "expansion";
      const inPipeline = W.opportunity!.filter((o) => o.pipeline_id === pid);
      expect(inPipeline.length).toBeGreaterThan(0);
      for (const o of inPipeline) expect(o.kind).toBe(kind);
      for (const o of W.opportunity!.filter((o) => o.kind === kind))
        expect(o.pipeline_id).toBe(pid);
    }
  });

  it("the service subset is born open in the default pipeline with what each service will need", () => {
    const def = h.handoffs.setup.pipelines.default!.id;
    let n = 0;
    for (const o of m.opps) {
      if (o.service === null) continue;
      n++;
      const row = opps.get(o.id)!;
      expect(row.status).toBe("open");
      expect(row.archived).toBe(false);
      expect(row.pipeline_id).toBe(def);
      expect(row.customer_id).not.toBeNull();
      expect(num(row.estimated_value_minor)).toBeGreaterThan(0);
      if (o.service === "move") {
        expect(o.moveToKey).toBe("qualified");
        expect(["new", "contacted"]).toContain(row.stage_key);
        expect(row.expected_close_date).not.toBeNull();
      }
      if (o.service === "lose") expect(LOSS_REASONS.has(str(o.lossReason))).toBe(true);
    }
    expect(n).toBe(SERVICE_SUBSET.win + SERVICE_SUBSET.lose + SERVICE_SUBSET.move);
    for (const c of m.convert) {
      const lead = leads.get(c.lead.id)!;
      expect(lead.status).toBe("qualified");
      expect(lead.quarantine).toBe("trusted");
      expect(lead.archived).toBe(false);
      expect(lead.owner_user_id).not.toBeNull();
      expect(activeCustomers.has(c.customerId)).toBe(true);
      expect(c.name.length).toBeLessThanOrEqual(160);
      expect(c.closeDate > company.history.asOf).toBe(true);
    }
  });

  it("leads: conversion evidence, quarantine, reasons and money pairing all hold", () => {
    const seen = new Set<string>();
    let quarantined = 0;
    let arabic = 0;
    for (const l of W.lead!) {
      seen.add(str(l.status));
      expect(LEAD_STATUS.has(str(l.status))).toBe(true);
      expect(LEAD_SOURCE_KINDS.has(str(l.source_kind))).toBe(true);
      expect(QUARANTINE.has(str(l.quarantine))).toBe(true);
      if (l.quarantine === "quarantined") {
        quarantined++;
        expect(l.status).toBe("new");
      }
      if (l.quarantine === "spam") expect(l.disqualify_reason).toBe("spam");
      if (ARABIC.test(str(l.name))) arabic++;
      if (l.status === "converted") {
        expect(l.converted_at).toBeTruthy();
        const opp = opps.get(str(l.converted_opportunity_id));
        expect(opp?.lead_id).toBe(l.id);
        if (l.converted_customer_id !== null)
          expect(opp?.customer_id).toBe(l.converted_customer_id);
      } else {
        expect(l.converted_opportunity_id).toBeNull();
        expect(l.converted_customer_id).toBeNull();
        expect(l.converted_at).toBeNull();
      }
      if (l.status === "disqualified") expect(DISQUALIFY.has(str(l.disqualify_reason))).toBe(true);
      else expect(l.disqualify_reason).toBeNull();
      expect(l.estimated_value_minor === null).toBe(l.currency === null);
      if (l.duplicate_of_lead_id !== null)
        expect(leads.has(str(l.duplicate_of_lead_id))).toBe(true);
      for (const k of ["referrer_customer_id", "converted_customer_id"] as const)
        if (l[k] !== null) {
          expect(activeCustomers.has(str(l[k]))).toBe(true);
          expect(l[k]).not.toBe(m.merge.sourceId);
        }
      expect(str(l.country)).toMatch(/^[A-Z]{2}$/);
      expect(str(l.email)).toMatch(/@example\.invalid$/);
    }
    expect([...seen].sort()).toEqual([...LEAD_STATUS].sort());
    expect(quarantined).toBeGreaterThan(0);
    expect(arabic).toBeGreaterThan(0);
  });

  it("activities: a subject, legal kinds, due dates on follow-ups, contacts of the right customer, lifecycle marks", () => {
    const wonMarks = new Map<string, number>();
    const lostMarks = new Map<string, number>();
    let overdueOpen = 0;
    let completedWithOutcome = 0;
    for (const a of W.sales_activity!) {
      expect(a.lead_id !== null || a.opportunity_id !== null || a.customer_id !== null).toBe(true);
      expect(ACTIVITY_KINDS.has(str(a.kind))).toBe(true);
      if (a.kind === "follow_up") expect(a.due_date).not.toBeNull();
      if (a.kind === "custom") expect(a.custom_kind).not.toBeNull();
      if (a.outcome !== null) expect(OUTCOMES.has(str(a.outcome))).toBe(true);
      if (a.completed_at !== null) expect(a.completed_by).not.toBeNull();
      if (a.lead_id !== null) expect(leads.has(str(a.lead_id))).toBe(true);
      if (a.opportunity_id !== null) {
        const o = opps.get(str(a.opportunity_id))!;
        expect(o).toBeDefined();
        if (a.kind !== "won" && a.kind !== "lost" && a.kind !== "task" && a.kind !== "note")
          expect(a.customer_id).toBe(o.customer_id);
        if (a.kind === "stage_change") {
          const meta = a.meta as { from: string; to: string; ageDays: number };
          expect(a.title).toBe(`${meta.from}|${meta.to}`);
          const stages = stagesByPipelineId.get(str(o.pipeline_id))!;
          expect(stages.get(meta.from)).toBe("open");
          expect(stages.get(meta.to)).toBe("open");
        }
        if (a.kind === "won") wonMarks.set(o.id as string, (wonMarks.get(o.id as string) ?? 0) + 1);
        if (a.kind === "lost")
          lostMarks.set(o.id as string, (lostMarks.get(o.id as string) ?? 0) + 1);
      }
      if (a.contact_id !== null) {
        expect(a.customer_id).not.toBeNull();
        expect(contactsOf.get(str(a.customer_id))?.has(str(a.contact_id))).toBe(true);
      }
      if (
        (a.kind === "task" || a.kind === "follow_up") &&
        a.completed_at === null &&
        str(a.due_date) < company.history.asOf
      )
        overdueOpen++;
      if (a.completed_at !== null && a.outcome !== null) completedWithOutcome++;
      if (a.title !== null) expect(str(a.title).length).toBeLessThanOrEqual(200);
      if (a.body !== null) expect(str(a.body).length).toBeLessThanOrEqual(2000);
    }
    for (const o of W.opportunity!) {
      expect(wonMarks.get(str(o.id)) ?? 0, "won marks").toBe(o.status === "won" ? 1 : 0);
      expect(lostMarks.get(str(o.id)) ?? 0, "lost marks").toBe(o.status === "lost" ? 1 : 0);
    }
    expect(overdueOpen).toBeGreaterThan(0);
    expect(completedWithOutcome).toBeGreaterThan(0);
  });

  it("product lines reconcile to the opportunity's value with the product's own formula", () => {
    const net = new Map<string, number>();
    for (const p of W.crm_opportunity_product!) {
      expect(opps.has(str(p.opportunity_id))).toBe(true);
      expect(num(p.qty)).toBeGreaterThan(0);
      expect(num(p.discount_pct)).toBeGreaterThanOrEqual(0);
      expect(num(p.discount_pct)).toBeLessThanOrEqual(100);
      expect(str(p.description).length).toBeLessThanOrEqual(300);
      expect(str(p.unit).length).toBeLessThanOrEqual(16);
      if (p.item_id !== null) {
        expect(h.handoffs.masters.itemIds).toContain(p.item_id);
        expect(p.unit).toBe(h.handoffs.masters.items[str(p.item_id)]!.unit);
      }
      if (p.optional) continue;
      const line = computeLine({
        qty: num(p.qty),
        unitPriceMinor: num(p.unit_price_minor),
        discountPct: num(p.discount_pct),
        vatRate: num(p.vat_rate),
        unitCostMinor: null,
      });
      net.set(str(p.opportunity_id), (net.get(str(p.opportunity_id)) ?? 0) + line.lineNetMinor);
    }
    expect(net.size).toBeGreaterThan(0);
    for (const [oid, v] of net) expect(num(opps.get(oid)!.estimated_value_minor), oid).toBe(v);
  });

  it("stakeholders, competitors and risks hang off real opportunities with legal values", () => {
    for (const s of W.crm_opportunity_stakeholder!) {
      expect(opps.has(str(s.opportunity_id))).toBe(true);
      expect(s.contact_id !== null || s.name !== null).toBe(true);
      expect(ROLE_KINDS.has(str(s.role_kind))).toBe(true);
      expect(num(s.influence)).toBeGreaterThanOrEqual(1);
      expect(num(s.influence)).toBeLessThanOrEqual(5);
      if (s.contact_id !== null)
        expect(
          contactsOf.get(str(opps.get(str(s.opportunity_id))!.customer_id))?.has(str(s.contact_id)),
        ).toBe(true);
    }
    for (const c of W.crm_opportunity_competitor!) {
      expect(opps.has(str(c.opportunity_id))).toBe(true);
      expect(["active", "eliminated", "won_against_us", "unknown"]).toContain(c.status);
    }
    for (const r of W.crm_opportunity_risk!) {
      expect(opps.has(str(r.opportunity_id))).toBe(true);
      expect(["risk", "blocker", "dependency"]).toContain(r.kind);
      expect(["low", "medium", "high"]).toContain(r.severity);
      expect(["open", "mitigated", "closed"]).toContain(r.status);
    }
    expect(W.crm_opportunity_stakeholder!.length).toBeGreaterThan(0);
    expect(W.crm_opportunity_competitor!.length).toBeGreaterThan(0);
    expect(W.crm_opportunity_risk!.length).toBeGreaterThan(0);
  });

  it("discounts: pending only where the row stays open, one live request per opportunity, arithmetic exact", () => {
    const pending = new Set<string>();
    for (const d of W.crm_discount!) {
      const o = opps.get(str(d.opportunity_id))!;
      expect(o).toBeDefined();
      expect(num(d.requested_pct)).toBeGreaterThan(0);
      expect(num(d.requested_pct)).toBeLessThanOrEqual(100);
      expect(num(d.discounted_total_minor)).toBe(
        Math.round(num(d.list_total_minor) * (1 - num(d.requested_pct) / 100)),
      );
      expect(d.currency).toBe(company.currency);
      expect(["pending", "approved", "rejected", "withdrawn"]).toContain(d.status);
      expect(d.decided_at === null).toBe(d.status === "pending");
      if (d.status === "pending") {
        expect(o.status).toBe("open");
        expect(oppModel.get(str(o.id))!.service).toBeNull();
        expect(pending.has(str(o.id))).toBe(false);
        pending.add(str(o.id));
      }
    }
    expect(W.crm_discount!.length).toBeGreaterThan(0);
  });

  it("deal canvases: one per open opportunity, well-formed nodes and edges", () => {
    const seen = new Set<string>();
    for (const c of W.crm_deal_canvas!) {
      expect(seen.has(str(c.opportunity_id))).toBe(false);
      seen.add(str(c.opportunity_id));
      expect(opps.get(str(c.opportunity_id))!.status).toBe("open");
      const doc = c.doc as { nodes: Array<Row>; edges: Array<Row> };
      const nodeIds = new Set(doc.nodes.map((n) => str(n.id)));
      for (const n of doc.nodes) {
        expect(CANVAS_KINDS.has(str(n.kind))).toBe(true);
        expect(str(n.label).length).toBeLessThanOrEqual(200);
      }
      for (const e of doc.edges) {
        expect(nodeIds.has(str(e.from))).toBe(true);
        expect(nodeIds.has(str(e.to))).toBe(true);
      }
    }
    expect(W.crm_deal_canvas!.length).toBeGreaterThanOrEqual(2);
  });

  it("campaigns and touches: legal dates and money; every touch cites its subject's campaign", () => {
    const campaigns = byId(W.crm_campaign!);
    for (const c of W.crm_campaign!) {
      expect(CAMPAIGN_CHANNELS.has(str(c.channel))).toBe(true);
      expect(CAMPAIGN_STATUS.has(str(c.status))).toBe(true);
      if (c.ends_on !== null) expect(str(c.ends_on) >= str(c.starts_on)).toBe(true);
      expect(num(c.cost_minor)).toBeGreaterThanOrEqual(0);
      if (c.budget_minor !== null || num(c.cost_minor) > 0) expect(c.currency).not.toBeNull();
      if (c.status === "active" || c.status === "paused")
        expect(c.ends_on === null || str(c.ends_on) >= company.history.asOf).toBe(true);
      if (c.status === "completed") expect(str(c.ends_on) < company.history.asOf).toBe(true);
    }
    for (const t of W.crm_touch!) {
      expect(campaigns.has(str(t.campaign_id))).toBe(true);
      expect(TOUCH_KINDS.has(str(t.kind))).toBe(true);
      expect(t.lead_id !== null || t.opportunity_id !== null || t.customer_id !== null).toBe(true);
      const subject =
        t.lead_id !== null ? leads.get(str(t.lead_id)) : opps.get(str(t.opportunity_id));
      expect(subject?.campaign_id).toBe(t.campaign_id);
      if (t.note !== null) expect(str(t.note).length).toBeLessThanOrEqual(300);
    }
    expect(W.crm_touch!.length).toBeGreaterThan(0);
  });

  it("targets: scope and value rules, org + owners + territories, dated re-sets", () => {
    const scopes = new Set<string>();
    for (const t of W.crm_target!) {
      scopes.add(str(t.scope_kind));
      expect(TARGET_SCOPES.has(str(t.scope_kind))).toBe(true);
      expect(TARGET_METRICS.has(str(t.metric))).toBe(true);
      expect(t.scope_kind === "org").toBe(t.scope_id === null);
      expect(str(t.period_end) >= str(t.period_start)).toBe(true);
      if (t.metric === "activities" || t.metric === "new_customers") {
        expect(t.count_target).not.toBeNull();
        expect(t.amount_minor).toBeNull();
      } else {
        expect(num(t.amount_minor)).toBeGreaterThan(0);
        expect(t.currency).toBe(company.currency);
      }
      const late = SimClock.diffDays(str(t.effective_from), str(t.period_start));
      expect(late).toBeLessThanOrEqual(15);
      if (t.scope_kind === "user") expect(Object.values(h.users)).toContain(t.scope_id);
      if (t.scope_kind === "territory") expect(m.territoryIds).toContain(t.scope_id);
    }
    expect([...scopes].sort()).toEqual(["org", "territory", "user"]);
    const revised = W.crm_target!.filter((t) => t.note === "Revised after the board review");
    expect(revised).toHaveLength(1);
  });

  it(`forecast snapshots: ${SNAPSHOT_MONTHS} consecutive months whose totals equal their frozen rows`, () => {
    expect(W.crm_forecast_snapshot!).toHaveLength(SNAPSHOT_MONTHS);
    const keys = W.crm_forecast_snapshot!.map((s) => str(s.period_key));
    expect(new Set(keys).size).toBe(SNAPSHOT_MONTHS);
    expect(keys[keys.length - 1]).toBe(company.history.asOf.slice(0, 7));
    for (const s of W.crm_forecast_snapshot!) {
      expect(str(s.period_key)).toMatch(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
      const rows = s.rows as Array<Row>;
      const totals = s.totals as Record<string, number>;
      expect(s.row_count).toBe(rows.length);
      const active = rows.filter((r) => r.category !== "omitted");
      expect(totals.count).toBe(active.length);
      expect(totals.pipelineMinor).toBe(active.reduce((a, r) => a + num(r.valueMinor), 0));
      expect(totals.weightedMinor).toBe(active.reduce((a, r) => a + num(r.weightedMinor), 0));
      expect(totals.commitMinor).toBe(
        active.filter((r) => r.category === "commit").reduce((a, r) => a + num(r.valueMinor), 0),
      );
      for (const r of rows) {
        const o = opps.get(str(r.id))!;
        expect(o).toBeDefined();
        expect(str(r.closeDate).slice(0, 7)).toBe(s.period_key);
        expect(str(o.created_at) <= str(s.captured_at)).toBe(true);
        expect(stagesByPipelineId.get(str(o.pipeline_id))!.has(str(r.stageKey))).toBe(true);
        expect(num(r.weightedMinor)).toBe(
          Math.round((num(r.valueMinor) * num(r.probability)) / 100),
        );
      }
      expect(s.currency).toBe(company.currency);
    }
    expect(W.crm_forecast_snapshot!.some((s) => num(s.row_count) > 0)).toBe(true);
  });

  it("scenarios: three, applied exactly when applied_at is set, overlays cite real open rows", () => {
    expect(W.crm_scenario!).toHaveLength(3);
    for (const s of W.crm_scenario!) {
      expect((s.status === "applied") === (s.applied_at !== null)).toBe(true);
      expect((s.applied_by !== null) === (s.applied_at !== null)).toBe(true);
      const overlay = s.overlay as {
        slips: Array<{ opportunityId: string }>;
        excludes: string[];
        probabilities: Array<{ opportunityId: string; probability: number }>;
        categories: Array<{ opportunityId: string; category: string }>;
      };
      const cited = [
        ...overlay.slips.map((x) => x.opportunityId),
        ...overlay.excludes,
        ...overlay.probabilities.map((x) => x.opportunityId),
        ...overlay.categories.map((x) => x.opportunityId),
      ];
      expect(cited.length).toBeGreaterThan(0);
      for (const oid of cited) expect(opps.get(oid)!.status).toBe("open");
      for (const p of overlay.probabilities) {
        expect(p.probability).toBeGreaterThanOrEqual(0);
        expect(p.probability).toBeLessThanOrEqual(100);
      }
    }
    expect(new Set(W.crm_scenario!.map((s) => s.status))).toEqual(
      new Set(["reviewed", "draft", "applied"]),
    );
  });

  it("automations: legal triggers and actions; runs are idempotent keys, live only where allowed, mixed outcomes", () => {
    const automations = byId(W.crm_automation!);
    expect(W.crm_automation!).toHaveLength(4);
    for (const a of W.crm_automation!) {
      expect(AUTOMATION_TRIGGERS.has(str(a.trigger))).toBe(true);
      const conditions = a.conditions as { all: Array<Row> };
      for (const c of conditions.all) expect(typeof c.key).toBe("string");
      for (const act of a.actions as Array<Row>) {
        expect(ACTION_KINDS.has(str(act.kind))).toBe(true);
        if (["create_task", "notify", "flag_risk"].includes(str(act.kind))) {
          expect(str(act.title).length).toBeGreaterThan(0);
          expect(str(act.title).length).toBeLessThanOrEqual(200);
        }
        if (act.kind === "assign_owner") expect(Object.values(h.users)).toContain(act.userId);
        if (act.kind === "set_forecast_category")
          expect(FORECAST_CATEGORIES.has(str(act.category))).toBe(true);
      }
      expect(str(a.name).length).toBeLessThanOrEqual(120);
    }
    const keys = new Set<string>();
    const statuses = new Set<string>();
    for (const r of W.crm_automation_run!) {
      const a = automations.get(str(r.automation_id))!;
      expect(a).toBeDefined();
      expect(RUN_STATUS.has(str(r.status))).toBe(true);
      statuses.add(str(r.status));
      expect(["dry_run", "live"]).toContain(r.mode);
      if (r.mode === "live") {
        expect(a.enabled).toBe(true);
        expect(a.dry_run).toBe(false);
      }
      const key = [r.automation_id, r.subject_type, r.subject_id, r.occurrence_key, r.mode].join(
        "|",
      );
      expect(keys.has(key), "duplicate run key").toBe(false);
      keys.add(key);
      if (r.subject_type === "lead") expect(leads.has(str(r.subject_id))).toBe(true);
      if (r.subject_type === "opportunity") expect(opps.has(str(r.subject_id))).toBe(true);
      expect(Array.isArray(r.result)).toBe(true);
      expect(r.error === null).toBe(r.status !== "failed");
      expect(str(r.ran_at) <= str(a.last_run_at)).toBe(true);
    }
    expect(statuses.size).toBeGreaterThanOrEqual(3);
    expect(W.crm_automation_run!.length).toBeGreaterThan(0);
    for (const t of W.sales_activity!.filter((x) => (x.meta as Row).automationId !== undefined)) {
      expect(t.kind).toBe("task");
      expect(automations.has(str((t.meta as Row).automationId))).toBe(true);
    }
  });

  it("customer-success signals: active customers only, scored the way each kind demands", () => {
    for (const s of W.crm_customer_signal!) {
      expect(activeCustomers.has(str(s.customer_id))).toBe(true);
      expect(s.customer_id).not.toBe(m.merge.sourceId);
      expect(SIGNAL_KINDS.has(str(s.kind))).toBe(true);
      if (s.kind === "satisfaction") {
        expect(num(s.score)).toBeGreaterThanOrEqual(1);
        expect(num(s.score)).toBeLessThanOrEqual(5);
      }
      if (s.score !== null) {
        expect(num(s.score)).toBeGreaterThanOrEqual(0);
        expect(num(s.score)).toBeLessThanOrEqual(100);
      }
      if (s.status !== null) expect(SIGNAL_STATUS.has(str(s.status))).toBe(true);
    }
    expect(W.crm_customer_signal!.length).toBeGreaterThan(0);
  });

  it("the merge: one reviewed merge of the newest active customer, untouched by every other row, retired by the seed", () => {
    expect(W.crm_merge!).toHaveLength(1);
    const mg = W.crm_merge![0]!;
    expect(mg.source_customer_id).not.toBe(mg.target_customer_id);
    expect(activeCustomers.has(str(mg.source_customer_id))).toBe(true);
    expect(activeCustomers.has(str(mg.target_customer_id))).toBe(true);
    const activeOrdered = h.handoffs.masters.customerIds.filter((id) => activeCustomers.has(id));
    expect(mg.source_customer_id).toBe(activeOrdered[activeOrdered.length - 1]);
    expect(mg.target_customer_id).toBe(activeOrdered[activeOrdered.length - 2]);
    expect((mg.source_snapshot as Row).id).toBe(mg.source_customer_id);
    expect((mg.target_snapshot as Row).id).toBe(mg.target_customer_id);
    expect((mg.source_snapshot as Row).name).toBeDefined();
    for (const v of Object.values(mg.repointed as Record<string, number>)) expect(v).toBe(0);
    const src = str(mg.source_customer_id);
    for (const t of CRM_TABLES)
      for (const r of W[t] ?? [])
        for (const k of ["customer_id", "referrer_customer_id", "converted_customer_id"])
          if (k in r) expect(r[k], `${t}.${k}`).not.toBe(src);
    const mergeActs = W.sales_activity!.filter((a) => a.kind === "merged");
    expect(mergeActs).toHaveLength(1);
    expect(mergeActs[0]!.customer_id).toBe(mg.target_customer_id);
    expect((mergeActs[0]!.meta as Row).sourceId).toBe(src);
    const retire = h.statements.filter((s) => s.text.includes("merged_into_customer_id ="));
    expect(retire).toHaveLength(1);
    expect(retire[0]!.values).toContain(src);
    expect(retire[0]!.values).toContain(mg.target_customer_id);
    expect(run.report.handoff?.mergedCustomerId).toBe(src);
  });

  it("the handoff is small and names what later families need", () => {
    const ho = run.report.handoff!;
    expect(ho.pipelineIds).toEqual(
      Object.fromEntries(Object.entries(h.handoffs.setup.pipelines).map(([k, p]) => [k, p.id])),
    );
    expect(ho.territoryIds).toEqual(m.territoryIds);
    expect(ho.campaignIds).toEqual(m.campaignIds);
    expect(ho.opportunityCount).toBe(company.profile.opportunities);
    expect(ho.leadCount).toBe(company.profile.leads);
    expect((ho.openOpportunitySample as string[]).length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(ho).length).toBeLessThan(4000);
  });
});

// ── across the five companies ────────────────────────────────────────────────

describe("volume where the profiles ask for it", () => {
  const by = (key: string) => RUNS.find((r) => r.company.key === key)!;

  it("tradeline crosses the 1,205-row pagination mark on opportunities and leads", () => {
    // One company past the boundary is the law; every company past it is what
    // put this family at 55,000 rows before the lab was scaled to its ceiling.
    const key = "tradeline";
    expect(by(key).plan.opportunity, "opportunities").toBeGreaterThan(1205);
    expect(by(key).plan.lead, "leads").toBeGreaterThan(1205);
    expect(by(key).h.written.opportunity!.length, key).toBeGreaterThan(1205);
    for (const other of ["gulfbuild", "saudimfg", "consult", "facilico"])
      expect(by(other).plan.opportunity, other).toBeGreaterThan(100);
  });

  it("the activity stream is deep enough to page through", () => {
    // Every opportunity carries a handful of touches; tradeline's book alone
    // takes the stream past the pagination boundary.
    expect(by("tradeline").plan.sales_activity).toBeGreaterThan(1205);
    const total = RUNS.reduce((s, r) => s + r.plan.sales_activity!, 0);
    expect(total).toBeGreaterThan(4_000);
  });

  it("every company has the same governed depth: snapshots, scenarios, automations, territories, one merge", () => {
    for (const r of RUNS) {
      expect(r.plan.crm_forecast_snapshot, r.company.key).toBe(SNAPSHOT_MONTHS);
      expect(r.plan.crm_scenario).toBe(3);
      expect(r.plan.crm_automation).toBe(4);
      expect(r.plan.crm_territory).toBe(3);
      expect(r.plan.crm_campaign).toBe(5);
      expect(r.plan.crm_merge).toBe(1);
    }
  });

  it("the Saudi company is Arabic-first in its opportunity names", () => {
    const sa = by("saudimfg").h.written.opportunity!;
    const arabic = sa.filter((o) => ARABIC.test(str(o.name))).length;
    expect(arabic / sa.length).toBeGreaterThan(0.5);
  });
});
