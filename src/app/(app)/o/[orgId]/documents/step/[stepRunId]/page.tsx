import { notFound, redirect } from "next/navigation";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { DocError, getStepRun } from "@/modules/docstudio/service";

/** H26 — an approval inbox link names a step run; send the person to its document. */
export default async function StepRedirectPage({
  params,
}: {
  params: Promise<{ orgId: string; stepRunId: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId, stepRunId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.view")) notFound();
  try {
    const step = await getStepRun(resolved.ctx, resolved.archetype, stepRunId);
    redirect(`/o/${orgId}/documents/${step.documentId}?tab=workflow`);
  } catch (err) {
    if (err instanceof DocError && err.code === "not_found") notFound();
    throw err;
  }
}
