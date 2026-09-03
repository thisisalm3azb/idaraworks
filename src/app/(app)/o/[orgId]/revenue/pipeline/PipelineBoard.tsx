"use client";

/**
 * H27 — the interactive pipeline. Drag a card between columns (pointer) or
 * pick a stage from the card's own select (keyboard, screen reader, phone);
 * either way the move goes through ONE governed action that validates the
 * target stage's requirements, records who moved it and why, and refuses an
 * out-of-date card. Bulk moves review every card first, then run one by one
 * so each is audited on its own. No animation: reduced-motion users get the
 * same experience as everyone.
 */
import { useMemo, useState, useTransition, type DragEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog } from "@/platform/ui";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import type { BoardCard, StageAggregate, StageRequirement } from "@/modules/crm/service";
import { moveStageAction, type MoveResult } from "./actions";
import type { Locale } from "@/platform/registries";

export type BoardDict = {
  move: string;
  moveTo: string;
  reason: string;
  reasonHint: string;
  requirements: string;
  unmet: string;
  confirm: string;
  cancel: string;
  close: string;
  moved: string;
  conflict: string;
  forbidden: string;
  failed: string;
  state: string;
  selected: string;
  bulkMove: string;
  review: string;
  clear: string;
  cards: string;
  value: string;
  weighted: string;
  stalled: string;
  days: string;
  risks: string;
  stakeholders: string;
  empty: string;
  open: string;
  requirement: Record<StageRequirement, string>;
  select: string;
};

export type BoardStage = {
  key: string;
  label: string;
  category: "open" | "won" | "lost";
  requirements: StageRequirement[];
  maxAgeDays: number | null;
};

type Outcome = { id: string; name: string; result: MoveResult };

