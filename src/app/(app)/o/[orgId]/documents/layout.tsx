import { ModuleGate } from "../guard";

/** H26: the Document Studio belongs to the documents module — a blueprint can hide it. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <ModuleGate orgId={orgId} module="cap.documents">
      {children}
    </ModuleGate>
  );
}
