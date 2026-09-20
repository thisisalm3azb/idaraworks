/**
 * The short onboarding: four screens (server components, native forms, no
 * client state). Phone-first: one column, 44px targets, chips and cards as
 * native radios/checkboxes, logical properties only. Every screen has one
 * primary action; the draft autosaves on each submit and resumes on refresh.
 */
import Link from "next/link";
import { Card, SubmitButton } from "@/platform/ui";
import type { Locale } from "@/platform/registries";
import type { Translator } from "@/platform/i18n/server";
import { offeredLocales } from "@/platform/i18n/offered";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import { TEMPLATE_CATALOGUE, getCatalogueEntry } from "@/platform/config";
import {
  COUNTRY_DEFAULTS,
  EMPLOYEE_BANDS,
  PRIORITY_AREAS,
  prevStepBefore,
  type DraftData,
  type FlowStep,
} from "@/modules/onboarding/service";
import { chooseSetupAction, confirmFlowAction, saveStepAction } from "./actions";

export type ScreenProps = {
  t: Translator;
  locale: Locale;
  data: DraftData;
  /** The stored draft's updated_at — the optimistic two-tab guard. */
  draftRev: string;
};

const input =
  "min-h-12 w-full rounded-md border border-line-strong bg-card px-3 py-2 text-base font-normal text-ink";
const chip =
  "flex min-h-12 cursor-pointer items-center gap-2.5 rounded-md border border-line bg-card px-3.5 text-sm text-ink has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:font-medium";
const backCls =
  "inline-flex min-h-12 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken";

function stepHref(step: FlowStep): string {
  return `/onboarding?step=${step}`;
}

function NavRow({
  t,
  step,
  data,
  draftRev,
  nextLabel,
}: {
  t: Translator;
  step: FlowStep;
  data: DraftData;
  draftRev?: string;
  nextLabel?: string;
}) {
  const first = prevStepBefore(step, data.answers) === step;
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      {draftRev !== undefined ? <input type="hidden" name="draft_rev" value={draftRev} /> : null}
      {first ? (
        <span />
      ) : (
        <Link href={stepHref(prevStepBefore(step, data.answers))} className={backCls}>
          {t("onboarding.flow.back")}
        </Link>
      )}
      <SubmitButton pendingLabel={t("common.working")}>
        {nextLabel ?? t("onboarding.flow.next")}
      </SubmitButton>
    </div>
  );
}

