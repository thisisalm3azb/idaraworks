/**
 * U4 pre-org onboarding wizard — the step screens (server components; the only
 * client pieces are RegionFields and LogoPicker). Phone-first: one column,
 * 44px targets, chips as native checkboxes/radios (no JS), logical properties
 * only. Dynamic question skips run on pure CSS `:has()` (group-has-*) so a
 * screen reacts to its own answers without client state; the server-side skip
 * rules (modules/onboarding/flow.ts) remain the source of truth on submit.
 */
import Link from "next/link";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { TierCards, CustomBuilder } from "@/platform/ui/subscription";
import type {
  CustomBuilderGroup,
  SelectionCurrency,
  SelectionView,
} from "@/platform/ui/subscription";
import { formatMoney } from "@/platform/format";
import type { Locale } from "@/platform/registries";
import type { Translator } from "@/platform/i18n/server";
import { getCatalogueEntry, TEMPLATES, type TemplateCatalogueEntry } from "@/platform/config";
import {
  buildGroundedProposal,
  buildReviewSummary,
  draftToIntake,
  prevStepBefore,
  recommendationForDraft,
  CAPABILITY_CHIPS,
  COUNTRY_DEFAULTS,
  DEPARTMENTS,
  DEVICES,
  EMPLOYEE_BANDS,
  FLOW_CURRENCIES,
  FLOW_TIMEZONES,
  INDUSTRIES,
  LOCATION_BANDS,
  USER_BANDS,
  WORK_INTAKE,
  WORK_PATTERNS,
  type DraftData,
  type FlowStep,
} from "@/modules/onboarding/service";
import {
  chooseTemplateAction,
  confirmFlowAction,
  removeFlowLogoAction,
  saveBrandingStepAction,
  saveProposalTermsAction,
  saveStepAction,
  selectCustomAction,
  selectFreeAction,
  selectTierFlowAction,
  skipBrandingStepAction,
  startFlowAction,
  uploadFlowLogoAction,
} from "./actions";
import { RegionFields } from "./RegionFields";
import { LogoPicker } from "./LogoPicker";

export type StepProps = {
  t: Translator;
  locale: Locale;
  data: DraftData;
};

const field = "flex flex-col gap-1.5 text-sm font-medium text-ink";
const input =
  "min-h-11 rounded-md border border-line-strong bg-card px-3 py-2 text-base font-normal text-ink";
const help = "text-xs font-normal text-ink-muted";
const chipCls =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-card px-4 text-sm text-ink has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand";
const backLinkCls =
  "inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken";

function stepHref(step: FlowStep): string {
  return `/onboarding?step=${step}`;
}

function NavRow({ t, step, nextLabel }: { t: Translator; step: FlowStep; nextLabel?: string }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <Link href={stepHref(prevStepBefore(step))} className={backLinkCls}>
        {t("onboarding.flow.back")}
      </Link>
      <Button type="submit">{nextLabel ?? t("onboarding.flow.next")}</Button>
    </div>
  );
}

function Chip({
  name,
  value,
  label,
  checked,
  inputClass,
}: {
  name: string;
  value: string;
  label: string;
  checked: boolean;
  inputClass?: string;
}) {
  return (
    <label className={chipCls}>
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={checked}
        className={`size-4 accent-current ${inputClass ?? ""}`}
      />
      {label}
    </label>
  );
}

function RadioChip({
  name,
  value,
  label,
  checked,
  required,
  id,
  ltr,
}: {
  name: string;
  value: string;
  label: string;
  checked: boolean;
  required?: boolean;
  id?: string;
  ltr?: boolean;
}) {
  return (
    <label className={chipCls}>
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        defaultChecked={checked}
        required={required}
        className="size-4 accent-current"
      />
      <span dir={ltr ? "ltr" : undefined} className={ltr ? "font-mono" : undefined}>
        {label}
      </span>
    </label>
  );
}

// ── Welcome ───────────────────────────────────────────────────────────────────
export function WelcomeStep({ t }: StepProps) {
  const points = ["point_questions", "point_template", "point_plan", "point_confirm"] as const;
  return (
    <Card>
      <h1 className="mb-2 text-xl font-semibold text-ink">{t("onboarding.flow.welcome.title")}</h1>
      <p className="mb-4 text-sm leading-relaxed text-ink">{t("onboarding.flow.welcome.lead")}</p>
      <ul className="mb-4 flex flex-col gap-2 text-sm text-ink">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-brand">
              ✓
            </span>
            {t(`onboarding.flow.welcome.${p}`)}
          </li>
        ))}
      </ul>
      <p className={`mb-4 ${help}`}>{t("onboarding.flow.resume_note")}</p>
      <form action={startFlowAction}>
        <Button type="submit" size="lg" className="w-full">
          {t("onboarding.flow.welcome.start")}
        </Button>
      </form>
    </Card>
  );
}

