import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { WORKFLOW_PRESETS, listWorkflows } from "@/modules/docstudio/service";
import { createWorkflowAction } from "../studio-actions";

/** H26 — reusable approval workflows: the library and the way in to the designer. */
export default async function WorkflowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.workflows.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const workflows = await listWorkflows(resolved.ctx, resolved.archetype, { includeRetired: true });
  const create = createWorkflowAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  const k = (key: string) => t(`docstudio.wf.${key}`);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {t("docstudio.back")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink">{k("title")}</h1>
        <p className="text-sm text-ink-muted">{k("subtitle")}</p>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {workflows.map((w) => (
          <Card key={w.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-ink">{w.name}</h2>
                <p className="text-xs text-ink-muted">
                  {w.definition.steps.length} {k("steps")}
                </p>
              </div>
              <Badge tone={w.status === "active" ? "success" : "neutral"}>
                {k(`status.${w.status}`)}
              </Badge>
            </div>
            {w.description ? (
              <p className="mt-2 text-sm text-ink-secondary">{w.description}</p>
            ) : null}
            <ol className="mt-2 flex flex-col gap-1 text-xs text-ink-secondary">
              {w.definition.steps.map((s, i) => (
                <li key={s.id}>
                  {i + 1}. {k(`kind.${s.kind}`)} ·{" "}
                  {(locale === "ar" ? s.name.ar : s.name.en) ?? s.id}
                  {s.condition ? ` · ${k("conditional")}` : ""}
                  {s.mode === "parallel" ? ` · ${k("parallel")}` : ""}
                </li>
              ))}
            </ol>
            <div className="mt-3">
              <Link
                href={`/o/${orgId}/documents/workflows/${w.id}`}
                className="min-h-9 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-sunken"
              >
                {k("open")}
              </Link>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">{k("new")}</h2>
        <form action={create} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-muted">
            {k("name")}
            <input name="name" required maxLength={160} className={input} />
          </label>
          <label className="text-xs text-ink-muted">
            {k("preset")}
            <select name="preset" className={input} defaultValue="">
              <option value="">{k("preset_blank")}</option>
              {WORKFLOW_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {locale === "ar" ? p.nameAr : p.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {k("description")}
            <input name="description" maxLength={2000} className={input} />
          </label>
          <div className="sm:col-span-3">
            <Button type="submit">{k("create")}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
