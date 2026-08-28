/**
 * Typed agent contract (H12 / A1) — the structured request and result every
 * agent interaction uses. Facts, assumptions, citations, confidence,
 * proposed actions, approval demands, failure and escalation are SEPARATE,
 * validated fields: a provider response that mixes them is rejected, and a
 * citation that references a record the run did not consult is rejected as
 * fabricated.
 */
import { z } from "zod";
import { ACTION_CLASSES, type ActionClass, type AgentId, type AgentToolId } from "./registry";

/** What the browser may send. Everything else about identity is resolved
 * server-side: org membership, user, role, permissions, locale and allowed
 * tools NEVER come from this shape. Unknown fields are stripped. */
export const AgentRequestSchema = z
  .object({
    orgId: z.string().uuid(),
    agentId: z.string().min(1).max(40),
    input: z.string().trim().min(1).max(4000),
    /** Optional narrowing of the agent's allow-list — never a widening. */
    toolIds: z.array(z.string().max(60)).max(10).optional(),
    /** The action classification the caller requests (default read_explain). */
    classification: z.enum(ACTION_CLASSES).optional(),
    /** Reference to an existing approval for execute-class requests. */
    approvalRef: z.string().uuid().optional(),
  })
  .strip();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** The model-facing output schema: separation is structural. */
export const AgentOutputSchema = z
  .object({
    facts: z.array(z.string().min(1).max(2000)).max(50).default([]),
    calculations: z.array(z.string().min(1).max(2000)).max(50).default([]),
    assumptions: z.array(z.string().min(1).max(2000)).max(50).default([]),
    suggestions: z.array(z.string().min(1).max(2000)).max(50).default([]),
    citations: z
      .array(z.object({ type: z.string().min(1).max(60), id: z.string().min(1).max(80) }))
      .max(100)
      .default([]),
    confidence: z.enum(["high", "medium", "low"]),
    /** What is uncertain and what evidence would resolve it (required when
     * confidence is not high — enforced in the runner). */
    uncertainty: z.string().max(2000).optional(),
    proposedActions: z
      .array(
        z.object({
          classification: z.enum(ACTION_CLASSES),
          description: z.string().min(1).max(2000),
        }),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export type AgentDenialReason =
  | "unauthenticated"
  | "no_membership"
  | "mfa_required"
  | "feature_disabled"
  | "unknown_agent"
  | "unsupported_classification"
  | "prohibited"
  | "approval_required"
  | "approval_invalid"
  | "tool_not_allowed";

export type AgentFailureReason =
  | "provider_disabled"
  | "provider_timeout"
  | "provider_error"
  | "invalid_output"
  | "fabricated_citation"
  | "tool_failed";

export type AgentResult =
  | {
      status: "ok";
      correlationId: string;
      agentId: AgentId;
      locale: "en" | "ar";
      output: AgentOutput & {
        /** Server-computed: every proposed non-read action requires human
         * approval; the model cannot waive this. */
        proposedActions: {
          classification: ActionClass;
          description: string;
          approvalRequired: boolean;
        }[];
      };
      consulted: { tool: AgentToolId; records: { type: string; id: string }[] }[];
      /** Tools the agent could not use, and why — stated, never silent. */
      withheldTools: {
        tool: string;
        reason: "not_allowed" | "no_permission" | "not_implemented";
      }[];
      escalation: null;
    }
  | {
      status: "denied";
      correlationId: string;
      reason: AgentDenialReason;
      /** Where a human with the right permission must take over. */
      escalation: string | null;
    }
  | {
      status: "failed";
      correlationId: string;
      reason: AgentFailureReason;
      escalation: string | null;
    };

/** The immutable audit payload for every agent request that reaches a
 * resolvable organization context (written through the command path). */
export type AgentAuditRecord = {
  correlationId: string;
  agentId: string;
  classification: ActionClass | "unknown";
  status: "ok" | "denied" | "failed";
  reason?: string;
  consultedTools: readonly string[];
  citations: number;
  proposedActions: number;
  approvalState: "none_required" | "required_missing" | "invalid" | "attached";
};
