"use client";

/**
 * H25M — the review panel: deterministic findings about this plan, each with
 * the fact behind it and ONE explicit next step that runs an ordinary action
 * when the person chooses. The optional narrative comes from the platform's
 * assistant seam and says so when no assistant is provisioned.
 */
import { useState, useTransition } from "react";
import type { Finding, Narrative } from "@/modules/studio/service";
import type { StudioDict } from "./StudioWorkspace";

export function ReviewPanel({
  findings,
  basis,
  dict,
  onOpenView,
  onSelect,
  onOpenScenarios,
  onLevel,
  onSimulate,
  onCaptureBaseline,
  onNarrative,
}: {
  findings: Finding[];
  basis: string[];
  dict: StudioDict;
  onOpenView: (view: string) => void;
  onSelect: (nodeId: string) => void;
  onOpenScenarios: () => void;
  onLevel: () => void;
  onSimulate: () => void;
  onCaptureBaseline: () => void;
  onNarrative: () => Promise<Narrative>;
}) {
  const [pending, start] = useTransition();
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const tone: Record<Finding["severity"], string> = {
    high: "bg-danger-soft text-danger",
    medium: "bg-warning-soft text-warning",
    low: "bg-sunken text-ink-muted",
  };

  const run = (f: Finding) => {
    const a = f.action;
    if (!a) return;
    if (a.kind === "open_view") onOpenView(a.view);
    else if (a.kind === "select") onSelect(a.nodeId);
    else if (a.kind === "open_scenarios") onOpenScenarios();
    else if (a.kind === "level") onLevel();
    else if (a.kind === "simulate") onSimulate();
    else if (a.kind === "capture_baseline") onCaptureBaseline();
  };
  const label = (f: Finding): string => {
    const a = f.action;
    if (!a) return "";
    if (a.kind === "open_view") return dict.views[a.view] ?? a.view;
    if (a.kind === "select") return dict.inspector;
    if (a.kind === "open_scenarios") return dict.scenario.title ?? "";
    if (a.kind === "level") return dict.level;
    if (a.kind === "simulate") return dict.scenario.simulate ?? "";
    return dict.baseline;
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-ink">{dict.review}</h2>
      <p className="text-[11px] text-ink-muted">{basis.join(" · ")}</p>
      {findings.length === 0 ? (
        <p className="rounded-md bg-success-soft px-2 py-1 text-xs text-success">
          {dict.reviewClean}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((f) => (
            <li key={f.key} className="rounded-md border border-line p-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-ink">{f.title}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${tone[f.severity]}`}
                >
                  {dict.severities[f.severity] ?? f.severity}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">{f.detail}</p>
              {f.action ? (
                <button
                  type="button"
                  onClick={() => run(f)}
                  className="mt-1 min-h-8 rounded-md border border-line px-2 text-[11px] text-ink"
                >
                  {label(f)} →
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <section className="border-t border-line pt-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setNarrative(await onNarrative());
            })
          }
          className="min-h-9 rounded-md border border-line px-2 text-xs text-ink disabled:opacity-50"
        >
          {dict.narrative}
        </button>
        {narrative ? (
          narrative.available ? (
            <p className="mt-2 whitespace-pre-wrap rounded-md bg-sunken p-2 text-xs text-ink">
              {narrative.text}
              <span className="mt-1 block text-[10px] text-ink-muted">{narrative.provider}</span>
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-ink-muted">
              {dict.narrativeUnavailable}: {narrative.reason}
            </p>
          )
        ) : null}
        <p className="mt-1 text-[10px] text-ink-muted">{dict.reviewLaw}</p>
      </section>
    </div>
  );
}
