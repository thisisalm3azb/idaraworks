/**
 * H27 — CRM intelligence through the platform's ONE agent provider (ADR-46).
 * Fails closed until a provider and the organisation's feature are
 * configured. When enabled it READS the customer's or opportunity's context
 * and returns proposals with evidence links; it never writes: no messages,
 * no stage moves, no discounts, no financial records, no signatures, no
 * merges, no consent changes, no invented interactions.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentProviderDisabledError,
  AgentProviderTimeoutError,
  agentsEnabled,
  buildProviderRequest,
  callProvider,
  getAgentProvider,
  untrustedBlock,
  type AgentProvider,
} from "@/platform/agents";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

export const CRM_AI_OWNER_ACTION =
  "Configure a model provider behind getAgentProvider() (src/platform/agents/provider.ts) and enable the feat.ai_agents feature for the organisation. Until then the CRM assistant stays off; nothing is simulated.";

export class CrmAiError extends Error {
  readonly code: "unavailable" | "validation" | "not_found";
  readonly ownerAction?: string;
  constructor(message: string, code: CrmAiError["code"], ownerAction?: string) {
    super(message);
    this.code = code;
    this.ownerAction = ownerAction;
  }
}

export type CrmAiDeps = { provider?: AgentProvider; enabled?: boolean };

export async function crmAiAvailability(
  ctx: Ctx,
  deps: CrmAiDeps = {},
): Promise<{ available: boolean; provider: string; ownerAction: string | null }> {
  const provider = deps.provider ?? getAgentProvider();
  const enabled = deps.enabled ?? (await agentsEnabled(ctx));
  const available = provider.name !== "disabled" && enabled;
  return {
    available,
    provider: provider.name,
    ownerAction: available ? null : CRM_AI_OWNER_ACTION,
  };
}

/** A fact the assistant may cite: a record reference the person can open. */
export type EvidenceRef = {
  type:
    | "activity"
    | "opportunity"
    | "lead"
    | "customer"
    | "invoice"
    | "document"
    | "obligation"
    | "quote";
  id: string;
  label: string;
};

export type CrmContext = {
  subject: { kind: "customer" | "opportunity"; id: string; name: string };
  lines: string[];
  refs: EvidenceRef[];
};

