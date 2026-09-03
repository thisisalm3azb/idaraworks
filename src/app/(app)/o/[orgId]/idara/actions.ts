"use server";

/**
 * H28 — server actions behind the Idara Dock and workspace. Every action
 * resolves the session and membership first, then the release flag, then the
 * person's `idara.use` permission; nothing about identity comes from the
 * browser. Results are plain data the client renders; failures are typed.
 */
import { z } from "zod";
import { AGENT_DEFS, type AgentId } from "@/platform/agents/registry";
import { idaraGateFor, type IdaraGate } from "@/platform/ai";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { can, ForbiddenError } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { getServerLocale, getT } from "@/platform/i18n/server";
import { listMyNotifications } from "@/platform/notifications";
import type { Locale } from "@/platform/i18n";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { getCustomer } from "@/modules/masters/service";
import { getOpportunityCommercial, listLeads, listOpportunities } from "@/modules/crm/service";
import { getJobDetail, listJobs } from "@/modules/jobs/service";
import { getDocument, listDocuments } from "@/modules/docstudio/service";
import {
  ActionStateError,
  addressableAgents,
  branchConversation,
  cancelAction,
  cancelRun,
  confirmAction,
  conversationView,
  executeApprovedAction,
  forget,
  listActions,
  listConversations,
  listMemory,
  preference,
  remember,
  startConversation,
  startRun,
  updateConversation,
  RecordRefSchema,
  type ConversationRow,
  type RecordRef,
} from "@/modules/idara/service";

export type Fail = {
  ok: false;
  code: "off" | "forbidden" | "failed" | "not_found" | "invalid" | "state";
  message?: string;
};

type Resolved = { ctx: Ctx; archetype: RoleArchetype; locale: Locale };

async function resolve(orgId: string): Promise<Resolved | Fail> {
  if (!idaraEnabled()) return { ok: false, code: "off" };
  const r = await resolveCtxForAction(orgId);
  if (typeof r === "string") return { ok: false, code: "forbidden" };
  if (!can(r.archetype, "idara.use")) return { ok: false, code: "forbidden" };
  return { ctx: r.ctx, archetype: r.archetype, locale: await getServerLocale() };
}

function failOf(e: unknown): Fail {
  if (e instanceof ForbiddenError) return { ok: false, code: "forbidden" };
  if (e instanceof ActionStateError) return { ok: false, code: "state", message: e.code };
  if (e instanceof z.ZodError) return { ok: false, code: "invalid" };
  return { ok: false, code: "failed", message: String((e as Error).message ?? e).slice(0, 200) };
}

export type AgentOption = { id: AgentId; name: string; description: string; capability: string };

export type DockState = {
  ok: true;
  surfaceOn: boolean;
  modelAvailable: boolean;
  reason: IdaraGate["reason"];
  ownerAction: string | null;
  agents: AgentOption[];
  allowance: { allowance: number | null; remaining: number | null; usedPct: number | null } | null;
  unread: number;
  shortcut: string;
  canConfirm: boolean;
  canManageAgents: boolean;
  canViewUsage: boolean;
};

export async function idaraStateAction(orgId: string): Promise<DockState | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const t = await getT();
    const gate = await idaraGateFor(r.ctx);
    const agents = addressableAgents(r.archetype).map((id) => ({
      id,
      name: t(`idara.agents.${id}.name`),
      description: t(`idara.agents.${id}.purpose`),
      capability: AGENT_DEFS[id].capability,
    }));
    const notifications = await listMyNotifications(r.ctx, true, { limit: 50 });
    const unread = notifications.filter((n) => String(n.kind).startsWith("idara_")).length;
    const shortcut = (await preference(r.ctx, "dock.shortcut")) as string | null;
    return {
      ok: true,
      surfaceOn: gate.surfaceOn,
      modelAvailable: gate.modelAvailable,
      reason: gate.reason,
      ownerAction: gate.ownerAction,
      agents,
      allowance: gate.allowance
        ? {
            allowance: gate.allowance.allowance,
            remaining: gate.allowance.remaining,
            usedPct: gate.allowance.usedPct,
          }
        : null,
      unread,
      shortcut: shortcut ?? "ctrl+.",
      canConfirm: can(r.archetype, "idara.actions.confirm"),
      canManageAgents: can(r.archetype, "idara.agents.manage"),
      canViewUsage: can(r.archetype, "idara.usage.view"),
    };
  } catch (e) {
    return failOf(e);
  }
}

