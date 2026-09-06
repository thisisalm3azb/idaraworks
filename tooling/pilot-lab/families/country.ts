/**
 * H33 Pilot Lab — country packs, e-invoicing and AI, in their OFF states.
 *
 * This family exists to make the disabled half of the product visible. Every
 * other family fills a screen with work; this one fills the screens a customer
 * reaches when a capability is not available to them, because "what it looks
 * like switched off" is exactly what a pilot has to be able to inspect.
 *
 * ── What it will never write ───────────────────────────────────────────────
 * No `einvoice_submission` row, ever: a submission means something left this
 * building for a tax authority, and nothing in this lab has. No `ai_run` or
 * `ai_interaction` either — those would assert that a provider did work, and
 * no provider is configured. `verify()` asserts both absences against the live
 * database rather than trusting that nobody adds one later.
 *
 * ── What it does write ─────────────────────────────────────────────────────
 * For the establishment-carrying company: a privacy register, an e-invoicing
 * channel in `not_configured` (the only status the schema allows without a
 * credential), and a handful of e-invoice documents in genuinely LOCAL states
 * — prepared, validated, blocked for want of a credential, cancelled — with
 * the local events that produced them. For every company: the AI entitlement
 * history of an organisation whose trial lapsed and which is now switched off.
 *
 * Establishments and their registrations belong to `setup`; this family reads
 * them and never writes them.
 */
import type { Check, Family, FamilyPlan, FamilyReport, LabContext } from "../types";

type Row = Record<string, unknown>;

export const COUNTRY_TABLES = [
  "establishment_privacy",
  "einvoice_channel",
  "einvoice_document",
  "einvoice_event",
  "ai_entitlement",
  "ai_credit_ledger",
  "ai_privacy_register",
] as const;
export type CountryTable = (typeof COUNTRY_TABLES)[number];

/** Statuses an e-invoice document can hold with nothing having been submitted. */
export const LOCAL_ONLY_EINVOICE_STATUSES = [
  "prepared",
  "validated",
  "blocked_no_credential",
  "cancelled",
] as const;

/** Statuses that would mean something left the building. Never written here. */
export const SUBMITTED_EINVOICE_STATUSES = [
  "submitted",
  "reported",
  "cleared",
  "rejected",
  "warning",
  "retry_pending",
] as const;

/** Tables whose emptiness is the point; `verify()` counts them and expects 0. */
export const FORBIDDEN_TABLES = ["einvoice_submission", "ai_run", "ai_interaction"] as const;

const PRIVACY_ROWS = [
  {
    category: "employee_records",
    purpose: "Payroll, leave and statutory payroll reporting",
    provider: "Supabase (managed Postgres)",
    region: "ap-northeast-2",
    retention: "Held while employed, then per the erasure policy draft",
    crossBorder: true,
    basis: "contract",
  },
  {
    category: "customer_contacts",
    purpose: "Quotations, invoicing and delivery",
    provider: "Supabase (managed Postgres)",
    region: "ap-northeast-2",
    retention: "Held while the commercial relationship lasts",
    crossBorder: true,
    basis: "contract",
  },
  {
    category: "document_files",
    purpose: "Contracts, signed records and issued documents",
    provider: "Supabase Storage (private buckets)",
    region: "ap-northeast-2",
    retention: "Per the document retention rules",
    crossBorder: true,
    basis: "legal_obligation",
  },
  {
    category: "attendance_records",
    purpose: "Timekeeping and payroll input",
    provider: "Supabase (managed Postgres)",
    region: "ap-northeast-2",
    retention: "Held for the statutory retention period",
    crossBorder: false,
    basis: "legal_obligation",
  },
] as const;

/**
 * The document plan. Every entry is a state reachable without a credential,
 * and each carries the local event that put it there.
 */
const DOCUMENT_PLAN = [
  {
    status: "prepared",
    outcome: "prepared",
    detail: "Built from the invoice; local validation has not run yet",
  },
  {
    status: "validated",
    outcome: "validated",
    detail: "Passed the local schema and arithmetic checks",
  },
  {
    status: "validated",
    outcome: "validated",
    detail: "Passed the local schema and arithmetic checks",
  },
  {
    status: "blocked_no_credential",
    outcome: "blocked",
    detail: "No credential is configured on this channel, so nothing was sent",
  },
  {
    status: "blocked_no_credential",
    outcome: "blocked",
    detail: "No credential is configured on this channel, so nothing was sent",
  },
  {
    status: "cancelled",
    outcome: "cancelled",
    detail: "The invoice this was built from was cancelled before anything was sent",
  },
] as const;

