import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { managementStudioEnabled } from "@/platform/flags";
import { formatDate } from "@/platform/format";
import { portfolioSummary, listTemplates } from "@/modules/studio/service";
import { createPlanAction, createFromTemplateAction } from "./actions";

/** H25 — the Studio home: every plan the organization is shaping. */
export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!managementStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "studio.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const manages = can(resolved.archetype, "studio.manage");
  const { rows, truncated } = await portfolioSummary(resolved.ctx, resolved.archetype);
  const plans = rows.map((r) => r.plan);
  const create = createPlanAction.bind(null, orgId);
  const createFromTemplate = createFromTemplateAction.bind(null, orgId);
  const templates = manages ? await listTemplates(resolved.ctx, resolved.archetype) : [];
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("studio.title")}</h1>
          <p className="text-sm text-ink-muted">{t("studio.subtitle")}</p>
        </div>
        <Link
          href={`/o/${orgId}/studio/registers`}
          className="min-h-9 text-sm text-accent underline"
        >
          {t("studio.registers.title")}
        </Link>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {manages ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("studio.new_plan")}</h2>
          <form action={create} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted sm:col-span-2">
              {t("studio.plan_name")}
              <input name="name" required maxLength={200} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("studio.plan_description")}
              <input name="description" maxLength={4000} className={input} />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit">{t("studio.new_plan")}</Button>
            </div>
          </form>
          <form
            action={createFromTemplate}
            className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 sm:grid-cols-3"
          >
            <label className="text-xs text-ink-muted">
              {t("studio.template.pick")}
              <select name="template" required className={input}>
                {templates.map((tp) => (
                  <option key={tp.key} value={tp.key}>
                    {tp.name} · {tp.nodes}
                    {tp.builtIn ? "" : ` · ${t("studio.template.org")}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("studio.plan_name")}
              <input name="name" required maxLength={200} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("studio.field.start_date")}
              <input name="startDate" type="date" className={input} dir="ltr" />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit" variant="ghost">
                {t("studio.template.create")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {plans.length === 0 ? (
        <EmptyState title={t("studio.empty")} description={t("studio.empty_hint")} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2 text-start font-medium">{t("studio.portfolio.plan")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("studio.portfolio.finish")}</th>
                <th className="px-3 py-2 text-end font-medium">{t("studio.portfolio.chain")}</th>
                <th className="px-3 py-2 text-end font-medium">
                  {t("studio.portfolio.overloads")}
                </th>
                <th className="px-3 py-2 text-end font-medium">{t("studio.portfolio.risks")}</th>
                <th className="px-3 py-2 text-end font-medium">{t("studio.portfolio.score")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.plan.id} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    <Link
                      href={`/o/${orgId}/studio/${r.plan.id}`}
                      className="font-medium text-ink underline-offset-2 hover:underline"
                    >
                      {r.plan.name}
                    </Link>
                    <span className="block text-[11px] text-ink-muted" dir="ltr">
                      {r.plan.reference} · {r.plan.nodeCount} {t("studio.portfolio.elements")}
                      {r.scenariosUnderReview > 0
                        ? ` · ${t("studio.portfolio.under_review").replace("{count}", String(r.scenariosUnderReview))}`
                        : ""}
                    </span>
                    {r.warnings.length > 0 ? (
                      <span className="block text-[11px] text-warning">
                        {r.warnings.join(" · ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-ink-muted" dir="ltr">
                    {r.projectFinish ? formatDate(r.projectFinish, { locale }) : "∅"}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums text-ink" dir="ltr">
                    {r.durationDays ?? ""}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                    <span className={r.overloads > 0 ? "text-danger" : "text-ink-muted"}>
                      {r.overloads}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                    <span className={r.unscoredRisks > 0 ? "text-warning" : "text-ink-muted"}>
                      {r.openRisks}
                      {r.unscoredRisks > 0 ? ` (${r.unscoredRisks} ?)` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end" dir="ltr">
                    {r.score === null ? (
                      <span className="text-[11px] text-ink-muted">
                        {t("studio.kpi.insufficient")}
                      </span>
                    ) : (
                      <details className="inline-block text-start">
                        <summary
                          className={`cursor-pointer list-none rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.score >= 75
                              ? "bg-success-soft text-success"
                              : r.score >= 50
                                ? "bg-warning-soft text-warning"
                                : "bg-danger-soft text-danger"
                          }`}
                        >
                          {r.score} / 100
                        </summary>
                        <ul className="mt-1 w-64 text-[11px] text-ink-muted">
                          {r.components.map((c) => (
                            <li key={c.key}>
                              <span className="text-ink">
                                {t(`studio.portfolio.component.${c.key}`)} {c.points}/{c.max}
                              </span>
                              : {c.basis}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {truncated ? (
            <p className="px-3 py-2 text-[11px] text-ink-muted">
              {t("studio.portfolio.truncated")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