// ── 1. Your business ─────────────────────────────────────────────────────────
export function BusinessScreen({ t, locale, data, draftRev }: ScreenProps) {
  const a = data.answers;
  const countries = Object.keys(COUNTRY_DEFAULTS);
  const language = a.preferred_language ?? locale;
  return (
    <Card>
      <p className="mb-4 text-sm text-ink-secondary">{t("onb.business.lead")}</p>
      <form action={saveStepAction.bind(null, "business")} className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          {t("onb.business.name")}
          <input
            name="business_name"
            type="text"
            required
            maxLength={120}
            autoComplete="organization"
            defaultValue={a.business_name ?? ""}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          {t("onb.business.country")}
          <select
            name="country"
            required
            defaultValue={a.country ?? "AE"}
            className="min-h-12 rounded-md border border-line-strong bg-card px-3 text-base font-normal text-ink"
          >
            {countries.map((c) => (
              <option key={c} value={c}>
                {t(`onboarding.flow.country.${c}`)}
              </option>
            ))}
          </select>
          <span className="text-xs font-normal text-ink-muted">
            {t("onb.business.country_note")}
          </span>
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onb.business.language")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {offeredLocales().map((l) => (
              <label key={l} className={chip}>
                <input
                  type="radio"
                  name="preferred_language"
                  value={l}
                  defaultChecked={language === l}
                  required
                  className="size-4 accent-current"
                />
                <span lang={l}>{LOCALE_NATIVE_NAME[l]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <NavRow t={t} step="business" data={data} draftRev={draftRev} />
      </form>
    </Card>
  );
}

// ── 2. How you work ──────────────────────────────────────────────────────────
export function SetupScreen({ t, locale, data, draftRev }: ScreenProps) {
  const ar = locale === "ar";
  const selected = data.template.selected_key;
  return (
    <Card>
      <p className="mb-4 text-sm text-ink-secondary">{t("onb.setup.lead")}</p>
      <form action={chooseSetupAction} className="flex flex-col gap-2">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t("onb.setup.title")}</legend>
          {TEMPLATE_CATALOGUE.map((entry) => (
            <label
              key={entry.key}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-card p-3.5 has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input
                type="radio"
                name="template_key"
                value={entry.key}
                required
                defaultChecked={selected === entry.key}
                className="mt-1 size-4 shrink-0 accent-current"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">
                  {ar ? entry.names.ar : entry.names.en}
                </span>
                <span className="mt-0.5 block text-xs text-ink-secondary">
                  {t(`onb.setup.tpl.${entry.key}`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="mt-1 text-xs text-ink-muted">{t("onb.setup.note")}</p>
        <NavRow t={t} step="setup" data={data} draftRev={draftRev} />
      </form>
    </Card>
  );
}

// ── 3. Your first priorities ─────────────────────────────────────────────────
export function PrioritiesScreen({ t, data, draftRev }: ScreenProps) {
  const a = data.answers;
  const chosen = new Set(a.priorities ?? []);
  return (
    <Card>
      <p className="mb-4 text-sm text-ink-secondary">{t("onb.priorities.lead")}</p>
      <form action={saveStepAction.bind(null, "priorities")} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("onb.priorities.pick")}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PRIORITY_AREAS.map((area) => (
              <label key={area} className={chip}>
                <input
                  type="checkbox"
                  name="priorities"
                  value={area}
                  defaultChecked={chosen.has(area)}
                  className="size-4 accent-current"
                />
                <span className="min-w-0">
                  <span className="block">{t(`onb.priority.${area}`)}</span>
                  <span className="block text-xs font-normal text-ink-muted">
                    {t(`onb.priority.${area}_hint`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">{t("onb.team.title")}</legend>
          <div className="flex flex-wrap gap-2">
            {EMPLOYEE_BANDS.map((band) => (
              <label key={band} className={chip}>
                <input
                  type="radio"
                  name="employees_band"
                  value={band}
                  defaultChecked={(a.employees_band ?? "1-5") === band}
                  className="size-4 accent-current"
                />
                {t(`onb.team.${band}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <NavRow t={t} step="priorities" data={data} draftRev={draftRev} />
      </form>
    </Card>
  );
}

// ── 4. Ready to start ────────────────────────────────────────────────────────
export function ReadyScreen({ t, locale, data }: ScreenProps) {
  const a = data.answers;
  const ar = locale === "ar";
  const entry = data.template.selected_key ? getCatalogueEntry(data.template.selected_key) : null;
  const priorities = (a.priorities ?? []).map((p) => t(`onb.priority.${p}`));
  const rows: Array<[string, string]> = [
    [t("onb.ready.business"), a.business_name ?? ""],
    [
      t("onb.ready.region"),
      `${a.country ? t(`onboarding.flow.country.${a.country}`) : ""} · ${
        a.preferred_language ? LOCALE_NATIVE_NAME[a.preferred_language] : ""
      }`,
    ],
    [t("onb.ready.setup"), entry ? (ar ? entry.names.ar : entry.names.en) : ""],
    [
      t("onb.ready.priorities"),
      priorities.length > 0 ? priorities.join(ar ? "، " : ", ") : t("onb.ready.no_priorities"),
    ],
  ];
  return (
    <Card>
      <p className="mb-4 text-sm text-ink-secondary">{t("onb.ready.lead")}</p>
      <dl className="grid gap-2 rounded-md border border-line bg-sunken p-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-ink-secondary">{k}</dt>
            <dd className="font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* The trial, in two lines; the detail sits behind a disclosure. */}
      <div className="mt-4 rounded-md border border-brand/30 bg-brand/5 p-3">
        <p className="text-sm font-semibold text-ink">{t("trial.promise.headline")}</p>
        <p className="mt-0.5 text-sm text-ink-secondary">{t("trial.promise.after_short")}</p>
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer text-sm leading-[44px] text-brand">
            {t("trial.promise.details")}
          </summary>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-xs text-ink-secondary">
            <li>{t("trial.promise.included")}</li>
            <li>{t("trial.promise.dates")}</li>
            <li>{t("trial.promise.after")}</li>
            <li>{t("trial.promise.no_restart")}</li>
            <li>
              <Link href="/terms" className="text-brand underline">
                {t("auth.gateway.terms")}
              </Link>
            </li>
          </ul>
        </details>
      </div>

      <form action={confirmFlowAction} className="mt-4 flex items-center justify-between gap-3">
        <Link href={stepHref(prevStepBefore("ready", data.answers))} className={backCls}>
          {t("onboarding.flow.back")}
        </Link>
        <SubmitButton pendingLabel={t("onb.ready.working")}>{t("onb.ready.open")}</SubmitButton>
      </form>
      <p className="mt-3 text-xs text-ink-muted">{t("onb.ready.later")}</p>
    </Card>
  );
}