type SetupHandoff = { establishments?: Record<string, string> };
type SalesHandoff = { invoiceIds?: string[] };

export type CountryModel = {
  /** Null when this company carries no establishment (four of the five). */
  establishmentId: string | null;
  privacy: Array<{
    id: string;
    establishmentId: string;
    category: string;
    purpose: string;
    provider: string;
    region: string;
    retention: string;
    crossBorder: boolean;
    basis: string;
  }>;
  channels: Array<{
    id: string;
    establishmentId: string;
    country: string;
    adapterKey: string;
    environment: string;
    status: string;
  }>;
  documents: Array<{
    id: string;
    channelId: string;
    establishmentId: string;
    sourceId: string;
    uuid: string;
    counter: number;
    hash: string;
    previousHash: string | null;
    status: string;
    idempotencyKey: string;
    dayAgo: number;
  }>;
  events: Array<{
    id: string;
    documentId: string;
    attempt: number;
    outcome: string;
    detail: string;
    dayAgo: number;
  }>;
  aiEntitlements: Array<{
    id: string;
    version: number;
    mode: string;
    monthlyCredits: number;
    fromDay: number;
    toDay: number | null;
    reason: string;
  }>;
  aiLedger: Array<{ id: string; kind: string; credits: number; periodKey: string; note: string }>;
  aiPrivacy: Array<{ id: string; providerKey: string }>;
  notes: string[];
  tableCounts: Record<CountryTable, number>;
};

const MODELS = new WeakMap<object, CountryModel>();

/** A deterministic 64-character hex string standing in for a document hash. */
export function fakeHash(seed: string): string {
  let h = 2166136261 >>> 0;
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j) + i;
      h = Math.imul(h, 16777619) >>> 0;
    }
    out.push(h.toString(16).padStart(8, "0"));
  }
  return out.join("");
}

function readHandoff<T>(ctx: LabContext, family: string): T {
  try {
    return (ctx.handoff<T>(family) ?? ({} as T)) as T;
  } catch {
    return {} as T;
  }
}

