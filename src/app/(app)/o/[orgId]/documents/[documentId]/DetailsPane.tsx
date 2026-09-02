"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/platform/ui";
import type { DocumentDetail } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import { updateDocumentAction } from "../studio-actions";

export type DetailsDict = {
  title: string;
  reference: string;
  docTitle: string;
  category: string;
  language: string;
  counterparty: string;
  record: string;
  folder: string;
  noFolder: string;
  tags: string;
  effectiveFrom: string;
  expires: string;
  issuedAt: string;
  frozenNote: string;
  save: string;
  supersedes: string;
  supersededBy: string;
  languages: Record<string, string>;
};

export function DetailsPane({
  orgId,
  detail,
  folders,
  canEdit,
  issued,
  dict,
  categories,
  counterparty,
  recordKinds,
  settle,
}: {
  orgId: string;
  detail: DocumentDetail;
  folders: Array<{ id: string; name: string }>;
  canEdit: boolean;
  issued: boolean;
  dict: DetailsDict;
  categories: Record<string, string>;
  counterparty: Record<string, string>;
  recordKinds: Record<string, string>;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
}) {
  const d = detail.document;
  const [title, setTitle] = useState(d.title);
  const [category, setCategory] = useState(d.category);
  const [language, setLanguage] = useState(d.language);
  const [folderId, setFolderId] = useState(d.folderId ?? "");
  const [tags, setTags] = useState(d.tags.join(", "));
  const [effectiveFrom, setEffectiveFrom] = useState(d.effectiveFrom ?? "");
  const [expiresAt, setExpiresAt] = useState(d.expiresAt ?? "");
  const [busy, setBusy] = useState(false);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink disabled:bg-sunken";

  const save = async () => {
    setBusy(true);
    const res = await updateDocumentAction(orgId, {
      documentId: d.id,
      expectedRowVersion: d.rowVersion,
      ...(issued
        ? {}
        : {
            title: title.trim(),
            category,
            language,
            effectiveFrom: effectiveFrom || null,
          }),
      folderId: folderId || null,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
      expiresAt: expiresAt || null,
    });
    setBusy(false);
    settle(res);
  };

  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-card p-3 shadow-card sm:grid-cols-2">
      <div className="text-xs text-ink-muted">
        {dict.reference}
        <div className="mt-1 font-mono text-sm text-ink">
          <bdi dir="ltr">{d.reference}</bdi>
        </div>
      </div>
      {d.issuedAt ? (
        <div className="text-xs text-ink-muted">
          {dict.issuedAt}
          <div className="mt-1 text-sm text-ink">{d.issuedAt.slice(0, 10)}</div>
        </div>
      ) : (
        <div />
      )}
      {issued ? (
        <p className="text-xs text-ink-secondary sm:col-span-2">{dict.frozenNote}</p>
      ) : null}
      <label className="text-xs text-ink-muted sm:col-span-2">
        {dict.docTitle}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit || issued}
          className={input}
        />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.category}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={!canEdit || issued}
          className={input}
        >
          {Object.entries(categories).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted">
        {dict.language}
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={!canEdit || issued}
          className={input}
        >
          {Object.entries(dict.languages).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <div className="text-xs text-ink-muted">
        {dict.counterparty}
        <div className="mt-1 text-sm text-ink">
          {d.counterpartyKind
            ? `${counterparty[d.counterpartyKind] ?? d.counterpartyKind}${d.counterpartyLabel ? ` · ${d.counterpartyLabel}` : ""}`
            : "–"}
        </div>
      </div>
      <div className="text-xs text-ink-muted">
        {dict.record}
        <div className="mt-1 text-sm text-ink">
          {d.recordType
            ? `${recordKinds[d.recordType] ?? d.recordType} · ${d.recordId?.slice(0, 8)}`
            : "–"}
        </div>
      </div>
      <label className="text-xs text-ink-muted">
        {dict.folder}
        <select
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          disabled={!canEdit}
          className={input}
        >
          <option value="">{dict.noFolder}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted">
        {dict.tags}
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          disabled={!canEdit}
          className={input}
        />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.effectiveFrom}
        <input
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          disabled={!canEdit || issued}
          className={input}
        />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.expires}
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          disabled={!canEdit}
          className={input}
        />
      </label>
      {d.supersedesDocumentId ? (
        <p className="text-xs text-ink-secondary">
          {dict.supersedes}:{" "}
          <Link
            href={`/o/${orgId}/documents/${d.supersedesDocumentId}`}
            className="text-accent underline"
          >
            <bdi dir="ltr">{d.supersedesDocumentId.slice(0, 8)}</bdi>
          </Link>
        </p>
      ) : null}
      {d.supersededByDocumentId ? (
        <p className="text-xs text-ink-secondary">
          {dict.supersededBy}:{" "}
          <Link
            href={`/o/${orgId}/documents/${d.supersededByDocumentId}`}
            className="text-accent underline"
          >
            <bdi dir="ltr">{d.supersededByDocumentId.slice(0, 8)}</bdi>
          </Link>
        </p>
      ) : null}
      {canEdit ? (
        <div className="sm:col-span-2">
          <Button disabled={busy} onClick={save}>
            {dict.save}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
