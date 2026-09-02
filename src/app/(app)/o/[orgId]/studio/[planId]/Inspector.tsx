"use client";

/**
 * H25C — the side inspector: edit the selected node's meaning. Linked-task
 * fields route to the real task through the ONE update path; row versions
 * make simultaneous edits explicit; conversion turns a draft into a record.
 * Form state re-seeds when the selected node changes using React's
 * adjust-state-while-rendering pattern (no effects).
 */
import { useState, useTransition } from "react";
import { Button } from "@/platform/ui";
import type { EffectiveNode } from "@/modules/studio/service";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

const input =
  "mt-1 min-h-10 w-full rounded-md border border-line-strong bg-card px-2 text-sm text-ink";

type Form = {
  title: string;
  description: string;
  startDate: string;
  dueDate: string;
  duration: string;
  status: string;
  priority: string;
};

function seed(node: EffectiveNode): Form {
  return {
    title: node.title,
    description: node.description ?? "",
    startDate: node.startDate ?? "",
    dueDate: node.dueDate ?? "",
    duration: node.durationDays === null ? "" : String(node.durationDays),
    status: node.rawStatus ?? "",
    priority: node.priority,
  };
}

export function Inspector({
  node,
  payload,
  dict,
  actions,
  settle,
  onClose,
}: {
  node: EffectiveNode | null;
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  const [form, setForm] = useState<Form | null>(node ? seed(node) : null);
  // Only fields the person actually typed in are sent on save; everything
  // else follows the server, so a refresh landing mid-edit can neither be
  // overwritten by a stale form nor wipe the person's typing.
  const [dirty, setDirty] = useState<Set<keyof Form>>(() => new Set());
  const sig = node ? `${node.id}:${JSON.stringify(seed(node))}` : null;
  const [seededSig, setSeededSig] = useState<string | null>(sig);
  const [seededFor, setSeededFor] = useState<string | null>(node?.id ?? null);
  const [jobId, setJobId] = useState("");
  const [taskCount, setTaskCount] = useState<number | null>(null);
  if (sig !== seededSig) {
    setSeededSig(sig);
    const fresh = node ? seed(node) : null;
    if (node && form && seededFor === node.id) {
      const merged: Form = { ...(fresh as Form) };
      for (const k of dirty) merged[k] = form[k];
      setForm(merged);
    } else {
      setForm(fresh);
      setDirty(new Set());
      setJobId("");
      setTaskCount(null);
    }
    setSeededFor(node?.id ?? null);
  }

  if (!node || !form) {
    return <p className="text-sm text-ink-muted">{dict.nothingSelected}</p>;
  }
  const current = node;
  const f = form;
  const set = (patch: Partial<Form>) => {
    setForm({ ...f, ...patch });
    const next = new Set(dirty);
    for (const k of Object.keys(patch) as Array<keyof Form>) next.add(k);
    setDirty(next);
  };

  const sched = payload.schedule[current.id];
  const isLinked = current.recordId !== null;
  const isDraftActivity =
    !isLinked && (current.nodeType === "task" || current.nodeType === "milestone");
  const withheld = isLinked && !current.recordVisible;
  const canEdit = payload.canManage && !withheld;

  function save() {
    const changed: Record<string, unknown> = {};
    if (dirty.has("title")) changed.title = f.title.trim() || null;
    if (dirty.has("description")) changed.description = f.description.trim() || null;
    if (dirty.has("startDate")) changed.startDate = f.startDate || null;
    if (dirty.has("dueDate")) changed.dueDate = f.dueDate || null;
    if (dirty.has("duration")) changed.durationDays = f.duration === "" ? null : Number(f.duration);
    if (dirty.has("priority")) changed.priority = f.priority;
    if (!isLinked && dirty.has("status") && f.status) changed.status = f.status;
    if (Object.keys(changed).length === 0) return;
    start(async () => {
      const res = await actions.updateNode({
        nodeId: current.id,
        expectedRowVersion: current.rowVersion,
        ...(payload.scenarioId ? { scenarioId: payload.scenarioId } : {}),
        ...changed,
      });
      if (settle(res)) setDirty(new Set());
    });
  }

  async function chooseJob(id: string) {
    setJobId(id);
    setTaskCount(null);
    if (!id) return;
    const res = await actions.listJobTasks(id);
    if (res.ok) setTaskCount(res.data.length);
  }

  function convert() {
    if (!jobId) return;
    start(async () => {
      const res = await actions.convertNode({ nodeId: current.id, to: "task", jobId });
      settle(res);
    });
  }

  function remove() {
    start(async () => {
      const res = await actions.archiveNode(current.id);
      if (settle(res)) onClose();
    });
  }

  const draftStatusLabel = (s: string) =>
    dict.statuses[
      s === "proposed" ? "planned" : s === "active" ? "active" : s === "done" ? "done" : "dropped"
    ] ?? s;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {dict.nodeTypes[current.nodeType] ?? current.nodeType}
            {isLinked ? ` · ${dict.linked}` : ""}
          </p>
          <h2 className="text-sm font-semibold text-ink">{current.title}</h2>
        </div>
        <button type="button" onClick={onClose} className="min-h-9 px-2 text-sm text-ink-muted">
          ✕
        </button>
      </div>

      {withheld ? <p className="text-xs text-warning">{dict.withheld}</p> : null}
      {current.warnings.map((w) => (
        <p key={w} className="rounded-md bg-warning-soft px-2 py-1 text-xs text-warning">
          {w}
        </p>
      ))}

      {sched ? (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-md bg-sunken p-2 text-xs">
          <dt className="text-ink-muted">{dict.startDate}</dt>
          <dd dir="ltr">{sched.earlyStart}</dd>
          <dt className="text-ink-muted">{dict.dueDate}</dt>
          <dd dir="ltr">{sched.earlyFinish}</dd>
          <dt className="text-ink-muted">{dict.duration}</dt>
          <dd dir="ltr">{sched.durationDays}</dd>
          <dt className="text-ink-muted">float</dt>
          <dd dir="ltr" className={sched.critical ? "font-semibold text-danger" : ""}>
            {sched.totalFloatDays}
            {sched.critical ? ` · ${dict.critical}` : ""}
          </dd>
        </dl>
      ) : null}

      <label className="text-xs text-ink-muted">
        {dict.title}
        <input
          value={f.title}
          onChange={(e) => set({ title: e.target.value })}
          disabled={!canEdit}
          className={input}
        />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.description}
        <textarea
          value={f.description}
          onChange={(e) => set({ description: e.target.value })}
          disabled={!canEdit}
          rows={3}
          className={`${input} min-h-20`}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-ink-muted">
          {dict.startDate}
          <input
            type="date"
            value={f.startDate}
            onChange={(e) => set({ startDate: e.target.value })}
            disabled={!canEdit}
            className={input}
            dir="ltr"
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.dueDate}
          <input
            type="date"
            value={f.dueDate}
            onChange={(e) => set({ dueDate: e.target.value })}
            disabled={!canEdit}
            className={input}
            dir="ltr"
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.duration}
          <input
            type="number"
            min={0}
            max={3650}
            value={f.duration}
            onChange={(e) => set({ duration: e.target.value })}
            disabled={!canEdit}
            className={input}
            dir="ltr"
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.priority}
          <select
            value={f.priority}
            onChange={(e) => set({ priority: e.target.value })}
            disabled={!canEdit}
            className={input}
            dir="ltr"
          >
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {!isLinked ? (
          <label className="text-xs text-ink-muted">
            {dict.status}
            <select
              value={f.status}
              onChange={(e) => set({ status: e.target.value })}
              disabled={!canEdit}
              className={input}
              dir="ltr"
            >
              {["proposed", "active", "done", "dropped"].map((s) => (
                <option key={s} value={s}>
                  {draftStatusLabel(s)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="text-xs text-ink-muted">
            {dict.status}
            <p className="mt-1 min-h-10 rounded-md bg-sunken px-2 py-2 text-sm text-ink">
              {dict.statuses[current.statusCategory] ?? current.statusCategory}
            </p>
          </div>
        )}
      </div>

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={save} disabled={pending}>
            {dict.save}
          </Button>
          <Button type="button" variant="ghost" onClick={remove} disabled={pending}>
            {dict.remove}
          </Button>
        </div>
      ) : null}

      {canEdit && isDraftActivity && payload.jobs.length > 0 ? (
        <div className="rounded-md border border-line p-2">
          <p className="text-xs font-semibold text-ink">{dict.convert}</p>
          <p className="mb-1 text-[11px] text-ink-muted">{dict.convertHint}</p>
          <label className="text-xs text-ink-muted">
            {dict.chooseJob}
            <select
              value={jobId}
              onChange={(e) => chooseJob(e.target.value)}
              className={input}
              dir="ltr"
            >
              <option value="">—</option>
              {payload.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.reference} · {j.name}
                </option>
              ))}
            </select>
          </label>
          {taskCount !== null ? (
            <p className="mt-1 text-[11px] text-ink-muted">
              {taskCount} {dict.chooseTask}
            </p>
          ) : null}
          <Button type="button" variant="secondary" onClick={convert} disabled={pending || !jobId}>
            {dict.convert}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
