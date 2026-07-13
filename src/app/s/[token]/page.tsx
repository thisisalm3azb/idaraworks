/**
 * PUBLIC customer-share page (doc 04 F-22; doc 10 item 14). No auth: a bearer-token holder
 * (the customer, via a link the org sent) sees ONLY the safe-by-construction snapshot —
 * stage completions, progress %, next milestones, the message. NEVER a cost, a name of a
 * worker, an internal issue, or any org/subject id. noindex; rate-limited per IP; an invalid,
 * expired, or revoked token renders the IDENTICAL "not available" page (no enumeration signal).
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { resolvePublicShare } from "@/modules/customer-updates/service";
import { rateLimit } from "@/platform/http/rateLimit";

export const dynamic = "force-dynamic";

// noindex, nofollow — this link must never be crawled/cached by search engines.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "Project update",
};

type Content = {
  reference: string | null;
  progressPct: number | null;
  stagesCompleted: Array<{ en: string; ar: string }>;
  nextMilestones: Array<{ en: string; ar: string }>;
};

function clientIp(h: Headers): string {
  const fwd = h.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0]!.trim() : null) ?? h.get("x-real-ip") ?? "unknown";
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const gate = await rateLimit("share", clientIp(h));
  const update = gate.allowed ? await resolvePublicShare(token) : null;

  if (!update) {
    // Identical response for invalid / expired / revoked / rate-limited — no signal.
    return (
      <main
        dir="rtl"
        className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <h1 className="text-lg font-semibold text-ink">هذا الرابط غير متاح</h1>
        <p className="text-sm text-ink-muted">This link is no longer available.</p>
      </main>
    );
  }

  const ar = update.language === "ar";
  const content = (update.content as Content | null) ?? null;
  const stages = content?.stagesCompleted ?? [];
  const milestones = content?.nextMilestones ?? [];
  const pct = content?.progressPct ?? null;

  return (
    <main dir={ar ? "rtl" : "ltr"} className="mx-auto flex w-full max-w-md flex-col gap-5 p-5">
      <header className="flex flex-col gap-1 border-b border-line pb-3">
        <h1 className="text-xl font-semibold text-ink">{update.title}</h1>
        {content?.reference ? (
          <span className="font-mono text-xs text-ink-muted" dir="ltr">
            {content.reference}
          </span>
        ) : null}
      </header>

      <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{update.body}</p>

      {pct !== null ? (
        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-muted">{ar ? "نسبة الإنجاز" : "Progress"}</span>
            <span className="font-mono text-ink" dir="ltr">
              {pct}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </section>
      ) : null}

      {stages.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-ink">{ar ? "المراحل المكتملة" : "Completed"}</h2>
          <ul className="flex flex-wrap gap-2">
            {stages.map((s, i) => (
              <li
                key={i}
                className="rounded-full border border-line bg-card px-3 py-1 text-xs text-ink"
              >
                {ar ? s.ar : s.en}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {milestones.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-ink">{ar ? "الخطوات القادمة" : "Next up"}</h2>
          <ul className="flex flex-col gap-1 text-sm text-ink-muted">
            {milestones.map((m, i) => (
              <li key={i}>• {ar ? m.ar : m.en}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
