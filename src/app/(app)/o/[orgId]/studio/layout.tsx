import { ModuleGate } from "../guard";

/** H25: the Management Studio belongs to the studio module — a blueprint can hide it. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.studio">
      {children}
    </ModuleGate>
  );
}
