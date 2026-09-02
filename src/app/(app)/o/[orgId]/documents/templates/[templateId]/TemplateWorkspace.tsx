"use client";

/**
 * H26 — one organisation template: metadata, the draft version in the same
 * builder documents use, and the immutable published versions. Publishing
 * never rewrites a document created from an earlier version (ADR-19).
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { DocBody, DocSettings, TemplateDetail } from "@/modules/docstudio/service";
import type { ActionResult } from "../../studio-actions";
import {
  publishTemplateAction,
  retireTemplateAction,
  updateTemplateAction,
} from "../../studio-actions";
import { Builder, type BuilderDict } from "../../[documentId]/Builder";
import type { Vocabulary } from "../../[documentId]/BlockEditor";

export type TemplateDict = {
  nameEn: string;
  nameAr: string;
  description: string;
  category: string;
  language: string;
  workflow: string;
  noWorkflow: string;
  save: string;
  publish: string;
  publishHint: string;
  retire: string;
  retireHint: string;
  versions: string;
  version: string;
  published: string;
  draft: string;
  retired: string;
  current: string;
  changeNote: string;
  draftBody: string;
  draftBodyHint: string;
  builtinFrom: string;
  saved: string;
  failed: string;
  conflict: string;
  status: Record<string, string>;
};

export function TemplateWorkspace({
  orgId,
  locale,
  template,
  workflows,
  categories,
  languages,
  dict,
  builder,
  blockTypes,
  bindings,
  vocab,
}: {
  orgId: string;
  locale: string;
  template: TemplateDetail;
  workflows: Array<{ id: string; name: string }>;
  categories: Record<string, string>;
  languages: Record<string, string>;
  dict: TemplateDict;
  builder: BuilderDict;
  blockTypes: Record<string, string>;
  bindings: Record<string, string>;
  vocab: Vocabulary;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [nameEn, setNameEn] = useState(template.nameEn);
  const [nameAr, setNameAr] = useState(template.nameAr);
  const [description, setDescription] = useState(template.description ?? "");
  const [category, setCategory] = useState(template.category);
  const [language, setLanguage] = useState(template.language);
  const [workflowId, setWorkflowId] = useState(template.workflowId ?? "");
  const [changeNote, setChangeNote] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  useEffect(() => {
    if (!notice || notice.tone !== "ok") return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const settle = useCallback(
    (res: ActionResult<unknown>, okText = dict.saved, quiet = false): boolean => {
      if (res.ok) {
        if (!quiet) setNotice({ tone: "ok", text: okText });
        startTransition(() => router.refresh());
      } else {
        setNotice({
          tone: "error",
          text: res.code === "conflict" ? dict.conflict : `${dict.failed}: ${res.error}`,
        });
      }
      return res.ok;
    },
    [dict.saved, dict.failed, dict.conflict, router],
  );

  const draft = template.versions.find((v) => v.publishedAt === null) ?? null;
  const latest = template.versions[0] ?? null;
  // The builder edits the draft version, or starts one from the latest published body.
  const editing = draft ?? latest;
  const revisionLike = editing
    ? {
        id: editing.id,
        revisionNo: editing.version,
        state: "working" as const,
        body: editing.body,
        variables: {},
        settings: editing.settings as DocSettings,
        contentHash: null,
        note: null,
        frozenAt: null,
        rowVersion: 1,
        createdAt: editing.createdAt,
        updatedAt: editing.createdAt,
      }
    : null;

  const saveMeta = async () => {
    setBusy(true);
    const res = await updateTemplateAction(orgId, {
      templateId: template.id,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
      description: description.trim() || null,
      category,
      language,
      workflowId: workflowId || null,
    });
    setBusy(false);
    settle(res);
  };

  const saveBody = async (snapshot: {
    body: DocBody;
    variables: Record<string, unknown>;
    settings: DocSettings;
  }): Promise<ActionResult<{ rowVersion: number; savedAt: string }>> => {
    const res = await updateTemplateAction(orgId, {
      templateId: template.id,
      body: snapshot.body,
      settings: snapshot.settings,
      language,
    });
    if (!res.ok) return res;
    return { ok: true, data: { rowVersion: 1, savedAt: new Date().toISOString() } };
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-ink-muted">
              <bdi dir="ltr">{template.key}</bdi>
            </span>
            <Badge tone={template.status === "published" ? "success" : "neutral"}>
              {dict.status[template.status] ?? template.status}
            </Badge>
            {template.currentVersion > 0 ? (
              <span className="text-xs text-ink-muted">
                {dict.current} v{template.currentVersion}
              </span>
            ) : null}
          </div>
          <h1 className="text-lg font-semibold text-ink">
            {locale === "ar" ? template.nameAr : template.nameEn}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {template.status !== "retired" ? (
            <Button
              disabled={busy || !draft}
              onClick={async () => {
                setBusy(true);
                const res = await publishTemplateAction(orgId, {
                  templateId: template.id,
                  changeNote: changeNote.trim() || undefined,
                });
                setBusy(false);
                setChangeNote("");
                settle(res);
              }}
              title={dict.publishHint}
            >
              {dict.publish}
            </Button>
          ) : null}
          {template.status !== "retired" ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                settle(await retireTemplateAction(orgId, { templateId: template.id }));
                setBusy(false);
              }}
              title={dict.retireHint}
            >
              {dict.retire}
            </Button>
          ) : null}
        </div>
      </div>
      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <section className="grid grid-cols-1 gap-2 rounded-lg border border-line bg-card p-3 shadow-card lg:col-span-2 sm:grid-cols-2">
          <label className="text-xs text-ink-muted">
            {dict.nameEn}
            <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className={input} />
          </label>
          <label className="text-xs text-ink-muted">
            {dict.nameAr}
            <input
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              dir="rtl"
              className={input}
            />
          </label>
          <label className="text-xs text-ink-muted sm:col-span-2">
            {dict.description}
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={input}
            />
          </label>
          <label className="text-xs text-ink-muted">
            {dict.category}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
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
              onChange={(e) => setLanguage(e.target.value as typeof language)}
              className={input}
            >
              {Object.entries(languages).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.workflow}
            <select
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
              className={input}
            >
              <option value="">{dict.noWorkflow}</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.changeNote}
            <input
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              maxLength={1000}
              className={input}
            />
          </label>
          <div className="sm:col-span-2">
            <Button variant="secondary" disabled={busy} onClick={saveMeta}>
              {dict.save}
            </Button>
          </div>
        </section>
        <section className="rounded-lg border border-line bg-card p-3 shadow-card">
          <h2 className="mb-2 text-sm font-semibold text-ink">{dict.versions}</h2>
          <ol className="flex flex-col gap-2">
            {template.versions.map((v) => (
              <li key={v.id} className="rounded-md border border-line p-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">
                    {dict.version} {v.version}
                  </span>
                  <Badge tone={v.publishedAt ? "success" : "neutral"}>
                    {v.publishedAt ? dict.published : dict.draft}
                  </Badge>
                </div>
                <div className="text-xs text-ink-secondary">
                  {formatDateTime(v.publishedAt ?? v.createdAt, { locale: locale as "en" | "ar" })}
                </div>
                {v.changeNote ? (
                  <div className="text-xs text-ink-secondary">{v.changeNote}</div>
                ) : null}
                <div className="text-xs text-ink-muted">
                  {v.body.blocks.length} {blockTypes.section ? "" : ""}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink">{dict.draftBody}</h2>
        <p className="text-xs text-ink-muted">{dict.draftBodyHint}</p>
        {revisionLike ? (
          <Builder
            key={`${revisionLike.id}:${template.versions.length}`}
            orgId={orgId}
            documentId={template.id ?? ""}
            language={language}
            revision={revisionLike}
            readOnly={template.status === "retired"}
            settle={settle}
            dict={builder}
            blockTypes={blockTypes}
            bindings={bindings}
            vocab={vocab}
            save={saveBody}
          />
        ) : null}
      </section>
    </div>
  );
}