export function buildCountry(ctx: LabContext): CountryModel {
  const key = ctx as unknown as object;
  const memo = MODELS.get(key);
  if (memo) return memo;

  const { company, clock } = ctx;
  const setup = readHandoff<SetupHandoff>(ctx, "setup");
  const sales = readHandoff<SalesHandoff>(ctx, "sales");
  const notes: string[] = [];

  const establishmentId = company.profile.enables.establishment
    ? (Object.values(setup.establishments ?? {})[0] ?? null)
    : null;

  const privacy: CountryModel["privacy"] = [];
  const channels: CountryModel["channels"] = [];
  const documents: CountryModel["documents"] = [];
  const events: CountryModel["events"] = [];

  if (establishmentId) {
    for (const [i, p] of PRIVACY_ROWS.entries()) {
      privacy.push({
        id: ctx.id("establishment_privacy", i),
        establishmentId,
        category: p.category,
        purpose: p.purpose,
        provider: p.provider,
        region: p.region,
        retention: p.retention,
        crossBorder: p.crossBorder,
        basis: p.basis,
      });
    }

    const channelId = ctx.id("einvoice_channel", 0);
    channels.push({
      id: channelId,
      establishmentId,
      country: company.country,
      adapterKey: company.country === "SA" ? "zatca_phase2" : "peppol",
      // Sandbox, never production: a production channel is a claim about a
      // real authority connection, and there is none.
      environment: "sandbox",
      status: "not_configured",
    });

    /*
     * A document needs a source invoice — `source_id` is NOT NULL — so the plan
     * is capped by however many issued invoices sales actually handed over. If
     * sales produced none, this company gets no documents and says so, rather
     * than inventing an invoice id that points at nothing.
     */
    const sourceIds = (sales.invoiceIds ?? []).slice(0, DOCUMENT_PLAN.length);
    if (!sourceIds.length) {
      notes.push("no issued invoices in the sales handoff — no e-invoice documents were built");
    } else if (sourceIds.length < DOCUMENT_PLAN.length) {
      notes.push(
        `only ${sourceIds.length} invoices available — ${DOCUMENT_PLAN.length - sourceIds.length} document states were skipped`,
      );
    }
    let previousHash: string | null = null;
    for (const [i, p] of DOCUMENT_PLAN.slice(0, sourceIds.length).entries()) {
      const docId = ctx.id("einvoice_document", i);
      const hash = fakeHash(`${company.key}:einvoice:${i}`);
      documents.push({
        id: docId,
        channelId,
        establishmentId,
        sourceId: sourceIds[i]!,
        uuid: ctx.id("einvoice_uuid", i),
        counter: i + 1,
        hash,
        previousHash,
        status: p.status,
        idempotencyKey: `einvoice:${company.key}:${String(i).padStart(4, "0")}`,
        dayAgo: 40 - i * 5,
      });
      previousHash = hash;
      events.push({
        id: ctx.id("einvoice_event", i),
        documentId: docId,
        attempt: 1,
        outcome: p.outcome,
        detail: p.detail,
        dayAgo: 40 - i * 5,
      });
    }
  }

  /*
   * AI: a trial that was granted, expired and then switched off. Two
   * entitlement versions so the history reads as a history, a ledger that nets
   * to zero so the balance is honestly empty, and a privacy register entry
   * recording that no provider is configured at all.
   */
  const aiEntitlements: CountryModel["aiEntitlements"] = [
    {
      id: ctx.id("ai_entitlement", 1),
      version: 1,
      mode: "trial",
      monthlyCredits: 500,
      fromDay: 300,
      toDay: 120,
      reason: "Evaluation allowance granted at sign-up",
    },
    {
      id: ctx.id("ai_entitlement", 2),
      version: 2,
      mode: "disabled",
      monthlyCredits: 0,
      fromDay: 120,
      toDay: null,
      reason: "Trial ended and no provider is configured; assistance is unavailable",
    },
  ];
  const periodKey = clock.dayAgo(150).slice(0, 7);
  const aiLedger: CountryModel["aiLedger"] = [
    {
      id: ctx.id("ai_credit_ledger", 0),
      kind: "allowance_adjust",
      credits: 500,
      periodKey,
      note: "Trial allowance",
    },
    {
      id: ctx.id("ai_credit_ledger", 1),
      kind: "expiry",
      credits: -500,
      periodKey,
      note: "Trial allowance expired unused; no provider was ever configured",
    },
  ];
  const aiPrivacy: CountryModel["aiPrivacy"] = [
    { id: ctx.id("ai_privacy_register", 0), providerKey: "none_configured" },
  ];

  const tableCounts: Record<CountryTable, number> = {
    establishment_privacy: privacy.length,
    einvoice_channel: channels.length,
    einvoice_document: documents.length,
    einvoice_event: events.length,
    ai_entitlement: aiEntitlements.length,
    ai_credit_ledger: aiLedger.length,
    ai_privacy_register: aiPrivacy.length,
  };

  const model: CountryModel = {
    establishmentId,
    privacy,
    channels,
    documents,
    events,
    aiEntitlements,
    aiLedger,
    aiPrivacy,
    notes,
    tableCounts,
  };
  MODELS.set(key, model);
  return model;
}

