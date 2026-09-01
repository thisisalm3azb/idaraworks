import { redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { lockedFeatureGate } from "@/platform/ui/subscription";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listJobs } from "@/modules/jobs/service";
import { listItems, listSuppliers } from "@/modules/masters/service";
import { PoForm, type PoDict, type PickableItem } from "../PoForm";

export default async function NewPoPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "po.manage")) redirect(`/o/${orgId}`);
  // Locked-feature UX (U3): honest unlock screen when the capability is off.
  const locked = await lockedFeatureGate(resolved.ctx, a, orgId, "cap.purchase_orders");
  if (locked) return locked;
  const t = await getT();
  const locale = await getServerLocale();
  const [suppliers, jobs, catalogue] = await Promise.all([
    listSuppliers(resolved.ctx, a).then((r) => r.rows),
    listJobs(resolved.ctx, a, { limit: 200 }).then((r) => r.rows),
    /*
     * The catalogue, so an order line can NAME an item rather than describe
     * one. Only a line carrying an item id can become stock when the goods
     * arrive, so without this the whole order-receive-stock chain is broken at
     * its first link. Bounded, and empty for anybody without catalogue access —
     * the form falls back to free text, exactly as it worked before.
     */
    can(a, "catalog.view")
      ? listItems(resolved.ctx, a, { limit: 200 }).then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  const items: PickableItem[] = catalogue.map((i) => ({
    id: i.id,
    sku: i.sku,
    name: i.name,
    unit: i.unit,
  }));

  const dict: PoDict = {
    title: t("po.new"),
    supplier: t("po.supplier"),
    job: t("po.job", { job: "job" }),
    add_line: t("po.add_line"),
    item: t("mr.item"),
    item_free_text: t("po.item_free_text"),
    item_pick: t("po.item_pick"),
    unit_cost: t("po.unit_cost"),
    vat: t("po.vat"),
    notes: t("po.notes"),
    create: t("po.create"),
    err_supplier: t("common.error"),
    err_lines: t("common.error"),
    err_failed: t("common.error"),
  };

  return (
    <PoForm
      orgId={orgId}
      suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
      jobs={jobs.map((j) => ({ id: j.id, reference: j.reference }))}
      items={items}
      dict={dict}
      dir={locale === "ar" ? "rtl" : "ltr"}
    />
  );
}
