"use client";

/**
 * H28 — renderer for structured output blocks (ADR-58): text, facts with
 * calculations, assumptions and gaps, evidence links, tables, comparisons,
 * timelines, small charts, proposed actions and honest notices. Nothing here
 * invents content: every block comes from the run's message.
 */
import Link from "next/link";
import type { ActionStatus, OutputBlock, RecordRef } from "@/modules/idara/service";
import type { DockDict } from "./IdaraDock";
import { hrefFor } from "./links";

export function RecordChip({ orgId, r }: { orgId: string; r: RecordRef }) {
  const href = hrefFor(orgId, r);
  const label = r.label ?? `${r.type.replace(/_/g, " ")} ${r.id.slice(0, 8)}`;
  const cls =
    "inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-sunken px-2 py-0.5 text-xs text-ink";
  return href ? (
    <Link href={href} className={`${cls} hover:underline`} prefetch={false}>
      <span className="truncate">{label}</span>
    </Link>
  ) : (
    <span className={cls}>
      <span className="truncate">{label}</span>
    </span>
  );
}

function List({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: "muted" | "warning";
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p
        className={`text-xs font-semibold uppercase tracking-wide ${tone === "warning" ? "text-warning" : "text-ink-muted"}`}
      >
        {title}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

export function Blocks({
  orgId,
  blocks,
  dict,
  canConfirm,
  busyAction,
  onConfirm,
  onExecute,
  onCancelAction,
  actionStatus,
}: {
  orgId: string;
  blocks: OutputBlock[];
  dict: DockDict;
  canConfirm: boolean;
  busyAction: string | null;
  onConfirm: (actionId: string) => void;
  onExecute: (actionId: string) => void;
  onCancelAction: (actionId: string) => void;
  /** Live statuses by action id (the message keeps the status at answer time). */
  actionStatus: Record<string, ActionStatus>;
}) {
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "text":
            return (
              <p key={i} className="whitespace-pre-wrap text-sm leading-6 text-ink">
                {b.text}
              </p>
            );
          case "facts":
            return (
              <div key={i} className="rounded-lg border border-line bg-card p-3">
                <List title={dict.facts} items={b.facts} />
                <List title={dict.calculations} items={b.calculations} />
                <List title={dict.assumptions} items={b.assumptions} />
                <List title={dict.gaps} items={b.gaps} tone="warning" />
                {b.method ? <p className="mt-2 text-xs text-ink-muted">{b.method}</p> : null}
              </div>
            );
          case "evidence":
            return (
              <div key={i}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {dict.evidence}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {b.items.map((r, j) => (
                    <RecordChip key={`${r.type}:${r.id}:${j}`} orgId={orgId} r={r} />
                  ))}
                </div>
              </div>
            );
          case "table":
            return (
              <div key={i} className="w-0 min-w-full overflow-x-auto rounded-lg border border-line">
                {b.title ? (
                  <p className="border-b border-line px-3 py-2 text-sm font-medium text-ink">
                    {b.title}
                  </p>
                ) : null}
                <table className="min-w-full text-sm">
                  <thead className="bg-sunken text-xs uppercase text-ink-muted">
                    <tr>
                      {b.columns.map((c, j) => (
                        <th key={j} className="px-3 py-2 text-start font-semibold">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-line">
                        {r.map((cell, k) => (
                          <td
                            key={k}
                            className="px-3 py-1.5 text-ink [font-variant-numeric:tabular-nums]"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "comparison":
            return (
              <div key={i} className="w-0 min-w-full overflow-x-auto rounded-lg border border-line">
                <table className="min-w-full text-sm">
                  <thead className="bg-sunken text-xs uppercase text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 text-start">{b.title ?? ""}</th>
                      <th className="px-3 py-2 text-start">{b.left.label}</th>
                      <th className="px-3 py-2 text-start">{b.right.label}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr
                        key={j}
                        className={`border-t border-line ${r.differs ? "bg-warning-soft" : ""}`}
                      >
                        <td className="px-3 py-1.5 text-ink-muted">{r.field}</td>
                        <td className="px-3 py-1.5 text-ink">{r.left}</td>
                        <td className="px-3 py-1.5 text-ink">{r.right}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "timeline":
            return (
              <ol key={i} className="space-y-1 border-s border-line ps-3">
                {b.items.map((it, j) => (
                  <li key={j} className="text-sm text-ink">
                    <span
                      className="me-2 text-xs text-ink-muted [font-variant-numeric:tabular-nums]"
                      dir="ltr"
                    >
                      {it.date}
                    </span>
                    {it.label}
                    {it.ref ? (
                      <span className="ms-2">
                        <RecordChip orgId={orgId} r={it.ref} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            );
          case "chart": {
            const max = Math.max(1, ...b.series.flatMap((s) => s.values));
            return (
              <div key={i} className="rounded-lg border border-line bg-card p-3">
                {b.title ? <p className="mb-2 text-sm font-medium text-ink">{b.title}</p> : null}
                <div
                  className="grid gap-1"
                  style={{ gridTemplateColumns: `repeat(${b.labels.length}, minmax(0, 1fr))` }}
                >
                  {b.labels.map((l, j) => (
                    <div key={j} className="flex flex-col items-center gap-1">
                      <div className="flex h-24 w-full items-end gap-0.5">
                        {b.series.map((s, k) => (
                          <div
                            key={k}
                            title={`${s.name}: ${s.values[j] ?? 0}`}
                            className={`w-full rounded-t ${k === 0 ? "bg-brand" : "bg-accent"}`}
                            style={{ height: `${Math.round(((s.values[j] ?? 0) / max) * 100)}%` }}
                          />
                        ))}
                      </div>
                      <span className="truncate text-[10px] text-ink-muted">{l}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          case "actions":
            return (
              <div key={i} className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {dict.actions}
                </p>
                {b.actions.map((a) => {
                  const status = actionStatus[a.actionId] ?? (a.status as ActionStatus);
                  const busy = busyAction === a.actionId;
                  return (
                    <div key={a.actionId} className="rounded-lg border border-line bg-card p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-ink">{a.title}</p>
                        <span className="rounded-sm bg-sunken px-2 py-0.5 text-xs text-ink-secondary">
                          {dict.riskClass[a.riskClass as 1 | 2 | 3 | 4 | 5]} ·{" "}
                          {dict.status[status] ?? status}
                        </span>
                      </div>
                      {canConfirm && status === "proposed" ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onConfirm(a.actionId)}
                            className="min-h-9 rounded-md bg-brand px-3 text-sm font-medium text-ink-inverse disabled:opacity-60"
                          >
                            {dict.confirm}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onCancelAction(a.actionId)}
                            className="min-h-9 rounded-md border border-line px-3 text-sm text-ink"
                          >
                            {dict.cancelAction}
                          </button>
                        </div>
                      ) : null}
                      {canConfirm && status === "approved" ? (
                        <div className="mt-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onExecute(a.actionId)}
                            className="min-h-9 rounded-md bg-brand px-3 text-sm font-medium text-ink-inverse disabled:opacity-60"
                          >
                            {dict.execute}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          case "notice":
            return (
              <div
                key={i}
                role={b.level === "error" ? "alert" : undefined}
                className={`rounded-lg border p-3 text-sm ${b.level === "error" ? "border-danger bg-danger-soft text-ink" : b.level === "warning" ? "border-warning bg-warning-soft text-ink" : "border-info bg-info-soft text-ink"}`}
              >
                <p>{b.text}</p>
                {b.ownerAction ? (
                  <p className="mt-1 text-xs text-ink-secondary" dir="ltr">
                    {dict.ownerAction}: {b.ownerAction}
                  </p>
                ) : null}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
