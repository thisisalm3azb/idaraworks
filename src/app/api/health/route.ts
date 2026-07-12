import { NextResponse } from "next/server";
import { healthReport } from "@/platform/observability/health";
import { newRequestId, REQUEST_ID_HEADER } from "@/platform/observability/requestId";

export const dynamic = "force-dynamic";

/**
 * Health check (BUILD_BIBLE §15.5; Phase I): per-dependency status for
 * db / storage / queue (outbox gauges) / inngest (configured|unconfigured).
 * 503 when a hard dependency (db, storage) is down. Outside the middleware
 * matcher, so it mints its own correlation id (§8.4: 5xx carries request_id).
 */
export async function GET() {
  const requestId = newRequestId();
  const report = await healthReport(requestId);
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