/** Gather the facts (bounded, redacted by privilege) the assistant may read. */
export async function gatherCrmContext(
  ctx: Ctx,
  archetype: RoleArchetype,
  subject: { kind: "customer" | "opportunity"; id: string },
): Promise<CrmContext> {
  assertCan(archetype, subject.kind === "customer" ? "customers.view" : "opportunities.view");
  return withCtx(ctx, async (tx) => {
    const refs: EvidenceRef[] = [];
    const lines: string[] = [];
    let name = "";
    if (subject.kind === "opportunity") {
      const o = (await tx.execute(sql`
        select o.id::text as id, o.name, o.stage_key, o.status, o.forecast_category, o.estimated_value_minor, o.probability, o.expected_close_date::text as close_date,
               o.next_action, o.decision_criteria, o.needs, c.name as customer_name, c.id::text as customer_id
        from public.opportunity o left join public.customer c on c.id = o.customer_id
        where o.id = ${subject.id} and o.org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, unknown>>;
      if (!o[0]) throw new CrmAiError("opportunity not found", "not_found");
      name = String(o[0].name);
      refs.push({ type: "opportunity", id: subject.id, label: name });
      lines.push(
        `Opportunity "${name}" for ${o[0].customer_name ?? "no customer"}; stage ${o[0].stage_key}; status ${o[0].status}; forecast ${o[0].forecast_category}${ctx.pricePrivileged && o[0].estimated_value_minor !== null ? `; value ${Number(o[0].estimated_value_minor) / 100}` : ""}; probability ${o[0].probability ?? "unset"}; close ${o[0].close_date ?? "unset"}.`,
      );
      if (o[0].next_action) lines.push(`Next action: ${o[0].next_action}`);
      if (o[0].decision_criteria) lines.push(`Decision criteria: ${o[0].decision_criteria}`);
      if (o[0].needs) lines.push(`Needs: ${o[0].needs}`);
      const sh = (await tx.execute(
        sql`select coalesce(c.name, s.name) as name, s.role_kind, s.influence, s.sentiment from public.crm_opportunity_stakeholder s left join public.customer_contact c on c.id = s.contact_id where s.org_id = ${ctx.orgId} and s.opportunity_id = ${subject.id}`,
      )) as unknown as Array<Record<string, unknown>>;
      for (const s of sh)
        lines.push(
          `Stakeholder: ${s.name} (${s.role_kind}, influence ${s.influence}, ${s.sentiment})`,
        );
      const risks = (await tx.execute(
        sql`select id::text as id, title, severity, status from public.crm_opportunity_risk where org_id = ${ctx.orgId} and opportunity_id = ${subject.id} and status = 'open'`,
      )) as unknown as Array<Record<string, unknown>>;
      for (const r of risks)
        lines.push(`Open risk [${String(r.id).slice(0, 8)}]: ${r.title} (${r.severity})`);
    } else {
      const c = (await tx.execute(
        sql`select id::text as id, name, country, segment, tags from public.customer where id = ${subject.id} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<Record<string, unknown>>;
      if (!c[0]) throw new CrmAiError("customer not found", "not_found");
      name = String(c[0].name);
      refs.push({ type: "customer", id: subject.id, label: name });
      lines.push(
        `Customer "${name}"${c[0].country ? ` (${c[0].country})` : ""}${c[0].segment ? `; segment ${c[0].segment}` : ""}; tags ${((c[0].tags as string[]) ?? []).join(", ") || "none"}.`,
      );
      const opps = (await tx.execute(
        sql`select id::text as id, name, stage_key, status from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${subject.id} order by created_at desc limit 10`,
      )) as unknown as Array<Record<string, unknown>>;
      for (const o of opps) {
        refs.push({ type: "opportunity", id: String(o.id), label: String(o.name) });
        lines.push(
          `Opportunity [${String(o.id).slice(0, 8)}]: ${o.name} (${o.stage_key}, ${o.status})`,
        );
      }
    }
    const acts = (await tx.execute(sql`
      select a.id::text as id, a.kind, a.title, a.body, a.outcome, a.created_at::text as at
      from public.sales_activity a
      where a.org_id = ${ctx.orgId} and (${subject.kind === "opportunity" ? sql`a.opportunity_id = ${subject.id}` : sql`(a.customer_id = ${subject.id} or a.opportunity_id in (select id from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${subject.id}))`})
      order by a.created_at desc limit 30
    `)) as unknown as Array<Record<string, unknown>>;
    for (const a of acts) {
      refs.push({
        type: "activity",
        id: String(a.id),
        label: `${a.kind}${a.title ? `: ${a.title}` : ""}`,
      });
      lines.push(
        `Activity [${String(a.id).slice(0, 8)}] ${String(a.at).slice(0, 10)} ${a.kind}${a.title ? `: ${a.title}` : ""}${a.outcome ? ` (${a.outcome})` : ""}${a.body ? ` — ${String(a.body).slice(0, 300)}` : ""}`,
      );
    }
    return { subject: { kind: subject.kind, id: subject.id, name }, lines, refs };
  });
}

const Proposal = z.object({
  kind: z.enum([
    "follow_up",
    "stakeholder_gap",
    "stalled",
    "forecast_risk",
    "duplicate",
    "action_item",
    "brief",
    "answer",
  ]),
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  evidence: z.array(z.string().min(1)).max(10).default([]),
});
const Output = z.object({
  summary: z.string().max(4000).optional(),
  proposals: z.array(Proposal).max(20).default([]),
});

export type CrmAiResult = {
  summary: string | null;
  proposals: Array<{
    kind: string;
    title: string;
    detail: string | null;
    evidence: EvidenceRef[];
    evidenceFound: boolean;
  }>;
  notice: string;
};

export const CRM_AI_NOTICE =
  "Proposals only: nothing here has been done. Confirm each item yourself; the assistant never sends, moves, approves, signs or merges.";

/** Pure: keep only evidence references that exist in the gathered context. */
export function validateProposals(context: CrmContext, raw: unknown): CrmAiResult {
  const parsed = Output.safeParse(typeof raw === "string" ? safeJson(raw) : raw);
  if (!parsed.success)
    throw new CrmAiError("the assistant returned an unusable answer", "validation");
  const byPrefix = new Map<string, EvidenceRef>();
  for (const r of context.refs) {
    byPrefix.set(r.id, r);
    byPrefix.set(r.id.slice(0, 8), r);
  }
  return {
    summary: parsed.data.summary ?? null,
    proposals: parsed.data.proposals.map((p) => {
      const evidence = p.evidence
        .map((e) => byPrefix.get(e))
        .filter((x): x is EvidenceRef => Boolean(x));
      return {
        kind: p.kind,
        title: p.title,
        detail: p.detail ?? null,
        evidence,
        evidenceFound: evidence.length > 0,
      };
    }),
    notice: CRM_AI_NOTICE,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { summary: s, proposals: [] };
  }
}

const INSTRUCTIONS: Record<string, string> = {
  brief:
    'Prepare a short meeting brief and up to five proposals (follow-ups, stakeholder gaps, risks). Return JSON {"summary": string, "proposals": [{"kind": "brief"|"follow_up"|"stakeholder_gap"|"stalled"|"forecast_risk"|"action_item", "title": string, "detail": string, "evidence": [activity or record id prefixes from the context]}]}. Cite only ids present in the context. Never state facts the context does not contain.',
  actions:
    'Extract concrete action items from the notes and activities. Return JSON {"proposals": [{"kind": "action_item", "title": string, "detail": string, "evidence": [ids]}]}.',
  risks:
    'Explain the risks to this deal or relationship from the evidence, including stakeholder coverage gaps and inactivity. Return JSON {"summary": string, "proposals": [{"kind": "forecast_risk"|"stakeholder_gap"|"stalled", "title": string, "detail": string, "evidence": [ids]}]}.',
  ask: 'Answer the question using only the context; cite the ids you relied on; if the context does not contain the answer say so. Return JSON {"summary": string, "proposals": [{"kind": "answer", "title": string, "detail": string, "evidence": [ids]}]}.',
};

export async function crmAssist(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  deps: CrmAiDeps = {},
): Promise<CrmAiResult> {
  const input = z
    .object({
      kind: z.enum(["customer", "opportunity"]),
      id: z.string().uuid(),
      mode: z.enum(["brief", "actions", "risks", "ask"]).default("brief"),
      question: z.string().trim().max(2000).optional(),
    })
    .parse(raw);
  const avail = await crmAiAvailability(ctx, deps);
  if (!avail.available)
    throw new CrmAiError(CRM_AI_OWNER_ACTION, "unavailable", CRM_AI_OWNER_ACTION);
  const provider = deps.provider ?? getAgentProvider();
  const context = await gatherCrmContext(ctx, archetype, { kind: input.kind, id: input.id });
  const req = buildProviderRequest({
    agentId: "sales_crm",
    correlationId: randomUUID(),
    locale: "en",
    input: `${INSTRUCTIONS[input.mode]}\n\n${input.question ?? ""}`,
    blocks: [
      untrustedBlock(
        "read.customer_overview",
        [{ type: input.kind, id: input.id }],
        context.lines.join("\n"),
      ),
    ],
  });
  return command(
    ctx,
    {
      audit: {
        action: `crm.ai.${input.mode}`,
        entityType: input.kind,
        entityId: input.id,
        summary: `Assistant ${input.mode} (read-only, ${provider.name})`,
      },
    },
    async () => {
      try {
        const res = await callProvider(provider, req);
        return validateProposals(context, res.output);
      } catch (err) {
        if (err instanceof AgentProviderDisabledError)
          throw new CrmAiError(CRM_AI_OWNER_ACTION, "unavailable", CRM_AI_OWNER_ACTION);
        if (err instanceof AgentProviderTimeoutError)
          throw new CrmAiError("the assistant did not answer in time", "unavailable");
        throw err;
      }
    },
  );
}
