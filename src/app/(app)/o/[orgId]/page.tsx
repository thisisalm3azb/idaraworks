import { redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";
import { resolveEntitlements } from "@/platform/entitlements";

export default async function OrgHome({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const ent = await resolveEntitlements(resolved.ctx);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Workspace"
          meta={
            <span className="flex items-center gap-2">
              {resolved.roleKey}
              <Badge tone={ent.billingState === "trialing" ? "info" : "brand"}>
                {ent.planKey} · {ent.billingState}
              </Badge>
            </span>
          }
        />
        <p className="text-sm text-ink-secondary">
          Identity and entitlements are live: memberships, roles, org-scoped access, and the
          resolved plan all flow through the platform layer. Operational surfaces arrive with the
          next slices.
        </p>
      </Card>
      <EmptyState
        title="Today will live here"
        description="The role-scoped Today screen ships in slice S5, once daily reports and costing exist to feed it."
      />
    </div>
  );
}
