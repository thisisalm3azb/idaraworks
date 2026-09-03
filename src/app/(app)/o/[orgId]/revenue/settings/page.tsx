import { revenueStudioEnabled } from "@/platform/flags";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { listPipelines, listStageSettings, STAGE_REQUIREMENTS } from "@/modules/crm/service";
import { localeText, resolveRevenue, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import { createPipelineAction, updatePipelineAction, updateStageSettingsAction } from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — pipelines and stage governance: several pipelines (new business,
 * expansion, renewal, custom), one default; per stage the requirements a
 * move must satisfy, the exit criteria, a default probability and the age
 * after which a deal counts as stalled.
 */
export default async function RevenueSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ pipeline?: string; ok?: string; error?: string }>;
}) {
  if (!revenueStudioEnabled()) notFound(); // page-level gate: layouts and pages render concurrently
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "pipeline.configure");
  const pipelines = await listPipelines(resolved.ctx, resolved.archetype);
  const selected =
    pipelines.find((p) => p.id === sp.pipeline) ??
    pipelines.find((p) => p.isDefault) ??
    pipelines[0];
  const stages = selected
    ? await listStageSettings(resolved.ctx, resolved.archetype, selected.id)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.settings.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="settings"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.settings.error.${sp.error}`)}</Badge>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.settings.ok.${sp.ok}`)}</Badge>
      ) : null}

      <Card>
        <CardHeader title={t("revenue.settings.pipelines")} />
        <ul className="flex flex-col gap-2">
          {pipelines.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm"
            >
              <Link
                href={`/o/${orgId}/revenue/settings?pipeline=${p.id}`}
                className={`text-ink hover:underline ${p.id === selected?.id ? "font-semibold" : ""}`}
              >
                {localeText(p.name, locale, p.key)}{" "}
                <span className="text-xs text-ink-muted">
                  · {t(`revenue.pipeline_kind.${p.kind}`)} · {p.stageCount}{" "}
                  {t("revenue.settings.stages")}
                </span>{" "}
                {p.isDefault ? <Badge tone="brand">{t("revenue.settings.default")}</Badge> : null}
                {!p.active ? <Badge tone="neutral">{t("common.inactive")}</Badge> : null}
              </Link>
              <form action={updatePipelineAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="id" value={p.id} />
                {!p.isDefault ? (
                  <Button type="submit" name="intent" value="default" variant="ghost" size="md">
                    {t("revenue.settings.make_default")}
                  </Button>
                ) : null}
                {!p.isDefault ? (
                  <Button
                    type="submit"
                    name="intent"
                    value={p.active ? "deactivate" : "activate"}
                    variant="ghost"
                    size="md"
                  >
                    {p.active ? t("common.deactivate") : t("common.activate")}
                  </Button>
                ) : null}
              </form>
            </li>
          ))}
        </ul>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            {t("revenue.settings.create_pipeline")}
          </summary>
          <form
            action={createPipelineAction.bind(null, orgId)}
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label className={field}>
              {t("revenue.territory.key")}
              <input
                name="key"
                required
                pattern="[a-z][a-z0-9_]{0,39}"
                className={input}
                dir="ltr"
              />
            </label>
            <label className={field}>
              {t("common.name")} (EN)
              <input name="name_en" required maxLength={200} className={input} />
            </label>
            <label className={field}>
              {t("common.name")} (AR)
              <input name="name_ar" maxLength={200} className={input} dir="rtl" />
            </label>
            <label className={field}>
              {t("revenue.deal.kind")}
              <select name="kind" defaultValue="custom" className={input}>
                {(["new_business", "expansion", "renewal", "custom"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`revenue.pipeline_kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${field} sm:col-span-2 lg:col-span-4`}>
              {t("revenue.settings.stage_lines")}
              <textarea
                name="stages"
                required
                rows={4}
                className={`${input} font-mono text-xs`}
                dir="ltr"
                placeholder={"qualified | Qualified | مؤهل\nproposal | Proposal | عرض"}
              />
            </label>
            <div>
              <Button type="submit">{t("revenue.settings.create_pipeline")}</Button>
            </div>
          </form>
        </details>
      </Card>

      {selected ? (
        <Card>
          <CardHeader
            title={`${t("revenue.settings.stages")} · ${localeText(selected.name, locale, selected.key)}`}
          />
          <p className="mb-2 text-xs text-ink-muted">{t("revenue.settings.stage_hint")}</p>
          <ul className="flex flex-col gap-2">
            {stages
              .sort((a, b) => a.sort - b.sort)
              .map((s) => (
                <li key={s.id} className="rounded-md border border-line p-3">
                  <form
                    action={updateStageSettingsAction.bind(null, orgId)}
                    className="flex flex-col gap-2"
                  >
                    <input type="hidden" name="stage_key" value={s.key} />
                    <input type="hidden" name="pipeline_id" value={selected.id} />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink">
                        {localeText(s.label, locale, s.key)}{" "}
                        <Badge
                          tone={
                            s.category === "won"
                              ? "success"
                              : s.category === "lost"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {s.category}
                        </Badge>
                        {!s.active ? <Badge tone="neutral">{t("common.inactive")}</Badge> : null}
                      </span>
                      <span className="text-xs text-ink-muted" dir="ltr">
                        {s.key}
                      </span>
                    </div>
                    {s.category === "open" ? (
                      <>
                        <fieldset className="flex flex-wrap gap-3 text-sm text-ink">
                          <legend className="text-xs text-ink-muted">
                            {t("revenue.board.requirements")}
                          </legend>
                          {STAGE_REQUIREMENTS.map((r) => (
                            <label key={r} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                name={`req_${r}`}
                                defaultChecked={s.requirements.includes(r)}
                                className="size-5"
                              />
                              {t(`revenue.requirement.${r}`)}
                            </label>
                          ))}
                        </fieldset>
                        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                          <label className={field}>
                            {t("revenue.settings.exit")} (EN)
                            <input
                              name="exit_en"
                              defaultValue={s.exitCriteria?.en ?? ""}
                              maxLength={200}
                              className={input}
                            />
                          </label>
                          <label className={field}>
                            {t("revenue.settings.exit")} (AR)
                            <input
                              name="exit_ar"
                              defaultValue={s.exitCriteria?.ar ?? ""}
                              maxLength={200}
                              className={input}
                              dir="rtl"
                            />
                          </label>
                          <label className={field}>
                            {t("revenue.settings.default_probability")}
                            <input
                              name="default_probability"
                              inputMode="numeric"
                              defaultValue={s.defaultProbability ?? ""}
                              className={input}
                              dir="ltr"
                            />
                          </label>
                          <label className={field}>
                            {t("revenue.settings.max_age")}
                            <input
                              name="max_age_days"
                              inputMode="numeric"
                              defaultValue={s.maxAgeDays ?? ""}
                              className={input}
                              dir="ltr"
                            />
                          </label>
                        </div>
                        <div>
                          <Button type="submit" variant="secondary" size="md">
                            {t("common.save")}
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </form>
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
