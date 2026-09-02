"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { RunRow } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import { decideReviewStepAction, delegateStepAction } from "../studio-actions";

export type WorkflowDict = {
  title: string;
  none: string;
  noneHint: string;
  run: Record<string, string>;
  step: Record<string, string>;
  kinds: Record<string, string>;
  started: string;
  finished: string;
  outcome: string;
  assignee: string;
  due: string;
  overdue: string;
  decidedBy: string;
  approve: string;
  reject: string;
  note: string;
  delegate: string;
  delegateTo: string;
  inInbox: string;
  openInbox: string;
  archetypeNames: Record<string, string>;
};

export function WorkflowPane({
  orgId,
  run,
  members,
  currentUserId,
  currentArchetype,
  canReview,
  locale,
  dict,
  settle,
}: {
  orgId: string;
  run: RunRow | null;
  members: Array<{ id: string; name: string }>;
  currentUserId: string;
  currentArchetype: string;
  canReview: boolean;
  locale: string;
  dict: WorkflowDict;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
}) {
  const [note, setNote] = useState("");
  const [delegateTo, setDelegateTo] = useState("");
  const [busy, setBusy] = useState(false);
  const l = locale as "en" | "ar";
  if (!run) {
    return (
      <div className="rounded-lg border border-line bg-card p-4 shadow-card">
        <h2 className="text-sm font-semibold text-ink">{dict.none}</h2>
        <p className="text-sm text-ink-muted">{dict.noneHint}</p>
      </div>
    );
  }
  const stepName = (i: number) => {
    const s = run.definition.steps[i];
    return (l === "ar" ? s?.name.ar || s?.name.en : s?.name.en || s?.name.ar) || s?.id || "";
  };
  const who = (id: string | null, archetype: string | null) =>
    id
      ? (members.find((m) => m.id === id)?.name ?? id.slice(0, 8))
      : archetype
        ? (dict.archetypeNames[archetype] ?? archetype)
        : "";
  const tone = (s: string) =>
    s === "completed"
      ? "success"
      : s === "rejected"
        ? "danger"
        : s === "active"
          ? "warning"
          : "neutral";
  const mayAct = (st: RunRow["steps"][number]) =>
    canReview &&
    st.status === "active" &&
    st.kind === "review" &&
    run.startedBy !== currentUserId &&
    (st.assigneeUserId
      ? st.assigneeUserId === currentUserId
      : st.assigneeArchetype === currentArchetype ||
        currentArchetype === "owner" ||
        currentArchetype === "admin");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge
          tone={
            run.status === "completed" ? "success" : run.status === "running" ? "info" : "danger"
          }
        >
          {dict.run[run.status] ?? run.status}
        </Badge>
        <span className="text-xs text-ink-muted">
          {dict.started} {formatDateTime(run.startedAt, { locale: l })}
        </span>
        {run.finishedAt ? (
          <span className="text-xs text-ink-muted">
            {dict.finished} {formatDateTime(run.finishedAt, { locale: l })}
          </span>
        ) : null}
        {run.outcomeNote ? (
          <span className="text-xs text-ink-secondary">
            {dict.outcome}: {run.outcomeNote}
          </span>
        ) : null}
      </div>
      <ol className="flex flex-col gap-2">
        {run.definition.steps.map((def, i) => {
          const runs = run.steps.filter((s) => s.stepIndex === i);
          const isCurrent = run.status === "running" && run.currentStepIndex === i;
          return (
            <li
              key={def.id}
              className={`rounded-lg border p-3 ${isCurrent ? "border-accent-line bg-accent-soft" : "border-line bg-card"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-sunken font-mono text-[11px] text-ink-secondary">
                  {i + 1}
                </span>
                <span className="text-sm font-medium text-ink">{stepName(i)}</span>
                <span className="text-xs text-ink-muted">{dict.kinds[def.kind] ?? def.kind}</span>
                {def.mode === "parallel" ? <span className="text-xs text-ink-muted">∥</span> : null}
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {runs.length === 0 ? <li className="text-xs text-ink-muted">–</li> : null}
                {runs.map((st) => (
                  <li
                    key={st.id}
                    className="flex flex-col gap-1 rounded-md border border-line bg-card p-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={tone(st.status)}>{dict.step[st.status] ?? st.status}</Badge>
                      <span className="text-ink">
                        {dict.assignee}: {who(st.assigneeUserId, st.assigneeArchetype)}
                      </span>
                      {st.dueAt ? (
                        <span
                          className={`text-xs ${st.overdue ? "text-danger" : "text-ink-muted"}`}
                        >
                          {st.overdue ? dict.overdue : dict.due}{" "}
                          {formatDateTime(st.dueAt, { locale: l })}
                        </span>
                      ) : null}
                      {st.decidedBy ? (
                        <span className="text-xs text-ink-secondary">
                          {dict.decidedBy} {who(st.decidedBy, null)}
                          {st.decidedAt ? ` · ${formatDateTime(st.decidedAt, { locale: l })}` : ""}
                        </span>
                      ) : null}
                    </div>
                    {st.note ? <p className="text-xs text-ink-secondary">{st.note}</p> : null}
                    {st.status === "active" && st.kind === "approval" ? (
                      <p className="text-xs text-ink-muted">
                        {dict.inInbox}{" "}
                        <Link href={`/o/${orgId}/approvals`} className="text-accent underline">
                          {dict.openInbox}
                        </Link>
                      </p>
                    ) : null}
                    {mayAct(st) ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex-1 text-xs text-ink-muted">
                          {dict.note}
                          <input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                          />
                        </label>
                        <Button
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            settle(
                              await decideReviewStepAction(orgId, {
                                stepRunId: st.id,
                                decision: "approved",
                                note: note || undefined,
                              }),
                            );
                            setBusy(false);
                            setNote("");
                          }}
                        >
                          {dict.approve}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || note.trim().length === 0}
                          onClick={async () => {
                            setBusy(true);
                            settle(
                              await decideReviewStepAction(orgId, {
                                stepRunId: st.id,
                                decision: "rejected",
                                note,
                              }),
                            );
                            setBusy(false);
                            setNote("");
                          }}
                        >
                          {dict.reject}
                        </Button>
                      </div>
                    ) : null}
                    {st.status === "active" &&
                    def.allowDelegate &&
                    canReview &&
                    (st.assigneeUserId === currentUserId ||
                      currentArchetype === "owner" ||
                      currentArchetype === "admin") ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="text-xs text-ink-muted">
                          {dict.delegateTo}
                          <select
                            value={delegateTo}
                            onChange={(e) => setDelegateTo(e.target.value)}
                            className="mt-1 min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                          >
                            <option value="">–</option>
                            {members
                              .filter((m) => m.id !== currentUserId && m.id !== run.startedBy)
                              .map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <Button
                          variant="secondary"
                          disabled={busy || !delegateTo}
                          onClick={async () => {
                            setBusy(true);
                            settle(
                              await delegateStepAction(orgId, {
                                stepRunId: st.id,
                                toUserId: delegateTo,
                              }),
                            );
                            setBusy(false);
                            setDelegateTo("");
                          }}
                        >
                          {dict.delegate}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
