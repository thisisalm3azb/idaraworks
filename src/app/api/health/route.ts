import { NextResponse, type NextRequest } from "next/server";
import { healthReport, type HealthReport } from "@/platform/observability/health";
import { newRequestId, REQUEST_ID_HEADER } from "@/platform/observability/requestId";
import { rateLimit } from "@/platform/http/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Health check (BUILD_BIBLE §15.5; Phase I): per-dependency status for
 * db / storage / queue (outbox gauges) / inngest (configured|unconfigured).
 * 503 when a hard dependency (db, storage) is down. Outside the middleware
 * matcher, so it mints its own correlation id (§8.4: 5xx carries request_id).
 *
 * DoS bounds (review fix — unauthenticated endpoint that fans out to DB +
 * storage): a short per-instance report cache collapses bursts, and the
 * standard rateLimit seam bounds sustained callers per client IP.
 */
const CACHE_TTL_MS = 5_000;
let cached: { at: number; report: HealthReport } | null = null;

function clientIp(request: NextRequest): string {
  // Same trust order as the auth actions: platform-set header first, the
  // client-spoofable leftmost x-forwarded-for entry last.
  return (
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("true-client-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();

  const { allowed } = await rateLimit("health", clientIp(request));
  if (!allowed) {
    return NextResponse.json(
      { error: "rate_limited", request_id: requestId },
      { status: 429, headers: { [REQUEST_ID_HEADER]: requestId, "retry-after": "60" } },
    );
  }

  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    cached = { at: Date.now(), report: await healthReport(requestId) };
  }
  const report = { ...cached.report, request_id: requestId };
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
