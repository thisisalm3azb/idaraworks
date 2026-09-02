import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import {
  BINDING_PATHS,
  BLOCK_TYPES,
  CONDITION_OPS,
  DOC_CATEGORIES,
  DocError,
  FIELD_KINDS,
  SIGNATURE_PARTS,
  getTemplate,
  listWorkflows,
} from "@/modules/docstudio/service";
import { TemplateWorkspace } from "./TemplateWorkspace";
import { builderDict } from "../../[documentId]/builderDict";

/** H26 — one organisation template: its draft version in the builder, its published versions. */
export default async function TemplatePage({
  params,
}: {
  params: Promise<{ orgId: string; templateId: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId, templateId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.templates.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  let template;
  try {
    template = await getTemplate(resolved.ctx, resolved.archetype, templateId);
  } catch (err) {
    if (err instanceof DocError && err.code === "not_found") notFound();
    throw err;
  }
  const workflows = await listWorkflows(resolved.ctx, resolved.archetype);
  const k = (key: string) => t(`docstudio.tpl.${key}`);

  return (
    <div className="flex flex-col gap-3">
      <Link href={`/o/${orgId}/documents/templates`} className="text-sm text-accent underline">
        {k("back")}
      </Link>
      <TemplateWorkspace
        orgId={orgId}
        locale={locale}
        template={template}
        workflows={workflows.map((w) => ({ id: w.id, name: w.name }))}
        categories={Object.fromEntries(
          DOC_CATEGORIES.map((c) => [c, t(`docstudio.category.${c}`)]),
        )}
        languages={{
          en: t("docstudio.language.en"),
          ar: t("docstudio.language.ar"),
          bilingual: t("docstudio.language.bilingual"),
        }}
        dict={{
          nameEn: k("name_en"),
          nameAr: k("name_ar"),
          description: k("description"),
          category: t("docstudio.field.category"),
          language: t("docstudio.field.language"),
          workflow: k("workflow"),
          noWorkflow: k("no_workflow"),
          save: t("docstudio.ws.save"),
          publish: k("publish"),
          publishHint: k("publish_hint"),
          retire: k("retire"),
          retireHint: k("retire_hint"),
          versions: k("versions"),
          version: k("version"),
          published: k("status.published"),
          draft: k("status.draft"),
          retired: k("status.retired"),
          current: k("current"),
          changeNote: k("change_note"),
          draftBody: k("draft_body"),
          draftBodyHint: k("draft_body_hint"),
          builtinFrom: k("builtin_from"),
          saved: t("docstudio.saved"),
          failed: t("docstudio.failed"),
          conflict: t("docstudio.conflict"),
          status: {
            draft: k("status.draft"),
            published: k("status.published"),
            retired: k("status.retired"),
          },
        }}
        builder={builderDict(t)}
        blockTypes={Object.fromEntries(BLOCK_TYPES.map((b) => [b, t(`docstudio.block.${b}`)]))}
        bindings={Object.fromEntries(
          BINDING_PATHS.map((p) => [p, t(`docstudio.binding.${p.replace(/\./g, "_")}`)]),
        )}
        vocab={{
          blockTypes: BLOCK_TYPES,
          fieldKinds: FIELD_KINDS,
          bindingPaths: BINDING_PATHS,
          conditionOps: CONDITION_OPS,
          signatureParts: SIGNATURE_PARTS,
        }}
      />
    </div>
  );
}