export function PipelineBoard({
  orgId,
  stages,
  cards: initial,
  aggregates,
  canManage,
  seesPrice,
  currency,
  locale,
  dict,
}: {
  orgId: string;
  stages: BoardStage[];
  cards: BoardCard[];
  aggregates: StageAggregate[];
  canManage: boolean;
  seesPrice: boolean;
  currency: CurrencyCode;
  locale: Locale;
  dict: BoardDict;
}) {
  const router = useRouter();
  const [cards, setCards] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The review dialog: one card (drag / select) or the whole selection (bulk).
  const [review, setReview] = useState<{ ids: string[]; stageKey: string } | null>(null);
  const [reason, setReason] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [bulkStage, setBulkStage] = useState("");

  const byStage = useMemo(() => {
    const m = new Map<string, BoardCard[]>();
    for (const s of stages) m.set(s.key, []);
    for (const c of cards) {
      const list = m.get(c.stageKey);
      if (list) list.push(c);
      else m.set(c.stageKey, [c]);
    }
    return m;
  }, [cards, stages]);
  const agg = useMemo(() => new Map(aggregates.map((a) => [a.stageKey, a])), [aggregates]);
  const stageOf = (key: string) => stages.find((s) => s.key === key);

  const onDragStart = (e: DragEvent, id: string) => {
    if (!canManage) return;
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onDrop = (e: DragEvent, stageKey: string) => {
    e.preventDefault();
    setOverStage(null);
    const id = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    if (!id) return;
    const card = cards.find((c) => c.id === id);
    if (!card || card.stageKey === stageKey) return;
    openReview([id], stageKey);
  };
  const openReview = (ids: string[], stageKey: string) => {
    setReason("");
    setOutcomes(null);
    setReview({ ids, stageKey });
  };

  const run = () => {
    if (!review) return;
    const { ids, stageKey } = review;
    startTransition(async () => {
      const results: Outcome[] = [];
      for (const id of ids) {
        const card = cards.find((c) => c.id === id);
        if (!card) continue;
        const result = await moveStageAction(orgId, {
          id,
          stageKey,
          rowVersion: card.rowVersion,
          reason: reason.trim() || null,
        });
        results.push({ id, name: card.name, result });
        if (result.ok) {
          setCards((prev) =>
            prev.map((c) =>
              c.id === id ? { ...c, stageKey, rowVersion: result.rowVersion, stageAgeDays: 0 } : c,
            ),
          );
        }
      }
      setOutcomes(results);
      setSelected(new Set());
      router.refresh();
    });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const money = (n: number | null) =>
    seesPrice && n !== null ? formatMoney(n, currency, { locale }) : null;
  const outcomeText = (r: MoveResult) =>
    r.ok
      ? dict.moved
      : r.code === "requirements"
        ? `${dict.unmet}: ${(r.unmet ?? []).map((u) => dict.requirement[u]).join(", ")}`
        : r.code === "conflict"
          ? dict.conflict
          : r.code === "forbidden"
            ? dict.forbidden
            : r.code === "state"
              ? dict.state
              : dict.failed;

  const target = review ? stageOf(review.stageKey) : null;

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-3">
      {canManage && selected.size > 0 ? (
        <div
          role="region"
          aria-live="polite"
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-line bg-card p-2 shadow-sm"
        >
          <span className="text-sm font-medium text-ink">
            {dict.selected.replace("{n}", String(selected.size))}
          </span>
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">{dict.bulkMove}</span>
            <select
              className="min-h-10 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
              value={bulkStage}
              onChange={(e) => setBulkStage(e.target.value)}
            >
              <option value="">{dict.moveTo}</option>
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="md"
            disabled={!bulkStage}
            onClick={() => bulkStage && openReview([...selected], bulkStage)}
          >
            {dict.review}
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            {dict.clear}
          </Button>
        </div>
      ) : null}

      <div className="flex w-0 min-w-full snap-x gap-3 relative overflow-x-auto pb-2 [scrollbar-width:thin]">
        {stages.map((s) => {
          const list = byStage.get(s.key) ?? [];
          const a = agg.get(s.key);
          return (
            <section
              key={s.key}
              aria-label={s.label}
              onDragOver={(e) => {
                if (!canManage) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overStage !== s.key) setOverStage(s.key);
              }}
              onDragLeave={() => setOverStage((o) => (o === s.key ? null : o))}
              onDrop={(e) => onDrop(e, s.key)}
              className={cn(
                "flex w-[280px] shrink-0 snap-start flex-col gap-2 rounded-lg border bg-surface p-2",
                overStage === s.key ? "border-brand ring-2 ring-brand-soft" : "border-line",
              )}
            >
              <header className="flex flex-col gap-1 px-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="truncate text-sm font-semibold text-ink">{s.label}</h2>
                  <Badge
                    tone={
                      s.category === "won"
                        ? "success"
                        : s.category === "lost"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {a?.count ?? list.length}
                  </Badge>
                </div>
                {a ? (
                  <p className="flex flex-wrap gap-x-2 text-xs text-ink-muted">
                    {money(a.valueMinor) ? (
                      <span dir="ltr">
                        {dict.value} {money(a.valueMinor)}
                      </span>
                    ) : null}
                    {money(a.weightedMinor) ? (
                      <span dir="ltr">
                        {dict.weighted} {money(a.weightedMinor)}
                      </span>
                    ) : null}
                    {a.stalled > 0 ? (
                      <span className="text-warning">
                        {dict.stalled} {a.stalled}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {s.requirements.length > 0 ? (
                  <p className="text-xs text-ink-muted">
                    {dict.requirements}: {s.requirements.map((r) => dict.requirement[r]).join(", ")}
                  </p>
                ) : null}
              </header>
              <ul className="flex min-h-16 flex-col gap-2">
                {list.length === 0 ? (
                  <li className="rounded-md border border-dashed border-line p-3 text-center text-xs text-ink-muted">
                    {dict.empty}
                  </li>
                ) : null}
                {list.map((c) => (
                  <li
                    key={c.id}
                    draggable={canManage}
                    onDragStart={(e) => onDragStart(e, c.id)}
                    onDragEnd={() => setDragId(null)}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-lg border border-line bg-card px-3 py-2.5",
                      canManage && "cursor-grab active:cursor-grabbing",
                      dragId === c.id && "opacity-60",
                      selected.has(c.id) && "border-brand",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {canManage ? (
                        <input
                          type="checkbox"
                          aria-label={`${dict.select} ${c.name}`}
                          className="mt-0.5 size-5"
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                      ) : null}
                      <Link
                        href={`/o/${orgId}/revenue/deals/${c.id}`}
                        className="min-w-0 flex-1 text-sm font-medium text-ink hover:underline"
                      >
                        {c.name}
                      </Link>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
                      {c.customerName ? <span className="truncate">{c.customerName}</span> : null}
                      {money(c.estimatedValueMinor) ? (
                        <span dir="ltr" className="font-mono">
                          {money(c.estimatedValueMinor)}
                        </span>
                      ) : null}
                      {c.expectedCloseDate ? (
                        <span dir="ltr">{formatDate(c.expectedCloseDate, { locale })}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge
                        tone={
                          c.forecastCategory === "commit"
                            ? "success"
                            : c.forecastCategory === "omitted"
                              ? "neutral"
                              : "info"
                        }
                      >
                        {c.forecastCategory}
                      </Badge>
                      <span
                        className={cn(
                          "text-ink-muted",
                          s.maxAgeDays !== null && c.stageAgeDays > s.maxAgeDays && "text-warning",
                        )}
                      >
                        {c.stageAgeDays} {dict.days}
                      </span>
                      {c.openRiskCount > 0 ? (
                        <span className="text-danger">
                          {c.openRiskCount} {dict.risks}
                        </span>
                      ) : null}
                      {c.stakeholderCount > 0 ? (
                        <span className="text-ink-muted">
                          {c.stakeholderCount} {dict.stakeholders}
                        </span>
                      ) : null}
                      {c.ownerName ? <span className="text-ink-muted">{c.ownerName}</span> : null}
                    </div>
                    {canManage ? (
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        <span className="sr-only">{dict.move}</span>
                        <select
                          className="min-h-9 w-full rounded-md border border-line bg-card px-2 text-xs text-ink"
                          value=""
                          onChange={(e) => e.target.value && openReview([c.id], e.target.value)}
                          aria-label={`${dict.move}: ${c.name}`}
                        >
                          <option value="">{dict.moveTo}</option>
                          {stages
                            .filter((x) => x.key !== c.stageKey)
                            .map((x) => (
                              <option key={x.key} value={x.key}>
                                {x.label}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <Dialog
        open={review !== null}
        onClose={() => setReview(null)}
        title={`${dict.moveTo} ${target?.label ?? ""}`}
        description={outcomes ? undefined : dict.reasonHint}
        closeLabel={dict.close}
      >
        {review && !outcomes ? (
          <div className="flex flex-col gap-3">
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm text-ink">
              {review.ids.map((id) => {
                const c = cards.find((x) => x.id === id);
                return c ? (
                  <li key={id} className="truncate">
                    {c.name}
                    {c.customerName ? (
                      <span className="text-ink-muted"> · {c.customerName}</span>
                    ) : null}
                  </li>
                ) : null;
              })}
            </ul>
            {target && target.requirements.length > 0 ? (
              <p className="text-xs text-ink-muted">
                {dict.requirements}:{" "}
                {target.requirements.map((r) => dict.requirement[r]).join(", ")}
              </p>
            ) : null}
            <label className="flex flex-col gap-1 text-sm text-ink">
              {dict.reason}
              <textarea
                className="min-h-20 rounded-md border border-line-strong bg-card px-3 py-2 text-sm text-ink"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setReview(null)} disabled={pending}>
                {dict.cancel}
              </Button>
              <Button onClick={run} disabled={pending}>
                {dict.confirm}
              </Button>
            </div>
          </div>
        ) : null}
        {outcomes ? (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1 text-sm">
              {outcomes.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="truncate text-ink">{o.name}</span>
                  <Badge tone={o.result.ok ? "success" : "danger"}>{outcomeText(o.result)}</Badge>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button onClick={() => setReview(null)}>{dict.close}</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
