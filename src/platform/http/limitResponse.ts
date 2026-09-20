/**
 * The answer a route gives when a request is refused by a budget rather than
 * by authorisation (security review 2026-09-20, F-23/F-24): a rate limit that
 * was reached, or an export that is too large to build in one request.
 *
 * A browser that navigated to the link (a Download button is a plain link)
 * gets a small page that says what happened and when to try again; a script
 * gets JSON with the same facts. Both carry `retry-after` when the budget will
 * free itself, and neither ever pretends to be the file that was asked for.
 */
import { NextResponse } from "next/server";

export type LimitKind = "rate_limited" | "export_too_large";

type LimitDetail = {
  kind: LimitKind;
  /** Seconds until the caller may try again; omitted when waiting does not help. */
  retryAfterSeconds?: number;
  /** For export_too_large: the row bound that was exceeded. */
  limit?: number;
  /** Where the person can go instead (a filtered view, the previous page). */
  backUrl?: string;
};

const COPY: Record<LimitKind, { title: string; body: (d: LimitDetail) => string }> = {
  rate_limited: {
    title: "Please wait a moment",
    body: (d) =>
      `You have made this request more times than the limit allows. ` +
      (d.retryAfterSeconds
        ? `It will work again in about ${d.retryAfterSeconds} second${d.retryAfterSeconds === 1 ? "" : "s"}.`
        : `Please try again shortly.`),
  },
  export_too_large: {
    title: "This export is too large to download in one file",
    body: (d) =>
      `The export would exceed ${(d.limit ?? 0).toLocaleString("en")} rows, which is more than one download can hold. ` +
      `Nothing was downloaded — a partial file would look complete and it is not. ` +
      `Please contact support for an archive export.`,
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(d: LimitDetail): string {
  const c = COPY[d.kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(c.title)}</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f6f5f1;color:#1c2321}main{max-width:32rem;margin:10vh auto;padding:0 16px}h1{font-size:20px}p{font-size:15px;line-height:1.5}a{color:#1c5f57}</style></head><body><main><h1>${escapeHtml(c.title)}</h1><p>${escapeHtml(c.body(d))}</p>${d.backUrl ? `<p><a href="${escapeHtml(d.backUrl)}">Go back</a></p>` : ""}</main></body></html>`;
}

export function limitReached(d: LimitDetail, accept: string | null): NextResponse {
  const status = d.kind === "rate_limited" ? 429 : 413;
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (d.retryAfterSeconds) headers["retry-after"] = String(d.retryAfterSeconds);
  if (accept?.includes("text/html")) {
    return new NextResponse(page(d), {
      status,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  }
  return NextResponse.json(
    {
      error: d.kind,
      message: COPY[d.kind].body(d),
      ...(d.retryAfterSeconds ? { retryAfterSeconds: d.retryAfterSeconds } : {}),
      ...(d.limit ? { limit: d.limit } : {}),
    },
    { status, headers },
  );
}
