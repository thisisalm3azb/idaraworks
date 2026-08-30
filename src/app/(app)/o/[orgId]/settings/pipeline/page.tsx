import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listPipelineStages, salesOverview } from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { updateStageAction, deactivateStageAction } from "./actions";

/**
 * H20 — pipeline configuration: rename (both languages), reorder and
 * deactivate open stages. Stage KEYS never change (records stay valid);
 * won/lost are structural terminals and cannot be edited away; a stage
 * holding open opportunities can only be deactivated with an explicit
 * reassignment target — never silently.
 */
export default async function PipelineSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; stage?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "pipeline.configure")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();

  const stages = await listPipelineStages(resolved.ctx, resolved.archetype);
  // Open-opportunity counts per stage (shared derivation) so the page can say
  // honestly which stages are safe to deactivate.
  const overview = await salesOverview(resolved.ctx, resolved.archetype, {
    asOf: orgToday(new Date(), resolved.timezone),
    days: 30,
  });
  const countOf = (key: string) => overview.openByStage.find((c) => c.stageKey === key)?.count ?? 0;

  const update = updateStageAction.bind(null, orgId);
  const deactivate = deactivateStageAction.bind(null, orgId);
  const openStages = stages.filter((s) => s.category === "open");
  const selectCls = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("pipeline.title")} meta={t("pipeline.subtitle")} />
        {sp.ok ? (
          <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
            {t("common.saved")}
          </p>
        ) : null}
        {sp.error === "not_empty" ? (
          <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            {t("pipeline.error.not_empty")}
          </p>
        ) : sp.error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("common.action_failed")}
          </p>
        ) : null}
        <p className="mt-2 text-sm text-ink-secondary">{t("pipeline.keys_note")}</p>
      </Card>

      {stages.map((s) => (
        <Card key={s.key}>
          <CardHeader
            title={locale === "ar" ? s.label.ar : s.label.en}
            meta={
              <span className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    s.category === "won" ? "success" : s.category === "lost" ? "neutral" : "info"
                  }
                >
                  {t(`pipeline.category.${s.category}`)}
                </Badge>
                {!s.active ? <Badge tone="neutral">{t("pipeline.inactive")}</Badge> : null}
                {s.category === "open" && countOf(s.key) > 0 ? (
                  <span className="text-xs text-ink-secondary">
                    {t("pipeline.open_count", { count: countOf(s.key) })}
                  </span>
                ) : null}
              </span>
            }
          />
          <form action={update} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="key" value={s.key} />
            <div className="min-w-40 flex-1">
              <Field
                label={t("pipeline.label_en")}
                name="label_en"
                defaultValue={s.label.en}
                maxLength={60}
              />
            </div>
            <div className="min-w-40 flex-1">
              <Field
                label={t("pipeline.label_ar")}
                name="label_ar"
                defaultValue={s.label.ar}
                maxLength={60}
                dir="rtl"
              />
            </div>
            <div className="w-24">
              <Field
                label={t("pipeline.sort")}
                name="sort"
                type="number"
                min={0}
                max={99}
                defaultValue={String(s.sort)}
              />
            </div>
            <Button type="submit" variant="secondary">
              {t("common.save")}
            </Button>
          </form>
          {s.category === "open" && s.active ? (
            <form
              action={deactivate}
              className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3"
            >
              <input type="hidden" name="key" value={s.key} />
              {countOf(s.key) > 0 ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                  {t("pipeline.reassign_label", { count: countOf(s.key) })}
                  <select name="reassign_to" defaultValue="" required className={selectCls}>
                    <option value="" disabled>
                      {t("pipeline.reassign_pick")}
                    </option>
                    {openStages
                      .filter((x) => x.active && x.key !== s.key)
                      .map((x) => (
                        <option key={x.key} value={x.key}>
                          {locale === "ar" ? x.label.ar : x.label.en}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <Button type="submit" variant="ghost">
                {t("pipeline.deactivate")}
              </Button>
            </form>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
