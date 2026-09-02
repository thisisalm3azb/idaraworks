"use client";

/**
 * H25G — the scenario laboratory panel.
 *
 * Live mode lists the plan's scenarios and branches a new one. With a
 * scenario active it shows what the scenario changes (from → to, with drift
 * against the live plan), what those changes do to the schedule, the
 * assumption register, the decision record, a reproducible Monte Carlo run,
 * and the lifecycle actions. Nothing here edits the live plan: edits go
 * through the same inspector/views with the scenario overlay; applying is a
 * separate, separately permitted command that refuses on drift.
 */
import { useState, useTransition } from "react";
import type { ActionResult, SimulationDto } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

const CONFIDENCES = ["low", "medium", "high"] as const;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function ScenarioPanel({
  payload,
  dict,
  actions,
  settle,
  onOpen,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
  onOpen: (scenarioId: string | null) => void;
}) {
  const d = dict.scenario;
  const [pending, start] = useTransition();
  const [newName, setNewName] = useState("");
  const [assumption, setAssumption] = useState("");
  const [confidence, setConfidence] = useState<(typeof CONFIDENCES)[number]>("medium");
  const [samples, setSamples] = useState("1000");
  const [sim, setSim] = useState<SimulationDto | null>(null);
  const active = payload.scenario;
  const [decisionFor, setDecisionFor] = useState<string | null>(active?.scenario.id ?? null);
  const [decision, setDecision] = useState<Record<string, string>>(() => ({
    question: active?.scenario.decision.question ?? "",
    recommendation: active?.scenario.decision.recommendation ?? "",
    decision: active?.scenario.decision.decision ?? "",
    rationale: active?.scenario.decision.rationale ?? "",
  }));
  if ((active?.scenario.id ?? null) !== decisionFor) {
    setDecisionFor(active?.scenario.id ?? null);
    setDecision({
      question: active?.scenario.decision.question ?? "",
      recommendation: active?.scenario.decision.recommendation ?? "",
      decision: active?.scenario.decision.decision ?? "",
      rationale: active?.scenario.decision.rationale ?? "",
    });
    setSim(null);
  }

  const titleOf = (nodeId: string) =>
    payload.nodes.find((n) => n.id === nodeId)?.title ?? nodeId.slice(0, 8);

  // ── live mode: the list ────────────────────────────────────────────────────
  if (!active) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">{d.title}</h2>
        <p className="text-xs text-ink-muted">{d.branch_hint}</p>
        {payload.scenarios.length === 0 ? null : (
          <ul className="flex flex-col gap-1">
            {payload.scenarios.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="flex min-h-10 w-full items-center justify-between gap-2 rounded-md border border-line px-2 text-start text-sm text-ink hover:bg-sunken"
                >
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 rounded-full bg-sunken px-2 text-[11px] text-ink-muted">
                    {d[`status_${s.status}`]} · {s.changeCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {payload.canManageScenario ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              start(async () => {
                const res = await actions.createScenario({ planId: payload.planId, name });
                if (settle(res) && res.ok) {
                  setNewName("");
                  onOpen(res.data.id);
                }
              });
            }}
          >
            <label className="text-xs text-ink-muted">
              {d.name}
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                maxLength={200}
              />
            </label>
            <button
              type="submit"
              disabled={pending || !newName.trim()}
              className="min-h-10 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {d.new}
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  // ── scenario mode ──────────────────────────────────────────────────────────
  const s = active.scenario;
  const editable = s.status === "draft" || s.status === "under_review";
  const shown: SimulationDto | null =
    sim ??
    (s.simulation
      ? {
          ok: true,
          seed: s.simulation.seed,
          samples: s.simulation.samples,
          projectStart: "",
          deterministicFinish: s.simulation.deterministicFinish,
          deterministicDurationDays: 0,
          finish: s.simulation.finish,
          durationDays: { p50: 0, p80: 0, p90: 0, mean: 0, min: 0, max: 0 },
          confidenceInDeterministic: s.simulation.confidenceInDeterministic,
          criticality: s.simulation.criticality,
          finishByNode: {},
          failedSamples: 0,
          warnings: s.simulation.warnings,
        }
      : null);

  function saveAssumptions(next: Array<{ text: string; confidence: string; owner?: string }>) {
    start(async () => {
      const res = await actions.updateScenario({
        scenarioId: s.id,
        expectedRowVersion: s.rowVersion,
        assumptions: next,
      });
      settle(res);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">{d.active}</span>
          <button
            type="button"
            onClick={() => onOpen(null)}
            className="min-h-8 rounded-md border border-line px-2 text-xs text-ink"
          >
            {d.live}
          </button>
        </div>
        <h2 className="text-sm font-semibold text-ink">{s.name}</h2>
        <span className="w-fit rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
          {d[`status_${s.status}`]}
          {s.appliedAt ? ` · ${s.appliedAt.slice(0, 10)}` : ""}
        </span>
      </header>

      {/* Changes */}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-ink">
          {d.changes} ({active.changes.length})
        </h3>
        {active.changes.length === 0 ? (
          <p className="text-xs text-ink-muted">{d.no_changes}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {active.changes.map((c) => (
              <li
                key={c.id}
                className={`rounded-md border px-2 py-1 text-xs ${
                  c.drifted ? "border-warning bg-warning-soft" : "border-line"
                }`}
              >
                <span className="block truncate font-medium text-ink">{c.title}</span>
                <span className="block text-ink-muted" dir="ltr">
                  {c.field}: {fmt(c.oldValue)} → {fmt(c.newValue)}
                </span>
                {c.drifted ? (
                  <span className="block text-warning">
                    {d.drifted} ({fmt(c.liveValue)})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Schedule impact */}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-ink">{d.schedule}</h3>
        <dl className="grid grid-cols-2 gap-x-2 text-xs">
          <dt className="text-ink-muted">{d.finish_live}</dt>
          <dd className="text-ink" dir="ltr">
            {active.schedule.live.projectFinish ?? "∅"}
          </dd>
          <dt className="text-ink-muted">{d.finish_scenario}</dt>
          <dd className="text-ink" dir="ltr">
            {active.schedule.scenario.projectFinish ?? "∅"}
          </dd>
        </dl>
        <p
          className={`text-xs ${
            (active.schedule.finishDeltaDays ?? 0) > 0
              ? "text-danger"
              : (active.schedule.finishDeltaDays ?? 0) < 0
                ? "text-success"
                : "text-ink-muted"
          }`}
        >
          {active.schedule.finishDeltaDays
            ? (d.delta_days ?? "").replace(
                "{days}",
                `${active.schedule.finishDeltaDays > 0 ? "+" : ""}${active.schedule.finishDeltaDays}`,
              )
            : d.no_delta}
        </p>
        {active.schedule.nodes.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-[11px] text-ink-muted">
            {active.schedule.nodes.slice(0, 8).map((n) => (
              <li key={n.nodeId} className="flex justify-between gap-2">
                <span className="truncate text-ink">{n.title}</span>
                <span dir="ltr" className="shrink-0">
                  {n.deltaDays !== null && n.deltaDays !== 0
                    ? `${n.deltaDays > 0 ? "+" : ""}${n.deltaDays}d`
                    : ""}
                  {n.liveCritical !== n.scenarioCritical
                    ? n.scenarioCritical
                      ? ` · ${dict.critical}`
                      : " · ok"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Assumptions */}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-ink">{d.assumptions}</h3>
        <ul className="flex flex-col gap-1">
          {s.assumptions.map((a, i) => (
            <li
              key={`${i}-${a.text}`}
              className="flex items-start justify-between gap-2 rounded-md border border-line px-2 py-1 text-xs"
            >
              <span>
                <span className="block text-ink">{a.text}</span>
                <span className="block text-ink-muted">{d[`confidence_${a.confidence}`]}</span>
              </span>
              {editable && payload.canManageScenario ? (
                <button
                  type="button"
                  aria-label={dict.remove}
                  onClick={() => saveAssumptions(s.assumptions.filter((_, j) => j !== i))}
                  className="min-h-6 min-w-6 rounded text-ink-muted hover:text-danger"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {editable && payload.canManageScenario ? (
          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const text = assumption.trim();
              if (!text) return;
              saveAssumptions([...s.assumptions, { text, confidence }]);
              setAssumption("");
            }}
          >
            <input
              value={assumption}
              onChange={(e) => setAssumption(e.target.value)}
              placeholder={d.assumption_add}
              maxLength={500}
              className="min-h-9 w-full rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
            />
            <div className="flex gap-1">
              <select
                value={confidence}
                onChange={(e) => setConfidence(e.target.value as (typeof CONFIDENCES)[number])}
                className="min-h-9 flex-1 rounded-md border border-line bg-card px-1 text-xs text-ink"
              >
                {CONFIDENCES.map((c) => (
                  <option key={c} value={c}>
                    {d[`confidence_${c}`]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={pending || !assumption.trim()}
                className="min-h-9 rounded-md border border-line px-2 text-xs text-ink disabled:opacity-50"
              >
                {d.assumption_add}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {/* Monte Carlo */}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-ink">{d.simulation}</h3>
        {payload.canSchedule ? (
          <form
            className="flex items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const res = await actions.simulate({
                  planId: payload.planId,
                  scenarioId: s.id,
                  samples: Number(samples) || 1000,
                });
                if (res.ok) setSim(res.data);
                else settle(res);
              });
            }}
          >
            <label className="text-[11px] text-ink-muted">
              {d.samples}
              <input
                type="number"
                min={100}
                max={5000}
                step={100}
                value={samples}
                onChange={(e) => setSamples(e.target.value)}
                className="mt-0.5 block min-h-9 w-24 rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={pending}
              className="min-h-9 rounded-md border border-line px-2 text-xs text-ink disabled:opacity-50"
            >
              {d.simulate}
            </button>
          </form>
        ) : null}
        {shown ? (
          shown.ok ? (
            <div className="flex flex-col gap-1 rounded-md border border-line px-2 py-1 text-xs">
              <dl className="grid grid-cols-2 gap-x-2" dir="ltr">
                <dt className="text-ink-muted">{d.plan_date}</dt>
                <dd className="text-ink">{shown.deterministicFinish}</dd>
                <dt className="text-ink-muted">P50</dt>
                <dd className="text-ink">{shown.finish.p50}</dd>
                <dt className="text-ink-muted">P80</dt>
                <dd className="text-ink">{shown.finish.p80}</dd>
                <dt className="text-ink-muted">P90</dt>
                <dd className="text-ink">{shown.finish.p90}</dd>
                <dt className="text-ink-muted">{d.confidence}</dt>
                <dd className="font-medium text-ink">{pct(shown.confidenceInDeterministic)}</dd>
              </dl>
              <p className="text-[11px] text-ink-muted">{d.forecast_note}</p>
              <p className="text-[11px] text-ink-muted" dir="ltr">
                {(d.ran ?? "")
                  .replace("{samples}", String(shown.samples))
                  .replace("{seed}", String(shown.seed))}
              </p>
              {Object.keys(shown.criticality).length > 0 ? (
                <ul className="text-[11px]">
                  <li className="text-ink-muted">{d.criticality}</li>
                  {Object.entries(shown.criticality)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([id, v]) => (
                      <li key={id} className="flex justify-between gap-2">
                        <span className="truncate text-ink">{titleOf(id)}</span>
                        <span className="text-ink-muted">{pct(v)}</span>
                      </li>
                    ))}
                </ul>
              ) : null}
              {shown.warnings.map((w) => (
                <p key={w} className="text-[11px] text-warning">
                  {w}
                </p>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-warning bg-warning-soft px-2 py-1 text-xs text-warning">
              <p>{shown.reason === "insufficient_estimates" ? d.insufficient : shown.reason}</p>
              {shown.missing.length > 0 ? (
                <ul className="list-disc ps-4">
                  {shown.missing.slice(0, 10).map((id) => (
                    <li key={id}>{titleOf(id)}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      {/* Decision record */}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-ink">{d.decision}</h3>
        {(["question", "recommendation", "decision", "rationale"] as const).map((k) => (
          <label key={k} className="text-[11px] text-ink-muted">
            {d[`decision_${k}`]}
            <textarea
              value={decision[k] ?? ""}
              onChange={(e) => setDecision({ ...decision, [k]: e.target.value })}
              disabled={!payload.canManageScenario || s.status === "discarded"}
              rows={k === "question" ? 1 : 2}
              className="mt-0.5 block w-full rounded-md border border-line-strong bg-card px-2 py-1 text-xs text-ink disabled:opacity-60"
            />
          </label>
        ))}
        {payload.canManageScenario && s.status !== "discarded" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await actions.updateScenario({
                  scenarioId: s.id,
                  expectedRowVersion: s.rowVersion,
                  decision: Object.fromEntries(
                    Object.entries(decision).map(([k, v]) => [k, v.trim() || undefined]),
                  ),
                });
                settle(res);
              })
            }
            className="min-h-9 w-fit rounded-md border border-line px-3 text-xs text-ink disabled:opacity-50"
          >
            {dict.save}
          </button>
        ) : null}
      </section>

      {/* Lifecycle */}
      <section className="flex flex-wrap gap-2 border-t border-line pt-3">
        {s.status === "draft" && payload.canManageScenario ? (
          <button
            type="button"
            disabled={pending || active.changes.length === 0}
            onClick={() =>
              start(async () => {
                const res = await actions.submitScenario({
                  scenarioId: s.id,
                  expectedRowVersion: s.rowVersion,
                });
                settle(res);
              })
            }
            className="min-h-10 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {d.submit}
          </button>
        ) : null}
        {s.status === "under_review" ? (
          <span className="min-h-10 rounded-md bg-sunken px-3 text-sm leading-10 text-ink-muted">
            {d.awaiting}
          </span>
        ) : null}
        {s.status === "approved" && payload.canApplyScenario ? (
          <button
            type="button"
            disabled={pending || active.changes.some((c) => c.drifted)}
            title={d.apply_hint}
            onClick={() =>
              start(async () => {
                const res = await actions.applyScenario({
                  scenarioId: s.id,
                  expectedRowVersion: s.rowVersion,
                });
                settle(res);
              })
            }
            className="min-h-10 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {d.apply}
          </button>
        ) : null}
        {s.status !== "applied" && s.status !== "discarded" && payload.canManageScenario ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await actions.discardScenario({ scenarioId: s.id });
                settle(res);
              })
            }
            className="min-h-10 rounded-md border border-line px-3 text-sm text-danger disabled:opacity-50"
          >
            {d.discard}
          </button>
        ) : null}
        {s.status === "approved" ? (
          <p className="w-full text-[11px] text-ink-muted">{d.apply_hint}</p>
        ) : null}
      </section>
    </div>
  );
}
