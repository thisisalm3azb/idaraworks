"use client";

/**
 * H26 — a form document's links and the submissions it received. Links are
 * shown once when minted (only their hash is stored).
 */
import { useState } from "react";
import Link from "next/link";
import { Badge, Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { FormLinkRow, SubmissionRow } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import { createFormLinkAction, revokeFormLinkAction } from "../studio-actions";

export type FormsDict = {
  title: string;
  notForm: string;
  notActive: string;
  links: string;
  newLink: string;
  label: string;
  expiresInDays: string;
  maxUses: string;
  unlimited: string;
  create: string;
  linkOnce: string;
  copy: string;
  uses: string;
  expires: string;
  revoked: string;
  revoke: string;
  submissions: string;
  noSubmissions: string;
  inbox: string;
  status: Record<string, string>;
};

export function FormsPane({
  orgId,
  documentId,
  category,
  status,
  links,
  submissions,
  canManage,
  locale,
  dict,
  settle,
}: {
  orgId: string;
  documentId: string;
  category: string;
  status: string;
  links: FormLinkRow[];
  submissions: SubmissionRow[];
  canManage: boolean;
  locale: string;
  dict: FormsDict;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
}) {
  const l = locale as "en" | "ar";
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [maxUses, setMaxUses] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  if (category !== "form")
    return (
      <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-secondary">{dict.notForm}</p>
    );

  return (
    <div className="flex flex-col gap-3">
      {minted ? (
        <section className="rounded-lg border border-warning-soft bg-warning-soft p-3">
          <p className="text-xs text-ink-secondary">{dict.linkOnce}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="truncate rounded bg-card px-2 py-1 text-xs">
              <bdi dir="ltr">{minted}</bdi>
            </code>
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(minted)}>
              {dict.copy}
            </Button>
          </div>
        </section>
      ) : null}
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <h3 className="text-sm font-semibold text-ink">{dict.links}</h3>
        {status !== "active" ? (
          <p className="mt-1 text-xs text-ink-muted">{dict.notActive}</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-1">
          {links.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{k.label ?? k.id.slice(0, 8)}</span>
              <span className="text-xs text-ink-muted">
                {dict.uses}: {k.useCount}
                {k.maxUses ? ` / ${k.maxUses}` : ""}
              </span>
              <span className="text-xs text-ink-muted">
                {dict.expires} {formatDateTime(k.expiresAt, { locale: l })}
              </span>
              {k.revokedAt ? (
                <Badge tone="danger">{dict.revoked}</Badge>
              ) : canManage ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    settle(await revokeFormLinkAction(orgId, { linkId: k.id }));
                    setBusy(false);
                  }}
                >
                  {dict.revoke}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage && status === "active" ? (
          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 sm:grid-cols-4">
            <label className="text-xs text-ink-muted">
              {dict.label}
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                className={input}
              />
            </label>
            <label className="text-xs text-ink-muted">
              {dict.expiresInDays}
              <input
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className={input}
              />
            </label>
            <label className="text-xs text-ink-muted">
              {dict.maxUses}
              <input
                type="number"
                min={1}
                value={maxUses}
                placeholder={dict.unlimited}
                onChange={(e) => setMaxUses(e.target.value)}
                className={input}
              />
            </label>
            <div className="flex items-end">
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const res = await createFormLinkAction(orgId, {
                    documentId,
                    label: label.trim() || undefined,
                    expiresInDays: days,
                    maxUses: maxUses ? Number(maxUses) : null,
                  });
                  setBusy(false);
                  if (settle(res)) setMinted(res.ok ? res.data.url : null);
                }}
              >
                {dict.create}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{dict.submissions}</h3>
          <Link href={`/o/${orgId}/documents/forms`} className="text-xs text-accent underline">
            {dict.inbox}
          </Link>
        </div>
        {submissions.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">{dict.noSubmissions}</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-1">
          {submissions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge
                tone={
                  s.status === "received"
                    ? "warning"
                    : s.status === "converted"
                      ? "success"
                      : "neutral"
                }
              >
                {dict.status[s.status] ?? s.status}
              </Badge>
              <span className="text-ink">{s.submitterName ?? s.submitterEmail ?? "–"}</span>
              <span className="text-xs text-ink-muted">
                {formatDateTime(s.submittedAt, { locale: l })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
