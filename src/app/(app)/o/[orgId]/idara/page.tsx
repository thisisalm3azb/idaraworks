import { notFound, redirect } from "next/navigation";
import { idaraGateFor } from "@/platform/ai";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { directionFor } from "@/platform/i18n";
import { getServerLocale, getT } from "@/platform/i18n/server";
import { addressableAgents } from "@/modules/idara/service";
import { IdaraWorkspace } from "./IdaraWorkspace";
import type { DockDict } from "./IdaraDock";

/**
 * H28 — the deep workspace (ADR-58): the full-page surface for long research,
 * planning and multi-step work. Same conversations, runs and actions as the
 * dock; nothing here is a second chat system.
 */
export default async function IdaraWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  if (!idaraEnabled()) notFound(); // page-level gate: a layout gate does not stop this page from rendering
  const { orgId } = await params;
  const { c } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}/idara`);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "idara.use")) notFound();
  const gate = await idaraGateFor(resolved.ctx);
  if (!gate.surfaceOn) notFound();
  const locale = await getServerLocale();
  const t = await getT();
  const { dictFor } = await import("./dict");
  const dict: DockDict = dictFor(t);
  const agents = addressableAgents(resolved.archetype).map((id) => ({
    id,
    name: t(`idara.agents.${id}.name`),
    description: t(`idara.agents.${id}.purpose`),
  }));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t("idara.workspace.title")}</h1>
        <p className="text-sm text-ink-muted">{t("idara.workspace.subtitle")}</p>
      </div>
      <IdaraWorkspace
        orgId={orgId}
        userId={resolved.ctx.userId}
        locale={locale}
        dir={directionFor(locale)}
        dict={dict}
        agents={agents}
        modelAvailable={gate.modelAvailable}
        reason={gate.reason}
        ownerAction={gate.ownerAction}
        canConfirm={can(resolved.archetype, "idara.actions.confirm")}
        initialConversationId={c && /^[0-9a-f-]{36}$/.test(c) ? c : null}
      />
    </div>
  );
}
