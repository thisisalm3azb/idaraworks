"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  SIZE_CLASS,
  WIDGET_SIZES,
  type BoardEntry,
  type WidgetSize,
} from "@/platform/ui/dashboard/board-layout";
import type { WidgetKey } from "@/modules/dashboard/service";

type ResolvedEntry = BoardEntry & { key: WidgetKey };
import { resetDashboardLayoutAction, saveDashboardLayoutAction } from "./actions";

/**
 * The dashboard board: the widgets in the person's order, and the editor that
 * changes it.
 *
 * Everything shown was rendered on the server for the widgets the saved
 * layout selects; this island only arranges those pieces and edits the list.
 * Nothing here fetches. A widget added in the editor appears after Save,
 * because that is when the server first loads its data, and the placeholder
 * says so rather than pretending.
 *
 * Reordering is by button (Move up / Move down), so it works from a keyboard,
 * a screen reader and a thumb alike. There is no drag-only path.
 */

export type BoardCatalogueItem = { key: WidgetKey; label: string; hint: string };

export type BoardLabels = {
  edit: string;
  done: string;
  save: string;
  saving: string;
  saved: string;
  cancel: string;
  reset: string;
  resetHint: string;
  add: string;
  addTitle: string;
  nothingToAdd: string;
  remove: string;
  hide: string;
  show: string;
  hidden: string;
  moveUp: string;
  moveDown: string;
  size: string;
  sizes: Record<WidgetSize, string>;
  pending: string;
  empty: string;
  emptyHint: string;
  errorInvalid: string;
  errorForbidden: string;
  errorFailed: string;
  droppedNote: string;
  editing: string;
};

type Status = { kind: "idle" } | { kind: "saved" } | { kind: "error"; text: string };

