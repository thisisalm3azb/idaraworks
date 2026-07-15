import { redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { lockedFeatureGate } from "@/platform/ui/subscription";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listJobs } from "@/modules/jobs/service";
import { listSuppliers } from "@/modules/masters/service";
import { PoForm, type PoDict } from "../PoForm";

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
  const [suppliers, jobs] = await Promise.all([
    listSuppliers(resolved.ctx, a),
    listJobs(resolved.ctx, a),
  ]);

  const dict: PoDict = {
    title: t("po.new"),
    supplier: t("po.supplier"),
    job: t("po.job", { job: "job" }),
    add_line: t("po.add_line"),
    item: t("mr.item"),
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
      dict={dict}
      dir={locale === "ar" ? "rtl" : "ltr"}
    />
  );
}
