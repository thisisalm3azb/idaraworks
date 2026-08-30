import { ModuleGate } from "../guard";

/** H21: My Work reads the work module's records, so it follows cap.jobs. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.jobs">
      {children}
    </ModuleGate>
  );
}
