import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card } from "@/platform/ui";
import { ACTIVE_AGENT_IDS, AGENT_DEFS } from "@/platform/agents/registry";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import {
  AGENT_TEMPLATES,
  describeTools,
  getCustomAgent,
  listCustomAgents,
  listCustomAgentVersions,
} from "@/modules/idara/service";
import {
  createAgentAction,
  publishAgentAction,
  retireAgentAction,
  rollbackAgentAction,
  updateAgentAction,
} from "./actions";

/**
 * H28 — the agent builder (ADR-53/63). Administrators compose an organisation
 * agent on a platform agent: instructions, a narrowed tool list, availability
 * by role, a cost ceiling. Publishing runs the evaluation suite and refuses
 * when a critical safety category fails; every published version is kept and
 * can be rolled back to.
 */
export default async function AgentBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ agent?: string; ok?: string; error?: string; details?: string }>;
}) {
  if (!idaraEnabled()) notFound(); // page-level gate: a layout gate does not stop this page from rendering
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}/settings/ai/agents`);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "idara.agents.manage")) notFound();
  const t = await getT();
  const agents = await listCustomAgents(resolved.ctx, { includeRetired: true });
  const selected = sp.agent ? await getCustomAgent(resolved.ctx, sp.agent) : null;
  const versions = selected ? await listCustomAgentVersions(resolved.ctx, selected.id) : [];
  const tools = selected
    ? describeTools(selected.baseAgentId, resolved.archetype).filter((x) => x.usable)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("idara.builder.title")}</h1>
          <p className="text-sm text-ink-muted">{t("idara.builder.subtitle")}</p>
        </div>
        <Link
          href={`/o/${orgId}/settings/ai`}
          className="text-sm text-brand hover:underline"
          prefetch={false}
        >
          {t("idara.builder.back")}
        </Link>
      </header>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("idara.settings.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
          {t(`idara.builder.error.${sp.error}`)}
          {sp.details ? ` (${decodeURIComponent(sp.details)})` : ""}
        </p>
      ) : null}

      <Card>
        <p className="mb-2 font-medium text-ink">{t("idara.builder.new")}</p>
        <form action={createAgentAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.builder.key")}
            <input
              type="text"
              name="key"
              required
              pattern="[a-z0-9_]{2,40}"
              className="min-h-10 rounded-md border border-line bg-card px-2"
              dir="ltr"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.builder.base")}
            <select
              name="baseAgentId"
              className="min-h-10 rounded-md border border-line bg-card px-2"
            >
              {ACTIVE_AGENT_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`idara.agents.${id}.name`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.builder.name_en")}
            <input
              type="text"
              name="nameEn"
              required
              maxLength={80}
              className="min-h-10 rounded-md border border-line bg-card px-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.builder.name_ar")}
            <input
              type="text"
              name="nameAr"
              required
              maxLength={80}
              className="min-h-10 rounded-md border border-line bg-card px-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink sm:col-span-2">
            {t("idara.builder.template")}
            <select name="template" className="min-h-10 rounded-md border border-line bg-card px-2">
              <option value="">{t("idara.builder.no_template")}</option>
              {AGENT_TEMPLATES.map((tpl) => (
                <option key={tpl.key} value={tpl.key}>
                  {tpl.nameEn}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <Button type="submit">{t("idara.builder.create")}</Button>
          </div>
        </form>
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("idara.settings.custom.title")}</p>
        {agents.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("idara.settings.custom.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {agents.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
              >
                <Link
                  href={`/o/${orgId}/settings/ai/agents?agent=${a.id}`}
                  className="text-sm text-ink hover:underline"
                  prefetch={false}
                >
                  {a.nameEn} · {a.key}
                </Link>
                <span className="flex items-center gap-2">
                  <Badge
                    tone={
                      a.status === "published"
                        ? "success"
                        : a.status === "retired"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {a.status}
                  </Badge>
                  <span className="text-xs text-ink-muted">
                    {t("idara.settings.custom.base")}: {t(`idara.agents.${a.baseAgentId}.name`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected ? (
        <Card>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-ink">
              {selected.nameEn} · {selected.key}
            </p>
            <span className="flex items-center gap-2">
              <form action={publishAgentAction.bind(null, orgId, selected.id)}>
                <Button type="submit">{t("idara.builder.publish")}</Button>
              </form>
              <form action={retireAgentAction.bind(null, orgId, selected.id)}>
                <Button type="submit" variant="secondary">
                  {t("idara.builder.retire")}
                </Button>
              </form>
            </span>
          </div>
          <form
            action={updateAgentAction.bind(null, orgId, selected.id)}
            className="flex flex-col gap-3"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-ink">
                {t("idara.builder.name_en")}
                <input
                  type="text"
                  name="nameEn"
                  defaultValue={selected.nameEn}
                  maxLength={80}
                  className="min-h-10 rounded-md border border-line bg-card px-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-ink">
                {t("idara.builder.name_ar")}
                <input
                  type="text"
                  name="nameAr"
                  defaultValue={selected.nameAr}
                  maxLength={80}
                  className="min-h-10 rounded-md border border-line bg-card px-2"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.builder.instructions")}
              <textarea
                name="instructions"
                rows={5}
                defaultValue={selected.draft.instructions}
                maxLength={4000}
                className="rounded-md border border-line bg-card px-2 py-1"
              />
            </label>
            <p className="text-xs text-ink-muted">{t("idara.builder.instructions_note")}</p>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm text-ink-muted">{t("idara.builder.tools")}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {tools.map((x) => (
                  <label key={x.id} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="tools"
                      value={x.id}
                      defaultChecked={selected.draft.allowedTools.includes(x.id)}
                      className="size-5"
                    />
                    <span className="truncate">
                      {t(x.titleKey)}{" "}
                      <span className="text-xs text-ink-muted">
                        (
                        {t(
                          `idara.risk.${x.riskClass === 1 ? "read" : x.riskClass === 2 ? "draft" : x.riskClass === 3 ? "reversible" : "material"}`,
                        )}
                        )
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm text-ink-muted">{t("idara.builder.roles")}</legend>
              <div className="flex flex-wrap gap-3">
                {MVP_GRANTABLE_ARCHETYPES.map((r) => (
                  <label key={r} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="roles"
                      value={r}
                      defaultChecked={selected.draft.availabilityRoles.includes(r)}
                      className="size-5"
                    />
                    {r}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-ink">
                {t("idara.builder.ceiling")}
                <input
                  type="number"
                  min={0}
                  name="costCeiling"
                  defaultValue={selected.draft.costCeilingCredits ?? ""}
                  className="min-h-10 rounded-md border border-line bg-card px-2"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="evalRequired"
                  defaultChecked={selected.draft.evalRequired}
                  className="size-5"
                />
                {t("idara.builder.eval_required")}
              </label>
            </div>
            <Button type="submit">{t("common.save")}</Button>
          </form>

          <div className="mt-4 border-t border-line pt-3">
            <p className="font-medium text-ink">{t("idara.builder.versions")}</p>
            {versions.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("idara.builder.no_versions")}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {versions.map((v) => (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5"
                  >
                    <span className="text-ink">
                      v{v.version} · {v.publishedAt ? v.publishedAt.slice(0, 16) : "—"} ·{" "}
                      {v.evalPassed === null
                        ? t("idara.builder.eval_none")
                        : v.evalPassed
                          ? t("idara.builder.eval_passed")
                          : t("idara.builder.eval_failed")}
                      {v.evalVersion ? ` (${v.evalVersion})` : ""}
                    </span>
                    {selected.publishedVersion === v.version ? (
                      <Badge tone="success">{t("idara.builder.current")}</Badge>
                    ) : (
                      <form action={rollbackAgentAction.bind(null, orgId, selected.id, v.version)}>
                        <Button type="submit" variant="secondary">
                          {t("idara.builder.rollback")}
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-3 text-xs text-ink-muted">
            {t("idara.builder.narrowing_note", {
              agent: t(`idara.agents.${selected.baseAgentId}.name`),
            })}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {AGENT_DEFS[selected.baseAgentId].approvalRule === "never_executes"
              ? t("idara.builder.never_executes")
              : t("idara.builder.actions_need_approval")}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
