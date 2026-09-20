/**
 * The sink for the REPORT-ONLY nonce policy staged in middleware (security
 * review 2026-09-20, F-04 / SEC-1). Browsers POST a small JSON document here
 * whenever the staged policy would have blocked a script; the report is
 * written to the log with the few fields that identify the script and the
 * page, so the policy can be tightened from evidence instead of guesswork.
 *
 * Unauthenticated by nature (browsers send it without credentials), so it is
 * rate-limited per client address, the body is bounded, and nothing in the
 * report is trusted beyond being logged as a string.
 */
import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const FIELDS = [
  "document-uri",
  "blocked-uri",
  "violated-directive",
  "effective-directive",
  "source-file",
  "line-number",
  "column-number",
  "script-sample",
  "disposition",
] as const;

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await rateLimit("csp_report", clientIpFromHeaders(request.headers));
  if (!gate.allowed) return new NextResponse(null, { status: 429 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  let report: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { "csp-report"?: Record<string, unknown> };
    const body = parsed["csp-report"] ?? (parsed as Record<string, unknown>);
    for (const f of FIELDS) {
      const v = body[f];
      if (typeof v === "string") report[f] = v.slice(0, 300);
      else if (typeof v === "number") report[f] = v;
    }
  } catch {
    report = { unparseable: true };
  }
  logger.warn({ csp: report }, "csp report-only violation");
  return new NextResponse(null, { status: 204 });
}