export function countryRows(ctx: LabContext, m: CountryModel): Record<CountryTable, Row[]> {
  const org = ctx.orgId;
  const admin = ctx.users.admin;
  const clock = ctx.clock;
  const rows = Object.fromEntries(COUNTRY_TABLES.map((t) => [t, [] as Row[]])) as Record<
    CountryTable,
    Row[]
  >;

  for (const p of m.privacy)
    rows.establishment_privacy.push({
      id: p.id,
      org_id: org,
      establishment_id: p.establishmentId,
      data_category: p.category,
      purpose: p.purpose,
      provider: p.provider,
      processing_region: p.region,
      retention: p.retention,
      cross_border: p.crossBorder,
      transfer_basis: p.crossBorder
        ? "Intra-group contractual clauses (draft — see the DPA)"
        : null,
      lawful_basis: p.basis,
      reviewed_by: admin,
      reviewed_at: clock.tsAgo(90, 10, 0),
      note: null,
      created_at: clock.tsAgo(200, 10, 0),
      updated_at: clock.tsAgo(90, 10, 0),
    });

  for (const c of m.channels)
    rows.einvoice_channel.push({
      id: c.id,
      org_id: org,
      establishment_id: c.establishmentId,
      country: c.country,
      adapter_key: c.adapterKey,
      environment: c.environment,
      status: c.status,
      // No credential, never activated, and explicitly stopped: three separate
      // ways of saying the same true thing.
      credential_ref: null,
      activated_at: null,
      activated_by: null,
      stopped: true,
      stop_reason: "No credential configured; submission is unavailable in the Pilot Lab",
      last_health_at: null,
      last_health: null,
      created_at: clock.tsAgo(200, 9, 0),
      updated_at: clock.tsAgo(200, 9, 0),
    });

  for (const d of m.documents)
    rows.einvoice_document.push({
      id: d.id,
      org_id: org,
      channel_id: d.channelId,
      establishment_id: d.establishmentId,
      source_kind: "invoice",
      source_id: d.sourceId,
      document_uuid: d.uuid,
      counter: d.counter,
      document_hash: d.hash,
      previous_hash: d.previousHash,
      qr_payload: null,
      status: d.status,
      idempotency_key: d.idempotencyKey,
      // Zero attempts: an attempt is a network call, and none was made.
      attempts: 0,
      request_evidence: null,
      response_evidence: null,
      error_code: d.status === "blocked_no_credential" ? "no_credential" : null,
      error_message:
        d.status === "blocked_no_credential"
          ? "The channel has no credential, so the document was not sent."
          : null,
      prepared_at: clock.tsAgo(d.dayAgo, 12, 0),
      submitted_at: null,
      settled_at: null,
      created_at: clock.tsAgo(d.dayAgo, 12, 0),
      updated_at: clock.tsAgo(d.dayAgo, 12, 0),
    });

  for (const e of m.events)
    rows.einvoice_event.push({
      id: e.id,
      org_id: org,
      document_id: e.documentId,
      attempt: e.attempt,
      outcome: e.outcome,
      detail: { message: e.detail, local: true },
      latency_ms: null,
      created_at: clock.tsAgo(e.dayAgo, 12, 1),
    });

  for (const a of m.aiEntitlements)
    rows.ai_entitlement.push({
      id: a.id,
      org_id: org,
      version: a.version,
      effective_from: clock.tsAgo(a.fromDay, 9, 0),
      effective_to: a.toDay === null ? null : clock.tsAgo(a.toDay, 9, 0),
      mode: a.mode,
      monthly_credits: a.monthlyCredits,
      daily_credit_limit: null,
      per_user_daily_credits: null,
      per_agent_limits: {},
      model_allow: [],
      max_cost_per_request_credits: null,
      soft_warn_pct: 80,
      hard_stop: true,
      overage_allowed: false,
      restricted_domains: [],
      ai_enabled_by_org: a.mode !== "disabled",
      reason: a.reason,
      set_by: admin,
      set_by_operator: false,
      created_at: clock.tsAgo(a.fromDay, 9, 0),
    });

  for (const l of m.aiLedger)
    rows.ai_credit_ledger.push({
      id: l.id,
      org_id: org,
      kind: l.kind,
      credits: l.credits,
      period_key: l.periodKey,
      ref_type: null,
      ref_id: null,
      note: l.note,
      created_by: admin,
      created_at: clock.tsAgo(150, 10, 0),
    });

  for (const p of m.aiPrivacy)
    rows.ai_privacy_register.push({
      id: p.id,
      org_id: org,
      provider_key: p.providerKey,
      lawful_basis: "Not applicable — no provider is configured",
      processor_agreement_ref: "None — no AI processor is engaged (Pilot Lab)",
      transfer_mechanism: "None — no personal data leaves the processing region",
      retention_note: "Not applicable",
      minimisation_confirmed: false,
      ropa_ref: null,
      dpo_checked: false,
      recorded_by: admin,
      recorded_at: clock.tsAgo(120, 10, 0),
      revoked_at: null,
      revoked_by: null,
    });

  return rows;
}

