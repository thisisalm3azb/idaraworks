import { ModuleGate } from "../guard";

/** H23G: claims belong to the people module — a blueprint can hide them. */
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
