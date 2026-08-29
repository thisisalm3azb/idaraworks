/**
 * H16 workspace-shell derivation — the read surface every MEMBER's shell uses.
 *
 * getAppliedWorkspaceShape reads the organization's ONE applied blueprint
 * revision without the config.view gate: the applied workspace shape IS what
 * every member experiences, so any active member may read it (the 0076 RLS
 * policy enforces exactly that at the database — applied revisions only;
 * drafts, approvals and history stay owner/admin). Legacy organizations
 * (no applied revision) return null and the shell renders exactly as today.
 *
 * The pure helpers below derive the shell's navigation filter from the
 * compiled output. LAW (H14 Part C): the blueprint contributes ONLY the
 * approved-configuration layer — the live nav builder keeps deciding
 * permission (can()) and entitlement, so a plan change is honoured
 * immediately while the configuration layer stays stable per revision.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { CompiledWorkspace } from "./compiler";
import { NAV_ITEM_INFO, isNavItemKey, type WorkspaceModuleKey } from "./registry";

export type AppliedWorkspaceShape = {
  revisionId: string;
  revisionNo: number;
  appliedAt: string | null;
  compilerVersion: string | null;
  compiled: CompiledWorkspace;
};

/** The applied workspace shape for ANY active member (null = legacy org,
 * render today's shell unchanged). Fail safe: a malformed row returns null. */
export async function getAppliedWorkspaceShape(ctx: Ctx): Promise<AppliedWorkspaceShape | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id, revision_no, applied_at::text as applied_at, compiler_version, compiled
      from public.workspace_blueprint_revision
      where org_id = ${ctx.orgId} and status = 'applied'
    `),
  )) as unknown as Array<{
    id: string;
    revision_no: number;
    applied_at: string | null;
    compiler_version: string | null;
    compiled: CompiledWorkspace | null;
  }>;
  const r = rows[0];
  if (!r || !r.compiled || !Array.isArray(r.compiled.capabilities)) return null;
  return {
    revisionId: r.id,
    revisionNo: r.revision_no,
    appliedAt: r.applied_at,
    compilerVersion: r.compiler_version,
    compiled: r.compiled,
  };
}

/** The modules this organization's approved configuration switched OFF.
 * (configEnabled is the stable configuration layer; entitlement and
 * permission keep intersecting live in the nav builder / route guards.) */
export function disabledModulesOf(compiled: CompiledWorkspace): Set<WorkspaceModuleKey> {
  const out = new Set<WorkspaceModuleKey>();
  for (const c of compiled.capabilities) {
    if (c.configEnabled === false) out.add(c.key);
  }
  return out;
}

/** One nav item's blueprint verdict: keep, unless its module was switched
 * off by the approved configuration (safety-rail items always stay). */
export function navItemAllowedByBlueprint(
  itemKey: string,
  disabled: ReadonlySet<WorkspaceModuleKey>,
): boolean {
  if (!isNavItemKey(itemKey)) return true; // unknown key: fail open to today's law
  const info = NAV_ITEM_INFO[itemKey];
  if (info.alwaysVisible || info.module === null) return true;
  return !disabled.has(info.module);
}

/** Filter built nav groups by the blueprint's configuration layer. Pure and
 * shape-generic so the layout's view-models pass straight through; empty
 * groups are dropped (never rendered). A null shape returns the input
 * UNCHANGED — the legacy-organization law. */
export function filterGroupsByBlueprint<T extends { key: string; items: Array<{ key: string }> }>(
  groups: T[],
  shape: AppliedWorkspaceShape | null,
): T[] {
  if (!shape) return groups;
  const disabled = disabledModulesOf(shape.compiled);
  if (disabled.size === 0) return groups;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => navItemAllowedByBlueprint(i.key, disabled)),
    }))
    .filter((g) => g.items.length > 0);
}

/** Quick-create ("+ New") keys → module (the builder's QUICK_CREATE list uses
 * its own key vocabulary; parity-tested against the builder's output). */
export const QUICK_CREATE_MODULE: Record<string, WorkspaceModuleKey> = {
  job: "cap.jobs",
  report: "cap.daily_reports",
  mr: "cap.material_requests",
  quote: "cap.quoting",
  invoice: "cap.invoicing",
  payment: "cap.payments",
  expense: "cap.expenses",
};

export function quickCreateAllowedByBlueprint(
  itemKey: string,
  disabled: ReadonlySet<WorkspaceModuleKey>,
): boolean {
  const module_ = QUICK_CREATE_MODULE[itemKey];
  return module_ === undefined || !disabled.has(module_);
}

/** The blueprint state of one module for direct-route enforcement (Part E). */
export function moduleStateOf(
  shape: AppliedWorkspaceShape | null,
  module: WorkspaceModuleKey,
): "active" | "disabled" | "no_blueprint" {
  if (!shape) return "no_blueprint";
  return disabledModulesOf(shape.compiled).has(module) ? "disabled" : "active";
}
