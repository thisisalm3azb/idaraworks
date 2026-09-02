"use client";

/**
 * H26H — the obligations board: list, timeline, calendar and relationship
 * views over the same items, with evidence-gated completion, waive/cancel with
 * a reason, reopen, escalation and creation. Also embedded in a document's
 * workspace with `fixedDocumentId` (compact).
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog } from "@/platform/ui";
import type { ObligationRow } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import {
  closeObligationAction,
  completeObligationAction,
  createObligationAction,
  escalateObligationAction,
  reopenObligationAction,
  updateObligationAction,
} from "../studio-actions";

import type { ObligationsDict } from "./obligationsDict";

type View = "list" | "timeline" | "calendar" | "relationships";
type DialogState =
  | null
  | { kind: "new"; item?: ObligationRow }
  | { kind: "complete"; item: ObligationRow }
  | { kind: "close"; item: ObligationRow; mode: "waive" | "cancel" }
  | { kind: "reopen"; item: ObligationRow }
  | { kind: "escalate"; item: ObligationRow };

const DUE_TONE: Record<string, "danger" | "warning" | "info" | "neutral" | "success"> = {
  overdue: "danger",
  due_soon: "warning",
  upcoming: "info",
  closed: "neutral",
};

const input =
  "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ObligationsBoard({
  orgId,
  locale,
  userId,
  items,
  documents,
  members,
  canManage,
  soonDays,
  initialView,
  fixedDocumentId,
  dict,
}: {
  orgId: string;
  locale: string;
  userId: string;
  items: ObligationRow[];
  documents: Array<{ id: string; reference: string; title: string }>;
  members: Array<{ id: string; name: string }>;
  canManage: boolean;
  soonDays: number;
  initialView?: string;
  fixedDocumentId?: string;
  dict: ObligationsDict;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const compact = Boolean(fixedDocumentId);
  const views: View[] = compact
    ? ["list", "timeline"]
    : ["list", "timeline", "calendar", "relationships"];
  const [view, setView] = useState<View>(
    views.includes(initialView as View) ? (initialView as View) : "list",
  );
  const [openOnly, setOpenOnly] = useState(true);
  const [mine, setMine] = useState(false);
  const [kind, setKind] = useState("");
  const [dueState, setDueState] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const fmtDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "ar" ? "ar-AE" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [locale],
  );
  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale === "ar" ? "ar-AE" : "en-AE", {
      style: "currency",
      currency,
    }).format(cents / 100);

  useEffect(() => {
    if (!notice || notice.tone !== "ok") return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const settle = (res: ActionResult<unknown>): boolean => {
    if (res.ok) {
      setNotice({ tone: "ok", text: dict.saved });
      startTransition(() => router.refresh());
    } else setNotice({ tone: "error", text: `${dict.failed}: ${res.error}` });
    return res.ok;
  };

  const visible = useMemo(
    () =>
      items.filter(
        (o) =>
          (!openOnly || o.status === "open") &&
          (!mine || o.ownerUserId === userId || o.escalatedTo === userId) &&
          (!kind || o.kind === kind) &&
          (!dueState || o.dueState === dueState),
      ),
    [items, openOnly, mine, kind, dueState, userId],
  );
  const counts = useMemo(
    () => ({
      overdue: items.filter((o) => o.dueState === "overdue").length,
      due_soon: items.filter((o) => o.dueState === "due_soon").length,
      upcoming: items.filter((o) => o.dueState === "upcoming").length,
      done: items.filter((o) => o.status === "done").length,
    }),
    [items],
  );

  const dueLabel = (o: ObligationRow) =>
    o.status !== "open"
      ? dict.statuses[o.status]
      : o.daysLeft < 0
        ? dict.daysOver.replace("{n}", String(-o.daysLeft))
        : o.daysLeft === 0
          ? dict.today
          : dict.daysLeft.replace("{n}", String(o.daysLeft));

  const ItemActions = ({ o }: { o: ObligationRow }) =>
    canManage ? (
      <div className="flex flex-wrap gap-1">
        {o.status === "open" ? (
          <>
            <Button onClick={() => setDialog({ kind: "complete", item: o })}>
              {dict.actions.complete}
            </Button>
            <Button variant="secondary" onClick={() => setDialog({ kind: "new", item: o })}>
              {dict.actions.edit}
            </Button>
            <Button variant="ghost" onClick={() => setDialog({ kind: "escalate", item: o })}>
              {dict.actions.escalate}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDialog({ kind: "close", item: o, mode: "waive" })}
            >
              {dict.actions.waive}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDialog({ kind: "close", item: o, mode: "cancel" })}
            >
              {dict.actions.cancel}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setDialog({ kind: "reopen", item: o })}>
            {dict.actions.reopen}
          </Button>
        )}
        {o.kind === "renewal" && o.status === "open" ? (
          <Link
            href={`/o/${orgId}/documents/${o.documentId}?tab=details`}
            className="inline-flex min-h-9 items-center rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
          >
            {dict.actions.renew}
          </Link>
        ) : null}
      </div>
    ) : null;

  const Card = ({ o, showDoc = true }: { o: ObligationRow; showDoc?: boolean }) => (
    <article
      className={`rounded-lg border bg-card p-3 shadow-card ${o.dueState === "overdue" ? "border-danger" : "border-line"}`}
      data-obligation={o.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Badge tone={DUE_TONE[o.dueState] ?? "neutral"}>{dueLabel(o)}</Badge>
        <Badge tone="neutral">{dict.kinds[o.kind] ?? o.kind}</Badge>
        {o.riskLevel ? (
          <Badge
            tone={
              o.riskLevel === "high" ? "danger" : o.riskLevel === "medium" ? "warning" : "neutral"
            }
          >
            {dict.risk[o.riskLevel]}
          </Badge>
        ) : null}
        <span>{fmtDate.format(new Date(`${o.dueOn}T00:00:00Z`))}</span>
        {o.ownerName ? <span>· {o.ownerName}</span> : null}
        {o.escalatedTo ? <Badge tone="warning">{dict.actions.escalate}</Badge> : null}
      </div>
      <h3 className="mt-1 text-sm font-semibold text-ink">{o.title}</h3>
      {showDoc ? (
        <Link
          href={`/o/${orgId}/documents/${o.documentId}?tab=obligations`}
          className="text-xs text-accent underline"
        >
          <bdi dir="ltr">{o.documentReference}</bdi> · {o.documentTitle}
        </Link>
      ) : null}
      {o.amountCents !== null && o.currency ? (
        <p className="mt-1 text-sm text-ink">{fmtMoney(o.amountCents, o.currency)}</p>
      ) : null}
      {o.description ? <p className="mt-1 text-sm text-ink-secondary">{o.description}</p> : null}
      {o.status === "done" && o.evidenceNote ? (
        <p className="mt-1 rounded bg-sunken px-2 py-1 text-xs text-ink-secondary">
          {dict.fields.evidence_note}: {o.evidenceNote}
        </p>
      ) : null}
      {o.closedReason ? (
        <p className="mt-1 text-xs text-ink-muted">
          {dict.fields.reason}: {o.closedReason}
        </p>
      ) : null}
      <div className="mt-2">
        <ItemActions o={o} />
      </div>
    </article>
  );

  // ── views ──
  const timelineGroups = useMemo(() => {
    const groups = new Map<string, ObligationRow[]>();
    for (const o of [...visible].sort((a, b) => a.dueOn.localeCompare(b.dueOn))) {
      const key = o.dueOn.slice(0, 7);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    return [...groups.entries()];
  }, [visible]);

  const calendar = useMemo(() => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 1, 1));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const cells: Array<{ iso: string | null; items: ObligationRow[] }> = [];
    for (let i = 0; i < lead; i++) cells.push({ iso: null, items: [] });
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ iso, items: visible.filter((o) => o.dueOn === iso) });
    }
    return { y, m, cells };
  }, [month, visible]);

  const byDocument = useMemo(() => {
    const groups = new Map<string, { ref: string; title: string; items: ObligationRow[] }>();
    for (const o of visible) {
      const g = groups.get(o.documentId) ?? {
        ref: o.documentReference,
        title: o.documentTitle,
        items: [],
      };
      g.items.push(o);
      groups.set(o.documentId, g);
    }
    return [...groups.entries()];
  }, [visible]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
        >
          {notice.text}
        </p>
      ) : null}
      {!compact ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["overdue", "due_soon", "upcoming", "done"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setDueState(key === "done" ? "closed" : key);
                setOpenOnly(key !== "done");
                setView("list");
              }}
              className={`rounded-lg border p-3 text-start shadow-card ${key === "overdue" && counts.overdue > 0 ? "border-danger bg-danger-soft" : "border-line bg-card"}`}
            >
              <p className="text-xs text-ink-muted">
                {dict.kpi[key]}
                {key === "due_soon" ? ` (${soonDays}d)` : ""}
              </p>
              <p className="text-2xl font-semibold tabular-nums text-ink">{counts[key]}</p>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex gap-1 rounded-md bg-sunken p-1">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`min-h-9 rounded px-3 text-sm ${view === v ? "bg-card font-medium text-ink shadow-card" : "text-ink-secondary"}`}
            >
              {dict.views[v]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          {dict.filters.open_only}
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          {dict.filters.mine}
        </label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="min-h-9 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
          aria-label={dict.fields.kind}
        >
          <option value="">{dict.filters.all_kinds}</option>
          {Object.entries(dict.kinds).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={dueState}
          onChange={(e) => setDueState(e.target.value)}
          className="min-h-9 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
          aria-label={dict.filters.any_state}
        >
          <option value="">{dict.filters.any_state}</option>
          {Object.entries(dict.dueStates).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {canManage ? (
          <Button onClick={() => setDialog({ kind: "new" })}>{dict.actions.new}</Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-card p-6 text-center text-sm text-ink-muted">
          {compact ? dict.emptyDoc : dict.empty}
        </p>
      ) : null}

      {view === "list" && visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {visible.map((o) => (
            <Card key={o.id} o={o} showDoc={!compact} />
          ))}
        </div>
      ) : null}

      {view === "timeline" && visible.length > 0 ? (
        <ol className="relative ms-3 border-s-2 border-line ps-4">
          {timelineGroups.map(([ym, group]) => (
            <li key={ym} className="mb-4">
              <div className="relative">
                <span className="absolute -start-[23px] top-1 h-3 w-3 rounded-full border-2 border-card bg-accent" />
                <h3 className="text-sm font-semibold text-ink">
                  {dict.months[Number(ym.slice(5, 7)) - 1]} {ym.slice(0, 4)}
                </h3>
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {group.map((o) => (
                  <Card key={o.id} o={o} showDoc={!compact} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {view === "calendar" ? (
        <section className="rounded-lg border border-line bg-card p-3 shadow-card">
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => shiftMonth(-1)} aria-label="previous month">
              ‹
            </Button>
            <h3 className="text-sm font-semibold text-ink">
              {dict.months[calendar.m - 1]} {calendar.y}
            </h3>
            <Button variant="ghost" onClick={() => shiftMonth(1)} aria-label="next month">
              ›
            </Button>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] text-ink-muted">
            {dict.weekdays.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {calendar.cells.map((c, i) => (
              <div
                key={i}
                className={`min-h-16 rounded border p-1 text-xs ${c.iso ? "border-line" : "border-transparent"} ${c.iso === todayIso() ? "bg-accent-soft" : ""}`}
              >
                {c.iso ? <div className="text-ink-muted">{Number(c.iso.slice(8, 10))}</div> : null}
                {c.items.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() =>
                      canManage && o.status === "open" && setDialog({ kind: "complete", item: o })
                    }
                    className={`mt-0.5 block w-full truncate rounded px-1 text-start ${o.dueState === "overdue" ? "bg-danger-soft text-danger" : o.dueState === "due_soon" ? "bg-warning-soft text-ink" : "bg-sunken text-ink"}`}
                    title={o.title}
                  >
                    {o.title}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view === "relationships" && visible.length > 0 ? (
        <div className="flex flex-col gap-3">
          {byDocument.map(([docId, g]) => (
            <section key={docId} className="rounded-lg border border-line bg-card p-3 shadow-card">
              <Link
                href={`/o/${orgId}/documents/${docId}?tab=obligations`}
                className="text-sm font-semibold text-ink underline"
              >
                <bdi dir="ltr">{g.ref}</bdi> · {g.title}
              </Link>
              <div className="mt-2 flex flex-wrap gap-2">
                {g.items.map((o) => (
                  <span
                    key={o.id}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${o.dueState === "overdue" ? "border-danger text-danger" : "border-line text-ink"}`}
                  >
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    {dict.kinds[o.kind]}: {o.title} · {dueLabel(o)}
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {/* ── dialogs ── */}
      <ObligationDialog
        state={dialog}
        onClose={() => setDialog(null)}
        busy={busy}
        setBusy={setBusy}
        settle={settle}
        orgId={orgId}
        documents={documents}
        members={members}
        fixedDocumentId={fixedDocumentId}
        dict={dict}
      />
    </div>
  );
}

