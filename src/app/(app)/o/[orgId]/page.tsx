import { redirect } from "next/navigation";
import { Card, CardHeader, EmptyState } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";

export default async function OrgHome({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Workspace" meta={resolved.roleKey} />
        <p className="text-sm text-ink-secondary">
          Identity is live: memberships, roles, and org-scoped access all resolve through the
          tenancy layer. Operational surfaces arrive with the next slices.
        </p>
      </Card>
      <EmptyState
        title="Today will live here"
        description="The role-scoped Today screen ships in slice S5, once daily reports and costing exist to feed it."
      />
    </div>
  );
}
