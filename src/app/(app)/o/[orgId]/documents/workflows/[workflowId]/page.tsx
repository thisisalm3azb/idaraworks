import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import { CONDITION_OPS, DocError, getWorkflow } from "@/modules/docstudio/service";
import { WorkflowDesigner } from "./WorkflowDesigner";

/** H26 — the visual workflow designer. */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ orgId: string; workflowId: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId, workflowId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.workflows.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  let workflow;
  try {
    workflow = await getWorkflow(resolved.ctx, resolved.archetype, workflowId);
  } catch (err) {
    if (err instanceof DocError && err.code === "not_found") notFound();
    throw err;
  }
  const members = await listMembers(resolved.ctx, resolved.archetype);
  const k = (key: string) => t(`docstudio.wf.${key}`);
  return (
    <div className="flex flex-col gap-3">
      <Link href={`/o/${orgId}/documents/workflows`} className="text-sm text-accent underline">
        {k("back")}
      </Link>
      <WorkflowDesigner
        orgId={orgId}
        locale={locale}
        workflow={workflow}
        members={members.map((m) => ({ id: m.userId, name: m.fullName, archetype: m.archetype }))}
        archetypes={[...MVP_GRANTABLE_ARCHETYPES]}
        conditionOps={[...CONDITION_OPS]}
        dict={{
          name: k("name"),
          description: k("description"),
          steps: k("steps"),
          addStep: k("add_step"),
          removeStep: k("remove_step"),
          moveUp: t("docstudio.ws.move_up"),
          moveDown: t("docstudio.ws.move_down"),
          stepName: k("step_name"),
          stepNameAr: k("step_name_ar"),
          kind: k("kind_label"),
          kinds: {
            review: k("kind.review"),
            approval: k("kind.approval"),
            signature: k("kind.signature"),
          },
          mode: k("mode"),
          sequential: k("sequential"),
          parallel: k("parallel"),
          quorum: k("quorum"),
          assignees: k("assignees"),
          addAssignee: k("add_assignee"),
          assigneeKinds: {
            archetype: k("assignee.archetype"),
            user: k("assignee.user"),
            document_owner: k("assignee.document_owner"),
            counterparty: k("assignee.counterparty"),
          },
          archetypeNames: Object.fromEntries(
            MVP_GRANTABLE_ARCHETYPES.map((a) => [a, t(`docstudio.role.${a}`)]),
          ),
          condition: t("docstudio.ws.condition"),
          conditionNone: t("docstudio.ws.condition_none"),
          conditionKey: t("docstudio.ws.condition_key"),
          conditionOp: t("docstudio.ws.condition_op"),
          conditionValue: t("docstudio.ws.condition_value"),
          dueDays: k("due_days"),
          escalateTo: k("escalate_to"),
          noEscalation: k("no_escalation"),
          allowDelegate: k("allow_delegate"),
          separationOfDuties: k("separation_of_duties"),
          onReject: k("on_reject"),
          returnToDraft: k("return_to_draft"),
          stop: k("stop"),
          save: t("docstudio.ws.save"),
          retire: k("retire"),
          reactivate: k("reactivate"),
          preview: k("preview"),
          previewHint: k("preview_hint"),
          saved: t("docstudio.saved"),
          failed: t("docstudio.failed"),
          conflict: t("docstudio.conflict"),
          status: { active: k("status.active"), retired: k("status.retired") },
          empty: k("empty"),
        }}
      />
    </div>
  );
}