const StartPayload = z.object({
  kind: z.enum(["quick", "session", "task"]).default("quick"),
  agentId: z.string().max(40).optional(),
  contextRefs: z.array(RecordRefSchema).max(12).default([]),
  title: z.string().trim().max(200).optional(),
});

export async function idaraStartAction(
  orgId: string,
  payload: unknown,
): Promise<{ ok: true; conversation: ConversationRow } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const p = StartPayload.parse(payload);
    const conversation = await startConversation(r.ctx, {
      kind: p.kind,
      agentId: p.agentId && p.agentId in AGENT_DEFS ? p.agentId : "idara",
      contextRefs: p.contextRefs,
      title: p.title,
    });
    return { ok: true, conversation };
  } catch (e) {
    return failOf(e);
  }
}

const SendPayload = z.object({
  conversationId: z.string().uuid(),
  input: z.string().trim().min(1).max(8000),
  agentId: z.string().max(40).optional(),
  contextRefs: z.array(RecordRefSchema).max(12).optional(),
  preferStrong: z.boolean().optional(),
  kind: z.enum(["interactive", "background"]).default("interactive"),
});

export async function idaraSendAction(
  orgId: string,
  payload: unknown,
): Promise<{ ok: true; runId: string; status: string } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const p = SendPayload.parse(payload);
    const res = await startRun(r.ctx, r.archetype, r.locale, p);
    return { ok: true, runId: res.runId, status: res.status };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraViewAction(orgId: string, conversationId: string, afterSeq?: number) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const view = await conversationView(r.ctx, z.string().uuid().parse(conversationId), {
      afterSeq,
    });
    if (!view) return { ok: false, code: "not_found" } as Fail;
    return { ok: true as const, ...view };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraCancelAction(
  orgId: string,
  runId: string,
): Promise<{ ok: true } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    await cancelRun(r.ctx, z.string().uuid().parse(runId));
    return { ok: true };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraConversationsAction(
  orgId: string,
  q: { status?: "active" | "archived"; limit?: number; offset?: number } = {},
) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const res = await listConversations(r.ctx, {
      status: q.status,
      limit: q.limit ?? 30,
      offset: q.offset ?? 0,
    });
    return { ok: true as const, ...res };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraUpdateConversationAction(
  orgId: string,
  payload: unknown,
): Promise<{ ok: true } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    await updateConversation(r.ctx, payload);
    return { ok: true };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraBranchAction(
  orgId: string,
  payload: unknown,
): Promise<{ ok: true; conversation: ConversationRow } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const conversation = await branchConversation(r.ctx, payload);
    return { ok: true, conversation };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraActionsAction(
  orgId: string,
  q: { status?: string; limit?: number; offset?: number } = {},
) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const res = await listActions(r.ctx, {
      status: q.status as never,
      mine: true,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });
    return { ok: true as const, ...res };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraConfirmAction(orgId: string, actionId: string) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  if (!can(r.archetype, "idara.actions.confirm")) return { ok: false, code: "forbidden" } as Fail;
  try {
    const action = await confirmAction(r.ctx, r.archetype, r.locale, { actionId });
    return { ok: true as const, action };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraExecuteApprovedAction(orgId: string, actionId: string) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  if (!can(r.archetype, "idara.actions.confirm")) return { ok: false, code: "forbidden" } as Fail;
  try {
    const action = await executeApprovedAction(r.ctx, r.archetype, r.locale, { actionId });
    return { ok: true as const, action };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraCancelProposedAction(
  orgId: string,
  actionId: string,
): Promise<{ ok: true } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    await cancelAction(r.ctx, { actionId });
    return { ok: true };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraMemoryAction(orgId: string) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    return { ok: true as const, rows: await listMemory(r.ctx) };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraRememberAction(orgId: string, payload: unknown) {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    return { ok: true as const, row: await remember(r.ctx, r.archetype, payload) };
  } catch (e) {
    return failOf(e);
  }
}

export async function idaraForgetAction(orgId: string, id: string): Promise<{ ok: true } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    await forget(r.ctx, r.archetype, z.string().uuid().parse(id));
    return { ok: true };
  } catch (e) {
    return failOf(e);
  }
}

