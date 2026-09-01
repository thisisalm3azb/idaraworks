import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { listAccounts } from "@/modules/finance/service";
import { createAccountAction } from "../actions";

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

/** H24K — the chart of accounts. */
export default async function AccountsPage({
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
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const manages = can(resolved.archetype, "finance.manage");
  const accounts = await listAccounts(resolved.ctx, resolved.archetype);
  const create = createAccountAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.accounts.title")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {manages ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.accounts.new")}</h2>
          <form action={create} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className="text-xs text-ink-muted">
              {t("finance.accounts.code")}
              <input name="code" required maxLength={20} className={input} dir="ltr" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.accounts.name_en")}
              <input name="name_en" required maxLength={120} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.accounts.name_ar")}
              <input name="name_ar" maxLength={120} className={input} dir="rtl" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.accounts.type")}
              <select name="account_type" className={input} dir="ltr">
                {TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`finance.accounts.type_${x}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-4">
              <Button type="submit">{t("finance.accounts.new")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState title={t("finance.accounts.empty")} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b border-line text-start text-xs text-ink-muted">
                  <th className="py-2 text-start">{t("finance.accounts.code")}</th>
                  <th className="py-2 text-start">{t("finance.accounts.name")}</th>
                  <th className="py-2 text-start">{t("finance.accounts.type")}</th>
                  <th className="py-2 text-start">{t("finance.accounts.kind")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="py-2" dir="ltr">
                      {a.code}
                    </td>
                    <td className="py-2 text-ink">
                      {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                    </td>
                    <td className="py-2 text-ink-muted">
                      {t(`finance.accounts.type_${a.accountType}`)}
                    </td>
                    <td className="py-2">
                      {a.isControl ? (
                        <Badge tone="info">{t("finance.accounts.control")}</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
