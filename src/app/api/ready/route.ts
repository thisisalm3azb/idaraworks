import { NextResponse } from "next/server";
import { newRequestId, REQUEST_ID_HEADER } from "@/platform/observability/requestId";

export const dynamic = "force-dynamic";

/**
 * Readiness probe (Phase I). Deliberately dependency-free: proves the process
 * boots, routes, and serves — the deep per-dependency check is /api/health.
 * Cheap enough for high-frequency external pings without DB/storage fan-out.
 */
export function GET() {
  const requestId = newRequestId();
  return NextResponse.json(
    { ready: true, request_id: requestId, uptime_s: Math.round(process.uptime()) },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
