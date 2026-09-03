/**
 * S10 self-service data export route (doc 10 #42). GET /api/o/:orgId/export?entity=<key> streams a
 * guarded CSV of one entity for the caller's org. Tenant-scoped (resolveCtx → withCtx RLS), gated by
 * `data.export` inside exportEntityCsv (owner/admin/accounts). Formula-injection-safe (csvEscape).
 */
import { NextResponse } from "next/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { hasFeature } from "@/platform/entitlements";
import { exportEntityCsv, isExportEntity, EXPORT_ENTITY_KEYS } from "@/platform/export/service";
import { toCsv } from "@/platform/export/csv";
import {
  buildExportContext,
  exportFilename,
  exportHeaders,
  manifestRows,
  type ExportContext,
} from "@/platform/export/context";
import { effectiveConfig } from "@/modules/country/service";
import { getServerLocale } from "@/platform/i18n/server";
import type { Ctx } from "@/platform/tenancy";

export const dynamic = "force-dynamic";

/**
 * The establishment's effective configuration, turned into the facts a
 * downloaded file has to carry. Resolved HERE rather than inside the export
 * platform code, which may not reach into a module (BUILD_BIBLE §3.3).
 */
async function contextFor(ctx: Ctx): Promise<ExportContext> {
  const config = await effectiveConfig(ctx, {});
  return buildExportContext({
    locale: await getServerLocale(),
    currency: config.currency,
    timezone: config.timezone,
    country: config.country,
    packKey: config.packKey,
    derivedFromOrganisation: config.derived,
    pricePrivileged: ctx.pricePrivileged,
    costPrivileged: ctx.costPrivileged,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<NextResponse> {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const entity = new URL(request.url).searchParams.get("entity") ?? "";

  // H29: the manifest is what makes an archived export readable later — the
  // currency its amounts are in, the timezone its timestamps are in, the pack
  // version its rules came from, and whether money columns were redacted. It is
  // not a tenant table, so it is answered here rather than pretending to be an
  // entity with rows.
  if (entity === "export_manifest") {
    const context = await contextFor(resolved.ctx);
    return new NextResponse(toCsv(["field", "value"], manifestRows(context)), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename("export_manifest", context)}"`,
        "Cache-Control": "no-store",
        ...exportHeaders(context),
      },
    });
  }

  if (!isExportEntity(entity)) {
    return NextResponse.json(
      { error: "unknown entity", available: EXPORT_ENTITY_KEYS },
      { status: 400 },
    );
  }
  // Add-on enforcement (0070 honesty pass): the audit-log export is what
  // addon.audit_history sells (feat.audit_export). The core data-portability
  // entities stay unconditional (FR-9 — an org can always take its records out);
  // ONLY the audit_log entity is add-on gated, mirroring the settings/export
  // page which hides the option. Refusal is explicit, never a silent 404.
  if (entity === "audit_log" && !(await hasFeature(resolved.ctx, "feat.audit_export"))) {
    return NextResponse.json(
      { error: "addon_required", addon: "addon.audit_history", feature: "feat.audit_export" },
      { status: 403 },
    );
  }
  try {
    const csv = await exportEntityCsv(resolved.ctx, resolved.archetype, entity);
    // H29: a file of amounts without its currency, or of timestamps without its
    // timezone, is unreadable the moment it leaves this screen. The BODY stays
    // exactly what it claims to be — no preamble, no comment row, nothing a
    // naive parser would choke on — so the context travels in the filename and
    // the response headers instead, and in the downloadable manifest.
    const context = await contextFor(resolved.ctx);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(entity, context)}"`,
        "Cache-Control": "no-store",
        ...exportHeaders(context),
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw err;
  }
}