export function DashboardBoard({
  orgId,
  entries,
  catalogue,
  slots,
  labels,
  droppedCount,
  header,
}: {
  orgId: string;
  /** The resolved layout, hidden entries included. */
  entries: ResolvedEntry[];
  /** Every widget this person may add, with its translated name. */
  catalogue: BoardCatalogueItem[];
  /** Server-rendered content, only for entries that are shown. */
  slots: Partial<Record<WidgetKey, ReactNode>>;
  labels: BoardLabels;
  droppedCount: number;
  /** The page's own heading row; the Edit button sits beside it. */
  header: ReactNode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ResolvedEntry[]>(entries);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const nameOf = (key: WidgetKey) => catalogue.find((c) => c.key === key)?.label ?? key;
  const inDraft = new Set(draft.map((e) => e.key));
  const addable = catalogue.filter((c) => !inDraft.has(c.key));

  const begin = () => {
    setDraft(entries);
    setStatus({ kind: "idle" });
    setEditing(true);
  };
  const cancel = () => {
    setDraft(entries);
    setEditing(false);
    setStatus({ kind: "idle" });
  };
  const move = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const next = d.slice();
      const [it] = next.splice(i, 1);
      next.splice(j, 0, it!);
      return next;
    });
  };
  const patch = (i: number, p: Partial<ResolvedEntry>) =>
    setDraft((d) => d.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const remove = (i: number) => setDraft((d) => d.filter((_, k) => k !== i));
  const add = (key: WidgetKey) =>
    setDraft((d) => [...d, { key, size: sizeDefault(key, catalogue), hidden: false }]);

  const errorText = (code: string) =>
    code === "invalid"
      ? labels.errorInvalid
      : code === "forbidden"
        ? labels.errorForbidden
        : labels.errorFailed;

  const save = () => {
    startTransition(async () => {
      const r = await saveDashboardLayoutAction(orgId, {
        v: 1,
        widgets: draft.map((e) => ({ key: e.key, size: e.size, hidden: e.hidden })),
      });
      if (r.ok) {
        setStatus({ kind: "saved" });
        setEditing(false);
        router.refresh();
      } else {
        setStatus({ kind: "error", text: errorText(r.error) });
      }
    });
  };
  const reset = () => {
    startTransition(async () => {
      const r = await resetDashboardLayoutAction(orgId);
      if (r.ok) {
        setStatus({ kind: "saved" });
        setEditing(false);
        router.refresh();
      } else {
        setStatus({ kind: "error", text: errorText(r.error) });
      }
    });
  };

  const shown = entries.filter((e) => !e.hidden);

  return (
    <div className="flex flex-col gap-4" data-dashboard-board={editing ? "editing" : "view"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">{header}</div>
        {!editing ? (
          <button
            type="button"
            onClick={begin}
            data-dashboard-edit
            className="inline-flex min-h-11 items-center gap-2 self-end rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken sm:self-auto"
          >
            <PencilGlyph />
            {labels.edit}
          </button>
        ) : (
          <span className="self-end rounded-full bg-accent-soft px-3 py-1.5 text-xs font-medium text-ink sm:self-auto">
            {labels.editing}
          </span>
        )}
      </div>

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-sm",
          status.kind === "error" ? "text-danger" : "text-success",
          (status.kind === "idle" || (status.kind === "saved" && pending)) && "sr-only",
        )}
      >
        {status.kind === "saved" && !pending
          ? labels.saved
          : status.kind === "error"
            ? status.text
            : ""}
      </p>

      {droppedCount > 0 && !editing ? (
        <p className="text-xs text-ink-muted">{labels.droppedNote}</p>
      ) : null}

      {!editing ? (
        shown.length === 0 ? (
          <div className="rounded-lg border border-line bg-card px-4 py-6 text-center">
            <p className="text-sm font-medium text-ink">{labels.empty}</p>
            <p className="mt-1 text-xs text-ink-muted">{labels.emptyHint}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((e) => (
              <section
                key={e.key}
                data-widget={e.key}
                data-widget-size={e.size}
                aria-label={nameOf(e.key)}
                className={cn("min-w-0", SIZE_CLASS[e.size])}
              >
                {slots[e.key] ?? null}
              </section>
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-2" aria-label={labels.edit}>
            {draft.map((e, i) => {
              const name = nameOf(e.key);
              const fresh = !entries.some((x) => x.key === e.key && !x.hidden) || !slots[e.key];
              return (
                <li
                  key={e.key}
                  data-widget-edit={e.key}
                  className={cn(
                    "rounded-lg border border-line bg-card p-3",
                    e.hidden && "opacity-70",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                      {name}
                      {e.hidden ? (
                        <span className="ms-2 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-normal text-ink-muted">
                          {labels.hidden}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0 || pending}
                        aria-label={`${labels.moveUp}: ${name}`}
                        className="flex size-11 items-center justify-center rounded-md border border-line text-ink hover:bg-sunken disabled:opacity-40"
                      >
                        <span aria-hidden>↑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === draft.length - 1 || pending}
                        aria-label={`${labels.moveDown}: ${name}`}
                        className="flex size-11 items-center justify-center rounded-md border border-line text-ink hover:bg-sunken disabled:opacity-40"
                      >
                        <span aria-hidden>↓</span>
                      </button>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-ink-secondary">
                      <span>{labels.size}</span>
                      <select
                        value={e.size}
                        onChange={(ev) => patch(i, { size: ev.target.value as WidgetSize })}
                        disabled={pending}
                        aria-label={`${labels.size}: ${name}`}
                        className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                      >
                        {WIDGET_SIZES.map((s) => (
                          <option key={s} value={s}>
                            {labels.sizes[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => patch(i, { hidden: !e.hidden })}
                      disabled={pending}
                      className="min-h-11 rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
                    >
                      {e.hidden ? labels.show : labels.hide}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={pending}
                      className="min-h-11 rounded-md px-3 text-sm text-ink-secondary hover:bg-sunken hover:text-danger"
                    >
                      {labels.remove}
                    </button>
                  </div>
                  {fresh && !e.hidden ? (
                    <p className="mt-2 text-xs text-ink-muted">{labels.pending}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <section
            aria-labelledby="dash-add-title"
            className="rounded-lg border border-dashed border-line-strong bg-sunken/40 p-3"
          >
            <h2 id="dash-add-title" className="text-sm font-semibold text-ink">
              {labels.addTitle}
            </h2>
            {addable.length === 0 ? (
              <p className="mt-1 text-xs text-ink-muted">{labels.nothingToAdd}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {addable.map((c) => (
                  <li key={c.key} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">{c.label}</span>
                      <span className="block text-xs text-ink-muted">{c.hint}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => add(c.key)}
                      disabled={pending}
                      data-widget-add={c.key}
                      aria-label={`${labels.add}: ${c.label}`}
                      className="min-h-11 shrink-0 rounded-md border border-line-strong bg-card px-3 text-sm font-medium text-ink hover:bg-sunken"
                    >
                      {labels.add}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card p-3 shadow-pop md:bottom-4">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              data-dashboard-save
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse disabled:opacity-60"
            >
              {pending ? labels.saving : labels.save}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={pending}
              className="min-h-11 rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
            >
              {labels.cancel}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={reset}
              disabled={pending}
              title={labels.resetHint}
              data-dashboard-reset
              className="min-h-11 rounded-md px-3 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
            >
              {labels.reset}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function sizeDefault(key: WidgetKey, catalogue: BoardCatalogueItem[]): WidgetSize {
  // The catalogue carries no sizes; a sensible middle is right for anything
  // added by hand and one tap away from being changed.
  void catalogue;
  return key === "attention" || key === "pulse" || key === "quick_actions" ? "l" : "m";
}

function PencilGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
    </svg>
  );
}
