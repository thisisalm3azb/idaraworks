/**
 * The agent runner (H12 / A1) — the ONE path every agent request takes.
 *
 * Order of authority (H11 §2, Part E):
 *  1. resolve the authenticated user + membership server-side (resolveCtx —
 *     the request's orgId only SELECTS which membership to validate),
 *  2. fail closed on the feature gate,
 *  3. validate agent, classification, approval binding,
 *  4. compute usable tools = agent allow-list ∩ can(archetype, tool.action)
 *     ∩ registered handlers — the model has NO tool channel and cannot add
 *     any (injection inside records is inert data),
 *  5. call the provider through the single seam (timeout, cancellation,
 *     correlation ID, secret-free context),
 *  6. validate output structurally and against ground truth (citations must
 *     reference consulted records — anything else is fabricated),
 *  7. write the immutable audit record through the existing command path.
 *
 * runAgentCore is dependency-injected so the security harness can prove the
 * denials without a database; runAgent wires the production dependencies.
 */
import { randomUUID } from "node:crypto";
import { can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { normalizeLocale } from "@/platform/i18n";
import {
  AGENT_TOOLS,
  AGENT_TOOL_ALLOW,
  A1_SUPPORTED_CLASSES,
  isAgentId,
  isAgentToolId,
  type AgentId,
  type AgentToolId,
} from "./registry";
import {
  AgentOutputSchema,
  AgentRequestSchema,
  type AgentAuditRecord,
  type AgentRequest,
  type AgentResult,
} from "./contract";
import {
  AgentProviderDisabledError,
  AgentProviderTimeoutError,
  callProvider,
  getAgentProvider,
  type AgentProvider,
  type UntrustedBlock,
} from "./provider";
import { buildProviderRequest, untrustedBlock } from "./context";
import { validateApprovalBinding, type ApprovalBinding } from "./approval";
import { agentsEnabled } from "./gate";

export type AgentToolHandler = (
  ctx: Ctx,
  archetype: RoleArchetype,
) => Promise<{ records: { type: string; id: string }[]; content: string }>;

export type ResolvedForAgent = { ctx: Ctx; archetype: RoleArchetype };

export type AgentDeps = {
  /** Server-side session + membership resolution. String = denial reason. */
  resolve: (
    orgId: string,
  ) => Promise<ResolvedForAgent | "no_session" | "no_membership" | "mfa_required">;
  agentsEnabled: (ctx: Ctx) => Promise<boolean>;
  /** Server-resolved locale (cookie) — request input never chooses it. */
  locale: () => Promise<string>;
  provider: AgentProvider;
  providerTimeoutMs?: number;
  toolHandlers: Partial<Record<AgentToolId, AgentToolHandler>>;
  loadApproval: (ctx: Ctx, approvalRef: string) => Promise<ApprovalBinding | null>;
  /** Immutable audit write (command path in production). */
  audit: (ctx: Ctx, record: AgentAuditRecord) => Promise<void>;
};

export async function runAgentCore(deps: AgentDeps, rawRequest: unknown): Promise<AgentResult> {
  const correlationId = randomUUID();

  const parsed = AgentRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return { status: "denied", correlationId, reason: "unknown_agent", escalation: null };
  }
  const request: AgentRequest = parsed.data;

  // 1) Server-side identity. Nothing from the request influences WHO acts.
  const resolved = await deps.resolve(request.orgId);
  if (resolved === "no_session") {
    return { status: "denied", correlationId, reason: "unauthenticated", escalation: null };
  }
  if (resolved === "no_membership") {
    return { status: "denied", correlationId, reason: "no_membership", escalation: null };
  }
  if (resolved === "mfa_required") {
    return { status: "denied", correlationId, reason: "mfa_required", escalation: null };
  }
  const { ctx, archetype } = resolved;

  const auditAndReturn = async (
    result: AgentResult,
    extras: Partial<AgentAuditRecord> = {},
  ): Promise<AgentResult> => {
    await deps.audit(ctx, {
      correlationId,
      agentId: String(request.agentId),
      classification: request.classification ?? "read_explain",
      status: result.status,
      reason: result.status === "ok" ? undefined : result.reason,
      consultedTools: [],
      citations: 0,
      proposedActions: 0,
      approvalState: request.approvalRef ? "attached" : "none_required",
      ...extras,
    });
    return result;
  };

  // 2) Fail closed on the server-authoritative feature gate.
  if (!(await deps.agentsEnabled(ctx))) {
    return auditAndReturn({
      status: "denied",
      correlationId,
      reason: "feature_disabled",
      escalation: null,
    });
  }

  // 3) Agent + classification + approval validation.
  if (!isAgentId(request.agentId)) {
    return auditAndReturn({
      status: "denied",
      correlationId,
      reason: "unknown_agent",
      escalation: null,
    });
  }
  const agentId: AgentId = request.agentId;
  const classification = request.classification ?? "read_explain";
  if (classification === "prohibited") {
    return auditAndReturn({
      status: "denied",
      correlationId,
      reason: "prohibited",
      escalation: null,
    });
  }
  if (classification === "execute_after_approval") {
    if (!request.approvalRef) {
      return auditAndReturn(
        {
          status: "denied",
          correlationId,
          reason: "approval_required",
          escalation: "A person with the required permission must approve this action first.",
        },
        { approvalState: "required_missing" },
      );
    }
    const approval = await deps.loadApproval(ctx, request.approvalRef);
    const binding = approval ? validateApprovalBinding(ctx, approval) : null;
    if (!approval || !binding || !binding.ok) {
      return auditAndReturn(
        {
          status: "denied",
          correlationId,
          reason: "approval_invalid",
          escalation: "The referenced approval does not authorize this request.",
        },
        { approvalState: "invalid" },
      );
    }
    // A valid binding is still not executable in A1: no execute-class tool
    // exists. The class stays structurally unsupported until it ships.
  }
  if (!A1_SUPPORTED_CLASSES.includes(classification)) {
    return auditAndReturn({
      status: "denied",
      correlationId,
      reason: "unsupported_classification",
      escalation: null,
    });
  }

  // 4) Tools: allow-list ∩ acting user's permissions ∩ registered handlers.
  //    A requested tool outside the allow-list is a hard denial (never a
  //    silent skip); permission/implementation gaps are stated, not hidden.
  const allow = AGENT_TOOL_ALLOW[agentId];
  const requested = request.toolIds ?? [...allow];
  const withheld: { tool: string; reason: "not_allowed" | "no_permission" | "not_implemented" }[] =
    [];
  const usable: AgentToolId[] = [];
  for (const toolId of requested) {
    if (!isAgentToolId(toolId) || !allow.includes(toolId)) {
      return auditAndReturn({
        status: "denied",
        correlationId,
        reason: "tool_not_allowed",
        escalation: null,
      });
    }
    if (!can(archetype, AGENT_TOOLS[toolId].action)) {
      withheld.push({ tool: toolId, reason: "no_permission" });
      continue;
    }
    if (!deps.toolHandlers[toolId]) {
      withheld.push({ tool: toolId, reason: "not_implemented" });
      continue;
    }
    usable.push(toolId);
  }

  // 5) Run tools (org-scoped ctx flows into every handler → RLS applies) and
  //    assemble the secret-free, boundary-labelled provider request.
  const blocks: UntrustedBlock[] = [];
  const consulted: { tool: AgentToolId; records: { type: string; id: string }[] }[] = [];
  for (const toolId of usable) {
    try {
      const out = await deps.toolHandlers[toolId]!(ctx, archetype);
      blocks.push(untrustedBlock(toolId, out.records, out.content));
      consulted.push({ tool: toolId, records: out.records });
    } catch {
      return auditAndReturn(
        { status: "failed", correlationId, reason: "tool_failed", escalation: null },
        { consultedTools: consulted.map((c) => c.tool) },
      );
    }
  }

  const locale = normalizeLocale(await deps.locale());
  let providerRequest;
  try {
    providerRequest = buildProviderRequest({
      agentId,
      correlationId,
      locale,
      input: request.input,
      blocks,
    });
  } catch {
    return auditAndReturn(
      { status: "failed", correlationId, reason: "provider_error", escalation: null },
      { consultedTools: consulted.map((c) => c.tool) },
    );
  }

  let raw: unknown;
  try {
    raw = (
      await callProvider(deps.provider, providerRequest, {
        timeoutMs: deps.providerTimeoutMs,
      })
    ).output;
  } catch (e) {
    const reason =
      e instanceof AgentProviderDisabledError
        ? "provider_disabled"
        : e instanceof AgentProviderTimeoutError
          ? "provider_timeout"
          : "provider_error";
    return auditAndReturn(
      { status: "failed", correlationId, reason, escalation: null },
      { consultedTools: consulted.map((c) => c.tool) },
    );
  }

  // 6) Structural validation + citation ground truth.
  const output = AgentOutputSchema.safeParse(raw);
  if (!output.success) {
    return auditAndReturn(
      { status: "failed", correlationId, reason: "invalid_output", escalation: null },
      { consultedTools: consulted.map((c) => c.tool) },
    );
  }
  if (output.data.confidence !== "high" && !output.data.uncertainty) {
    return auditAndReturn(
      { status: "failed", correlationId, reason: "invalid_output", escalation: null },
      { consultedTools: consulted.map((c) => c.tool) },
    );
  }
  const known = new Set(consulted.flatMap((c) => c.records.map((r) => `${r.type}:${r.id}`)));
  for (const cite of output.data.citations) {
    if (!known.has(`${cite.type}:${cite.id}`)) {
      return auditAndReturn(
        { status: "failed", correlationId, reason: "fabricated_citation", escalation: null },
        { consultedTools: consulted.map((c) => c.tool), citations: output.data.citations.length },
      );
    }
  }

  const result: AgentResult = {
    status: "ok",
    correlationId,
    agentId,
    locale,
    output: {
      ...output.data,
      // Server law: any non-read proposal requires human approval. The
      // model's opinion on this is ignored.
      proposedActions: output.data.proposedActions.map((a) => ({
        ...a,
        approvalRequired: a.classification !== "read_explain",
      })),
    },
    consulted,
    withheldTools: withheld,
    escalation: null,
  };

  return auditAndReturn(result, {
    consultedTools: consulted.map((c) => c.tool),
    citations: output.data.citations.length,
    proposedActions: output.data.proposedActions.length,
  });
}

/** Production wiring — every dependency is the existing platform system. */
export async function runAgent(rawRequest: unknown): Promise<AgentResult> {
  const { resolveCtx } = await import("@/platform/auth/resolve");
  const { getServerLocale } = await import("@/platform/i18n/server");
  const { command } = await import("@/platform/audit");
  return runAgentCore(
    {
      resolve: async (orgId) => {
        const r = await resolveCtx(orgId);
        if (typeof r === "string") {
          return r === "no_session"
            ? "no_session"
            : r === "mfa_required"
              ? "mfa_required"
              : "no_membership";
        }
        return { ctx: r.ctx, archetype: r.archetype };
      },
      agentsEnabled,
      locale: getServerLocale,
      provider: getAgentProvider(),
      toolHandlers: {}, // A1: no production tool handlers ship yet (H13+)
      loadApproval: async () => null, // execute path ships with its approval subject
      audit: async (ctx, record) =>
        void (await command(
          ctx,
          {
            audit: {
              action: "agent.run",
              entityType: "agent",
              entityId: record.correlationId,
              summary: JSON.stringify(record).slice(0, 2000),
            },
          },
          async () => null,
        )),
    },
    rawRequest,
  );
}
