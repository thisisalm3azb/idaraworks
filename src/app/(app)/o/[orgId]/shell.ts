/**
 * H16 — the ONE server-authoritative workspace-shell resolver.
 *
 * Everything the shell needs is resolved here, once per request, from
 * server-side truth only: the caller passes the resolveCtx result (session,
 * membership, archetype — never client input), and this adds the applied
 * blueprint shape (or null for legacy organizations) and the member's
 * organization-facing role label. React cache() keys on the ResolvedCtx
 * object, whose identity is stable per request (resolveCtx is cache()d), so
 * the layout and every route guard share one lookup — no per-item queries.
 * A new applied revision is a new row read on the next request; nothing is
 * cached across requests, so revision changes take effect immediately.
 */
import { cache } from "react";
import { sql, withCtx } from "@/platform/tenancy";
import type { ResolvedCtx } from "@/platform/auth/resolve";
import {
  getAppliedWorkspaceShape,
  disabledModulesOf,
  type AppliedWorkspaceShape,
} from "@/platform/workspace";
import type { WorkspaceModuleKey } from "@/platform/workspace";

export type ShellContext = {
  /** null = legacy organization: render today's shell exactly. */
  shape: AppliedWorkspaceShape | null;
  disabledModules: ReadonlySet<WorkspaceModuleKey>;
  /** The member's organization-facing role label ({en, ar}); falls back to
   * the role key when the definition row is missing (fail safe). */
  roleLabel: { en: string; ar: string };
};

export const resolveShell = cache(async (resolved: ResolvedCtx): Promise<ShellContext> => {
  let shape: AppliedWorkspaceShape | null = null;
  try {
    shape = await getAppliedWorkspaceShape(resolved.ctx);
  } catch {
    shape = null; // shell derivation must never break the workspace (fail safe)
  }
  let roleLabel = { en: resolved.roleKey, ar: resolved.roleKey };
  try {
    const rows = (await withCtx(resolved.ctx, (tx) =>
      tx.execute(sql`
        select label from public.role_definition
        where org_id = ${resolved.ctx.orgId} and key = ${resolved.roleKey}
      `),
    )) as unknown as Array<{ label: { en?: string; ar?: string } | null }>;
    const label = rows[0]?.label;
    if (label?.en || label?.ar) {
      roleLabel = {
        en: label.en ?? label.ar ?? resolved.roleKey,
        ar: label.ar ?? label.en ?? resolved.roleKey,
      };
    }
  } catch {
    // Keep the fallback label; the shell never fails on decoration.
  }
  return {
    shape,
    disabledModules: shape ? disabledModulesOf(shape.compiled) : new Set(),
    roleLabel,
  };
});
