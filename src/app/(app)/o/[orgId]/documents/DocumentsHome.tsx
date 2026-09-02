"use client";

/**
 * H26 — the library and command centre. One list of documents (the server's
 * window), projected as a list, a status board, a timeline or a relationship
 * graph. Filters are client-side over the window and can be saved as views.
 */
import { useCallback, useEffect, useMemo, useState, useTransition, lazy, Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { formatDate } from "@/platform/format";
import type { DocumentRow, FolderRow, SavedViewRow, ViewConfig } from "@/modules/docstudio/service";
import { saveViewAction, updateViewAction } from "./studio-actions";
import { DocCommandPalette, type PaletteCommand, type PaletteDict } from "./DocCommandPalette";

const RelationshipGraph = lazy(() => import("./RelationshipGraph"));

export type HomeDict = {
  status: Record<string, string>;
  category: Record<string, string>;
  counterparty: Record<string, string>;
  kpi: {
    drafts: string;
    review: string;
    signature: string;
    active: string;
    expiring: string;
    window: string;
  };
  filter: {
    search: string;
    status: string;
    category: string;
    folder: string;
    tag: string;
    all: string;
    clear: string;
    noFolder: string;
  };
  layout: { list: string; board: string; timeline: string; graph: string };
  views: { title: string; save: string; name: string; shared: string; remove: string };
  columns: {
    reference: string;
    title: string;
    status: string;
    counterparty: string;
    updated: string;
    expires: string;
  };
  empty: { title: string; body: string; filtered: string };
  timelineNone: string;
  newDocument: string;
  saved: string;
  failed: string;
  cancel: string;
  palette: PaletteDict;
  paletteCommands: PaletteCommand[];
};

type Layout = "list" | "board" | "timeline" | "graph";

const STATUS_TONE: Record<string, string> = {
  draft: "bg-sunken text-ink-secondary",
  review: "bg-info-soft text-ink",
  approval: "bg-info-soft text-ink",
  signature: "bg-warning-soft text-ink",
  active: "bg-success-soft text-success",
  expired: "bg-danger-soft text-danger",
  terminated: "bg-danger-soft text-danger",
  superseded: "bg-sunken text-ink-muted",
  archived: "bg-sunken text-ink-muted",
};

const BOARD_COLUMNS = ["draft", "review", "approval", "signature", "active", "expired"] as const;

export function DocumentsHome({
  orgId,
  locale,
  rows,
  total,
  folders,
  tags,
  views,
  initialViewId,
  canCreate,
  dict,
}: {
  orgId: string;
  locale: string;
  rows: DocumentRow[];
  total: number;
  folders: FolderRow[];
  tags: Array<{ tag: string; count: number }>;
  views: SavedViewRow[];
  initialViewId: string | null;
  canCreate: boolean;
  dict: HomeDict;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const initial = views.find((v) => v.id === initialViewId)?.config ?? {};
  const [search, setSearch] = useState(initial.search ?? "");
  const [status, setStatus] = useState<string[]>(initial.status ?? []);
  const [category, setCategory] = useState<string[]>(initial.category ?? []);
  const [folderId, setFolderId] = useState<string | null | undefined>(initial.folderId);
  const [tag, setTag] = useState<string | undefined>(initial.tag);
  const [layout, setLayout] = useState<Layout>(initial.layout ?? "list");
  const [viewName, setViewName] = useState("");
  const [viewShared, setViewShared] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [activeView, setActiveView] = useState<string | null>(initialViewId);

  useEffect(() => {
    if (!notice || notice.tone !== "ok") return;
    const id = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(id);
  }, [notice]);

  // Read once per mount: a render must not call the clock (React purity rule).
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [in30] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const live = useMemo(() => rows.filter((r) => r.status !== "archived"), [rows]);
  const kpis = useMemo(
    () => ({
      drafts: live.filter((r) => r.effectiveStatus === "draft").length,
      review: live.filter((r) => r.effectiveStatus === "review" || r.effectiveStatus === "approval")
        .length,
      signature: live.filter((r) => r.effectiveStatus === "signature").length,
      active: live.filter((r) => r.effectiveStatus === "active").length,
      expiring: live.filter(
        (r) =>
          r.effectiveStatus === "active" &&
          r.expiresAt !== null &&
          r.expiresAt >= today &&
          r.expiresAt <= in30,
      ).length,
    }),
    [live, today, in30],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status.length === 0 && r.status === "archived") return false;
      if (status.length > 0 && !status.includes(r.effectiveStatus)) return false;
      if (category.length > 0 && !category.includes(r.category)) return false;
      if (folderId !== undefined && (r.folderId ?? null) !== folderId) return false;
      if (tag && !r.tags.includes(tag)) return false;
      if (
        q &&
        !`${r.title} ${r.reference} ${r.counterpartyLabel ?? ""} ${r.tags.join(" ")}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [rows, search, status, category, folderId, tag]);

  const hasFilters =
    search !== "" ||
    status.length > 0 ||
    category.length > 0 ||
    folderId !== undefined ||
    tag !== undefined;
  const clear = () => {
    setSearch("");
    setStatus([]);
    setCategory([]);
    setFolderId(undefined);
    setTag(undefined);
    setActiveView(null);
  };
  const applyView = (v: SavedViewRow) => {
    const c = v.config;
    setSearch(c.search ?? "");
    setStatus(c.status ?? []);
    setCategory(c.category ?? []);
    setFolderId(c.folderId);
    setTag(c.tag);
    setLayout(c.layout ?? "list");
    setActiveView(v.id);
  };
  const currentConfig = (): ViewConfig => ({
    ...(search ? { search } : {}),
    ...(status.length ? { status } : {}),
    ...(category.length ? { category } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
    ...(tag ? { tag } : {}),
    layout,
  });
  const saveView = useCallback(async () => {
    if (!viewName.trim()) return;
    const res = await saveViewAction(orgId, {
      name: viewName.trim(),
      config: currentConfig(),
      isShared: viewShared,
    });
    if (res.ok) {
      setNotice({ tone: "ok", text: dict.saved });
      setViewName("");
      setActiveView(res.data.id);
      startTransition(() => router.refresh());
    } else setNotice({ tone: "error", text: `${dict.failed}: ${res.error}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, viewName, viewShared, search, status, category, folderId, tag, layout]);
  const removeView = async (id: string) => {
    const res = await updateViewAction(orgId, { viewId: id, remove: true });
    if (res.ok) {
      if (activeView === id) setActiveView(null);
      startTransition(() => router.refresh());
    } else setNotice({ tone: "error", text: `${dict.failed}: ${res.error}` });
  };

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const cp = (r: DocumentRow) =>
    r.counterpartyLabel ??
    (r.counterpartyKind ? (dict.counterparty[r.counterpartyKind] ?? r.counterpartyKind) : "");
  const fmt = (iso: string | null) =>
    iso ? formatDate(iso, { locale: locale as "en" | "ar" }) : "";
  const chip = "min-h-9 rounded-full border px-3 text-xs";
  const on = "border-accent-line bg-accent-soft text-ink";
  const off = "border-line bg-card text-ink-secondary hover:bg-sunken";

  return (
    <>
      <div className="flex justify-end">
        <DocCommandPalette
          rows={rows}
          commands={dict.paletteCommands}
          statusLabels={dict.status}
          orgId={orgId}
          dict={dict.palette}
        />
      </div>
      <div className="flex flex-col gap-4">
        <section aria-label={dict.kpi.window} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(
            [
              ["drafts", kpis.drafts, ["draft"]],
              ["review", kpis.review, ["review", "approval"]],
              ["signature", kpis.signature, ["signature"]],
              ["active", kpis.active, ["active"]],
              ["expiring", kpis.expiring, ["active"]],
            ] as const
          ).map(([key, value, statuses]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setStatus([...statuses]);
                setActiveView(null);
              }}
              className="rounded-lg border border-line bg-card p-3 text-start shadow-card hover:bg-sunken"
            >
              <div className="text-2xl font-semibold tabular-nums text-ink">{value}</div>
              <div className="text-xs text-ink-muted">{dict.kpi[key]}</div>
            </button>
          ))}
          {total > rows.length ? (
            <p className="col-span-full text-xs text-ink-muted">{dict.kpi.window}</p>
          ) : null}
        </section>

        {notice ? (
          <p
            className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
            role="status"
          >
            {notice.text}
          </p>
        ) : null}

        <section className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3 shadow-card">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={dict.filter.search}
              aria-label={dict.filter.search}
              className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            />
            <div role="group" aria-label={dict.layout.list} className="flex gap-1">
              {(["list", "board", "timeline", "graph"] as Layout[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={layout === l}
                  onClick={() => setLayout(l)}
                  className={`${chip} ${layout === l ? on : off}`}
                >
                  {dict.layout[l]}
                </button>
              ))}
            </div>
          </div>
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={dict.filter.status}
          >
            <span className="me-1 text-xs text-ink-muted">{dict.filter.status}</span>
            {Object.entries(dict.status).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={status.includes(k)}
                onClick={() => toggle(status, setStatus, k)}
                className={`${chip} ${status.includes(k) ? on : off}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={dict.filter.category}
          >
            <span className="me-1 text-xs text-ink-muted">{dict.filter.category}</span>
            {Object.entries(dict.category).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={category.includes(k)}
                onClick={() => toggle(category, setCategory, k)}
                className={`${chip} ${category.includes(k) ? on : off}`}
              >
                {label}
              </button>
            ))}
          </div>
          {folders.length > 0 || tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {folders.length > 0 ? (
                <label className="text-xs text-ink-muted">
                  {dict.filter.folder}
                  <select
                    value={folderId === undefined ? "" : (folderId ?? "none")}
                    onChange={(e) =>
                      setFolderId(
                        e.target.value === ""
                          ? undefined
                          : e.target.value === "none"
                            ? null
                            : e.target.value,
                      )
                    }
                    className="ms-1 min-h-9 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                  >
                    <option value="">{dict.filter.all}</option>
                    <option value="none">{dict.filter.noFolder}</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({f.documents})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {tags.length > 0 ? (
                <label className="text-xs text-ink-muted">
                  {dict.filter.tag}
                  <select
                    value={tag ?? ""}
                    onChange={(e) => setTag(e.target.value || undefined)}
                    className="ms-1 min-h-9 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                  >
                    <option value="">{dict.filter.all}</option>
                    {tags.map((x) => (
                      <option key={x.tag} value={x.tag}>
                        {x.tag} ({x.count})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <span className="text-xs text-ink-muted">{dict.views.title}</span>
            {views.map((v) => (
              <span key={v.id} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={activeView === v.id}
                  onClick={() => applyView(v)}
                  className={`${chip} ${activeView === v.id ? on : off}`}
                >
                  {v.name}
                  {v.isShared ? " ·" : ""}
                </button>
                {v.mine ? (
                  <button
                    type="button"
                    aria-label={dict.views.remove}
                    onClick={() => removeView(v.id)}
                    className="min-h-9 px-1 text-xs text-ink-muted hover:text-danger"
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            <input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder={dict.views.name}
              aria-label={dict.views.name}
              className="min-h-9 w-40 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
            />
            <label className="flex items-center gap-1 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={viewShared}
                onChange={(e) => setViewShared(e.target.checked)}
              />
              {dict.views.shared}
            </label>
            <Button variant="secondary" onClick={saveView} disabled={!viewName.trim()}>
              {dict.views.save}
            </Button>
            {hasFilters ? (
              <Button variant="ghost" onClick={clear}>
                {dict.filter.clear}
              </Button>
            ) : null}
          </div>
        </section>

        {rows.length === 0 ? (
          <EmptyState
            title={dict.empty.title}
            description={dict.empty.body}
            action={
              canCreate ? (
                <Link href={`/o/${orgId}/documents/new`}>
                  <Button>{dict.newDocument}</Button>
                </Link>
              ) : null
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={dict.empty.filtered}
            action={
              <Button variant="secondary" onClick={clear}>
                {dict.filter.clear}
              </Button>
            }
          />
        ) : layout === "list" ? (
          <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-start">{dict.columns.reference}</th>
                  <th className="px-3 py-2 text-start">{dict.columns.title}</th>
                  <th className="px-3 py-2 text-start">{dict.columns.status}</th>
                  <th className="hidden px-3 py-2 text-start md:table-cell">
                    {dict.columns.counterparty}
                  </th>
                  <th className="hidden px-3 py-2 text-start md:table-cell">
                    {dict.columns.updated}
                  </th>
                  <th className="hidden px-3 py-2 text-start lg:table-cell">
                    {dict.columns.expires}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-t border-line hover:bg-sunken">
                    <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                      <Link href={`/o/${orgId}/documents/${r.id}`} className="block min-h-9 py-1">
                        <bdi dir="ltr">{r.reference}</bdi>
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/o/${orgId}/documents/${r.id}`}
                        className="block min-h-9 py-1 font-medium text-ink"
                      >
                        {r.title}
                      </Link>
                      <div className="text-xs text-ink-muted">
                        {dict.category[r.category] ?? r.category}
                        {r.tags.length ? ` · ${r.tags.join(", ")}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={STATUS_TONE[r.effectiveStatus] ?? ""}>
                        {dict.status[r.effectiveStatus] ?? r.effectiveStatus}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-2 text-ink-secondary md:table-cell">{cp(r)}</td>
                    <td className="hidden px-3 py-2 text-ink-secondary md:table-cell">
                      {fmt(r.updatedAt)}
                    </td>
                    <td className="hidden px-3 py-2 text-ink-secondary lg:table-cell">
                      {fmt(r.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : layout === "board" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {BOARD_COLUMNS.map((col) => {
              const cards = filtered.filter((r) => r.effectiveStatus === col);
              return (
                <section
                  key={col}
                  className="flex flex-col gap-2 rounded-lg border border-line bg-sunken p-2"
                >
                  <h3 className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    {dict.status[col]} <span className="tabular-nums">{cards.length}</span>
                  </h3>
                  {cards.map((r) => (
                    <Link
                      key={r.id}
                      href={`/o/${orgId}/documents/${r.id}`}
                      className="rounded-md border border-line bg-card p-2 text-sm shadow-card hover:bg-accent-soft"
                    >
                      <div className="font-mono text-xs text-ink-muted">
                        <bdi dir="ltr">{r.reference}</bdi>
                      </div>
                      <div className="font-medium text-ink">{r.title}</div>
                      <div className="text-xs text-ink-secondary">{cp(r)}</div>
                    </Link>
                  ))}
                </section>
              );
            })}
          </div>
        ) : layout === "timeline" ? (
          <Timeline rows={filtered} orgId={orgId} dict={dict} locale={locale} today={today} />
        ) : (
          <Suspense
            fallback={<div className="h-[420px] rounded-lg border border-line bg-sunken" />}
          >
            <RelationshipGraph rows={filtered} orgId={orgId} dict={dict} />
          </Suspense>
        )}
      </div>
    </>
  );
}

function Timeline({
  rows,
  orgId,
  dict,
  locale,
  today,
}: {
  rows: DocumentRow[];
  orgId: string;
  dict: HomeDict;
  locale: string;
  today: string;
}) {
  const dated = rows
    .filter((r) => r.effectiveFrom || r.expiresAt || r.issuedAt)
    .map((r) => ({
      r,
      start: (r.effectiveFrom ?? r.issuedAt ?? r.createdAt).slice(0, 10),
      end: r.expiresAt ?? null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (dated.length === 0) return <EmptyState title={dict.timelineNone} description="" />;
  const min = dated[0]!.start;
  const max = dated.reduce(
    (m, x) => (x.end && x.end > m ? x.end : m),
    dated[dated.length - 1]!.start,
  );
  const t0 = Date.parse(min);
  const span = Math.max(Date.parse(max) - t0, 86_400_000 * 30);
  const pct = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - t0) / span) * 100));
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-card p-3 shadow-card">
      <div className="relative min-w-[640px]">
        <div
          className="absolute inset-y-0 w-px bg-danger"
          style={{ insetInlineStart: `${pct(today)}%` }}
          aria-hidden
        />
        {dated.map(({ r, start, end }) => (
          <div key={r.id} className="relative my-1 h-9">
            <Link
              href={`/o/${orgId}/documents/${r.id}`}
              className={`absolute top-0 flex h-9 min-w-[120px] items-center truncate rounded-md px-2 text-xs ${STATUS_TONE[r.effectiveStatus] ?? "bg-sunken"}`}
              style={{
                insetInlineStart: `${pct(start)}%`,
                width: end ? `${Math.max(pct(end) - pct(start), 6)}%` : "18%",
              }}
              title={`${r.reference} ${r.title} ${formatDate(start, { locale: locale as "en" | "ar" })}${end ? ` → ${formatDate(end, { locale: locale as "en" | "ar" })}` : ""}`}
            >
              <bdi dir="ltr" className="me-1 font-mono">
                {r.reference}
              </bdi>
              {r.title}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
