import { redirect } from "next/navigation";
import { Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { computeAR } from "@/modules/invoices/service";

export default async function ArPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "ar.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = new Date().toISOString().slice(0, 10);
  const ar = await computeAR(resolved.ctx, resolved.archetype, asOf);
  // computeAR redacts money (null) for a viewer without price privilege.
  const money = (v: number | null) => (v === null ? "🔒" : formatMoney(v, currency));
  const buckets: Array<[string, number | null]> = [
    [t("ar.bucket.current"), ar.current],
    [t("ar.bucket.d1_30"), ar.d1_30],
    [t("ar.bucket.d31_60"), ar.d31_60],
    [t("ar.bucket.d61_90"), ar.d61_90],
    [t("ar.bucket.over90"), ar.over90],
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("ar.title")}</h1>
      <Card>
        <CardHeader
          title={t("ar.outstanding")}
          meta={<span className="text-xs text-ink-muted">{asOf}</span>}
        />
        <p className="font-mono text-2xl font-semibold text-ink" dir="ltr">
          {money(ar.outstandingMinor)}
        </p>
      </Card>
      <Card>
        <CardHeader title={t("ar.aging")} />
        <div className="flex flex-col">
          {buckets.map(([label, v]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0"
            >
              <span className="text-ink-muted">{label}</span>
              <span className="font-mono text-ink" dir="ltr">
                {money(v)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