// ── Business ──────────────────────────────────────────────────────────────────
export function BusinessStep({ t, data }: StepProps) {
  const a = data.answers;
  return (
    <Card>
      <CardHeader title={t("onboarding.flow.business.title")} />
      <form action={saveStepAction.bind(null, "business")} className="flex flex-col gap-4">
        <label className={field}>
          {t("onboarding.flow.business.name")}
          <input
            name="business_name"
            required
            maxLength={120}
            defaultValue={a.business_name ?? ""}
            className={input}
          />
          <span className={help}>{t("onboarding.flow.business.name_help")}</span>
        </label>
        <label className={field}>
          <span>
            {t("onboarding.flow.business.legal_name")}{" "}
            <span className="font-normal text-ink-muted">({t("onboarding.flow.optional")})</span>
          </span>
          <input
            name="legal_name"
            maxLength={200}
            defaultValue={a.legal_name ?? ""}
            className={input}
          />
          <span className={help}>{t("onboarding.flow.business.legal_name_help")}</span>
        </label>
        <label className={field}>
          {t("onboarding.flow.business.industry")}
          <select name="industry" required defaultValue={a.industry ?? ""} className={input}>
            <option value="" disabled>
              {t("onboarding.flow.business.industry_pick")}
            </option>
            {INDUSTRIES.map((k) => (
              <option key={k} value={k}>
                {t(`onboarding.flow.industry.${k}`)}
              </option>
            ))}
          </select>
          <span className={help}>{t("onboarding.flow.business.industry_help")}</span>
        </label>
        <label className={field}>
          {t("onboarding.flow.business.description")}
          <textarea
            name="business_description"
            maxLength={600}
            rows={3}
            defaultValue={a.business_description ?? ""}
            className={`${input} text-base`}
          />
          <span className={help}>{t("onboarding.flow.business.description_help")}</span>
        </label>
        <NavRow t={t} step="business" />
      </form>
    </Card>
  );
}

// ── Region ────────────────────────────────────────────────────────────────────
export function RegionStep({ t, locale, data }: StepProps) {
  const a = data.answers;
  const country = a.country ?? "AE";
  const d = COUNTRY_DEFAULTS[country];
  return (
    <Card>
      <CardHeader title={t("onboarding.flow.region.title")} />
      <form action={saveStepAction.bind(null, "region")} className="flex flex-col gap-4">
        <RegionFields
          countries={Object.keys(COUNTRY_DEFAULTS).map((c) => ({
            value: c,
            label: t(`onboarding.flow.country.${c}`),
          }))}
          timezones={FLOW_TIMEZONES.map((z) => ({ value: z, label: z }))}
          currencies={FLOW_CURRENCIES.map((c) => ({ value: c, label: c }))}
          defaults={COUNTRY_DEFAULTS}
          initial={{
            country,
            timezone: a.timezone ?? d.timezone,
            currency: a.base_currency ?? d.currency,
          }}
          labels={{
            country: t("onboarding.flow.region.country"),
            timezone: t("onboarding.flow.region.timezone"),
            currency: t("onboarding.flow.region.currency"),
            defaultsNote: t("onboarding.flow.region.defaults_note"),
          }}
        />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.region.language")}
          </legend>
          <div className="flex flex-wrap gap-2">
            <RadioChip
              name="preferred_language"
              value="en"
              label={t("onboarding.flow.region.lang_en")}
              checked={(a.preferred_language ?? locale) === "en"}
              required
            />
            <RadioChip
              name="preferred_language"
              value="ar"
              label={t("onboarding.flow.region.lang_ar")}
              checked={(a.preferred_language ?? locale) === "ar"}
              required
            />
          </div>
          <span className={help}>{t("onboarding.flow.region.language_help")}</span>
        </fieldset>
        <NavRow t={t} step="region" />
      </form>
    </Card>
  );
}

