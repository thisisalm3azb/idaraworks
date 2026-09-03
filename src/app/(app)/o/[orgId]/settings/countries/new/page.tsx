import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Card, CardHeader } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { countryPacksEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { PACK_COUNTRIES, resolvePack } from "@/platform/country";
import { createEstablishmentAction } from "../actions";

/**
 * H29E — adding an establishment.
 *
 * The address form is BUILT FROM THE COUNTRY'S OWN SCHEMA. There is no shared
 * "address line 1 / city / postcode / state" shape here, because that shape is
 * an assumption about one country's post office. Saudi Arabia's national
 * address has a building number and an additional number; the UAE has neither
 * and has no postal code at all. The page renders whatever fields the pack
 * declares, in the pack's order, with the pack's own labels.
 *
 * The country cannot be changed afterwards: reinterpreting an establishment's
 * history by picking a different country from a dropdown is exactly what the
 * mandate forbids, so it is a create-time decision.
 */
export default async function NewEstablishmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ country?: string; error?: string; fields?: string }>;
}) {
  if (!countryPacksEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "country.manage")) redirect(`/o/${orgId}/settings/countries`);
  const t = await getT();

  // Which country's address shape to draw. Chosen with a plain link, not client
  // JS, so the form works before hydration on a workshop phone.
  const country = PACK_COUNTRIES.includes(sp.country ?? "") ? sp.country! : PACK_COUNTRIES[0]!;
  const pack = resolvePack(country, new Date().toISOString().slice(0, 10));
  const badFields = new Set((sp.fields ?? "").split(",").filter(Boolean));
  const create = createEstablishmentAction.bind(null, orgId);
  const input = "min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("country.new.title")} />
        <p className="text-sm text-ink-secondary">{t("country.new.hint")}</p>

        {sp.error ? (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
            {t(`country.error.${sp.error}`)}
            {badFields.size > 0 ? ` (${[...badFields].join(", ")})` : ""}
          </p>
        ) : null}

        {/* Country first, and by link: changing it redraws the address form. */}
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-ink">{t("country.field.country")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {PACK_COUNTRIES.map((code) => (
              <Link key={code} href={`?country=${code}`} scroll={false}>
                <Button variant={code === country ? "primary" : "secondary"}>{code}</Button>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-muted">{t("country.new.country_fixed")}</p>
        </fieldset>

        <form action={create} className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="country" value={country} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.code")}</span>
              <input name="code" required maxLength={24} className={input} />
              <span className="text-xs text-ink-muted">{t("country.field.code_hint")}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.legal_name")}</span>
              <input name="legalName" required maxLength={200} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.trading_name")}</span>
              <input name="tradingName" maxLength={200} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.legal_name_local")}</span>
              {/* dir="auto" so an Arabic name lays out right-to-left as typed.
                  Nothing here transliterates a name into another script. */}
              <input name="legalNameLocal" maxLength={200} dir="auto" className={input} />
              <span className="text-xs text-ink-muted">{t("country.field.local_hint")}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.timezone")}</span>
              <input
                name="timezone"
                required
                defaultValue={pack?.format.defaultTimezone ?? ""}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">{t("country.field.currency")}</span>
              <input
                name="baseCurrency"
                required
                maxLength={3}
                defaultValue={pack?.format.currency ?? ""}
                className={`${input} uppercase`}
              />
            </label>
          </div>

          {/* The country's own address shape, in the country's own order. */}
          {pack ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium text-ink">{t("country.field.address")}</legend>
              <p className="text-xs text-ink-muted">{t("country.field.address_hint")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {pack.address.fields.map((field) => (
                  <label key={field.key} className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-ink">
                      {t(field.labelKey)}
                      {field.required ? " *" : ""}
                    </span>
                    <input
                      name={`address.${field.key}`}
                      maxLength={field.maxLength}
                      dir="auto"
                      placeholder={field.example ?? ""}
                      aria-invalid={badFields.has(field.key) || undefined}
                      className={input}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="isPrimary" className="size-4" />
            {t("country.field.primary")}
          </label>

          <div className="flex gap-2">
            <Button type="submit">{t("country.new.create")}</Button>
            <Link href={`/o/${orgId}/settings/countries`}>
              <Button variant="ghost" type="button">
                {t("common.cancel")}
              </Button>
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
