"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/platform/ui";

/**
 * H13: the agent showcase — the first section after the hero. One command
 * room: the Manager Agent leads at the center, the nine specialists stand
 * around it in their business domains, and everything visibly shares one
 * business record. Evidence ("grounded in your records") and human approval
 * ("you approve important actions") are stated on the room itself.
 *
 * The ten agents are EXACTLY the canonical registry set
 * (src/platform/agents/registry AGENT_IDS) — asserted by test. All copy
 * arrives pre-resolved from the server; this island only holds which agent's
 * detail panel is open.
 *
 * Portrait system: photographic portraits are specified in
 * docs/design/AGENT_PORTRAIT_SYSTEM.md and are NOT yet produced (no image
 * generation in this environment). Until the commissioned assets land in
 * /public/agents/, each agent renders its designed interim identity: an
 * editorial monogram tile on the agent's own tone from one coherent palette,
 * with the shared material texture. This is a deliberate identity system,
 * not an icon substitution; the swap point is PORTRAIT_ASSETS below.
 *
 * Accessibility: every card is a real button (aria-expanded/aria-controls)
 * opening one shared detail region; name and responsibility are always
 * visible (nothing essential is hover-only); targets are 44px+; static
 * markup otherwise, so reduced motion needs no special path.
 */

export type AgentVM = {
  id: string;
  name: string;
  role: string;
  outcome: string;
  question: string;
  monogram: string;
  icon: IconName;
  /** Deep editorial tone + monogram ink for the interim portrait tile. */
  tone: { bg: string; ink: string };
};

/** Commissioned photographic assets (see the portrait system doc). All null
 * until produced; setting a path swaps the tile to the real portrait. */
export const PORTRAIT_ASSETS: Record<string, string | null> = {
  manager: null,
  executive: null,
  operations: null,
  project: null,
  sales_crm: null,
  accounting: null,
  finance: null,
  people_payroll: null,
  inventory_purchasing: null,
  planning_analytics: null,
};

function Portrait({ agent, size }: { agent: AgentVM; size: "lg" | "md" }) {
  const asset = PORTRAIT_ASSETS[agent.id] ?? null;
  if (asset) {
    // The commissioned photograph: cover-cropped into the same tile, with the
    // same domain-icon chip. Decorative — name and role are adjacent text.
    return (
      <span
        aria-hidden="true"
        className={
          "relative flex shrink-0 overflow-hidden rounded-xl " +
          (size === "lg" ? "size-20 sm:size-24" : "size-12")
        }
        style={{ background: agent.tone.bg }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size decorative tile */}
        <img src={asset} alt="" className="absolute inset-0 size-full object-cover" />
        <span
          className={
            "absolute flex items-center justify-center rounded-md " +
            (size === "lg" ? "bottom-2 end-2 size-6" : "bottom-1 end-1 size-5")
          }
          style={{ background: "rgb(0 0 0 / 0.35)", color: agent.tone.ink }}
        >
          <Icon name={agent.icon} size={size === "lg" ? 13 : 11} aria-hidden />
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl " +
        (size === "lg" ? "size-20 sm:size-24" : "size-12")
      }
      style={{
        background: `linear-gradient(170deg, ${agent.tone.bg} 0%, color-mix(in srgb, ${agent.tone.bg} 78%, black) 100%)`,
        boxShadow:
          "inset 0 1px 0 rgb(255 255 255 / 0.18), inset 0 -10px 18px -12px rgb(0 0 0 / 0.45)",
      }}
    >
      <span
        className="absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(180deg, transparent 0 9px, rgb(255 255 255 / 0.035) 9px 10px)",
        }}
      />
      <span
        className={
          "relative font-semibold tracking-tight " +
          (size === "lg" ? "text-3xl sm:text-4xl" : "text-lg")
        }
        style={{ color: agent.tone.ink }}
      >
        {agent.monogram}
      </span>
      <span
        className={
          "absolute flex items-center justify-center rounded-md " +
          (size === "lg" ? "bottom-2 end-2 size-6" : "bottom-1 end-1 size-5")
        }
        style={{ background: "rgb(255 255 255 / 0.14)", color: agent.tone.ink }}
      >
        <Icon name={agent.icon} size={size === "lg" ? 13 : 11} aria-hidden />
      </span>
    </span>
  );
}

function DetailBody({ agent, labels }: { agent: AgentVM; labels: Labels }) {
  return (
    <div>
      <p className="text-sm leading-relaxed text-ink">{agent.outcome}</p>
      <p className="mt-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {labels.ask}
      </p>
      <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{agent.question}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
          <Icon name="clipboard" size={11} aria-hidden className="shrink-0 text-brand" />
          {labels.evidence}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
          <Icon name="check" size={11} aria-hidden className="shrink-0 text-success" />
          {labels.approval}
        </span>
      </div>
    </div>
  );
}

type Labels = { evidence: string; approval: string; record: string; ask: string };

export function AgentShowcase({
  manager,
  specialists,
  labels,
}: {
  manager: AgentVM;
  specialists: AgentVM[];
  labels: Labels;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = specialists.find((a) => a.id === openId) ?? null;

  return (
    <div className="mx-auto mt-10 max-w-5xl">
      {/* ── The Manager Agent: the center of the command room ────────────── */}
      <div
        className="relative overflow-hidden rounded-2xl border p-5 sm:p-6"
        style={{
          borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
          background:
            "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
          boxShadow:
            "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
        }}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
          <Portrait agent={manager} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-ink">{manager.name}</h3>
            <p className="mt-0.5 text-sm text-ink-secondary">{manager.role}</p>
            <div className="mt-3">
              <DetailBody agent={manager} labels={labels} />
            </div>
          </div>
        </div>
      </div>

      {/* The shared record rail: every specialist stands on the same record. */}
      <div className="mx-auto flex w-fit items-center gap-2 py-3" aria-hidden="true">
        <span
          className="h-6 w-0.5 rounded-full"
          style={{ background: "color-mix(in srgb, var(--accent) 45%, var(--border-strong))" }}
        />
      </div>
      <p className="mx-auto flex w-fit items-center gap-2 rounded-full border border-line bg-card px-4 py-2 text-sm font-medium text-ink">
        <Icon name="grid" size={14} aria-hidden className="shrink-0 text-brand" />
        {labels.record}
      </p>

      {/* ── The specialists, standing around the shared record ───────────── */}
      <ul className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {specialists.map((a) => {
          const isOpen = openId === a.id;
          return (
            <li key={a.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls="agent-detail"
                onClick={() => setOpenId(isOpen ? null : a.id)}
                className={
                  "flex min-h-11 w-full items-center gap-3 rounded-xl border p-3 text-start " +
                  (isOpen
                    ? "border-brand/60 bg-card shadow-pop"
                    : "border-line bg-card shadow-card hover:bg-page")
                }
              >
                <Portrait agent={a} size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{a.name}</span>
                  <span className="block truncate text-xs text-ink-secondary">{a.role}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* One shared, keyboard-reachable detail region below the room. */}
      <div id="agent-detail" role="region" aria-live="polite" className="mt-3">
        {open ? (
          <div className="rounded-xl border border-brand/40 bg-card p-4 shadow-card sm:p-5">
            <div className="flex items-start gap-4">
              <Portrait agent={open} size="md" />
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-ink">{open.name}</h3>
                <p className="mt-0.5 text-xs text-ink-secondary">{open.role}</p>
                <div className="mt-3">
                  <DetailBody agent={open} labels={labels} />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
