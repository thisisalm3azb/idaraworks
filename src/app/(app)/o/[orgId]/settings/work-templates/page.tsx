import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader, Field, SubmitButton } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { PHASE_SEMANTICS } from "@/platform/registries";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { getCatalogueEntry } from "@/platform/config/templates";
import { installedTemplateKey, listPresets, readStageTemplate } from "@/modules/jobs/service";
import {
  addStageAction,
  createPresetAction,
  moveStageAction,
  removeStageAction,
  retirePresetAction,
  updatePresetAction,
  updateStageAction,
} from "./actions";

/**
 * Work templates (item 9): the stages every unit of work moves through, and the
 * named starting points ("presets") that pick from them. Plain forms, one per
 * change, so every edit is one audited config revision with undo on the
 * Configuration page. Existing work keeps the stages it was created with.
 */
const input =
  "min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

export default async function WorkTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const t = await getT();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.view")) redirect(`/o/${orgId}`);
  const manage = can(resolved.archetype, "config.manage");
  const locale = await getServerLocale();
  const ar = locale === "ar";
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobT = term("job", terms, "singular");
  const jobsT = term("job", terms, "plural");

  const [tpl, presets, installedKey] = await Promise.all([
    readStageTemplate(resolved.ctx, resolved.archetype),
    listPresets(resolved.ctx, resolved.archetype),
    installedTemplateKey(resolved.ctx),
  ]);
  const basedOn = installedKey ? getCatalogueEntry(installedKey) : null;

  const okCopy: Record<string, string> = {
    stage_added: t("work.ok.stage_added"),
    stage_saved: t("work.ok.stage_saved"),
    stage_moved: t("work.ok.stage_moved"),
    stage_removed: t("work.ok.stage_removed"),
    preset_created: t("work.ok.preset_created"),
    preset_saved: t("work.ok.preset_saved"),
    preset_retired: t("work.ok.preset_retired"),
    preset_restored: t("work.ok.preset_restored"),
  };
  const errorCopy: Record<string, string> = {
    stage_referenced: t("work.error.stage_referenced"),
    no_stages: t("work.error.no_stages"),
    duplicate_code: t("work.error.duplicate_code"),
    not_found: t("work.error.not_found"),
    invalid: t("work.error.invalid"),
  };

  const phaseLabel = (p: string) => t(`work.phase.${p}`);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-ink">{t("work.title", { jobs: jobsT })}</h1>
        <p className="text-sm text-ink-muted">{t("work.intro", { job: jobT })}</p>
        {basedOn ? (
          <p className="text-xs text-ink-muted">
            {t("work.based_on", { name: ar ? basedOn.names.ar : basedOn.names.en })}
          </p>
        ) : null}
      </header>

      {sp.ok && okCopy[sp.ok] ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {okCopy[sp.ok]}
        </p>
      ) : null}
      {sp.error && errorCopy[sp.error] ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {errorCopy[sp.error]}
        </p>
      ) : null}

      {/* ── Stages ─────────────────────────────────────────────────────── */}
      <Card>
        <div id="stages" />
        <CardHeader title={t("work.stages.title")} meta={`${tpl.stages.length}`} />
        <p className="mb-3 text-sm text-ink-secondary">{t("work.stages.hint", { job: jobT })}</p>
        <ol className="flex flex-col gap-3">
          {tpl.stages.map((s, i) => (
            <li key={s.stage_key} className="rounded-md border border-line p-3">
              <form
                action={updateStageAction.bind(null, orgId)}
                className="grid gap-2 sm:grid-cols-[auto_1fr_1fr_5rem_9rem_auto] sm:items-end"
              >
                <input type="hidden" name="stage_key" value={s.stage_key} />
                <span className="pb-3 text-sm font-semibold text-ink-muted" aria-hidden>
                  {i + 1}.
                </span>
                <Field
                  label={t("work.stages.name_en")}
                  name="name_en"
                  defaultValue={s.names.en}
                  required
                  maxLength={60}
                  disabled={!manage}
                />
                <Field
                  label={t("work.stages.name_ar")}
                  name="name_ar"
                  defaultValue={s.names.ar}
                  required
                  maxLength={60}
                  dir="rtl"
                  disabled={!manage}
                />
                <Field
                  label={t("work.stages.weight")}
                  name="weight"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={String(s.weight)}
                  required
                  disabled={!manage}
                />
                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                  {t("work.stages.phase")}
                  <select
                    name="phase"
                    defaultValue={s.phase_semantic}
                    className={input}
                    disabled={!manage}
                  >
                    {PHASE_SEMANTICS.map((p) => (
                      <option key={p} value={p}>
                        {phaseLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                {manage ? (
                  <SubmitButton variant="secondary" pendingLabel={t("common.saving")}>
                    {t("common.save")}
                  </SubmitButton>
                ) : null}
              </form>
              {manage ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <form action={moveStageAction.bind(null, orgId)}>
                    <input type="hidden" name="stage_key" value={s.stage_key} />
                    <input type="hidden" name="direction" value="up" />
                    <SubmitButton
                      variant="ghost"
                      disabled={i === 0}
                      aria-label={t("work.stages.move_up")}
                      pendingLabel={t("common.working")}
                    >
                      ↑ {t("work.stages.move_up")}
                    </SubmitButton>
                  </form>
                  <form action={moveStageAction.bind(null, orgId)}>
                    <input type="hidden" name="stage_key" value={s.stage_key} />
                    <input type="hidden" name="direction" value="down" />
                    <SubmitButton
                      variant="ghost"
                      disabled={i === tpl.stages.length - 1}
                      aria-label={t("work.stages.move_down")}
                      pendingLabel={t("common.working")}
                    >
                      ↓ {t("work.stages.move_down")}
                    </SubmitButton>
                  </form>
                  <form action={removeStageAction.bind(null, orgId)}>
                    <input type="hidden" name="stage_key" value={s.stage_key} />
                    <SubmitButton
                      variant="ghost"
                      className="text-danger"
                      pendingLabel={t("common.working")}
                    >
                      {t("work.stages.remove")}
                    </SubmitButton>
                  </form>
                  <span className="text-xs text-ink-muted">
                    {t("work.stages.key", { key: s.stage_key })}
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {manage ? (
          <form
            action={addStageAction.bind(null, orgId)}
            className="mt-4 grid gap-2 rounded-md border border-dashed border-line-strong p-3 sm:grid-cols-[1fr_1fr_5rem_9rem_auto] sm:items-end"
          >
            <Field label={t("work.stages.name_en")} name="name_en" required maxLength={60} />
            <Field
              label={t("work.stages.name_ar")}
              name="name_ar"
              required
              maxLength={60}
              dir="rtl"
            />
            <Field
              label={t("work.stages.weight")}
              name="weight"
              type="number"
              min={1}
              max={100}
              defaultValue="10"
              required
            />
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              {t("work.stages.phase")}
              <select
                name="phase"
                defaultValue={PHASE_SEMANTICS[1] ?? PHASE_SEMANTICS[0]}
                className={input}
              >
                {PHASE_SEMANTICS.map((p) => (
                  <option key={p} value={p}>
                    {phaseLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <SubmitButton pendingLabel={t("common.creating")}>{t("work.stages.add")}</SubmitButton>
          </form>
        ) : null}
        <p className="mt-3 text-xs text-ink-muted">
          {t("work.stages.undo_hint")}{" "}
          <Link href={`/o/${orgId}/settings/configuration`} className="text-brand hover:underline">
            {t("nav.configuration")}
          </Link>
        </p>
      </Card>

      {/* ── Templates (presets) ───────────────────────────────────────── */}
      <Card>
        <div id="templates" />
        <CardHeader
          title={t("work.presets.title")}
          meta={`${presets.filter((p) => !p.retiredAt).length}`}
        />
        <p className="mb-3 text-sm text-ink-secondary">{t("work.presets.hint", { job: jobT })}</p>
        <ul className="flex flex-col gap-3">
          {presets.map((p) => (
            <li key={p.id} className="rounded-md border border-line p-3">
              <form action={updatePresetAction.bind(null, orgId)} className="flex flex-col gap-2">
                <input type="hidden" name="preset_id" value={p.id} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-muted">{p.code}</span>
                  {p.retiredAt ? (
                    <Badge tone="neutral">{t("work.presets.retired")}</Badge>
                  ) : (
                    <Badge tone="success">{t("work.presets.active")}</Badge>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label={t("work.presets.name_en")}
                    name="name_en"
                    defaultValue={p.names.en}
                    required
                    maxLength={60}
                    disabled={!manage || Boolean(p.retiredAt)}
                  />
                  <Field
                    label={t("work.presets.name_ar")}
                    name="name_ar"
                    defaultValue={p.names.ar}
                    required
                    maxLength={60}
                    dir="rtl"
                    disabled={!manage || Boolean(p.retiredAt)}
                  />
                </div>
                <Field
                  label={t("work.presets.description")}
                  name="description"
                  defaultValue={p.description ?? ""}
                  maxLength={200}
                  disabled={!manage || Boolean(p.retiredAt)}
                />
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm font-medium text-ink">
                    {t("work.presets.stages_used")}
                  </legend>
                  <p className="text-xs text-ink-muted">{t("work.presets.stages_hint")}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {tpl.stages.map((s) => (
                      <label
                        key={s.stage_key}
                        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-2 text-sm text-ink"
                      >
                        <input
                          type="checkbox"
                          name="skip"
                          value={s.stage_key}
                          defaultChecked={p.defaultSkippedStageKeys.includes(s.stage_key)}
                          disabled={!manage || Boolean(p.retiredAt)}
                        />
                        <span>
                          {t("work.presets.skip")} {ar ? s.names.ar : s.names.en}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="text-xs text-ink-muted">
                  {t("work.presets.billing")}{" "}
                  {p.billingPoints
                    .map((bp) =>
                      bp.trigger === "on_acceptance"
                        ? `${bp.pct}% ${t("work.presets.on_acceptance")}`
                        : `${bp.pct}% ${typeof bp.trigger === "object" ? (tpl.stages.find((s) => s.stage_key === (bp.trigger as { stage_key: string }).stage_key)?.names[ar ? "ar" : "en"] ?? (bp.trigger as { stage_key: string }).stage_key) : ""}`,
                    )
                    .join(" · ")}
                </p>
                {manage && !p.retiredAt ? (
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton pendingLabel={t("common.saving")}>
                      {t("common.save")}
                    </SubmitButton>
                  </div>
                ) : null}
              </form>
              {manage ? (
                <form action={retirePresetAction.bind(null, orgId)} className="mt-2">
                  <input type="hidden" name="preset_id" value={p.id} />
                  {p.retiredAt ? <input type="hidden" name="restore" value="1" /> : null}
                  <SubmitButton
                    variant="ghost"
                    className={p.retiredAt ? "" : "text-danger"}
                    pendingLabel={t("common.working")}
                  >
                    {p.retiredAt ? t("work.presets.restore") : t("work.presets.retire")}
                  </SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <form
            action={createPresetAction.bind(null, orgId)}
            className="mt-4 flex flex-col gap-2 rounded-md border border-dashed border-line-strong p-3"
          >
            <p className="text-sm font-medium text-ink">{t("work.presets.add_title")}</p>
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr]">
              <Field
                label={t("work.presets.code")}
                name="code"
                required
                maxLength={8}
                pattern="[A-Za-z0-9]{1,8}"
                hint={t("work.presets.code_hint")}
              />
              <Field label={t("work.presets.name_en")} name="name_en" required maxLength={60} />
              <Field
                label={t("work.presets.name_ar")}
                name="name_ar"
                required
                maxLength={60}
                dir="rtl"
              />
            </div>
            <Field label={t("work.presets.description")} name="description" maxLength={200} />
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium text-ink">
                {t("work.presets.stages_used")}
              </legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {tpl.stages.map((s) => (
                  <label
                    key={s.stage_key}
                    className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-2 text-sm text-ink"
                  >
                    <input type="checkbox" name="skip" value={s.stage_key} />
                    <span>
                      {t("work.presets.skip")} {ar ? s.names.ar : s.names.en}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-xs text-ink-muted">{t("work.presets.new_billing_note")}</p>
            <SubmitButton pendingLabel={t("common.creating")}>{t("work.presets.add")}</SubmitButton>
          </form>
        ) : null}
      </Card>

      <p className="text-xs text-ink-muted">{t("work.documents_note")}</p>
    </div>
  );
}
