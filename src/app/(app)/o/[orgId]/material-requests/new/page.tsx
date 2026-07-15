import { redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { lockedFeatureGate } from "@/platform/ui/subscription";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listJobs } from "@/modules/jobs/service";
import { MrForm, type MrDict } from "../MrForm";

export default async function NewMrPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "mr.create")) redirect(`/o/${orgId}`);
  // Locked-feature UX (U3): honest unlock screen when the capability is off.
  const locked = await lockedFeatureGate(resolved.ctx, a, orgId, "cap.material_requests");
  if (locked) return locked;
  const t = await getT();
  const locale = await getServerLocale();
  const jobs = (await listJobs(resolved.ctx, a)).map((j) => ({ id: j.id, reference: j.reference }));

  const dict: MrDict = {
    title: t("mr.new"),
    job: t("mr.job", { job: "job" }),
    urgency: t("mr.urgency"),
    urgency_low: t("mr.urgency.low"),
    urgency_normal: t("mr.urgency.normal"),
    urgency_high: t("mr.urgency.high"),
    urgency_urgent: t("mr.urgency.urgent"),
    required_date: t("mr.required_date"),
    item: t("mr.item"),
    est_cost: t("mr.est_cost"),
    add_line: t("mr.add_line"),
    notes: t("mr.notes"),
    create: t("mr.create"),
    err_lines: t("common.error"),
    err_failed: t("common.error"),
  };

  return (
    <MrForm
      orgId={orgId}
      jobs={jobs}
      showCost={can(a, "po.view")}
      dict={dict}
      dir={locale === "ar" ? "rtl" : "ltr"}
    />
  );
}
