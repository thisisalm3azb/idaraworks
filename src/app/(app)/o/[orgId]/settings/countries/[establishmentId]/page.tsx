import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { countryPacksEnabled } from "@/platform/flags";
import { getT, getServerLocale } from "@/platform/i18n/server";
import type { CurrencyCode } from "@/platform/registries";
import { READINESS_STATES, formatBusinessDate, resolvePack } from "@/platform/country";
import {
  establishmentReadiness,
  getEstablishment,
  listAdoptions,
  listRegistrations,
  packTimeline,
} from "@/modules/country/service";
import {
  previewAdoptionAction,
  setRegistrationAction,
  updateEstablishmentAction,
} from "../actions";

/**
 * H29E — one establishment: what it is, what it is missing, which pack version
 * it runs on, and what versions exist around that.
 *
 * The timeline is the part that matters. A pack has versions with non-overlapping
 * validity, an establishment ADOPTS a version from a date, and adopting a newer
 * one never reaches back: a transaction dated in an earlier period keeps
 * resolving through the version that applied on its own date. That is why the
 * page shows the version in force TODAY next to the versions before and after
 * it, rather than a single "current settings" panel that quietly rewrites the
 * past every time someone saves.
 */
export default async function EstablishmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; establishmentId: string }>;
  searchParams: Promise<{ notice?: string; error?: string; fields?: string; on?: string }>;
}) {
  if (!countryPacksEnabled()) notFound();
  const { orgId, establishmentId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "country.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();

  const establishment = await getEstablishment(resolved.ctx, establishmentId);
  if (!establishment) notFound();

  // The date the page reads the world on. Defaults to today; a person checking
  // "what applied in March" changes it and every panel answers for that date.
  const on = /^\d{4}-\d{2}-\d{2}$/.test(sp.on ?? "")
    ? sp.on!
    : new Date().toISOString().slice(0, 10);

  const [readiness, registrations, adoptions] = await Promise.all([
    establishmentReadiness(resolved.ctx, establishmentId, on),
    listRegistrations(resolved.ctx, establishmentId),
    listAdoptions(resolved.ctx, establishmentId),
  ]);
  const timeline = packTimeline(establishment.country, on);
  const packToday = resolvePack(establishment.country, on);
  const mayManage = can(resolved.archetype, "country.manage");
  const maySimulate = can(resolved.archetype, "country.simulate");
  const badFields = new Set((sp.fields ?? "").split(",").filter(Boolean));

  const fmt = (iso: string) =>
    formatBusinessDate(iso, {
      uiLocale: locale,
      jurisdiction: establishment.country,
      timezone: establishment.timezone,
      // The stored currency is a plain 3-letter column; the formatter wants the
      // registry union, so it is narrowed once here rather than at each call.
      currency: establishment.baseCurrency as CurrencyCode,
    });
  const input = "min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink";
  const save = updateEstablishmentAction.bind(null, orgId, establishmentId);
  const addRegistration = setRegistrationAction.bind(null, orgId, establishmentId);
  const preview = previewAdoptionAction.bind(null, orgId, establishmentId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={establishment.legalName}
          meta={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{establishment.code}</Badge>
              <Badge tone="neutral">{establishment.country}</Badge>
              {establishment.isPrimary ? <Badge tone="brand">{t("country.primary")}</Badge> : null}
            </div>
          }
        />
        {establishment.legalNameLocal ? (
          <p className="text-sm text-ink-secondary" dir="auto">
            {establishment.legalNameLocal}
          </p>
        ) : null}
        {sp.notice ? (
          <p
            className="mt-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success"
            role="status"
          >
            {t(`country.notice.${sp.notice}`)}
          </p>
        ) : null}
        {sp.error ? (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
            {t(`country.error.${sp.error}`)}
            {badFields.size > 0 ? ` (${[...badFields].join(", ")})` : ""}
          </p>
        ) : null}

        {/* Reading the establishment AS OF a date. Not a filter — the whole page
            answers for this date, because that is how effective-dated rules are
            supposed to be read. */}
        <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink">{t("country.as_of")}</span>
            <input type="date" name="on" defaultValue={on} className={input} />
          </label>
          <Button type="submit" variant="secondary">
            {t("country.as_of_apply")}
          </Button>
        </form>
      </Card>

      {/* ── readiness ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title={t("country.readiness")} />
        <p className="text-sm text-ink-secondary">{t("country.readiness_hint")}</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {READINESS_STATES.map((state) => (
            <li key={state}>
              <Badge tone={readiness?.states[state] ? "success" : "neutral"}>
                {readiness?.states[state] ? "✓ " : "· "}
                {t(`country.state.${state}`)}
              </Badge>
            </li>
          ))}
        </ul>

        {readiness?.areas.map((area) => (
          <section key={area.area} className="mt-4">
            <h3 className="text-sm font-medium text-ink">
              {t(`country.area.${area.area}`)}{" "}
              {area.complete ? <span className="text-success">✓</span> : null}
            </h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {area.checks.map((check) => (
                <li key={check.key} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={
                      check.state === "ok"
                        ? "text-success"
                        : check.state === "blocked"
                          ? "text-danger"
                          : check.state === "missing"
                            ? "text-warning"
                            : "text-ink-muted"
                    }
                  >
                    {check.state === "ok" ? "✓" : check.state === "not_applicable" ? "–" : "!"}
                  </span>
                  <span className="text-ink-secondary">
                    {t(check.labelKey)}
                    {check.detailKey ? ` — ${t(check.detailKey, check.detail)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {readiness && readiness.externalActions.length > 0 ? (
          <div className="mt-4 rounded-md border border-line bg-sunken px-3 py-2 text-sm">
            <p className="font-medium text-ink">{t("country.external_actions")}</p>
            <ul className="mt-1 list-disc ps-5 text-ink-secondary">
              {readiness.externalActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {/* ── the version timeline ────────────────────────────────────────── */}
      <Card>
        <CardHeader title={t("country.timeline")} />
        <p className="text-sm text-ink-secondary">{t("country.timeline_hint")}</p>
        <ul className="mt-3 flex flex-col gap-2">
          {timeline.map(({ pack, inForce, future }) => (
            <li
              key={pack.packKey}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
            >
              <span className="font-medium text-ink">{pack.packKey}</span>
              <span className="text-ink-secondary">
                {fmt(pack.effectiveFrom)}
                {pack.effectiveTo ? ` → ${fmt(pack.effectiveTo)}` : ""}
              </span>
              <Badge tone={pack.status === "approved" ? "success" : "warning"}>
                {t(`country.pack_status.${pack.status}`)}
              </Badge>
              {inForce ? <Badge tone="brand">{t("country.in_force")}</Badge> : null}
              {future ? <Badge tone="neutral">{t("country.future")}</Badge> : null}
            </li>
          ))}
        </ul>

        {packToday && packToday.knownLimitations.length > 0 ? (
          <div className="mt-4 rounded-md border border-line bg-sunken px-3 py-2 text-sm">
            <p className="font-medium text-ink">{t("country.known_limits")}</p>
            <ul className="mt-1 list-disc ps-5 text-ink-secondary">
              {packToday.knownLimitations.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {maySimulate ? (
          <form action={preview} className="mt-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.adopt.version")}</span>
              <select name="packKey" className={input}>
                {timeline
                  .filter(({ pack }) => pack.status === "approved")
                  .map(({ pack }) => (
                    <option key={pack.packKey} value={pack.packKey}>
                      {pack.packKey}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.adopt.from")}</span>
              <input type="date" name="effectiveFrom" defaultValue={on} className={input} />
            </label>
            <Button type="submit" variant="secondary">
              {t("country.adopt.preview")}
            </Button>
          </form>
        ) : null}

        <h3 className="mt-5 text-sm font-medium text-ink">{t("country.adoption_history")}</h3>
        {adoptions.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">{t("country.no_adoptions")}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm text-ink-secondary">
            {adoptions.map((a) => (
              <li key={a.id}>
                {a.packKey} · {t("country.adopted_from", { date: fmt(a.effectiveFrom) })}
                {a.supersededBy ? ` · ${t("country.superseded")}` : ""}
                {a.note ? ` · ${a.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── registrations ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader title={t("country.registrations")} />
        <p className="text-sm text-ink-secondary">{t("country.registrations_hint")}</p>
        {registrations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">{t("country.no_registrations")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {registrations.map((r) => (
              <li key={r.id} className="rounded-md border border-line px-3 py-2">
                <span className="font-medium text-ink">{r.identifierKey}</span>{" "}
                <span className="font-mono text-ink-secondary" dir="ltr">
                  {r.value}
                </span>
                <span className="ms-2 text-ink-muted">{r.authority}</span>
                <Badge
                  tone={r.verificationState === "verified" ? "success" : "neutral"}
                  className="ms-2"
                >
                  {t(`country.verification.${r.verificationState}`)}
                </Badge>
                {r.expiresOn ? (
                  <span className="ms-2 text-ink-muted">
                    {t("country.expires", { date: fmt(r.expiresOn) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {mayManage && packToday ? (
          <form action={addRegistration} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.registration.which")}</span>
              <select name="identifierKey" className={input}>
                {packToday.identifiers.map((spec) => (
                  <option key={spec.key} value={spec.key}>
                    {t(spec.labelKey)}
                    {spec.required ? " *" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.registration.value")}</span>
              <input name="value" required maxLength={80} dir="ltr" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.registration.issued")}</span>
              <input type="date" name="issuedOn" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.registration.expires")}</span>
              <input type="date" name="expiresOn" className={input} />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary">
                {t("country.registration.save")}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      {/* ── details ─────────────────────────────────────────────────────── */}
      {mayManage ? (
        <Card>
          <CardHeader title={t("country.details")} />
          <form action={save} className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.legal_name")}</span>
              <input
                name="legalName"
                defaultValue={establishment.legalName}
                maxLength={200}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.trading_name")}</span>
              <input
                name="tradingName"
                defaultValue={establishment.tradingName ?? ""}
                maxLength={200}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.legal_name_local")}</span>
              <input
                name="legalNameLocal"
                defaultValue={establishment.legalNameLocal ?? ""}
                maxLength={200}
                dir="auto"
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.timezone")}</span>
              <input
                name="timezone"
                defaultValue={establishment.timezone}
                maxLength={64}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.bank")}</span>
              <input
                name="bankName"
                defaultValue={String(establishment.banking.bankName ?? "")}
                maxLength={120}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.iban")}</span>
              <input
                name="iban"
                defaultValue={String(establishment.banking.iban ?? "")}
                maxLength={60}
                dir="ltr"
                className={`${input} font-mono`}
              />
            </label>

            {packToday ? (
              <fieldset className="flex flex-col gap-3 sm:col-span-2">
                <legend className="text-sm font-medium text-ink">
                  {t("country.field.address")}
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {packToday.address.fields.map((field) => (
                    <label key={field.key} className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-ink">
                        {t(field.labelKey)}
                        {field.required ? " *" : ""}
                      </span>
                      <input
                        name={`address.${field.key}`}
                        defaultValue={establishment.address[field.key] ?? ""}
                        maxLength={field.maxLength}
                        dir="auto"
                        aria-invalid={badFields.has(field.key) || undefined}
                        className={input}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className="sm:col-span-2">
              <Button type="submit">{t("common.save")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <p className="text-sm">
        <Link href={`/o/${orgId}/settings/countries`} className="text-brand hover:underline">
          {t("country.back")}
        </Link>
      </p>
    </div>
  );
}