// ── Scale ─────────────────────────────────────────────────────────────────────
export function ScaleStep({ t, data }: StepProps) {
  const a = data.answers;
  return (
    <Card>
      <CardHeader title={t("onboarding.flow.scale.title")} />
      {/* `group` + has-[:checked] drive SKIP-1/SKIP-2 visually; flow.ts enforces them. */}
      <form action={saveStepAction.bind(null, "scale")} className="group flex flex-col gap-4">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.scale.employees")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {EMPLOYEE_BANDS.map((b, i) => (
              <RadioChip
                key={b}
                id={i === 0 ? "emp-band-smallest" : undefined}
                name="employees_band"
                value={b}
                label={b}
                checked={a.employees_band === b}
                required
                ltr
              />
            ))}
          </div>
        </fieldset>

        {/* SKIP-1: hidden while the smallest team band is selected. */}
        <fieldset className="flex flex-col gap-1.5 group-has-[#emp-band-smallest:checked]:hidden">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.scale.users")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {USER_BANDS.map((b) => (
              <RadioChip
                key={b}
                name="users_band"
                value={b}
                label={b}
                checked={a.users_band === b}
                ltr
              />
            ))}
          </div>
          <span className={help}>{t("onboarding.flow.scale.users_help")}</span>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.scale.locations")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {LOCATION_BANDS.map((b) => (
              <RadioChip
                key={b}
                name="locations_band"
                value={b}
                label={b === "1" ? t("onboarding.flow.scale.loc_single") : b}
                checked={a.locations_band === b}
                required
                ltr={b !== "1"}
              />
            ))}
          </div>
        </fieldset>

        {/* SKIP-2: departments only for teams above the smallest band. */}
        <fieldset className="flex flex-col gap-1.5 group-has-[#emp-band-smallest:checked]:hidden">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.scale.departments")}{" "}
            <span className="font-normal text-ink-muted">({t("onboarding.flow.optional")})</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {DEPARTMENTS.map((k) => (
              <Chip
                key={k}
                name="departments"
                value={k}
                label={t(`onboarding.flow.dept.${k}`)}
                checked={(a.departments ?? []).includes(k)}
              />
            ))}
          </div>
        </fieldset>
        <NavRow t={t} step="scale" />
      </form>
    </Card>
  );
}

// ── Work ──────────────────────────────────────────────────────────────────────
/** Patterns with a start-to-finish flow (SKIP-3 counterparts). */
const FLOWFUL_PATTERNS = new Set(["project", "order", "service", "production", "mixed"]);