function ObligationDialog({
  state,
  onClose,
  busy,
  setBusy,
  settle,
  orgId,
  documents,
  members,
  fixedDocumentId,
  dict,
}: {
  state: DialogState;
  onClose: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  settle: (r: ActionResult<unknown>) => boolean;
  orgId: string;
  documents: Array<{ id: string; reference: string; title: string }>;
  members: Array<{ id: string; name: string }>;
  fixedDocumentId?: string;
  dict: ObligationsDict;
}) {
  const [text, setText] = useState("");
  const [toUser, setToUser] = useState("");
  const item = state && "item" in state ? state.item : undefined;
  const key = state ? `${state.kind}:${item?.id ?? "new"}` : "none";
  const finish = async (p: Promise<ActionResult<unknown>>) => {
    setBusy(true);
    const ok = settle(await p);
    setBusy(false);
    if (ok) {
      setText("");
      setToUser("");
      onClose();
    }
  };
  const textarea = (label: string | undefined, hint?: string) => (
    <label className="text-xs text-ink-muted">
      {label}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className={`${input} py-2`}
      />
      {hint ? <span className="block text-[11px] text-ink-muted">{hint}</span> : null}
    </label>
  );
  const footer = (disabled: boolean, onConfirm: () => void) => (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>
        {dict.cancel}
      </Button>
      <Button disabled={busy || disabled} onClick={onConfirm}>
        {dict.confirm}
      </Button>
    </div>
  );

  if (!state) return null;
  if (state.kind === "new")
    return (
      <Dialog
        open
        onClose={onClose}
        title={(item ? dict.actions.edit : dict.actions.new) ?? ""}
        closeLabel={dict.close}
      >
        <ObligationForm
          key={key}
          orgId={orgId}
          item={item}
          documents={documents}
          members={members}
          fixedDocumentId={fixedDocumentId}
          dict={dict}
          busy={busy}
          onCancel={onClose}
          onSubmit={(payload) =>
            finish(
              item
                ? updateObligationAction(orgId, {
                    ...payload,
                    id: item.id,
                    rowVersion: item.rowVersion,
                  })
                : createObligationAction(orgId, payload),
            )
          }
        />
      </Dialog>
    );
  if (state.kind === "complete")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${dict.actions.complete}: ${item!.title}`}
        closeLabel={dict.close}
      >
        <div className="flex flex-col gap-2">
          {textarea(
            dict.fields.evidence_note,
            item!.requiresEvidence ? dict.evidenceHint : undefined,
          )}
          {footer(item!.requiresEvidence && text.trim().length === 0, () =>
            finish(
              completeObligationAction(orgId, {
                id: item!.id,
                rowVersion: item!.rowVersion,
                note: text.trim() || null,
                documentId: item!.documentId,
              }),
            ),
          )}
        </div>
      </Dialog>
    );
  if (state.kind === "close")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${state.mode === "waive" ? dict.actions.waive : dict.actions.cancel}: ${item!.title}`}
        closeLabel={dict.close}
      >
        <div className="flex flex-col gap-2">
          {textarea(dict.fields.reason, dict.reasonHint)}
          {footer(text.trim().length === 0, () =>
            finish(
              closeObligationAction(orgId, {
                id: item!.id,
                rowVersion: item!.rowVersion,
                reason: text.trim(),
                mode: state.mode,
                documentId: item!.documentId,
              }),
            ),
          )}
        </div>
      </Dialog>
    );
  if (state.kind === "reopen")
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${dict.actions.reopen}: ${item!.title}`}
        closeLabel={dict.close}
      >
        <div className="flex flex-col gap-2">
          {textarea(dict.fields.reason, dict.reasonHint)}
          {footer(text.trim().length === 0, () =>
            finish(
              reopenObligationAction(orgId, {
                id: item!.id,
                reason: text.trim(),
                documentId: item!.documentId,
              }),
            ),
          )}
        </div>
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${dict.actions.escalate}: ${item!.title}`}
      closeLabel={dict.close}
    >
      <div className="flex flex-col gap-2">
        <label className="text-xs text-ink-muted">
          {dict.fields.escalate_to}
          <select value={toUser} onChange={(e) => setToUser(e.target.value)} className={input}>
            <option value="">–</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {textarea(dict.fields.note, dict.escalateHint)}
        {footer(!toUser, () =>
          finish(
            escalateObligationAction(orgId, {
              id: item!.id,
              toUserId: toUser,
              note: text.trim() || null,
              documentId: item!.documentId,
            }),
          ),
        )}
      </div>
    </Dialog>
  );
}