/** A label for a record the page is showing (the context capsule). */
export async function idaraContextLabelAction(
  orgId: string,
  ref: unknown,
): Promise<{ ok: true; ref: RecordRef } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  try {
    const p = RecordRefSchema.parse(ref);
    let label: string | undefined;
    switch (p.type) {
      case "customer": {
        if (can(r.archetype, "customers.view"))
          label = ((await getCustomer(r.ctx, r.archetype, p.id)) as { name?: string } | null)?.name;
        break;
      }
      case "opportunity": {
        if (can(r.archetype, "opportunities.view"))
          label = (
            (await getOpportunityCommercial(r.ctx, r.archetype, p.id)) as { name?: string } | null
          )?.name;
        break;
      }
      case "job": {
        if (can(r.archetype, "jobs.view")) {
          const d = (await getJobDetail(r.ctx, r.archetype, p.id)) as {
            reference?: string;
            name?: string;
          } | null;
          label = d?.reference ?? d?.name;
        }
        break;
      }
      case "document": {
        if (can(r.archetype, "documents.view")) {
          const d = (await getDocument(r.ctx, r.archetype, p.id)) as {
            document?: { title?: string };
            title?: string;
          };
          label = d.document?.title ?? d.title;
        }
        break;
      }
      default:
        break;
    }
    return { ok: true, ref: { ...p, label: label ?? p.label } };
  } catch (e) {
    return failOf(e);
  }
}

export type SearchHit = RecordRef & { hint?: string };

/** Records the person may add to the capsule (bounded, permission-checked per kind). */
export async function idaraSearchAction(
  orgId: string,
  q: string,
): Promise<{ ok: true; hits: SearchHit[] } | Fail> {
  const r = await resolve(orgId);
  if ("ok" in r) return r;
  const needle = q.trim().slice(0, 80);
  if (needle.length < 2) return { ok: true, hits: [] };
  const hits: SearchHit[] = [];
  try {
    if (can(r.archetype, "opportunities.view")) {
      const rows = await listOpportunities(r.ctx, r.archetype, { status: "all", limit: 50 });
      for (const o of rows as Array<{ id: string; name?: string; customerName?: string | null }>) {
        if ((o.name ?? "").toLowerCase().includes(needle.toLowerCase()))
          hits.push({
            type: "opportunity",
            id: o.id,
            label: o.name,
            hint: o.customerName ?? undefined,
          });
        if (hits.length >= 5) break;
      }
    }
    if (can(r.archetype, "leads.view")) {
      const rows = await listLeads(r.ctx, r.archetype, { q: needle, limit: 5 });
      for (const l of rows as Array<{ id: string; name?: string }>)
        hits.push({ type: "lead", id: l.id, label: l.name });
    }
    if (can(r.archetype, "jobs.view")) {
      const rows = await listJobs(r.ctx, r.archetype, { search: needle, limit: 5 } as never);
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      for (const j of list as Array<{ id: string; reference?: string; name?: string }>)
        hits.push({ type: "job", id: j.id, label: j.reference ?? j.name, hint: j.name });
    }
    if (can(r.archetype, "documents.view")) {
      const res = await listDocuments(r.ctx, r.archetype, { search: needle, limit: 5 });
      for (const d of res.rows as Array<{ id: string; title?: string; reference?: string }>)
        hits.push({ type: "document", id: d.id, label: d.title, hint: d.reference });
    }
    return { ok: true, hits: hits.slice(0, 20) };
  } catch (e) {
    return failOf(e);
  }
}
