import { ModuleGate } from "../guard";

/** H20: leads belong to the cap.customers module (the sales CRM rides the
 * customer relationship capability — no separate module key). */
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