export function planCountry(ctx: LabContext): FamilyPlan {
  const m = buildCountry(ctx);
  return { family: "country", expected: { ...m.tableCounts } };
}

export async function seedCountry(ctx: LabContext): Promise<FamilyReport> {
  const m = buildCountry(ctx);
  const rows = countryRows(ctx, m);
  const counts: Record<string, number> = {};
  for (const table of COUNTRY_TABLES) {
    const r = await ctx.insert(table, rows[table]);
    counts[table] = r.attempted;
    if (rows[table].length) ctx.log(`${table}: ${r.attempted} rows`);
  }
  return {
    family: "country",
    counts,
    handoff: {
      einvoiceChannelIds: m.channels.map((c) => c.id),
      einvoiceDocumentIds: m.documents.map((d) => d.id),
    },
    notes: ["nothing was submitted to an authority and no AI provider was called", ...m.notes],
  };
}

export const country: Family = {
  key: "country",
  // Establishments come from setup; the invoices a document is built from come
  // from sales.
  deps: ["setup", "sales"],
  /** Every company shows the AI-off state; only some carry an establishment. */
  appliesTo: () => true,
  plan: planCountry,
  seed: seedCountry,

  async verify(ctx): Promise<Check[]> {
    const m = buildCountry(ctx);
    const org = ctx.orgId;
    const checks: Check[] = [];

    const count = async (table: string, where = "", params: unknown[] = []): Promise<number> => {
      const [r] = (await ctx.sql.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1 ${where}`,
        [org, ...params] as never[],
      )) as unknown as Array<{ n: number }>;
      return r!.n;
    };

    for (const t of COUNTRY_TABLES) {
      const n = await count(t);
      checks.push({
        name: `count ${t}`,
        ok: n === m.tableCounts[t],
        detail: `${n} live vs ${m.tableCounts[t]} planned`,
      });
    }

    // ── the absences this family exists to guarantee ─────────────────────────
    for (const table of FORBIDDEN_TABLES) {
      let n = 0;
      let present = true;
      try {
        n = await count(table);
      } catch {
        present = false; // not in this schema at all: also an acceptable absence
      }
      checks.push({
        name: `no ${table} rows exist for this company`,
        ok: !present || n === 0,
        detail: present ? `${n} rows` : "table not present",
      });
    }

    const submitted = await count("einvoice_document", `and status = any($2::text[])`, [
      [...SUBMITTED_EINVOICE_STATUSES],
    ]);
    checks.push({
      name: "no e-invoice document claims to have been submitted",
      ok: submitted === 0,
      detail: `${submitted} in a submitted state`,
    });

    const attempted = await count(
      "einvoice_document",
      `and (attempts > 0 or submitted_at is not null)`,
    );
    checks.push({
      name: "no e-invoice document records a transmission attempt",
      ok: attempted === 0,
      detail: `${attempted} with attempts or a submitted_at`,
    });

    const configured = await count(
      "einvoice_channel",
      `and (status <> 'not_configured' or credential_ref is not null or activated_at is not null)`,
    );
    checks.push({
      name: "no e-invoicing channel is configured or activated",
      ok: configured === 0,
      detail: `${configured} configured channels`,
    });

    const verified = await count(
      "establishment_registration",
      `and verification_state = 'verified'`,
    );
    checks.push({
      name: "no registration claims to be verified with an authority",
      ok: verified === 0,
      detail: `${verified} verified`,
    });

    const [ai] = (await ctx.sql.unsafe(
      `select mode from public.ai_entitlement where org_id = $1 order by version desc limit 1`,
      [org] as never[],
    )) as unknown as Array<{ mode: string }>;
    checks.push({
      name: "AI ends in the disabled state",
      ok: ai?.mode === "disabled",
      detail: ai?.mode ?? "no entitlement",
    });

    const [bal] = (await ctx.sql.unsafe(
      `select coalesce(sum(credits),0)::int as n from public.ai_credit_ledger where org_id = $1`,
      [org] as never[],
    )) as unknown as Array<{ n: number }>;
    checks.push({
      name: "the AI credit balance is zero",
      ok: bal!.n === 0,
      detail: `${bal!.n} credits`,
    });

    return checks;
  },
};
