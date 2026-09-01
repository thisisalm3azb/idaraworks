import { ModuleGate } from "../guard";

/** H23G: my-pay belongs to the people module — a blueprint can hide it. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.people">
      {children}
    </ModuleGate>
  );
}
