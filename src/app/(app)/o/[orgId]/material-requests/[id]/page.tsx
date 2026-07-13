import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getMaterialRequest } from "@/modules/supply/service";
import { listSuppliers } from "@/modules/masters/service";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { submitMrAction, convertMrAction } from "../actions";

export default async function MrDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, id } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  const t = await getT();
  const mr = await getMaterialRequest(resolved.ctx, a, id);
  if (!mr) notFound();
  const currency = resolved.baseCurrency as CurrencyCode;
  const submit = submitMrAction.bind(null, orgId);
  const convert = convertMrAction.bind(null, orgId);
  const canConvert = can(a, "mr.convert") && mr.status === "approved";
  const canSubmit =
    (mr.status === "draft" || mr.status === "rejected") && mr.createdBy === resolved.ctx.userId;
  const suppliers = canConvert ? await listSuppliers(resolved.ctx, a).catch(() => []) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{mr.reference}</h1>
        <Badge tone={mr.status === "approved" || mr.status === "converted" ? "success" : "info"}>
          {t(`mr.status.${mr.status}`)}
        </Badge>
      </div>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("mr.submitted_notice")}
        </p>
      ) : null}

      <Card>
        <p className="text-xs text-ink-muted">
          {mr.jobReference ? `${mr.jobReference} · ` : ""}
          {t(`mr.urgency.${mr.urgency}`)}
          {mr.requiredDate ? ` · ${mr.requiredDate}` : ""}
        </p>
        <ul className="mt-2 divide-y divide-line">
          {mr.lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-2 text-sm text-ink">
              <span>{l.itemName}</span>
              <span className="text-ink-secondary">
                {l.qty} {l.unit}
                {l.estUnitCostMinor
                  ? ` · ${formatMoney(Number(l.estUnitCostMinor), currency, { locale: "en" })}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
        {mr.totalMinor ? (
          <p className="mt-2 text-end text-sm font-semibold text-ink" dir="ltr">
            {formatMoney(Number(mr.totalMinor), currency, { locale: "en" })}
          </p>
        ) : null}
        {mr.notes ? <p className="mt-2 text-sm text-ink-secondary">{mr.notes}</p> : null}
      </Card>

      {canSubmit ? (
        <form action={submit}>
          <input type="hidden" name="mr_id" value={mr.id} />
          <Button type="submit" size="lg" className="w-full">
            {t("mr.submit")}
          </Button>
        </form>
      ) : null}

      {canConvert ? (
        <Card>
          <CardHeader title={t("mr.convert")} />
          <form action={convert} className="flex flex-col gap-2">
            <input type="hidden" name="mr_id" value={mr.id} />
            <label className="text-sm text-ink">{t("mr.convert_supplier")}</label>
            <select
              name="supplier_id"
              required
              className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              <option value="">—</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              name="vat_minor"
              type="number"
              min={0}
              placeholder={t("po.vat")}
              className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            />
            <Button type="submit">{t("mr.convert")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
