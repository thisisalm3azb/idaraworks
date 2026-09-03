/**
 * H28 — the authenticated cron entry for queued Idara runs (ADR-59).
 *
 * Vercel Cron (or any scheduler) calls this with the deployment's CRON_SECRET.
 * Without the secret configured the route refuses everything: nothing here
 * ever runs unauthenticated, and nothing runs while the release flag is off.
 * The same function backs the Inngest cron when Inngest is configured.
 */
import { timingSafeEqual } from "node:crypto";
import { idaraEnabled } from "@/platform/flags";
import { newRequestId } from "@/platform/observability";
import { executeQueuedIdaraRuns } from "@/modules/idara/service";

export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ")
    ? header.slice(7)
    : (req.headers.get("x-cron-secret") ?? "");
  if (bearer.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(bearer), Buffer.from(secret));
}

export async function GET(req: Request): Promise<Response> {
  if (!idaraEnabled()) return new Response(null, { status: 404 });
  if (!authorised(req)) return new Response(null, { status: 401 });
  const result = await executeQueuedIdaraRuns(`cron-${newRequestId()}`);
  return Response.json(result);
}

export const POST = GET;
