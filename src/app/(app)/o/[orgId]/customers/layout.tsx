import { ModuleGate } from "../guard";

/** H19: this segment belongs to the cap.customers module — the approved
 * workspace configuration can switch it off for the organization (records
 * untouched). The gate was missing pre-H19 (audit finding); siblings like
 * /quotes and /invoices already carried it. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.customers">
      {children}
    </ModuleGate>
  );
}
