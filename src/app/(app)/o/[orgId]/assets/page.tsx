import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { listAssets } from "@/modules/assets/service";

/** The statuses worth a one-tap filter. The rest are reachable by URL. */
const STATUS_FILTERS = [
  "in_service",
  "in_storage",
  "under_maintenance",
  "retired",
  "disposed",
] as const;

/**
 * The asset register (H22F).
 *
 * H22E gave a business the ability to record every tool, vehicle and machine it
 * owns — and no way to look at the list. This is the list.
 *
 * Search covers the four things somebody actually has in front of them when
 * they are trying to identify a physical object: the asset number, the name,
 * the manufacturer's serial, and the barcode. That is deliberate — a register
 * you can only search by name is a register nobody uses in a workshop.
 */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; status?: string; cursor?: string }>;
}) {
  if (!stockSurfacesEnabled()) notFound();

  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "assets.view")) notFound();
  const t = await getT();

  const search = (sp.q ?? "").trim();
  const status = (STATUS_FILTERS as readonly string[]).includes(sp.status ?? "")
    ? sp.status
    : undefined;

  const { rows, nextCursor, total } = await listAssets(resolved.ctx, resolved.archetype, {
    search,
    status,
    cursor: sp.cursor,
    limit: 50,
  });

  const hrefWith = (extra: Record<string, string>) =>
    `/o/${orgId}/assets?${new URLSearchParams({
      ...(search ? { q: search } : {}),
      ...(status ? { status } : {}),
      ...extra,
    })}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("assets.title")} />

        <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder={t("assets.search")}
            aria-label={t("assets.search")}
            className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
          />
          <button
            type="submit"
            className="min-h-11 rounded-md border border-line-strong px-4 text-sm text-ink"
          >
            {t("common.search")}
          </button>
        </form>

        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          {STATUS_FILTERS.map((s) => (
            <Link
              key={s}
              href={hrefWith(status === s ? {} : { status: s })}
              className={`min-h-11 rounded-md px-3 py-2 ${
                status === s ? "bg-brand-soft text-brand" : "text-ink-secondary underline"
              }`}
            >
              {t(`assets.status.${s}`)}
            </Link>
          ))}
        </div>

        <p className="mb-2 text-xs text-ink-muted">{t("assets.count", { n: total })}</p>

        {rows.length === 0 ? (
          <EmptyState title={t("assets.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/o/${orgId}/assets/${a.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {a.assetNo} — {a.nameEn}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {a.serialNo ? `${t("assets.serial")}: ${a.serialNo}` : t("assets.no_serial")}
                    </p>
                  </div>
                  <Badge tone={toneFor(a.status)}>{t(`assets.status.${a.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {nextCursor || sp.cursor ? (
          <div className="mt-3 flex items-center gap-4">
            {nextCursor ? (
              <Link
                href={hrefWith({ cursor: nextCursor })}
                className="inline-flex min-h-11 items-center text-sm text-brand underline"
              >
                {t("common.next")}
              </Link>
            ) : null}
            {sp.cursor ? (
              <Link
                href={hrefWith({})}
                className="inline-flex min-h-11 items-center text-sm text-ink-secondary underline"
              >
                {t("stock.back_to_start")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * Colour carries meaning, so it has to mean the same thing every time: an asset
 * out of service is a warning, one that has left the business is neutral, one
 * doing its job is quiet.
 */
function toneFor(status: string): "success" | "warning" | "neutral" | "danger" {
  if (status === "in_service" || status === "in_storage") return "success";
  if (status === "under_maintenance" || status === "in_transit") return "warning";
  if (status === "lost") return "danger";
  return "neutral";
}
