import { notFound, redirect } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { listAccounts } from "@/modules/finance/service";
import { createJournalAction } from "../../actions";

/** H24K — rapid manual entry: date, memo, up to 10 debit/credit rows. The
 *  entry is born a DRAFT; posting is a separate, deliberate step. */
export default async function NewJournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.post")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const accounts = (await listAccounts(resolved.ctx, resolved.archetype)).filter(
    (a) => !a.isControl,
  );
  const create = createJournalAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.journals.new")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}
      <Card>
        <form action={create} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-ink-muted">
              {t("finance.journals.entry_date")}
              <input name="entry_date" type="date" required className={input} dir="ltr" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.journals.memo")}
              <input name="memo" maxLength={1000} className={input} />
            </label>
          </div>
          <p className="text-xs text-ink-muted">{t("finance.journals.lines_hint")}</p>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <label className="text-xs text-ink-muted sm:col-span-2">
                  {t("finance.journals.account")}
                  <select name={`line_${i}_account`} className={input} dir="ltr" defaultValue="">
                    <option value="">—</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-muted">
                  {t("finance.journals.debit")}
                  <input
                    name={`line_${i}_debit`}
                    type="number"
                    step="0.01"
                    min="0"
                    className={input}
                    dir="ltr"
                  />
                </label>
                <label className="text-xs text-ink-muted">
                  {t("finance.journals.credit")}
                  <input
                    name={`line_${i}_credit`}
                    type="number"
                    step="0.01"
                    min="0"
                    className={input}
                    dir="ltr"
                  />
                </label>
              </div>
            ))}
          </div>
          <Button type="submit">{t("finance.journals.save_draft")}</Button>
        </form>
      </Card>
    </div>
  );
}
