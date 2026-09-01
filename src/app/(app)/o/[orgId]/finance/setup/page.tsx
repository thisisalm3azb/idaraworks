import { notFound, redirect } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { financeSetupState } from "@/modules/finance/service";
import { installFinanceAction, installVatPackAction, setVatProfileAction } from "../actions";

const EMIRATES = ["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"] as const;

/** H24K — books setup: start date, chart install, VAT pack, VAT profile. */
export default async function FinanceSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.manage")) notFound();
  const t = await getT();
  const setup = await financeSetupState(resolved.ctx, resolved.archetype);
  const install = installFinanceAction.bind(null, orgId);
  const vatPack = installVatPackAction.bind(null, orgId);
  const profile = setVatProfileAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.setup.title")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("common.saved")}
        </p>
      ) : null}

      <Card>
        <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.setup.install")}</h2>
        <p className="mb-2 text-xs text-ink-muted">{t("finance.setup.install_hint")}</p>
        {setup.installed ? (
          <p className="text-sm text-ink">
            {t("finance.setup.books_start")}: <span dir="ltr">{setup.booksStartDate}</span>
          </p>
        ) : (
          <form action={install} className="flex flex-col gap-2 sm:max-w-sm">
            <label className="text-xs text-ink-muted">
              {t("finance.setup.books_start")}
              <input name="books_start_date" type="date" required className={input} dir="ltr" />
            </label>
            <Button type="submit">{t("finance.setup.install")}</Button>
          </form>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.setup.vat_pack")}</h2>
        <p className="mb-2 text-xs text-ink-muted">{t("finance.setup.vat_pack_hint")}</p>
        {setup.vatPackInstalled ? (
          <p className="text-sm text-success">{t("finance.setup.vat_pack_installed")}</p>
        ) : (
          <form action={vatPack}>
            <Button type="submit" disabled={!setup.installed}>
              {t("finance.setup.vat_pack")}
            </Button>
          </form>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.setup.vat_profile")}</h2>
        <form action={profile} className="flex flex-col gap-2 sm:max-w-sm">
          <label className="text-xs text-ink-muted">
            {t("finance.setup.trn")}
            <input
              name="trn"
              defaultValue={setup.vatProfile?.trn ?? ""}
              maxLength={20}
              className={input}
              dir="ltr"
            />
          </label>
          <label className="text-xs text-ink-muted">
            {t("finance.setup.emirate")}
            <select
              name="emirate"
              defaultValue={setup.vatProfile?.emirate ?? "DXB"}
              className={input}
              dir="ltr"
            >
              {EMIRATES.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {t("finance.setup.periodicity")}
            <select
              name="periodicity"
              defaultValue={setup.vatProfile?.periodicity ?? "quarterly"}
              className={input}
              dir="ltr"
            >
              <option value="quarterly">{t("finance.setup.quarterly")}</option>
              <option value="monthly">{t("finance.setup.monthly")}</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              name="registered"
              defaultChecked={setup.vatProfile?.registered ?? false}
              className="h-4 w-4"
            />
            {t("finance.setup.registered")}
          </label>
          <Button type="submit">{t("common.save")}</Button>
        </form>
      </Card>
    </div>
  );
}
