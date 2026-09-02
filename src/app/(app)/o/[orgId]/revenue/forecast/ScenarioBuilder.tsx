"use client";

/**
 * H27 — build a what-if overlay: exclude a deal, slip it by months, change
 * its probability or its forecast category. The overlay is saved as a
 * scenario; the live pipeline is untouched until an owner applies it.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui";
import type { Overlay } from "@/modules/crm/service";
import { saveScenarioAction } from "./actions";

export type BuilderDict = {
  title: string;
  name: string;
  assumptions: string;
  deal: string;
  change: string;
  exclude: string;
  slip: string;
  probability: string;
  category: string;
  months: string;
  add: string;
  remove: string;
  save: string;
  saved: string;
  failed: string;
  forbidden: string;
  none: string;
  categories: Record<"pipeline" | "best_case" | "commit" | "omitted", string>;
};

type Change =
  | { kind: "exclude"; opportunityId: string }
  | { kind: "slip"; opportunityId: string; months: number }
  | { kind: "probability"; opportunityId: string; probability: number }
  | {
      kind: "category";
      opportunityId: string;
      category: "pipeline" | "best_case" | "commit" | "omitted";
    };

function toOverlay(changes: Change[]): Overlay {
  return {
    excludes: changes.filter((c) => c.kind === "exclude").map((c) => c.opportunityId),
    slips: changes
      .filter((c): c is Extract<Change, { kind: "slip" }> => c.kind === "slip")
      .map((c) => ({ opportunityId: c.opportunityId, months: c.months })),
    probabilities: changes
      .filter((c): c is Extract<Change, { kind: "probability" }> => c.kind === "probability")
      .map((c) => ({ opportunityId: c.opportunityId, probability: c.probability })),
    categories: changes
      .filter((c): c is Extract<Change, { kind: "category" }> => c.kind === "category")
      .map((c) => ({ opportunityId: c.opportunityId, category: c.category })),
  };
}

export function ScenarioBuilder({
  orgId,
  deals,
  dict,
}: {
  orgId: string;
  deals: Array<{ id: string; name: string }>;
  dict: BuilderDict;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [assumptions, setAssumptions] = useState("");
  const [changes, setChanges] = useState<Change[]>([]);
  const [dealId, setDealId] = useState(deals[0]?.id ?? "");
  const [kind, setKind] = useState<Change["kind"]>("slip");
  const [value, setValue] = useState("1");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cls = "min-h-10 rounded-md border border-line-strong bg-card px-2 text-sm text-ink";

  const add = () => {
    if (!dealId) return;
    const c: Change =
      kind === "exclude"
        ? { kind, opportunityId: dealId }
        : kind === "slip"
          ? { kind, opportunityId: dealId, months: Math.max(1, Math.min(24, Number(value) || 1)) }
          : kind === "probability"
            ? {
                kind,
                opportunityId: dealId,
                probability: Math.max(0, Math.min(100, Number(value) || 0)),
              }
            : {
                kind,
                opportunityId: dealId,
                category: (["pipeline", "best_case", "commit", "omitted"].includes(value)
                  ? value
                  : "pipeline") as "pipeline" | "best_case" | "commit" | "omitted",
              };
    setChanges((prev) => [
      ...prev.filter((p) => !(p.opportunityId === dealId && p.kind === kind)),
      c,
    ]);
  };
  const save = () =>
    startTransition(async () => {
      const r = await saveScenarioAction(orgId, {
        name: name.trim(),
        overlay: toOverlay(changes),
        assumptions: assumptions.trim() || null,
      });
      if (r.ok) {
        setStatus(dict.saved);
        setChanges([]);
        setName("");
        router.refresh();
      } else setStatus(r.code === "forbidden" ? dict.forbidden : dict.failed);
    });
  const nameOf = (id: string) => deals.find((d) => d.id === id)?.name ?? id;
  const describe = (c: Change) =>
    c.kind === "exclude"
      ? dict.exclude
      : c.kind === "slip"
        ? `${dict.slip} +${c.months} ${dict.months}`
        : c.kind === "probability"
          ? `${dict.probability} ${c.probability}%`
          : `${dict.category} ${dict.categories[c.category]}`;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink">{dict.title}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {dict.name}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className={cls}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {dict.assumptions}
          <input
            value={assumptions}
            onChange={(e) => setAssumptions(e.target.value)}
            maxLength={2000}
            className={cls}
          />
        </label>
      </div>
      {deals.length === 0 ? (
        <p className="text-sm text-ink-muted">{dict.none}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-ink-muted">
            {dict.deal}
            <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={cls}>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {dict.change}
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as Change["kind"];
                setKind(k);
                setValue(k === "category" ? "commit" : k === "probability" ? "50" : "1");
              }}
              className={cls}
            >
              <option value="slip">{dict.slip}</option>
              <option value="probability">{dict.probability}</option>
              <option value="category">{dict.category}</option>
              <option value="exclude">{dict.exclude}</option>
            </select>
          </label>
          {kind === "category" ? (
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={cls}
              aria-label={dict.category}
            >
              {(Object.keys(dict.categories) as Array<keyof BuilderDict["categories"]>).map((c) => (
                <option key={c} value={c}>
                  {dict.categories[c]}
                </option>
              ))}
            </select>
          ) : kind !== "exclude" ? (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="numeric"
              className={`${cls} w-24`}
              aria-label={kind === "slip" ? dict.months : dict.probability}
              dir="ltr"
            />
          ) : null}
          <Button variant="secondary" onClick={add}>
            {dict.add}
          </Button>
        </div>
      )}
      {changes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {changes.map((c, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5"
            >
              <span className="truncate text-ink">
                {nameOf(c.opportunityId)} · {describe(c)}
              </span>
              <button
                type="button"
                onClick={() => setChanges((prev) => prev.filter((_, j) => j !== i))}
                className="min-h-8 text-xs text-ink-muted hover:text-danger"
              >
                {dict.remove}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={pending || !name.trim() || changes.length === 0}>
          {dict.save}
        </Button>
        {status ? (
          <span className="text-xs text-ink-muted" role="status">
            {status}
          </span>
        ) : null}
      </div>
    </div>
  );
}
