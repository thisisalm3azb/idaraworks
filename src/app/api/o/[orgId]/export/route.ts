/**
 * S10 self-service data export route (doc 10 #42). GET /api/o/:orgId/export?entity=<key> streams a
 * guarded CSV of one entity for the caller's org. Tenant-scoped (resolveCtx → withCtx RLS), gated by
 * `data.export` inside exportEntityCsv (owner/admin/accounts). Formula-injection-safe (csvEscape).
 */
import { NextResponse } from "next/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { exportEntityCsv, isExportEntity, EXPORT_ENTITY_KEYS } from "@/platform/export/service";

export const dynamic = "force-dynamic";

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
  if (!isExportEntity(entity)) {
    return NextResponse.json(
      { error: "unknown entity", available: EXPORT_ENTITY_KEYS },
      { status: 400 },
    );
  }
  try {
    const csv = await exportEntityCsv(resolved.ctx, resolved.archetype, entity);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${entity}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw err;
  }
}
