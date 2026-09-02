"use client";

/**
 * H26 — the forms inbox: every form document with its status, and the
 * quarantined submissions. A reviewer marks, discards, or converts a
 * submission into a record with an explicit field mapping.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { SubmissionRow } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import { convertSubmissionAction, reviewSubmissionAction } from "../studio-actions";

export type SubmissionsDict = {
  title: string;
  subtitle: string;
  forms: string;
  noForms: string;
  newForm: string;
  open: string;
  submissions: string;
  noSubmissions: string;
  status: Record<string, string>;
  docStatus: Record<string, string>;
  submittedAt: string;
  from: string;
  answers: string;
  markReviewed: string;
  discard: string;
  convert: string;
  convertTitle: string;
  convertHint: string;
  target: string;
  targets: Record<string, string>;
  mapping: string;
  mapField: string;
  fromAnswer: string;
  template: string;
  docTitle: string;
  note: string;
  confirm: string;
  cancel: string;
  close: string;
  converted: string;
  showAll: string;
  saved: string;
  failed: string;
};

const TARGET_FIELDS: Record<string, string[]> = {
  customer: ["name", "contactName", "email", "phone", "taxRegNo", "country"],
  lead: ["name", "company", "email", "phone"],
  document: [],
};

export function SubmissionsInbox({
  orgId,
  locale,
  forms,
  submissions,
  templates,
  dict,
}: {
  orgId: string;
  locale: string;
  forms: Array<{ id: string; reference: string; title: string; status: string }>;
  submissions: SubmissionRow[];
  templates: Array<{ value: string; label: string }>;
  dict: SubmissionsDict;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState<SubmissionRow | null>(null);
  const [target, setTarget] = useState<"customer" | "lead" | "document">("customer");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [templateValue, setTemplateValue] = useState("");
  const [title, setTitle] = useState("");
  const l = locale as "en" | "ar";
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

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
    () => submissions.filter((s) => showAll || s.status === "received"),
    [submissions, showAll],
  );
  const formOf = (id: string) => forms.find((f) => f.id === id);
  const answerKeys = converting ? Object.keys(converting.answers) : [];

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
        >
          {notice.text}
        </p>
      ) : null}
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{dict.forms}</h2>
          <Link
            href={`/o/${orgId}/documents/new?template=builtin.intake_form`}
            className="min-h-9 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-sunken"
          >
            {dict.newForm}
          </Link>
        </div>
        {forms.length === 0 ? <p className="mt-2 text-sm text-ink-muted">{dict.noForms}</p> : null}
        <ul className="mt-2 flex flex-col gap-1">
          {forms.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-ink-muted">
                <bdi dir="ltr">{f.reference}</bdi>
              </span>
              <Link
                href={`/o/${orgId}/documents/${f.id}?tab=forms`}
                className="font-medium text-ink underline"
              >
                {f.title}
              </Link>
              <Badge tone={f.status === "active" ? "success" : "neutral"}>
                {dict.docStatus[f.status] ?? f.status}
              </Badge>
              <span className="text-xs text-ink-muted">
                {submissions.filter((s) => s.documentId === f.id && s.status === "received").length}{" "}
                {dict.submissions.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{dict.submissions}</h2>
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            {dict.showAll}
          </label>
        </div>
        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong bg-card p-4 text-sm text-ink-muted">
            {dict.noSubmissions}
          </p>
        ) : null}
        {visible.map((s) => (
          <article key={s.id} className="rounded-lg border border-line bg-card p-3 shadow-card">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
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
              <span className="font-medium text-ink">
                {formOf(s.documentId)?.title ?? s.documentId.slice(0, 8)}
              </span>
              <span>
                {dict.submittedAt} {formatDateTime(s.submittedAt, { locale: l })}
              </span>
              {s.submitterName || s.submitterEmail ? (
                <span>
                  {dict.from} {s.submitterName ?? ""}{" "}
                  {s.submitterEmail ? `<${s.submitterEmail}>` : ""}
                </span>
              ) : null}
              {s.convertedRecordType ? (
                <span>
                  {dict.converted}: {dict.targets[s.convertedRecordType] ?? s.convertedRecordType}{" "}
                  <bdi dir="ltr">{s.convertedRecordId?.slice(0, 8)}</bdi>
                </span>
              ) : null}
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              {Object.entries(s.answers).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-32 shrink-0 truncate font-mono text-xs text-ink-muted">{k}</dt>
                  <dd className="text-ink">
                    {v === null ? "–" : typeof v === "boolean" ? (v ? "✓" : "✗") : String(v)}
                  </dd>
                </div>
              ))}
            </dl>
            {s.status === "received" || s.status === "reviewed" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setConverting(s);
                    setTarget("customer");
                    setMapping({});
                  }}
                >
                  {dict.convert}
                </Button>
                {s.status === "received" ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      settle(
                        await reviewSubmissionAction(orgId, {
                          submissionId: s.id,
                          decision: "reviewed",
                        }),
                      );
                      setBusy(false);
                    }}
                  >
                    {dict.markReviewed}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    settle(
                      await reviewSubmissionAction(orgId, {
                        submissionId: s.id,
                        decision: "discarded",
                      }),
                    );
                    setBusy(false);
                  }}
                >
                  {dict.discard}
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <Dialog
        open={converting !== null}
        onClose={() => setConverting(null)}
        title={dict.convertTitle}
        description={dict.convertHint}
        closeLabel={dict.close}
      >
        <div className="flex flex-col gap-2">
          <label className="text-xs text-ink-muted">
            {dict.target}
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as typeof target)}
              className={input}
            >
              {Object.entries(dict.targets).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {target === "document" ? (
            <>
              <label className="text-xs text-ink-muted">
                {dict.template}
                <select
                  value={templateValue}
                  onChange={(e) => setTemplateValue(e.target.value)}
                  className={input}
                >
                  <option value="">–</option>
                  {templates.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                {dict.docTitle}
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} />
              </label>
            </>
          ) : (
            <fieldset className="rounded-md border border-line p-2">
              <legend className="px-1 text-xs text-ink-muted">{dict.mapping}</legend>
              {TARGET_FIELDS[target]!.map((f) => (
                <label key={f} className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
                  <span className="w-28 font-mono">{f}</span>
                  <select
                    value={mapping[f] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}
                    className="min-h-9 flex-1 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                  >
                    <option value="">–</option>
                    {answerKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConverting(null)}>
              {dict.cancel}
            </Button>
            <Button
              disabled={
                busy || !converting || (target === "document" ? !title.trim() : !mapping.name)
              }
              onClick={async () => {
                if (!converting) return;
                setBusy(true);
                const clean = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
                const res = await convertSubmissionAction(orgId, {
                  submissionId: converting.id,
                  target,
                  mapping: clean,
                  ...(target === "document"
                    ? {
                        title: title.trim(),
                        ...(templateValue.startsWith("builtin.")
                          ? { builtinKey: templateValue }
                          : templateValue
                            ? { templateId: templateValue }
                            : {}),
                      }
                    : {}),
                });
                setBusy(false);
                if (settle(res)) setConverting(null);
              }}
            >
              {dict.confirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
