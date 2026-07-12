import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { TERM_KEYS } from "@/platform/registries";
import { TEMPLATE_BOATBUILDING, diffConfig } from "@/platform/config";
import { loadOrgTerminology, resolveTerm } from "@/platform/terminology";
import { formatDateTime } from "@/platform/format";
import { sql, withCtx } from "@/platform/tenancy";
import { installTemplateAction, saveTermAction, undoRevisionAction } from "./actions";

export default async function ConfigurationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { orgId } = await params;
  const { error, notice } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);

  const settings = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select key, value from public.app_settings
      where org_id = ${resolved.ctx.orgId} and key = 'config.template'
    `),
  )) as unknown as Array<{ key: string; value: { key: string; version: number } }>;
  const installedTemplate = settings[0]?.value ?? null;

  const revisions = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, artifact_key, summary, before_data, after_data, created_at::text as created_at
      from public.config_revision
      where org_id = ${resolved.ctx.orgId}
      order by created_at desc
      limit 20
    `),
  )) as unknown as Array<{
    id: string;
    artifact_key: string;
    summary: string | null;
    before_data: unknown;
    after_data: unknown;
    created_at: string;
  }>;

  const install = installTemplateAction.bind(null, orgId);
  const saveTerm = saveTermAction.bind(null, orgId);
  const undo = undoRevisionAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("config.title")} />
        {notice === "installed" ? (
          <p className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">✓</p>
        ) : null}
        {error === "guard" ? (
          <p className="mb-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            {t("config.error.guard", { reason: "referenced by live data" })}
          </p>
        ) : error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {installedTemplate ? (
          <p className="text-sm text-ink-secondary">
            {t("config.installed", {
              template: installedTemplate.key,
              version: String(installedTemplate.version),
            })}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-secondary">
              {t("config.install.desc", { template: TEMPLATE_BOATBUILDING.key })}
            </p>
            <form action={install}>
              <input type="hidden" name="template_key" value={TEMPLATE_BOATBUILDING.key} />
              <Button type="submit">{t("config.install.cta")}</Button>
            </form>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t("config.terms.title")} />
        <p className="mb-3 text-sm text-ink-secondary">{t("config.terms.desc")}</p>
        <ul className="mb-4 flex flex-wrap gap-2">
          {TERM_KEYS.map((key) => {
            const en = resolveTerm(key, { ...terms, locale: "en" });
            const ar = resolveTerm(key, { ...terms, locale: "ar" });
            return (
              <li
                key={key}
                className="rounded-md border border-line px-2 py-1 text-xs text-ink-secondary"
              >
                <span className="font-mono">{key}</span>: {en.singular} · {ar.singular}
              </li>
            );
          })}
        </ul>
        <form action={saveTerm} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="term_key" className="text-sm font-medium text-ink">
              {t("config.terms.key")}
            </label>
            <select
              id="term_key"
              name="term_key"
              required
              className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              {TERM_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>
          <Field label={t("config.terms.en_singular")} name="en_singular" required maxLength={40} />
          <Field label={t("config.terms.en_plural")} name="en_plural" required maxLength={40} />
          <Field
            label={t("config.terms.ar_singular")}
            name="ar_singular"
            required
            maxLength={40}
            dir="rtl"
          />
          <Field
            label={t("config.terms.ar_plural")}
            name="ar_plural"
            required
            maxLength={40}
            dir="rtl"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ar_gender" className="text-sm font-medium text-ink">
              {t("config.terms.gender")}
            </label>
            <select
              id="ar_gender"
              name="ar_gender"
              className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              <option value="m">m</option>
              <option value="f">f</option>
            </select>
          </div>
          <Button type="submit">{t("config.terms.save")}</Button>
        </form>
      </Card>

      <Card>
        <CardHeader title={t("config.revisions.title")} />
        {revisions.length === 0 ? (
          <EmptyState title={t("config.revisions.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {revisions.map((r) => {
              const entries = diffConfig(r.before_data, r.after_data).slice(0, 6);
              return (
                <li key={r.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink">{r.summary ?? r.artifact_key}</p>
                      <p className="text-xs text-ink-muted">
                        <span className="font-mono">{r.artifact_key}</span> ·{" "}
                        {formatDateTime(r.created_at, { locale })}
                      </p>
                    </div>
                    <form action={undo}>
                      <input type="hidden" name="revision_id" value={r.id} />
                      <Button type="submit" variant="ghost">
                        {t("config.revisions.undo")}
                      </Button>
                    </form>
                  </div>
                  {entries.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5" dir="ltr">
                      {entries.map((e, i) => (
                        <li key={i} className="truncate font-mono text-xs text-ink-muted">
                          <Badge
                            tone={
                              e.kind === "added"
                                ? "success"
                                : e.kind === "removed"
                                  ? "warning"
                                  : "info"
                            }
                          >
                            {e.kind}
                          </Badge>{" "}
                          {e.path}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
