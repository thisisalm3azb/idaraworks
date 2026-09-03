import { revenueStudioEnabled } from "@/platform/flags";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { previewMerge } from "@/modules/crm/service";
import { getCustomer, listCustomers } from "@/modules/masters/service";
import { resolveRevenue, tabLabels } from "../../../shared";
import { RevenueTabs } from "../../../RevenueTabs";
import { mergeCustomersAction } from "../actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";

/**
 * H27 — a merge is reviewed, never guessed: pick the duplicate, see every
 * conflicting field and every record that will move, resolve each conflict,
 * give a reason, then apply. The source keeps a pointer to the survivor and
 * the evidence row is immutable.
 */
export default async function MergePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
  searchParams: Promise<{ source?: string; error?: string }>;
}) {
  if (!revenueStudioEnabled()) notFound(); // page-level gate: layouts and pages render concurrently
  const { orgId, customerId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.merge");
  const jobs = term("job", await loadOrgTerminology(resolved.ctx, locale), "plural");
  const target = await getCustomer(resolved.ctx, resolved.archetype, customerId);
  if (!target) notFound();
  const candidates = (
    await listCustomers(resolved.ctx, resolved.archetype, { status: "all", limit: 500 })
  ).filter((c) => c.id !== customerId);
  const preview =
    sp.source && candidates.some((c) => c.id === sp.source)
      ? await previewMerge(resolved.ctx, resolved.archetype, sp.source, customerId)
      : null;
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">
          {t("revenue.merge.title")} · {target.name}
        </h1>
        <RevenueTabs
          orgId={orgId}
          active="success"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? <Badge tone="danger">{t(`revenue.merge.error.${sp.error}`)}</Badge> : null}

      <Card>
        <CardHeader title={t("revenue.merge.pick")} />
        <p className="mb-2 text-sm text-ink-muted">{t("revenue.merge.pick_hint", { jobs })}</p>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.merge.source")}
            <select name="source" defaultValue={sp.source ?? ""} className={input} required>
              <option value="">—</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? "" : ` (${t("common.inactive")})`}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            {t("revenue.merge.preview")}
          </Button>
        </form>
      </Card>

      {preview && sp.source ? (
        <form
          action={mergeCustomersAction.bind(null, orgId, customerId)}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="source_id" value={sp.source} />
          <Card>
            <CardHeader title={t("revenue.merge.conflicts")} />
            {preview.conflicts.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("revenue.merge.no_conflicts")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {preview.conflicts.map((c) => (
                  <li
                    key={c.field}
                    className="grid grid-cols-1 gap-2 rounded-md border border-line p-3 sm:grid-cols-3"
                  >
                    <span className="text-sm font-medium text-ink">
                      {t(`revenue.merge.field.${c.field}`)}
                    </span>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="radio"
                        name={`res_${c.field}`}
                        value="target"
                        defaultChecked
                        className="size-5"
                      />
                      <span className="truncate">
                        <span className="text-xs text-ink-muted">{t("revenue.merge.keep")}: </span>
                        {show(c.target)}
                      </span>
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="radio"
                        name={`res_${c.field}`}
                        value="source"
                        className="size-5"
                      />
                      <span className="truncate">
                        <span className="text-xs text-ink-muted">{t("revenue.merge.take")}: </span>
                        {show(c.source)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-muted">{t("revenue.merge.fill_note")}</p>
            {preview.tagsUnion.length > 0 ? (
              <p className="mt-1 text-xs text-ink-muted">
                {t("revenue.customer.tags")}: {preview.tagsUnion.join(", ")}
              </p>
            ) : null}
          </Card>
          <Card>
            <CardHeader title={t("revenue.merge.moves")} />
            <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {Object.entries(preview.counts).map(([table, n]) => (
                <li key={table} className="rounded-md border border-line px-3 py-2">
                  <span className="block text-xs text-ink-muted">
                    {t(`revenue.merge.table.${table}`, { jobs })}
                  </span>
                  <span className="font-semibold text-ink">{n}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("revenue.merge.reason")}
              <textarea
                name="reason"
                required
                minLength={3}
                maxLength={500}
                rows={2}
                className={input}
              />
            </label>
            <p className="mt-2 text-xs text-ink-muted">{t("revenue.merge.irreversible")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="submit" variant="danger">
                {t("revenue.merge.apply")}
              </Button>
              <Link
                href={back}
                className="inline-flex min-h-11 items-center px-3 text-sm text-ink-secondary hover:underline"
              >
                {t("common.cancel")}
              </Link>
            </div>
          </Card>
        </form>
      ) : null}
    </div>
  );
}
