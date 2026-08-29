import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, FilterBar } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listIssues } from "@/modules/issues/service";
import { ISSUE_SEVERITIES } from "@/platform/registries";
import { raiseIssueAction, updateIssueStatusAction } from "./actions";
import { issuesHref, parseIssuesSearch } from "@/modules/dashboard/service";

const SEVERITY_TONE = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
} as const;

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; view?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "issues.raise")) redirect(`/o/${orgId}`);
  const t = await getT();
  // H18 drill-down contract: ?view=blocking shows exactly the open blocking
  // issues behind the dashboard signal; unknown values are safely ignored.
  const { blocking } = parseIssuesSearch(sp);
  const issues = await listIssues(resolved.ctx, a, { blocking });
  const canResolve = can(a, "issues.resolve");
  const raise = raiseIssueAction.bind(null, orgId);
  const setStatus = updateIssueStatusAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("issues.title")}</h1>
      {blocking ? (
        <FilterBar
          summary={t("filters.issues.blocking")}
          countLabel={t("filters.count", { count: issues.length })}
          clearHref={issuesHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {sp.ok === "raised" ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("issues.raised_notice")}
        </p>
      ) : null}

      <Card>
        <CardHeader title={t("issues.new")} />
        <form action={raise} className="flex flex-col gap-3">
          <input
            name="title"
            required
            maxLength={200}
            placeholder={t("issues.field.title")}
            className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
          />
          <textarea
            name="description"
            rows={2}
            maxLength={4000}
            placeholder={t("issues.field.description")}
            className="w-full rounded-md border border-line-strong bg-card p-3 text-base text-ink"
          />
          <div className="flex items-center gap-3">
            <label className="text-sm text-ink">{t("issues.field.severity")}</label>
            <select
              name="severity"
              defaultValue="medium"
              className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              {ISSUE_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`issues.severity.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="is_blocker" className="size-5" />
            {t("issues.field.blocker")}
          </label>
          <Button type="submit">{t("issues.raise")}</Button>
        </form>
      </Card>

      {issues.length === 0 ? (
        <EmptyState
          title={blocking ? t("filters.empty") : t("issues.empty")}
          description={blocking ? t("filters.empty_hint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((i) => (
            <li key={i.id}>
              <Card>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {i.isBlocker ? (
                        <Badge tone="danger">{t("issues.blocker_badge")}</Badge>
                      ) : null}
                      <Badge tone={SEVERITY_TONE[i.severity as keyof typeof SEVERITY_TONE]}>
                        {t(`issues.severity.${i.severity}`)}
                      </Badge>
                      <Badge tone="neutral">{t(`issues.status.${i.status}`)}</Badge>
                    </div>
                    <span className="font-medium text-ink">{i.title}</span>
                    <span className="text-xs text-ink-muted">
                      {i.jobReference ? `${i.jobReference} · ` : ""}
                      {t("issues.raised_by")}: {i.raisedByName ?? "—"}
                    </span>
                  </div>
                  {canResolve && i.status !== "resolved" && i.status !== "closed" ? (
                    <form action={setStatus}>
                      <input type="hidden" name="issue_id" value={i.id} />
                      <input type="hidden" name="status" value="resolved" />
                      <Button type="submit" variant="secondary" size="md">
                        {t("issues.resolve")}
                      </Button>
                    </form>
                  ) : null}
                  {canResolve && (i.status === "resolved" || i.status === "closed") ? (
                    <form action={setStatus}>
                      <input type="hidden" name="issue_id" value={i.id} />
                      <input type="hidden" name="status" value="open" />
                      <Button type="submit" variant="ghost" size="md">
                        {t("issues.reopen")}
                      </Button>
                    </form>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