function ObligationForm({
  item,
  documents,
  members,
  fixedDocumentId,
  dict,
  busy,
  onCancel,
  onSubmit,
}: {
  orgId: string;
  item?: ObligationRow;
  documents: Array<{ id: string; reference: string; title: string }>;
  members: Array<{ id: string; name: string }>;
  fixedDocumentId?: string;
  dict: ObligationsDict;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [documentId, setDocumentId] = useState(fixedDocumentId ?? item?.documentId ?? "");
  const [kind, setKind] = useState(item?.kind ?? "obligation");
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [dueOn, setDueOn] = useState(item?.dueOn ?? todayIso());
  const [owner, setOwner] = useState(item?.ownerUserId ?? "");
  const [side, setSide] = useState(item?.side ?? "ours");
  const [amount, setAmount] = useState(
    item?.amountCents !== null && item ? String(item.amountCents / 100) : "",
  );
  const [currency, setCurrency] = useState(item?.currency ?? "AED");
  const [recurrence, setRecurrence] = useState(
    item?.recurrenceMonths ? String(item.recurrenceMonths) : "",
  );
  const [requiresEvidence, setRequiresEvidence] = useState(item?.requiresEvidence ?? true);
  const [risk, setRisk] = useState(item?.riskLevel ?? "");
  const [clause, setClause] = useState(item?.clauseRef ?? "");
  const valid = documentId && title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(dueOn);
  return (
    <div className="flex flex-col gap-2">
      {!fixedDocumentId ? (
        <label className="text-xs text-ink-muted">
          {dict.fields.document}
          <select
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            className={input}
            disabled={Boolean(item)}
          >
            <option value="">–</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.reference} · {d.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          {dict.fields.kind}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ObligationRow["kind"])}
            className={input}
          >
            {Object.entries(dict.kinds).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.due_on}
          <input
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            className={input}
          />
        </label>
      </div>
      <label className="text-xs text-ink-muted">
        {dict.fields.title}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className={input}
        />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.fields.description}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`${input} py-2`}
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          {dict.fields.owner}
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={input}>
            <option value="">–</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.side}
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "ours" | "theirs")}
            className={input}
          >
            {Object.entries(dict.sides).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.amount}
          <input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={input}
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.currency}
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            className={input}
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.recurrence}
          <input
            type="number"
            min={1}
            max={120}
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className={input}
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.risk_level}
          <select
            value={risk}
            onChange={(e) => setRisk(e.target.value as "" | "low" | "medium" | "high")}
            className={input}
          >
            <option value="">–</option>
            {Object.entries(dict.risk).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          {dict.fields.clause}
          <input
            value={clause}
            onChange={(e) => setClause(e.target.value)}
            maxLength={80}
            className={input}
          />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm text-ink">
          <input
            type="checkbox"
            checked={requiresEvidence}
            onChange={(e) => setRequiresEvidence(e.target.checked)}
          />
          {dict.fields.requires_evidence}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {dict.cancel}
        </Button>
        <Button
          disabled={busy || !valid}
          onClick={() =>
            onSubmit({
              documentId,
              kind,
              title: title.trim(),
              description: description.trim() || null,
              dueOn,
              ownerUserId: owner || null,
              side,
              amountCents: amount ? Math.round(Number(amount) * 100) : null,
              currency: amount ? currency : null,
              recurrenceMonths: recurrence ? Number(recurrence) : null,
              requiresEvidence,
              riskLevel: risk || null,
              clauseRef: clause.trim() || null,
            })
          }
        >
          {dict.confirm}
        </Button>
      </div>
    </div>
  );
}