export function WorkStep({ t, data }: StepProps) {
  const a = data.answers;
  return (
    <Card>
      <CardHeader title={t("onboarding.flow.work.title")} />
      <form action={saveStepAction.bind(null, "work")} className="group flex flex-col gap-4">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.work.pattern")}
          </legend>
          <span className={`mb-1 ${help}`}>{t("onboarding.flow.work.pattern_help")}</span>
          <div className="flex flex-col gap-2">
            {WORK_PATTERNS.map((k) => (
              <Chip
                key={k}
                name="work_patterns"
                value={k}
                label={t(`onboarding.flow.pattern.${k}`)}
                checked={(a.work_patterns ?? []).includes(k)}
                inputClass={FLOWFUL_PATTERNS.has(k) ? "pattern-flowful" : undefined}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.work.intake")}{" "}
            <span className="font-normal text-ink-muted">({t("onboarding.flow.optional")})</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {WORK_INTAKE.map((k) => (
              <Chip
                key={k}
                name="work_intake"
                value={k}
                label={t(`onboarding.flow.intake.${k}`)}
                checked={(a.work_intake ?? []).includes(k)}
              />
            ))}
          </div>
        </fieldset>

        {/* SKIP-3: shown only when a chosen pattern has a start-to-finish flow. */}
        <label className={`${field} hidden group-has-[.pattern-flowful:checked]:flex`}>
          <span>
            {t("onboarding.flow.work.workflow")}{" "}
            <span className="font-normal text-ink-muted">({t("onboarding.flow.optional")})</span>
          </span>
          <textarea
            name="workflow_description"
            maxLength={600}
            rows={3}
            defaultValue={a.workflow_description ?? ""}
            className={`${input} text-base`}
          />
          <span className={help}>{t("onboarding.flow.work.workflow_help")}</span>
        </label>
        <NavRow t={t} step="work" />
      </form>
    </Card>
  );
}

// ── Needs ─────────────────────────────────────────────────────────────────────
const CUSTOMER_FACING = new Set(["quotes", "invoices", "customer_updates"]);

export function NeedsStep({ t, data }: StepProps) {
  const a = data.answers;
  return (
    <Card>
      <CardHeader title={t("onboarding.flow.needs.title")} />
      <form action={saveStepAction.bind(null, "needs")} className="group flex flex-col gap-4">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.needs.capabilities")}
          </legend>
          <span className={`mb-1 ${help}`}>{t("onboarding.flow.needs.capabilities_help")}</span>
          <div className="flex flex-wrap gap-2">
            {CAPABILITY_CHIPS.map((k) => (
              <Chip
                key={k}
                name="capabilities"
                value={k}
                label={t(`onboarding.flow.capability.${k}`)}
                checked={(a.capabilities ?? []).includes(k)}
                inputClass={CUSTOMER_FACING.has(k) ? "cap-customer" : undefined}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.needs.device")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {DEVICES.map((k) => (
              <RadioChip
                key={k}
                name="device"
                value={k}
                label={t(`onboarding.flow.device.${k}`)}
                checked={a.device === k}
                required
              />
            ))}
          </div>
        </fieldset>

        {/* SKIP-4: only asked when a customer-facing capability was picked. */}
        <fieldset className="hidden flex-col gap-1.5 group-has-[.cap-customer:checked]:flex">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onboarding.flow.needs.sharing")}
          </legend>
          <div className="flex flex-wrap gap-2">
            <RadioChip
              name="customer_sharing"
              value="yes"
              label={t("onboarding.flow.needs.sharing_yes")}
              checked={a.customer_sharing === true}
            />
            <RadioChip
              name="customer_sharing"
              value="no"
              label={t("onboarding.flow.needs.sharing_no")}
              checked={a.customer_sharing === false}
            />
          </div>
        </fieldset>

        <label className={field}>
          <span>
            {t("onboarding.flow.needs.problem")}{" "}
            <span className="font-normal text-ink-muted">({t("onboarding.flow.optional")})</span>
          </span>
          <textarea
            name="main_problem"
            maxLength={600}
            rows={3}
            defaultValue={a.main_problem ?? ""}
            className={`${input} text-base`}
          />
          <span className={help}>{t("onboarding.flow.needs.problem_help")}</span>
        </label>
        <NavRow t={t} step="needs" />
      </form>
    </Card>
  );
}

// ── Template ──────────────────────────────────────────────────────────────────
function TemplatePreview({
  t,
  locale,
  entry,
}: {
  t: Translator;
  locale: Locale;
  entry: TemplateCatalogueEntry;
}) {
  const ar = locale === "ar";
  const stages = entry.manifest.stage_template?.stages ?? [];
  const jobTerm = entry.manifest.terminology?.job?.[locale]?.singular;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-ink-muted">{ar ? entry.description.ar : entry.description.en}</p>
      {jobTerm ? (
        <p className="text-ink">
          {t("onboarding.flow.template.calls_things")}{" "}
          <span className="font-medium">{jobTerm}</span>
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {t("onboarding.flow.template.stages_label")}
        </p>
        <ol className="flex flex-wrap gap-1">
          {stages.map((s, i) => (
            <li key={s.stage_key} className="rounded-full bg-sunken px-2 py-1 text-xs text-ink">
              {i + 1}. {ar ? s.names.ar : s.names.en}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {t("onboarding.flow.template.limitations")}
        </p>
        <ul className="ms-4 flex list-disc flex-col gap-0.5 text-xs text-ink-muted">
          {entry.limitations.map((l) => (
            <li key={l.en}>{ar ? l.ar : l.en}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ChooseTemplateForm({
  t,
  templateKey,
  recommendedKey,
  confident,
  selected,
  primary,
}: {
  t: Translator;
  templateKey: string;
  recommendedKey: string;
  confident: boolean;
  selected: boolean;
  primary: boolean;
}) {
  if (selected) {
    return <Badge tone="success">{t("onboarding.flow.template.selected")}</Badge>;
  }
  return (
    <form action={chooseTemplateAction}>
      <input type="hidden" name="template_key" value={templateKey} />
      <input type="hidden" name="recommended_key" value={recommendedKey} />
      <input type="hidden" name="confident" value={confident ? "1" : "0"} />
      <Button type="submit" variant={primary ? "primary" : "secondary"}>
        {primary ? t("onboarding.flow.template.use") : t("onboarding.flow.template.choose")}
      </Button>
    </form>
  );
}

export function TemplateStep({ t, locale, data }: StepProps) {
  const ar = locale === "ar";
  const rec = recommendationForDraft(data);
  const selected = data.template.selected_key;
  const recEntry = getCatalogueEntry(rec.recommendedKey);
  const alternatives = rec.ranked.filter((m) => m.key !== rec.recommendedKey);
  const topAlternatives = alternatives.slice(0, 3);
  const restAlternatives = alternatives.slice(3);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("onboarding.flow.template.title")}
          meta={
            <Badge tone={rec.confident ? "success" : "warning"}>
              {rec.confident
                ? t("onboarding.flow.template.confidence_high")
                : t("onboarding.flow.template.confidence_low")}
            </Badge>
          }
        />
        {recEntry ? (
          <div className="flex flex-col gap-3">
            {/* Raw match score dropped (review): the confidence badge above is
                the honest signal — an internal number reads as false precision. */}
            <h2 className="text-base font-semibold text-ink">
              {ar ? recEntry.names.ar : recEntry.names.en}
            </h2>
            <p className="rounded-md bg-sunken p-3 text-sm text-ink">
              <span className="font-medium">{t("onboarding.flow.template.why_label")}:</span>{" "}
              {ar ? rec.reasonAr : rec.reasonEn}
            </p>
            <TemplatePreview t={t} locale={locale} entry={recEntry} />
            <div className="flex flex-wrap items-center gap-3">
              <ChooseTemplateForm
                t={t}
                templateKey={rec.recommendedKey}
                recommendedKey={rec.recommendedKey}
                confident={rec.confident}
                selected={selected === rec.recommendedKey}
                primary
              />
              <Link href={stepHref("business")} className="text-sm text-brand hover:underline">
                {t("onboarding.flow.template.edit_answers")}
              </Link>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={t("onboarding.flow.template.alternatives")} />
        <ul className="flex flex-col gap-3">
          {topAlternatives.map((m) => {
            const entry = getCatalogueEntry(m.key);
            if (!entry) return null;
            return (
              <li key={m.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <span className="text-sm font-semibold text-ink">
                  {ar ? entry.names.ar : entry.names.en}
                </span>
                <details>
                  <summary className="min-h-11 cursor-pointer text-sm leading-[44px] text-brand">
                    {t("onboarding.flow.template.preview")}
                  </summary>
                  <TemplatePreview t={t} locale={locale} entry={entry} />
                </details>
                <ChooseTemplateForm
                  t={t}
                  templateKey={m.key}
                  recommendedKey={rec.recommendedKey}
                  confident={rec.confident}
                  selected={selected === m.key}
                  primary={false}
                />
              </li>
            );
          })}
        </ul>
        {restAlternatives.length > 0 ? (
          <details className="mt-3">
            <summary className="min-h-11 cursor-pointer text-sm leading-[44px] text-brand">
              {t("onboarding.flow.template.all")}
            </summary>
            <ul className="flex flex-col gap-3">
              {restAlternatives.map((m) => {
                const entry = getCatalogueEntry(m.key);
                if (!entry) return null;
                return (
                  <li key={m.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
                    <span className="text-sm font-semibold text-ink">
                      {ar ? entry.names.ar : entry.names.en}
                    </span>
                    <TemplatePreview t={t} locale={locale} entry={entry} />
                    <ChooseTemplateForm
                      t={t}
                      templateKey={m.key}
                      recommendedKey={rec.recommendedKey}
                      confident={rec.confident}
                      selected={selected === m.key}
                      primary={false}
                    />
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Link href={stepHref("needs")} className={backLinkCls}>
          {t("onboarding.flow.back")}
        </Link>
        {selected ? (
          <Link
            href={stepHref("proposal")}
            className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse hover:bg-brand-strong"
          >
            {t("onboarding.flow.next")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ── Proposal ──────────────────────────────────────────────────────────────────
export function ProposalStep({ t, locale, data }: StepProps) {
  const ar = locale === "ar";
  const intake = draftToIntake(data);
  const proposal = buildGroundedProposal(intake);
  const manifest = TEMPLATES[proposal.template_key];
  const entry = getCatalogueEntry(proposal.template_key);
  const stages = manifest?.stage_template?.stages ?? [];
  const roles =
    (
      manifest?.role_presets as {
        roles?: Array<{ key: string; label?: { en?: string; ar?: string } }>;
      }
    )?.roles ?? [];
  const templateJobEn = manifest?.terminology?.job?.en?.singular ?? "";
  const templateJobAr = manifest?.terminology?.job?.ar?.singular ?? "";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("onboarding.flow.proposal.title")} />
        <p className="mb-2 text-xs text-ink-muted">{t("onboarding.flow.proposal.note")}</p>
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
          {ar ? proposal.intake_summary_ar : proposal.intake_summary_en}
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          {entry ? (ar ? entry.names.ar : entry.names.en) : proposal.template_key}
        </p>
      </Card>

      <Card>
        <CardHeader title={t("onboarding.flow.proposal.stages")} />
        <ol className="flex flex-col gap-1 text-sm text-ink">
          {stages.map((s, i) => (
            <li key={s.stage_key} className="flex items-center gap-2">
              <span dir="ltr" className="w-6 shrink-0 text-center font-mono text-xs text-ink-muted">
                {i + 1}
              </span>
              {ar ? s.names.ar : s.names.en}
            </li>
          ))}
        </ol>
      </Card>

      <form action={saveProposalTermsAction} className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t("onboarding.flow.proposal.terminology")} />
          <p className="mb-2 text-sm text-ink">
            {t("onboarding.flow.proposal.term_current", {
              term: ar ? templateJobAr : templateJobEn,
            })}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={field}>
              {t("onboarding.flow.proposal.term_edit_en")}
              <input
                name="job_term_en"
                maxLength={40}
                defaultValue={data.terms.job_term_en ?? ""}
                placeholder={templateJobEn}
                className={input}
                dir="ltr"
              />
            </label>
            <label className={field}>
              {t("onboarding.flow.proposal.term_edit_ar")}
              <input
                name="job_term_ar"
                maxLength={40}
                defaultValue={data.terms.job_term_ar ?? ""}
                placeholder={templateJobAr}
                className={input}
                dir="rtl"
              />
            </label>
          </div>
          <p className={`mt-2 ${help}`}>{t("onboarding.flow.proposal.term_help")}</p>
        </Card>

        <Card>
          <CardHeader title={t("onboarding.flow.proposal.roles")} />
          <ul className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <li key={r.key}>
                <Badge tone="neutral">{(ar ? r.label?.ar : r.label?.en) ?? r.key}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title={t("onboarding.flow.proposal.approvals")} />
          <p className="text-sm text-ink-muted">{t("onboarding.flow.proposal.approvals_note")}</p>
        </Card>

        <NavRow t={t} step="proposal" />
      </form>
    </div>
  );
}

// ── Plan (subscription selection — a recorded choice, no payment) ─────────────
export function PlanStep({ t, locale, data, view }: StepProps & { view: SelectionView }) {
  const currency: SelectionCurrency = data.answers.base_currency === "AED" ? "AED" : "USD";
  const selectedKey = data.template.selected_key ?? "";
  const jobsNoun =
    TEMPLATES[selectedKey]?.terminology?.job?.[locale]?.plural ??
    t("onboarding.flow.plan.jobs_fallback");
  const mode = data.tier?.mode;
  const current =
    mode === "free"
      ? ("free" as const)
      : mode === "tier_medium"
        ? ("medium" as const)
        : mode === "tier_high"
          ? ("high" as const)
          : mode === "custom"
            ? ("custom" as const)
            : null;

  const groups: CustomBuilderGroup[] = view.custom.groups.map((g) => ({
    key: g.key,
    label: t(`subscription.group.${g.key}`),
    items: g.items.map((i) => ({
      key: i.addon.key,
      name: i.addon.names[locale],
      description: i.addon.description[locale],
      priceMonthlyMinor: currency === "AED" ? i.addon.aedMonthlyMinor : i.addon.usdMonthlyMinor,
      stackable: i.addon.stackable,
      selectable: i.selectable,
      ...(i.addon.availabilityNote ? { note: i.addon.availabilityNote[locale] } : {}),
    })),
  }));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("onboarding.flow.plan.title")} />
        <p className="text-sm text-ink">{t("onboarding.flow.plan.must_choose")}</p>
        <p className="mt-2 rounded-md bg-sunken p-3 text-sm text-ink">
          {t("onboarding.flow.plan.honesty")}
        </p>
      </Card>

      {/* Free is one honest click — selected INSIDE its comparison card (the
          same slot the tiers use), never a duplicate card below the grid. */}
      <TierCards
        view={view}
        locale={locale}
        currency={currency}
        t={t}
        jobsNoun={jobsNoun}
        current={current}
        selectTierAction={selectTierFlowAction}
        selectFreeAction={selectFreeAction}
        customHref="#custom-builder"
        canManage
        providerEnabled
      />

      <div id="custom-builder" className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-ink">
          {t("onboarding.flow.plan.custom_title")}
        </h3>
        <p className="text-xs text-ink-muted">{t("onboarding.flow.plan.custom_help")}</p>
        <CustomBuilder
          groups={groups}
          currency={currency}
          locale={locale}
          labels={{
            total: t("subscription.monthly_total"),
            perMonth: t("subscription.per_month"),
            taxNote: t("subscription.indicative_pricing"),
            overlapNote: t("onboarding.flow.plan.honesty_short"),
            quantity: t("subscription.addon.quantity"),
            notAvailable: t("onboarding.flow.plan.not_available"),
            submit: t("onboarding.flow.plan.custom_cta"),
            increase: t("subscription.addon.increase"),
            decrease: t("subscription.addon.decrease"),
          }}
          initial={mode === "custom" ? (data.tier?.quantities ?? {}) : {}}
          action={selectCustomAction}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Link href={stepHref("proposal")} className={backLinkCls}>
          {t("onboarding.flow.back")}
        </Link>
        {mode ? (
          <Link
            href={stepHref("branding")}
            className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse hover:bg-brand-strong"
          >
            {t("onboarding.flow.next")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ── Branding ──────────────────────────────────────────────────────────────────
const SWATCHES = [
  "#0f766e",
  "#1d4ed8",
  "#7c3aed",
  "#b91c1c",
  "#c2410c",
  "#a16207",
  "#166534",
  "#0f172a",
] as const;

const LOGO_ERROR_CODES = [
  "too_large",
  "bad_type",
  "bad_signature",
  "too_small_dims",
  "too_large_dims",
  "bad_image",
  "quota_exceeded",
  "invalid_input",
  "session",
  "failed",
] as const;

export function BrandingStep({ t, data }: StepProps) {
  const a = data.answers;
  const b = data.branding;
  const logoDataUri = b.logo_base64 ? `data:image/png;base64,${b.logo_base64}` : null;
  const errors = Object.fromEntries(
    LOGO_ERROR_CODES.map((c) => [c, t(`onboarding.flow.branding.error.${c}`)]),
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("onboarding.flow.branding.title")} />
        <p className="text-xs text-ink-muted">{t("onboarding.flow.branding.note")}</p>
        {/* Honesty (review): logo DISPLAY is gated by the branding add-ons after the
            trial — the wizard must not set a false expectation for Free founders. */}
        <p className="mt-1 text-xs text-ink-muted">{t("onboarding.flow.branding.trial_note")}</p>
      </Card>

      <Card>
        <CardHeader title={t("onboarding.flow.branding.logo")} />
        <LogoPicker
          logoDataUri={logoDataUri}
          labels={{
            drop: t("onboarding.flow.branding.logo_drop"),
            choose: t("onboarding.flow.branding.logo_choose"),
            replace: t("onboarding.flow.branding.logo_replace"),
            remove: t("onboarding.flow.branding.logo_remove"),
            uploading: t("onboarding.flow.branding.logo_uploading"),
            hint: t("onboarding.flow.branding.logo_hint"),
            errors,
          }}
          uploadAction={uploadFlowLogoAction}
          removeAction={removeFlowLogoAction}
        />
      </Card>

      <form action={saveBrandingStepAction} className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t("onboarding.flow.branding.accent")} />
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map((c) => (
              <label key={c} className="cursor-pointer">
                <input
                  type="radio"
                  name="accent_swatch"
                  value={c}
                  aria-label={c}
                  defaultChecked={b.accent_color?.toLowerCase() === c}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className="block h-11 w-11 rounded-md border-2 border-line peer-checked:border-ink peer-focus-visible:outline-2"
                  style={{ backgroundColor: c }}
                />
              </label>
            ))}
          </div>
          <label className={`mt-3 ${field}`}>
            {t("onboarding.flow.branding.accent_hex")}
            <input
              name="accent_color"
              maxLength={7}
              defaultValue={b.accent_color ?? ""}
              placeholder="#0F766E"
              dir="ltr"
              className={input}
            />
          </label>
        </Card>

        <Card>
          <CardHeader title={t("onboarding.flow.branding.identity")} />
          <div className="flex flex-col gap-3">
            <label className={field}>
              {t("onboarding.flow.branding.display_name")}
              <input
                name="display_name"
                maxLength={120}
                defaultValue={b.display_name ?? a.business_name ?? ""}
                className={input}
              />
            </label>
            <label className={field}>
              {t("onboarding.flow.branding.legal_name")}
              <input
                name="legal_name"
                maxLength={200}
                defaultValue={b.legal_name ?? a.legal_name ?? ""}
                className={input}
              />
            </label>
            <label className={field}>
              {t("onboarding.flow.branding.footer")}
              <textarea
                name="footer_details"
                maxLength={500}
                rows={3}
                defaultValue={b.footer_details ?? ""}
                className={`${input} text-base`}
              />
              <span className={help}>{t("onboarding.flow.branding.footer_hint")}</span>
            </label>
          </div>
        </Card>

        <NavRow t={t} step="branding" nextLabel={t("onboarding.flow.branding.save")} />
      </form>

      <form action={skipBrandingStepAction} className="self-center">
        <Button type="submit" variant="ghost">
          {t("onboarding.flow.skip")}
        </Button>
      </form>
    </div>
  );
}

// ── Review + explicit confirm ─────────────────────────────────────────────────
function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-end font-medium text-ink">{value}</span>
    </div>
  );
}

function EditLink({ t, step }: { t: Translator; step: FlowStep }) {
  return (
    <Link href={stepHref(step)} className="text-sm text-brand hover:underline">
      {t("onboarding.flow.review.edit")}
    </Link>
  );
}

export function ReviewStep({ t, locale, data, view }: StepProps & { view: SelectionView }) {
  const ar = locale === "ar";
  const summary = buildReviewSummary(data, view);
  const currency: SelectionCurrency = summary.business.currency === "AED" ? "AED" : "USD";
  const notSet = t("onboarding.flow.review.not_set");
  const tierName =
    summary.tier.mode === "free"
      ? t("subscription.plan.free")
      : summary.tier.mode === "tier_medium"
        ? view.medium.names[locale]
        : summary.tier.mode === "tier_high"
          ? view.high.names[locale]
          : t("subscription.tier.custom");
  const partialConfirm = Boolean(data.confirm.org_id);
  const templateName = ar ? summary.template.nameAr : summary.template.nameEn;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("onboarding.flow.review.title")}</h1>

      {partialConfirm ? (
        <p className="rounded-md bg-warning-soft p-3 text-sm text-warning" role="status">
          {t("onboarding.flow.review.resume_note")}
        </p>
      ) : null}

      <Card>
        <CardHeader
          title={t("onboarding.flow.review.business")}
          meta={<EditLink t={t} step="business" />}
        />
        <div className="flex flex-col gap-1.5">
          <ReviewRow
            label={t("onboarding.flow.business.name")}
            value={summary.business.name || notSet}
          />
          {summary.business.legalName ? (
            <ReviewRow
              label={t("onboarding.flow.business.legal_name")}
              value={summary.business.legalName}
            />
          ) : null}
          <ReviewRow
            label={t("onboarding.flow.business.industry")}
            value={
              summary.business.industry
                ? t(`onboarding.flow.industry.${summary.business.industry}`)
                : notSet
            }
          />
          <ReviewRow
            label={t("onboarding.flow.region.country")}
            value={
              summary.business.country
                ? t(`onboarding.flow.country.${summary.business.country}`)
                : notSet
            }
          />
          <ReviewRow
            label={t("onboarding.flow.region.currency")}
            value={
              <span dir="ltr" className="font-mono">
                {summary.business.currency || notSet}
              </span>
            }
          />
          <ReviewRow
            label={t("onboarding.flow.region.language")}
            value={
              summary.business.language === "ar"
                ? t("onboarding.flow.region.lang_ar")
                : t("onboarding.flow.region.lang_en")
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("onboarding.flow.review.setup")}
          meta={<EditLink t={t} step="template" />}
        />
        <div className="flex flex-col gap-1.5">
          <ReviewRow label={t("onboarding.flow.review.template")} value={templateName} />
          <ReviewRow
            label={t("onboarding.flow.proposal.stages")}
            value={
              <span dir="ltr" className="font-mono">
                {summary.template.stageCount}
              </span>
            }
          />
          <ReviewRow
            label={t("onboarding.flow.review.job_term")}
            value={ar ? summary.template.jobTermAr : summary.template.jobTermEn}
          />
          {summary.template.renamed ? (
            <p className="text-xs text-ink-muted">{t("onboarding.flow.review.renamed_note")}</p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("onboarding.flow.review.plan")}
          meta={<EditLink t={t} step="plan" />}
        />
        <div className="flex flex-col gap-1.5">
          <ReviewRow label={t("onboarding.flow.review.plan_choice")} value={tierName} />
          {summary.tier.mode === "custom" ? (
            <ReviewRow
              label={t("onboarding.flow.review.custom_count")}
              value={
                <span dir="ltr" className="font-mono">
                  {summary.tier.customCount}
                </span>
              }
            />
          ) : null}
          <ReviewRow
            label={t("subscription.monthly_total")}
            value={
              <span dir="ltr" className="font-mono">
                {formatMoney(summary.tier.monthlyMinor[currency], currency, { locale })}
              </span>
            }
          />
          <p className="text-xs text-ink-muted">{t("subscription.monthly_total_note")}</p>
          <p className="text-xs text-ink-muted">{t("onboarding.flow.plan.honesty")}</p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("onboarding.flow.review.branding")}
          meta={<EditLink t={t} step="branding" />}
        />
        {summary.branding.skipped ? (
          <p className="text-sm text-ink-muted">{t("onboarding.flow.review.branding_skipped")}</p>
        ) : (
          <div className="flex items-center gap-3">
            {data.branding.logo_base64 ? (
              // eslint-disable-next-line @next/next/no-img-element -- draft data URI preview
              <img
                src={`data:image/png;base64,${data.branding.logo_base64}`}
                alt={t("onboarding.flow.branding.logo")}
                className="h-12 w-12 rounded-md border border-line object-contain"
              />
            ) : null}
            <div className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium text-ink">{summary.branding.displayName ?? notSet}</span>
              {summary.branding.accentColor ? (
                <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-sm border border-line"
                    style={{ backgroundColor: summary.branding.accentColor }}
                  />
                  <span dir="ltr" className="font-mono">
                    {summary.branding.accentColor}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t("onboarding.flow.review.confirm_title")} />
        <p className="mb-3 text-sm leading-relaxed text-ink">
          {t("onboarding.flow.review.confirm_explain", { template: templateName })}
        </p>
        <form action={confirmFlowAction}>
          <Button type="submit" size="lg" className="w-full">
            {partialConfirm
              ? t("onboarding.flow.review.confirm_resume")
              : t("onboarding.flow.review.confirm")}
          </Button>
        </form>
      </Card>

      <div className="flex items-center">
        <Link href={stepHref("branding")} className={backLinkCls}>
          {t("onboarding.flow.back")}
        </Link>
      </div>
    </div>
  );
}
