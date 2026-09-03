/**
 * H28 — shared shapes of the Idara module: record references, evidence,
 * structured output blocks, run and action states. Kept free of database
 * code so the dock, the run engine and the tests share one vocabulary.
 */
import type { AgentId } from "@/platform/agents/registry";

export type RecordRef = { type: string; id: string; label?: string; href?: string };

export type EvidenceItem = RecordRef & {
  field?: string;
  value?: string;
  date?: string;
};

export type ResultKind = "answer" | "suggestion" | "draft" | "proposed_action" | "refusal";

export type OutputBlock =
  | { kind: "text"; text: string }
  | { kind: "evidence"; items: EvidenceItem[] }
  | {
      kind: "facts";
      facts: string[];
      calculations: string[];
      assumptions: string[];
      gaps: string[];
      method?: string;
    }
  | { kind: "table"; title?: string; columns: string[]; rows: string[][] }
  | {
      kind: "comparison";
      title?: string;
      left: { label: string; ref?: RecordRef };
      right: { label: string; ref?: RecordRef };
      rows: { field: string; left: string; right: string; differs: boolean }[];
    }
  | { kind: "timeline"; items: { date: string; label: string; ref?: RecordRef }[] }
  | {
      kind: "chart";
      title?: string;
      type: "bar" | "line";
      labels: string[];
      series: { name: string; values: number[] }[];
    }
  | {
      kind: "actions";
      actions: {
        actionId: string;
        title: string;
        riskClass: number;
        status: string;
        toolId: string;
      }[];
    }
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string; ownerAction?: string };

export type Provenance = {
  answeredBy: AgentId;
  contributors: AgentId[];
  provider: string | null;
  model: string | null;
  resultKind: ResultKind;
  generated: boolean;
  generatedAt: string;
};

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "cancelled",
  "completed",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_KINDS = ["interactive", "background", "schedule", "delegation", "eval"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const STEP_KINDS = [
  "plan",
  "route",
  "tool",
  "model",
  "delegate",
  "approval",
  "note",
  "flag",
  "action",
  "memory",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const ACTION_STATUSES = [
  "proposed",
  "confirmed",
  "awaiting_approval",
  "approved",
  "executing",
  "executed",
  "failed",
  "refused_drift",
  "cancelled",
  "expired",
  "rejected",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export type ToolRiskClass = 1 | 2 | 3 | 4 | 5;

export type ActionPreview = {
  what: string;
  records: RecordRef[];
  changes: { field: string; from: string | null; to: string | null }[];
  permission: string;
  external: string[];
  estCredits: number;
  reversible: boolean;
  sideEffects: string[];
};

export type RecordVersion = { type: string; id: string; version: string };

/** Bounds every run obeys (ADR-56/60). */
export const RUN_LIMITS = {
  maxDepth: 2,
  maxChildrenPerRun: 4,
  maxToolCallsPerRun: 12,
  maxToolCallsPerRoot: 40,
  maxModelCallsPerRun: 6,
  maxContextRefs: 12,
  maxInputChars: 8_000,
  interactiveBudgetMs: 90_000,
} as const;
