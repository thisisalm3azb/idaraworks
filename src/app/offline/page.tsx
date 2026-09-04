import Link from "next/link";
import { getT } from "@/platform/i18n/server";

/**
 * H31 — the offline screen the service worker precaches.
 *
 * Deliberately PUBLIC and free of tenant data. It is the one page stored on a
 * device, so it must contain nothing that belongs to a company: no name, no
 * logo, no colour read from a database. A generic page is the honest one here —
 * the worker cannot know which company the user was in without storing that,
 * which is precisely what H31 refuses to do.
 *
 * It also says plainly that nothing is stored locally, because a user who has
 * just lost connection is entitled to know whether their data is sitting on the
 * device they are holding.
 */
export const dynamic = "force-static";

export default async function OfflinePage() {
  const t = await getT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <div
        aria-hidden
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-sunken text-2xl"
      >
        ⚡
      </div>
      <h1 className="text-xl font-semibold text-ink">{t("app.offline_title")}</h1>
      <p className="max-w-sm text-sm text-ink-secondary">{t("app.offline_body")}</p>
      {/*
        `next/link` rather than a bare anchor, per the framework's own rule.
        Either would work from the cached copy — this page is served by the
        service worker before any router has mounted, and a Link degrades to a
        plain anchor in that state, which is exactly the behaviour needed.
      */}
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-on-brand"
      >
        {t("app.offline_retry")}
      </Link>
      <p className="text-xs text-ink-muted">{t("app.powered_by")}</p>
    </main>
  );
}
