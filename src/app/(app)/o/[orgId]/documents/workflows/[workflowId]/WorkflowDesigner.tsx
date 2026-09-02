"use client";

/**
 * H26 — the workflow designer: an ordered lane of steps, each with a kind,
 * a mode, assignees, a condition, a due window, escalation and rules. Saved
 * as one definition; runs copy it, so a change here never rewrites a run.
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/platform/ui";
import type { Condition, WorkflowRow, WorkflowStep } from "@/modules/docstudio/service";
import type { ActionResult } from "../../studio-actions";
import { updateWorkflowAction } from "../../studio-actions";

export type DesignerDict = {
  name: string;
  description: string;
  steps: string;
  addStep: string;
  removeStep: string;
  moveUp: string;
  moveDown: string;
  stepName: string;
  stepNameAr: string;
  kind: string;
  kinds: Record<string, string>;
  mode: string;
  sequential: string;
  parallel: string;
  quorum: string;
  assignees: string;
  addAssignee: string;
  assigneeKinds: Record<string, string>;
  archetypeNames: Record<string, string>;
  condition: string;
  conditionNone: string;
  conditionKey: string;
  conditionOp: string;
  conditionValue: string;
  dueDays: string;
  escalateTo: string;
  noEscalation: string;
  allowDelegate: string;
  separationOfDuties: string;
  onReject: string;
  returnToDraft: string;
  stop: string;
  save: string;
  retire: string;
  reactivate: string;
  preview: string;
  previewHint: string;
  saved: string;
  failed: string;
  conflict: string;
  status: Record<string, string>;
  empty: string;
};

type Member = { id: string; name: string; archetype: string };
const input =
  "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
const newStepId = () => `s_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export function WorkflowDesigner({
  orgId,
  locale,
  workflow,
  members,
  archetypes,
  conditionOps,
  dict,
}: {
  orgId: string;
  locale: string;
  workflow: WorkflowRow;
  members: Member[];
  archetypes: string[];
  conditionOps: string[];
  dict: DesignerDict;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow.definition.steps);
  const [rowVersion, setRowVersion] = useState(workflow.rowVersion);
  const [selected, setSelected] = useState<string | null>(workflow.definition.steps[0]?.id ?? null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!notice || notice.tone !== "ok") return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const settle = useCallback(
    (res: ActionResult<unknown>): boolean => {
      if (res.ok) {
        setNotice({ tone: "ok", text: dict.saved });
        startTransition(() => router.refresh());
      } else {
        setNotice({
          tone: "error",
          text: res.code === "conflict" ? dict.conflict : `${dict.failed}: ${res.error}`,
        });
      }
      return res.ok;
    },
    [dict.saved, dict.failed, dict.conflict, router],
  );

  const patch = (id: string, p: Partial<WorkflowStep>) => {
    setSteps((s) => s.map((x) => (x.id === id ? ({ ...x, ...p } as WorkflowStep) : x)));
    setDirty(true);
  };
  const addStep = () => {
    const s: WorkflowStep = {
      id: newStepId(),
      kind: "approval",
      name: { en: "", ar: "" },
      mode: "sequential",
      assignees: [{ type: "archetype", value: "manager" }],
      allowDelegate: true,
      separationOfDuties: true,
      onReject: "return_to_draft",
    };
    setSteps((x) => [...x, s]);
    setSelected(s.id);
    setDirty(true);
  };
  const remove = (id: string) => {
    setSteps((x) => x.filter((s) => s.id !== id));
    if (selected === id) setSelected(null);
    setDirty(true);
  };
  const move = (id: string, delta: number) => {
    setSteps((x) => {
      const i = x.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= x.length) return x;
      const copy = [...x];
      const [s] = copy.splice(i, 1);
      copy.splice(j, 0, s!);
      return copy;
    });
    setDirty(true);
  };

  const save = async (status?: "active" | "retired") => {
    setBusy(true);
    const res = await updateWorkflowAction(orgId, {
      workflowId: workflow.id,
      expectedRowVersion: rowVersion,
      name: name.trim(),
      description: description.trim() || null,
      definition: { version: 1, steps },
      ...(status ? { status } : {}),
    });
    setBusy(false);
    if (res.ok) {
      setRowVersion(res.data.rowVersion);
      setDirty(false);
    }
    settle(res);
  };

  const step = steps.find((s) => s.id === selected) ?? null;
  const leaf = step?.condition && "key" in step.condition ? step.condition : null;
  const label = (s: WorkflowStep) =>
    (locale === "ar" ? s.name.ar || s.name.en : s.name.en || s.name.ar) || s.id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={workflow.status === "active" ? "success" : "neutral"}>
              {dict.status[workflow.status]}
            </Badge>
            {dirty ? <span className="text-xs text-ink-muted">·</span> : null}
          </div>
          <h1 className="text-lg font-semibold text-ink">{workflow.name}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !dirty} onClick={() => save()}>
            {dict.save}
          </Button>
          {workflow.status === "active" ? (
            <Button variant="danger" disabled={busy} onClick={() => save("retired")}>
              {dict.retire}
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => save("active")}>
              {dict.reactivate}
            </Button>
          )}
        </div>
      </div>
      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2 rounded-lg border border-line bg-card p-3 shadow-card sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          {dict.name}
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className={input}
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.description}
          <input
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setDirty(true);
            }}
            className={input}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* The lane */}
        <section className="rounded-lg border border-line bg-card p-3 shadow-card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{dict.steps}</h2>
            <Button variant="secondary" onClick={addStep}>
              + {dict.addStep}
            </Button>
          </div>
          {steps.length === 0 ? <p className="text-sm text-ink-muted">{dict.empty}</p> : null}
          <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
            {steps.map((s, i) => (
              <li
                key={s.id}
                className="flex items-stretch gap-2 sm:w-[calc(50%-0.25rem)] xl:w-[calc(33%-0.33rem)]"
              >
                <button
                  type="button"
                  aria-pressed={selected === s.id}
                  onClick={() => setSelected(s.id)}
                  className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-start ${
                    selected === s.id
                      ? "border-accent-line bg-accent-soft"
                      : "border-line bg-card hover:bg-sunken"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-full bg-sunken font-mono text-[11px] text-ink-secondary">
                      {i + 1}
                    </span>
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                      {dict.kinds[s.kind]}
                    </span>
                    {s.mode === "parallel" ? (
                      <span className="text-[10px] text-ink-muted">{dict.parallel}</span>
                    ) : null}
                  </div>
                  <div className="text-sm font-medium text-ink">{label(s)}</div>
                  <div className="text-xs text-ink-secondary">
                    {s.assignees
                      .map((a) =>
                        a.type === "archetype"
                          ? (dict.archetypeNames[a.value] ?? a.value)
                          : a.type === "user"
                            ? (members.find((m) => m.id === a.value)?.name ?? "?")
                            : dict.assigneeKinds[a.type],
                      )
                      .join(", ")}
                  </div>
                  {s.condition ? (
                    <div className="text-[11px] text-ink-muted">{dict.condition}</div>
                  ) : null}
                  {s.dueDays !== undefined ? (
                    <div className="text-[11px] text-ink-muted">
                      {dict.dueDays}: {s.dueDays}
                    </div>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </section>

        {/* The inspector */}
        <aside className="rounded-lg border border-line bg-card p-3 shadow-card">
          {step ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" onClick={() => move(step.id, -1)}>
                  {dict.moveUp}
                </Button>
                <Button variant="ghost" onClick={() => move(step.id, 1)}>
                  {dict.moveDown}
                </Button>
                <Button variant="danger" onClick={() => remove(step.id)}>
                  {dict.removeStep}
                </Button>
              </div>
              <label className="text-xs text-ink-muted">
                {dict.stepName}
                <input
                  value={step.name.en ?? ""}
                  onChange={(e) => patch(step.id, { name: { ...step.name, en: e.target.value } })}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-muted">
                {dict.stepNameAr}
                <input
                  value={step.name.ar ?? ""}
                  dir="rtl"
                  onChange={(e) => patch(step.id, { name: { ...step.name, ar: e.target.value } })}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-muted">
                {dict.kind}
                <select
                  value={step.kind}
                  onChange={(e) => patch(step.id, { kind: e.target.value as WorkflowStep["kind"] })}
                  className={input}
                >
                  {Object.entries(dict.kinds).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              {step.kind !== "signature" ? (
                <>
                  <label className="text-xs text-ink-muted">
                    {dict.mode}
                    <select
                      value={step.mode}
                      onChange={(e) =>
                        patch(step.id, { mode: e.target.value as WorkflowStep["mode"] })
                      }
                      className={input}
                    >
                      <option value="sequential">{dict.sequential}</option>
                      <option value="parallel">{dict.parallel}</option>
                    </select>
                  </label>
                  {step.mode === "parallel" ? (
                    <label className="text-xs text-ink-muted">
                      {dict.quorum}
                      <input
                        type="number"
                        min={1}
                        max={step.assignees.length}
                        value={step.quorum ?? step.assignees.length}
                        onChange={(e) => patch(step.id, { quorum: Number(e.target.value) })}
                        className={input}
                      />
                    </label>
                  ) : null}
                  <fieldset className="rounded-md border border-line p-2">
                    <legend className="px-1 text-xs text-ink-muted">{dict.assignees}</legend>
                    {step.assignees.map((a, i) => (
                      <div key={i} className="mb-1 flex flex-wrap items-end gap-1">
                        <select
                          value={a.type}
                          onChange={(e) => {
                            const type = e.target
                              .value as WorkflowStep["assignees"][number]["type"];
                            const next =
                              type === "archetype"
                                ? { type, value: "manager" as const }
                                : type === "user"
                                  ? { type, value: members[0]?.id ?? "" }
                                  : { type };
                            patch(step.id, {
                              assignees: step.assignees.map((x, j) =>
                                j === i ? (next as WorkflowStep["assignees"][number]) : x,
                              ),
                            });
                          }}
                          className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                        >
                          {Object.entries(dict.assigneeKinds).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        {a.type === "archetype" ? (
                          <select
                            value={a.value}
                            onChange={(e) =>
                              patch(step.id, {
                                assignees: step.assignees.map((x, j) =>
                                  j === i
                                    ? { type: "archetype", value: e.target.value as typeof a.value }
                                    : x,
                                ),
                              })
                            }
                            className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                          >
                            {archetypes.map((x) => (
                              <option key={x} value={x}>
                                {dict.archetypeNames[x] ?? x}
                              </option>
                            ))}
                          </select>
                        ) : a.type === "user" ? (
                          <select
                            value={a.value}
                            onChange={(e) =>
                              patch(step.id, {
                                assignees: step.assignees.map((x, j) =>
                                  j === i ? { type: "user", value: e.target.value } : x,
                                ),
                              })
                            }
                            className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                          >
                            {members.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <button
                          type="button"
                          aria-label={dict.removeStep}
                          disabled={step.assignees.length <= 1}
                          onClick={() =>
                            patch(step.id, { assignees: step.assignees.filter((_, j) => j !== i) })
                          }
                          className="min-h-11 px-2 text-ink-muted hover:text-danger disabled:opacity-40"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patch(step.id, {
                          assignees: [...step.assignees, { type: "archetype", value: "owner" }],
                        })
                      }
                      className="min-h-9 rounded-md border border-line px-2 text-xs text-ink-secondary hover:bg-sunken"
                    >
                      + {dict.addAssignee}
                    </button>
                  </fieldset>
                  <label className="text-xs text-ink-muted">
                    {dict.dueDays}
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={step.dueDays ?? ""}
                      onChange={(e) =>
                        patch(step.id, {
                          dueDays: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                      className={input}
                    />
                  </label>
                  <label className="text-xs text-ink-muted">
                    {dict.escalateTo}
                    <select
                      value={step.escalateTo ?? ""}
                      onChange={(e) =>
                        patch(step.id, {
                          escalateTo: (e.target.value || undefined) as WorkflowStep["escalateTo"],
                        })
                      }
                      className={input}
                    >
                      <option value="">{dict.noEscalation}</option>
                      {archetypes.map((x) => (
                        <option key={x} value={x}>
                          {dict.archetypeNames[x] ?? x}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={step.allowDelegate}
                      onChange={(e) => patch(step.id, { allowDelegate: e.target.checked })}
                    />
                    {dict.allowDelegate}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={step.separationOfDuties}
                      onChange={(e) => patch(step.id, { separationOfDuties: e.target.checked })}
                    />
                    {dict.separationOfDuties}
                  </label>
                  <label className="text-xs text-ink-muted">
                    {dict.onReject}
                    <select
                      value={step.onReject}
                      onChange={(e) =>
                        patch(step.id, { onReject: e.target.value as WorkflowStep["onReject"] })
                      }
                      className={input}
                    >
                      <option value="return_to_draft">{dict.returnToDraft}</option>
                      <option value="stop">{dict.stop}</option>
                    </select>
                  </label>
                </>
              ) : null}
              <fieldset className="rounded-md border border-line p-2">
                <legend className="px-1 text-xs text-ink-muted">{dict.condition}</legend>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={leaf !== null}
                    onChange={(e) =>
                      patch(step.id, {
                        condition: e.target.checked
                          ? { key: "document.amount", op: "gte", value: 50000 }
                          : undefined,
                      })
                    }
                  />
                  {leaf ? dict.condition : dict.conditionNone}
                </label>
                {leaf ? (
                  <div className="mt-1 grid grid-cols-1 gap-1">
                    <label className="text-xs text-ink-muted">
                      {dict.conditionKey}
                      <input
                        list="wf-keys"
                        value={leaf.key}
                        onChange={(e) =>
                          patch(step.id, {
                            condition: { ...leaf, key: e.target.value } as Condition,
                          })
                        }
                        className={input}
                      />
                      <datalist id="wf-keys">
                        {[
                          "document.amount",
                          "document.category",
                          "document.language",
                          "document.counterparty_kind",
                          "document.has_signatures",
                        ].map((k) => (
                          <option key={k} value={k} />
                        ))}
                      </datalist>
                    </label>
                    <label className="text-xs text-ink-muted">
                      {dict.conditionOp}
                      <select
                        value={leaf.op}
                        onChange={(e) =>
                          patch(step.id, {
                            condition: { ...leaf, op: e.target.value } as Condition,
                          })
                        }
                        className={input}
                      >
                        {conditionOps.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-ink-muted">
                      {dict.conditionValue}
                      <input
                        value={
                          Array.isArray(leaf.value)
                            ? leaf.value.join(",")
                            : String(leaf.value ?? "")
                        }
                        onChange={(e) => {
                          const raw = e.target.value;
                          const v =
                            leaf.op === "in"
                              ? raw
                                  .split(",")
                                  .map((x) => x.trim())
                                  .filter(Boolean)
                              : raw !== "" && !Number.isNaN(Number(raw))
                                ? Number(raw)
                                : raw;
                          patch(step.id, { condition: { ...leaf, value: v } as Condition });
                        }}
                        className={input}
                      />
                    </label>
                  </div>
                ) : null}
              </fieldset>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">{dict.previewHint}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
