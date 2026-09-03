import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { countryPacksEnabled } from "@/platform/flags";
import { getT, getServerLocale } from "@/platform/i18n/server";
import type { CurrencyCode } from "@/platform/registries";
import { formatBusinessDate } from "@/platform/country";
import { getEstablishment, previewAdoption } from "@/modules/country/service";
import { adoptPackAction } from "../../actions";

/**
 * H29E — the rule impact simulator.
 *
 * It answers "what would change, and what would not" without touching anything.
 * The preview runs against the establishment's real configuration but writes
 * nothing: no transaction is re-rated, no document is reissued, no stored value
 * moves. Applying is a separate, explicit act by someone who holds
 * `country.adopt`, and the module recomputes this same preview at that moment
 * and stores it on the adoption row — so the record shows what the person was
 * shown, not a summary written afterwards.
 *
 * The "unchanged" panel carries as much weight as the changes. Issued invoices,
 * posted journal entries and finalised payroll runs stay exactly as they are;
 * a pack version applies from its own date forward, and history is not rewritten
 * by adopting a newer one.
 */
export default async function SimulatePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; establishmentId: string }>;
  searchParams: Promise<{ packKey?: string; effectiveFrom?: string; error?: string }>;
}) {
  if (!countryPacksEnabled()) notFound();
  const { orgId, establishmentId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "country.simulate")) redirect(`/o/${orgId}/settings/countries`);
  const t = await getT();
  const locale = await getServerLocale();

  const establishment = await getEstablishment(resolved.ctx, establishmentId);
  if (!establishment) notFound();
  const back = `/o/${orgId}/settings/countries/${establishmentId}`;

  const packKey = sp.packKey ?? "";
  const effectiveFrom = sp.effectiveFrom ?? "";
  if (!packKey || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) redirect(back);

  let preview: Awaited<ReturnType<typeof previewAdoption>> | null = null;
  let failure: string | null = null;
  try {
    preview = await previewAdoption(resolved.ctx, resolved.archetype, {
      establishmentId,
      packKey,
      effectiveFrom,
    });
  } catch {
    // A preview that cannot be computed is reported, never guessed at. The
    // person is told plainly and sent back rather than shown an empty diff that
    // reads like "nothing would change".
    failure = "preview";
  }

  const fmt = (iso: string) =>
    formatBusinessDate(iso, {
      uiLocale: locale,
      jurisdiction: establishment.country,
      timezone: establishment.timezone,
      // The stored currency is a plain 3-letter column; the formatter wants the
      // registry union, so it is narrowed once here rather than at each call.
      currency: establishment.baseCurrency as CurrencyCode,
    });
  const mayAdopt = can(resolved.archetype, "country.adopt");
  const adopt = adoptPackAction.bind(null, orgId, establishmentId);
  const input = "min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("country.simulate.title")}
          meta={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{establishment.code}</Badge>
              <Badge tone="brand">{packKey}</Badge>
            </div>
          }
        />
        <p className="text-sm text-ink-secondary">{t("country.simulate.hint")}</p>
        <p className="mt-3 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-secondary">
          {t("country.simulate.law")}
        </p>
        {sp.error ? (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
            {t(`country.error.${sp.error}`)}
          </p>
        ) : null}
        {failure ? (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
            {t("country.error.preview")}
          </p>
        ) : null}
      </Card>

      {preview ? (
        <>
          <Card>
            <CardHeader title={t("country.simulate.changes")} />
            <p className="text-sm text-ink-secondary">
              {preview.fromPackKey
                ? t("country.simulate.from_to", {
                    from: preview.fromPackKey,
                    to: preview.toPackKey,
                    date: fmt(preview.effectiveFrom),
                  })
                : t("country.simulate.first_adoption", {
                    to: preview.toPackKey,
                    date: fmt(preview.effectiveFrom),
                  })}
            </p>

            {preview.changes.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">{t("country.simulate.no_changes")}</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {preview.changes.map((line) => (
                  <li
                    key={`${line.area}:${line.labelKey}`}
                    className="rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{t(`country.area.${line.area}`)}</Badge>
                      <span className="font-medium text-ink">{t(line.labelKey)}</span>
                      {line.actionRequired ? (
                        <Badge tone="warning">{t("country.simulate.action_required")}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-ink-secondary">
                      <span className="text-ink-muted">
                        {line.before ?? t("country.simulate.none")}
                      </span>
                      {" → "}
                      <span className="text-ink">{line.after ?? t("country.simulate.none")}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* What the change cannot touch. Shown as prominently as the diff,
              because "will my issued invoices be re-rated?" is the first thing
              anyone asks and the answer is no. */}
          <Card>
            <CardHeader title={t("country.simulate.unchanged")} />
            <p className="text-sm text-ink-secondary">{t("country.simulate.unchanged_hint")}</p>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-secondary">
              {preview.unchanged.map((u) => (
                <li key={u.kind}>
                  <span className="font-medium text-ink tabular-nums">{u.count}</span>{" "}
                  {t(`country.unchanged.${u.kind}`)} — {u.note}
                </li>
              ))}
            </ul>
          </Card>

          {preview.stillMissing.length > 0 ? (
            <Card>
              <CardHeader title={t("country.simulate.still_missing")} />
              <p className="text-sm text-ink-secondary">
                {t("country.simulate.still_missing_hint")}
              </p>
              <ul className="mt-2 list-disc ps-5 text-sm text-ink-secondary">
                {preview.stillMissing.map((c) => (
                  <li key={c.key}>
                    {t(c.labelKey)}
                    {c.detailKey ? ` — ${t(c.detailKey, c.detail)}` : ""}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {preview.newProviderRequirements.length > 0 ? (
            <Card>
              <CardHeader title={t("country.simulate.providers")} />
              <p className="text-sm text-ink-secondary">{t("country.simulate.providers_hint")}</p>
              <ul className="mt-2 list-disc ps-5 text-sm text-ink-secondary">
                {preview.newProviderRequirements.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title={t("country.simulate.apply")} />
            {mayAdopt ? (
              <form action={adopt} className="flex flex-col gap-3">
                <input type="hidden" name="packKey" value={preview.toPackKey} />
                <input type="hidden" name="effectiveFrom" value={preview.effectiveFrom} />
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">{t("country.simulate.note")}</span>
                  <input name="note" maxLength={1000} className={input} />
                  <span className="text-xs text-ink-muted">{t("country.simulate.note_hint")}</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit">{t("country.simulate.apply_cta")}</Button>
                  <Link href={back}>
                    <Button variant="ghost" type="button">
                      {t("common.cancel")}
                    </Button>
                  </Link>
                </div>
              </form>
            ) : (
              <p className="text-sm text-ink-secondary">{t("country.simulate.cannot_apply")}</p>
            )}
          </Card>
        </>
      ) : null}

      <p className="text-sm">
        <Link href={back} className="text-brand hover:underline">
          {t("country.back_establishment")}
        </Link>
      </p>
    </div>
  );
}
