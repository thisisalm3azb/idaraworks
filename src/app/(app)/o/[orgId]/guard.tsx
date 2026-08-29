import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/platform/ui";
import { can } from "@/platform/authz";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { requestLogger } from "@/platform/logger";
import { currentRequestId } from "@/platform/observability";
import type { WorkspaceModuleKey } from "@/platform/workspace";
import { moduleStateOf } from "@/platform/workspace";
import { resolveShell } from "./shell";

/**
 * H16 direct-route enforcement (Part E): navigation filtering is not
 * security. Each module segment's layout awaits this guard, which
 * re-resolves everything server-side (session, membership, archetype, the
 * applied blueprint) and — when the organization's APPROVED configuration
 * switched the module off — renders a calm, organization-specific
 * unavailable state instead of the module. Records are never touched;
 * permission and entitlement enforcement stay exactly where they already
 * live (can()/requireCapability in the pages and services below).
 *
 * Legacy organizations (no applied blueprint) pass through unchanged.
 */
export async function ModuleGate({
  orgId,
  module,
  children,
}: {
  orgId: string;
  module: WorkspaceModuleKey;
  children: React.ReactNode;
}) {
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}`);
  if (typeof resolved === "string") redirect("/");
  const shell = await resolveShell(resolved);
  const state = moduleStateOf(shell.shape, module);
  if (state !== "disabled") return <>{children}</>;

  // Meaningful, non-sensitive denial log (existing observability pattern).
  const requestId = await currentRequestId();
  requestLogger({ requestId, orgId, userId: resolved.ctx.userId }).info(
    { module, revision: shell.shape?.revisionNo ?? null, outcome: "module_disabled" },
    "workspace route blocked by approved configuration",
  );

  const t = await getT();
  const owner = can(resolved.archetype, "config.view");
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <h1 className="mb-2 text-lg font-semibold text-ink">{t("shell.module_off.title")}</h1>
        <p className="mb-1 text-sm leading-relaxed text-ink">
          {owner ? t("shell.module_off.body_owner") : t("shell.module_off.body_member")}
        </p>
        <p className="mb-4 text-sm text-ink-muted">{t("shell.module_off.records_note")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/o/${orgId}`}
            className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse hover:bg-brand-strong"
          >
            {t("shell.module_off.back_home")}
          </Link>
          {owner ? (
            <Link
              href={`/o/${orgId}/settings/workspace`}
              className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
            >
              {t("shell.module_off.view_setup")}
            </Link>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
