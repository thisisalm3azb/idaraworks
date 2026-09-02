"use client";

import { useState } from "react";
import { Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { DocumentDetail, RevisionDiff } from "@/modules/docstudio/service";
import { diffRevisionsAction } from "../studio-actions";

export type RevisionsDict = {
  title: string;
  compare: string;
  from: string;
  to: string;
  working: string;
  frozen: string;
  hash: string;
  added: string;
  removed: string;
  changed: string;
  moved: string;
  unchanged: string;
  noDiff: string;
  view: string;
};

export function RevisionsPane({
  orgId,
  documentId,
  detail,
  dict,
  locale,
}: {
  orgId: string;
  documentId: string;
  detail: DocumentDetail;
  dict: RevisionsDict;
  locale: string;
}) {
  const revs = detail.revisions;
  const [from, setFrom] = useState(
    revs.length > 1 ? revs[revs.length - 2]!.id : (revs[0]?.id ?? ""),
  );
  const [to, setTo] = useState(revs[revs.length - 1]?.id ?? "");
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const select = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
  const fmt = (iso: string) => formatDateTime(iso, { locale: locale as "en" | "ar" });

  const compare = async () => {
    setBusy(true);
    setError(null);
    const res = await diffRevisionsAction(orgId, { beforeId: from, afterId: to });
    setBusy(false);
    if (res.ok) setDiff(res.data);
    else setError(res.error);
  };

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <h2 className="mb-2 text-sm font-semibold text-ink">{dict.title}</h2>
        <ol className="flex flex-col gap-2">
          {revs.map((r) => (
            <li key={r.id} className="rounded-md border border-line p-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">#{r.revisionNo}</span>
                <span className="text-xs text-ink-muted">
                  {r.state === "working" ? dict.working : dict.frozen}
                </span>
              </div>
              <div className="text-xs text-ink-secondary">{fmt(r.frozenAt ?? r.createdAt)}</div>
              {r.note ? <div className="text-xs text-ink-secondary">{r.note}</div> : null}
              {r.contentHash ? (
                <div
                  className="truncate font-mono text-[10px] text-ink-muted"
                  title={r.contentHash}
                >
                  {dict.hash}: <bdi dir="ltr">{r.contentHash.slice(0, 16)}</bdi>
                </div>
              ) : null}
              <a
                href={`/api/o/${orgId}/documents/studio/${documentId}?rev=${r.id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block min-h-9 text-xs text-accent underline"
              >
                {dict.view}
              </a>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-lg border border-line bg-card p-3 shadow-card lg:col-span-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">
            {dict.from}
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={`${select} mt-1 block`}
            >
              {revs.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.revisionNo}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.to}
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={`${select} mt-1 block`}
            >
              {revs.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.revisionNo}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            disabled={busy || !from || !to || from === to}
            onClick={compare}
          >
            {dict.compare}
          </Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        {diff ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-xs text-ink-muted">
              {dict.added} {diff.summary.added} · {dict.removed} {diff.summary.removed} ·{" "}
              {dict.changed} {diff.summary.changed} · {dict.moved} {diff.summary.moved} ·{" "}
              {dict.unchanged} {diff.summary.unchanged}
            </p>
            {diff.changes.filter((c) => c.kind !== "unchanged").length === 0 ? (
              <p className="text-sm text-ink-secondary">{dict.noDiff}</p>
            ) : null}
            {diff.changes.map((c) => {
              if (c.kind === "unchanged") return null;
              const tone =
                c.kind === "added"
                  ? "border-success bg-success-soft"
                  : c.kind === "removed"
                    ? "border-danger bg-danger-soft"
                    : c.kind === "moved"
                      ? "border-line bg-sunken"
                      : "border-warning-soft bg-warning-soft";
              return (
                <div key={`${c.kind}:${c.id}`} className={`rounded-md border p-2 text-sm ${tone}`}>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    {dict[c.kind]} · {c.type} · <bdi dir="ltr">{c.id}</bdi>
                  </div>
                  {c.kind === "changed" && c.words ? (
                    <div className="mt-1 flex flex-col gap-1">
                      {(["en", "ar"] as const).map((l) =>
                        c.words?.[l] ? (
                          <p
                            key={l}
                            lang={l}
                            dir={l === "ar" ? "rtl" : "ltr"}
                            className="leading-relaxed"
                          >
                            {c.words[l]!.map((w, i) =>
                              w.op === "eq" ? (
                                <span key={i}>{w.text}</span>
                              ) : w.op === "ins" ? (
                                <ins
                                  key={i}
                                  className="rounded bg-success-soft px-0.5 text-success no-underline"
                                >
                                  {w.text}
                                </ins>
                              ) : (
                                <del key={i} className="rounded bg-danger-soft px-0.5 text-danger">
                                  {w.text}
                                </del>
                              ),
                            )}
                          </p>
                        ) : null,
                      )}
                    </div>
                  ) : c.kind === "changed" ? (
                    <pre className="mt-1 overflow-x-auto text-xs">
                      {JSON.stringify(c.after, null, 1)}
                    </pre>
                  ) : c.kind === "added" ? (
                    <pre className="mt-1 overflow-x-auto text-xs">
                      {JSON.stringify(c.after, null, 1)}
                    </pre>
                  ) : c.kind === "removed" ? (
                    <pre className="mt-1 overflow-x-auto text-xs">
                      {JSON.stringify(c.before, null, 1)}
                    </pre>
                  ) : (
                    <p className="text-xs text-ink-secondary">
                      {c.from + 1} → {c.to + 1}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
