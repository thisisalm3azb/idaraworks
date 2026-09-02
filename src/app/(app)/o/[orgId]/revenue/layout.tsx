import { notFound } from "next/navigation";
import { revenueStudioEnabled } from "@/platform/flags";
import { ModuleGate } from "../guard";

/**
 * H27 — the Revenue Growth Studio. Released behind FEATURE_REVENUE_STUDIO
 * (exact "1") and owned by the cap.revenue_studio module, which a blueprint
 * can switch off. Records are never touched by either gate.
 */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  if (!revenueStudioEnabled()) notFound();
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.revenue_studio">
      {children}
    </ModuleGate>
  );
}
