"use client";

/**
 * H25C — saved views: pick one (private or shared), save the current way of
 * looking, share it, or retire it. Presentation only; nothing here changes
 * the plan.
 */
import { useState, useTransition } from "react";
import type { ActionResult } from "../actions";
import type {
  StudioActions,
  StudioDict,
  WorkspacePayload,
  WorkspaceFilters,
} from "./StudioWorkspace";

export function SavedViewsBar({
  payload,
  dict,
  actions,
  view,
  filters,
  onApply,
  settle,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  view: string;
  filters: WorkspaceFilters;
  onApply: (viewId: string) => void;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
}) {
  const [pending, start] = useTransition();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [current, setCurrent] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <select
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
          if (e.target.value) onApply(e.target.value);
        }}
        aria-label={dict.savedViews}
        className="min-h-9 max-w-44 rounded-md border border-line bg-card px-2 text-xs text-ink"
      >
        <option value="">{dict.savedViews}</option>
        {payload.views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.isShared ? " · shared" : ""}
          </option>
        ))}
      </select>
      {current
        ? (() => {
            const v = payload.views.find((x) => x.id === current);
            const manager = payload.canManageScenario;
            return v && (v.mine || (v.isShared && manager)) ? (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await actions.updateView({ viewId: v.id, remove: true });
                    if (settle(res)) setCurrent("");
                  })
                }
                className="min-h-9 rounded-md border border-line px-2 text-danger"
              >
                {dict.retireView}
              </button>
            ) : null;
          })()
        : null}
      {saving ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            start(async () => {
              const res = await actions.saveView({
                planId: payload.planId,
                name: n,
                view,
                config: {
                  view,
                  filters: {
                    search: filters.search || undefined,
                    types: filters.types.length ? filters.types : undefined,
                    statuses: filters.statuses.length ? filters.statuses : undefined,
                    criticalOnly: filters.criticalOnly || undefined,
                  },
                  scenarioId: payload.scenarioId,
                },
                isShared: shared,
              });
              if (settle(res)) {
                setSaving(false);
                setName("");
              }
            });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={dict.viewName}
            maxLength={120}
            autoFocus
            className="min-h-9 w-36 rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
          />
          <label className="flex items-center gap-1 text-ink-muted">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {dict.shareView}
          </label>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="min-h-9 rounded-md bg-accent px-2 text-white disabled:opacity-50"
          >
            {dict.save}
          </button>
          <button
            type="button"
            onClick={() => setSaving(false)}
            className="min-h-9 rounded-md border border-line px-2 text-ink"
          >
            ×
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setSaving(true)}
          className="min-h-9 rounded-md border border-line px-2 text-ink"
        >
          {dict.saveView}
        </button>
      )}
    </div>
  );
}
