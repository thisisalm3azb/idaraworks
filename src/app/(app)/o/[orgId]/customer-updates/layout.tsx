import { ModuleGate } from "../guard";

/** H16: this segment belongs to the cap.customer_updates module — the approved workspace
 * configuration can switch it off for the organization (records untouched). */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.customer_updates">
      {children}
    </ModuleGate>
  );
}
