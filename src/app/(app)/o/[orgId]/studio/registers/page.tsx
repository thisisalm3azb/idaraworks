import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { managementStudioEnabled } from "@/platform/flags";
import { listRegister, REGISTER_KINDS, type RegisterKind } from "@/modules/studio/service";

/**
 * H25K — the governance registers: risks, issues, assumptions, decisions,
 * changes, actions, lessons, constraints and opportunities across every
 * plan, projected from their typed elements. Each row links to its plan.
 */
export default async function RegistersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ kind?: string; status?: string; q?: string; page?: string }>;
}) {
  if (!managementStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "studio.view")) notFound();
  const t = await getT();

  const kind = (REGISTER_KINDS as readonly string[]).includes(sp.kind ?? "")
    ? (sp.kind as RegisterKind)
    : "risk";
  const status = sp.status === "closed" || sp.status === "all" ? sp.status : "open";
  const page = Math.max(1, Number(sp.page) || 1);
  const limit = 100;
  const { rows, total } = await listRegister(resolved.ctx, resolved.archetype, {
    kind,
    status,
    search: sp.q?.trim() || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { kind, status, q: sp.q, page: String(page), ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "page" && v === "1")) q.set(k, v);
    const s = q.toString();
    return `/o/${orgId}/studio/registers${s ? `?${s}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("studio.registers.title")}</h1>
          <p className="text-xs text-ink-muted">{t("studio.registers.subtitle")}</p>
        </div>
        <Link href={`/o/${orgId}/studio`} className="text-sm text-accent underline">
          {t("studio.title")}
        </Link>
      </header>

      <nav
        className="flex max-w-full gap-1 overflow-x-auto"
        aria-label={t("studio.registers.title")}
      >
        {REGISTER_KINDS.map((k) => (
          <Link
            key={k}
            href={href({ kind: k, page: "1" })}
            aria-current={k === kind ? "page" : undefined}
            className={`min-h-9 shrink-0 rounded-full border px-3 text-sm leading-9 ${
              k === kind ? "border-accent bg-sunken text-ink" : "border-line text-ink-muted"
            }`}
          >
            {t(`studio.type.${k}`)}
          </Link>
        ))}
      </nav>

      <form className="flex flex-wrap items-center gap-2" action={`/o/${orgId}/studio/registers`}>
        <input type="hidden" name="kind" value={kind} />
        <select
          name="status"
          defaultValue={status}
          className="min-h-9 rounded-md border border-line bg-card px-2 text-sm text-ink"
        >
          <option value="open">{t("studio.registers.open")}</option>
          <option value="closed">{t("studio.registers.closed")}</option>
          <option value="all">{t("studio.registers.all")}</option>
        </select>
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder={t("studio.search")}
          className="min-h-9 rounded-md border border-line bg-card px-2 text-sm text-ink"
        />
        <button
          type="submit"
          className="min-h-9 rounded-md border border-line px-3 text-sm text-ink"
        >
          {t("studio.registers.filter")}
        </button>
        <span className="text-xs text-ink-muted">
          {t("studio.registers.count").replace("{count}", String(total))}
        </span>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-ink-muted">
          {t("studio.registers.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2 text-start font-medium">{t("studio.field.title")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("studio.registers.plan")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("studio.field.status")}</th>
                {kind === "risk" ? (
                  <th className="px-3 py-2 text-end font-medium">{t("studio.registers.score")}</th>
                ) : null}
                <th className="px-3 py-2 text-start font-medium">{t("studio.field.due")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link
                      href={`/o/${orgId}/studio/${r.planId}?focus=${r.id}`}
                      className="text-ink underline-offset-2 hover:underline"
                    >
                      {r.title}
                    </Link>
                    {r.description ? (
                      <span className="block truncate text-[11px] text-ink-muted">
                        {r.description}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    <span dir="ltr">{r.planReference}</span> · {r.planName}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink">
                      {t(`studio.status.${r.statusCategory}`)}
                    </span>
                  </td>
                  {kind === "risk" ? (
                    <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                      {r.score === null ? (
                        <span className="text-[11px] text-ink-muted">
                          {t("studio.risk.unscored")}
                        </span>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            r.score >= 15
                              ? "bg-danger-soft text-danger"
                              : r.score >= 8
                                ? "bg-warning-soft text-warning"
                                : "bg-success-soft text-success"
                          }`}
                        >
                          {r.score}
                        </span>
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-ink-muted" dir="ltr">
                    {r.dueDate ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > limit ? (
        <nav className="flex gap-2 text-sm">
          {page > 1 ? (
            <Link href={href({ page: String(page - 1) })} className="text-accent underline">
              ‹
            </Link>
          ) : null}
          <span className="text-ink-muted">
            {page} / {Math.ceil(total / limit)}
          </span>
          {page * limit < total ? (
            <Link href={href({ page: String(page + 1) })} className="text-accent underline">
              ›
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
