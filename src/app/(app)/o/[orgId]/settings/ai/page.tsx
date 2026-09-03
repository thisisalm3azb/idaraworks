import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card } from "@/platform/ui";
import {
  AI_PROVIDERS,
  allowanceStatus,
  byokProvisioned,
  idaraGateFor,
  listByokKeys,
  listPrivacyRegister,
  listUsage,
  resolveAiPolicy,
} from "@/platform/ai";
import { AGENT_DEFS, ACTIVE_AGENT_IDS } from "@/platform/agents/registry";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { withCtx } from "@/platform/tenancy";
import {
  agentStates,
  listCustomAgents,
  listMemory,
  listSchedules,
  mySchedulePrefs,
  SCHEDULE_KINDS,
} from "@/modules/idara/service";
import {
  forgetAction,
  rememberAction,
  revokeByokAction,
  revokePrivacyAction,
  saveScheduleAction,
  saveSchedulePrefAction,
  savePolicyAction,
  savePrivacyAction,
  setAgentStateAction,
  storeByokAction,
} from "./actions";

const DOMAINS = [
  "hr_payroll",
  "finance",
  "tax",
  "sales",
  "customer_success",
  "documents",
  "operations",
  "project",
  "reporting",
  "administration",
  "executive",
] as const;
const ROLES = [
  "owner",
  "admin",
  "manager",
  "foreman",
  "procurement",
  "accounts",
  "viewer",
] as const;

/**
 * H28 — the organisation's AI settings (ADR-54/61/65): honest status, the
 * allowance and recent use, organisation controls that only narrow, the
 * provider list with what each provider publishes, the privacy register,
 * organisation-supplied keys, agent availability, proactive schedules with
 * personal mute and snooze, and remembered knowledge.
 */
export default async function AiSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!idaraEnabled()) notFound(); // page-level gate: a layout gate does not stop this page from rendering
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}/settings/ai`);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "idara.use")) notFound();
  const t = await getT();
  const admin = can(resolved.archetype, "config.manage");
  const mayManageAgents = can(resolved.archetype, "idara.agents.manage");
  const mayViewUsage = can(resolved.archetype, "idara.usage.view");
  const gate = await idaraGateFor(resolved.ctx);
  const { policy, allowance, usage } = await withCtx(resolved.ctx, async (tx) => {
    const p = await resolveAiPolicy(tx, resolved.ctx);
    const a = await allowanceStatus(tx, resolved.ctx, p);
    const u = mayViewUsage ? await listUsage(tx, resolved.ctx, { limit: 10, offset: 0 }) : null;
    return { policy: p, allowance: a, usage: u };
  });
  const register = admin ? await listPrivacyRegister(resolved.ctx) : [];
  const byok = admin ? await withCtx(resolved.ctx, (tx) => listByokKeys(tx, resolved.ctx)) : [];
  const states = await agentStates(resolved.ctx);
  const schedules = await listSchedules(resolved.ctx);
  const prefs = await mySchedulePrefs(resolved.ctx);
  const memory = await listMemory(resolved.ctx);
  const custom = mayManageAgents ? await listCustomAgents(resolved.ctx) : [];
  const registered = new Set(register.map((r) => r.providerKey));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t("idara.settings.title")}</h1>
        <p className="text-sm text-ink-muted">{t("idara.settings.subtitle")}</p>
      </header>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("idara.settings.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
          {t(`idara.settings.error.${sp.error}`)}
        </p>
      ) : null}

      <Card>
        <p className="mb-1 font-medium text-ink">{t("idara.settings.status.title")}</p>
        <p className="text-sm text-ink">
          {t(`idara.settings.status.${gate.reason === "ok" ? "ok" : gate.reason}`)}
        </p>
        {gate.ownerAction ? (
          <p className="mt-1 text-xs text-ink-secondary" dir="ltr">
            {t("idara.dock.owner_action")}: {gate.ownerAction}
          </p>
        ) : null}
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("idara.settings.allowance.title")}</p>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-muted">{t("idara.settings.allowance.mode")}</dt>
            <dd className="text-ink">{t(`idara.mode.${policy.mode}`)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("idara.settings.allowance.used")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">{allowance.consumed}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("idara.settings.allowance.remaining")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">
              {allowance.remaining === null
                ? t("idara.settings.allowance.unlimited")
                : allowance.remaining}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("idara.settings.usage.credits")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">
              {allowance.allowance === null
                ? t("idara.settings.allowance.unlimited")
                : allowance.allowance}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-ink-muted">{t("idara.settings.allowance.renews")}</p>
        <p className="mt-1 text-xs text-ink-muted">{t("idara.settings.allowance.request_more")}</p>
      </Card>

      {usage ? (
        <Card>
          <p className="mb-2 font-medium text-ink">{t("idara.settings.usage.title")}</p>
          <p className="mb-2 text-sm text-ink-muted">
            {t("idara.settings.usage.requests")}: {usage.totals.requests} ·{" "}
            {t("idara.settings.usage.failed")}: {usage.totals.failed} ·{" "}
            {t("idara.settings.usage.credits")}: {usage.totals.credits}
          </p>
          {usage.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("idara.settings.usage.empty")}</p>
          ) : (
            <div className="w-0 min-w-full overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-sunken text-xs uppercase text-ink-muted">
                  <tr>
                    <th className="px-2 py-1 text-start">{t("idara.settings.usage.when")}</th>
                    <th className="px-2 py-1 text-start">{t("idara.settings.usage.agent")}</th>
                    <th className="px-2 py-1 text-start">{t("idara.settings.usage.decision")}</th>
                    <th className="px-2 py-1 text-start">{t("idara.settings.usage.credits")}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.rows.map((u) => (
                    <tr key={u.id} className="border-t border-line">
                      <td className="px-2 py-1 text-ink-muted" dir="ltr">
                        {u.createdAt.slice(0, 16)}
                      </td>
                      <td className="px-2 py-1 text-ink">{u.agentId ?? "—"}</td>
                      <td className="px-2 py-1 text-ink">{u.budgetDecision}</td>
                      <td className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]">
                        {u.credits}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {admin ? (
        <Card>
          <p className="mb-2 font-medium text-ink">{t("idara.settings.policy.title")}</p>
          <form action={savePolicyAction.bind(null, orgId)} className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="aiEnabled"
                defaultChecked={policy.aiEnabledByOrg}
                className="size-5"
              />
              {t("idara.settings.policy.enabled")}
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm text-ink-muted">
                {t("idara.settings.policy.restricted")}
              </legend>
              <div className="flex flex-wrap gap-3">
                {DOMAINS.map((d) => (
                  <label key={d} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="restricted"
                      value={d}
                      defaultChecked={policy.restrictedDomains.includes(d)}
                      className="size-5"
                    />
                    {t(`idara.domain.${d}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.policy.per_user")}
              <input
                type="number"
                min={0}
                name="perUserDailyCredits"
                defaultValue={policy.perUserDailyCredits ?? ""}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.policy.soft_warn")}
              <input
                type="number"
                min={1}
                max={100}
                name="softWarnPct"
                defaultValue={policy.softWarnPct}
                className="min-h-10 w-24 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.policy.reason")}
              <input
                type="text"
                name="reason"
                maxLength={500}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <p className="text-xs text-ink-muted">{t("idara.settings.policy.note")}</p>
            <Button type="submit">{t("common.save")}</Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <p className="mb-2 font-medium text-ink">{t("idara.settings.providers.title")}</p>
        <ul className="flex flex-col gap-3">
          {gate.providers.map((p) => {
            const def = AI_PROVIDERS[p.key];
            return (
              <li key={p.key} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-ink">{def.name}</p>
                  <Badge tone={p.available ? "success" : "neutral"}>
                    {t(`idara.settings.providers.reason.${p.reason}`)}
                  </Badge>
                </div>
                <dl className="mt-2 grid gap-1 text-xs text-ink-secondary sm:grid-cols-3">
                  <div>
                    <dt className="text-ink-muted">{t("idara.settings.providers.training")}</dt>
                    <dd>{def.privacy.training}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{t("idara.settings.providers.retention")}</dt>
                    <dd>{def.privacy.retentionNote}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{t("idara.settings.providers.residency")}</dt>
                    <dd>{def.privacy.residency}</dd>
                  </div>
                </dl>
                {def.privacy.sourceUrl ? (
                  <p className="mt-1 text-xs text-ink-muted" dir="ltr">
                    {t("idara.settings.providers.source")}: {def.privacy.sourceUrl} (
                    {def.privacy.fetchedAt})
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      {admin ? (
        <Card>
          <p className="mb-1 font-medium text-ink">{t("idara.settings.privacy.title")}</p>
          <p className="mb-2 text-sm text-ink-muted">{t("idara.settings.privacy.intro")}</p>
          {register.length > 0 ? (
            <ul className="mb-3 flex flex-col gap-2">
              {register.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    {AI_PROVIDERS[r.providerKey].name}: {r.lawfulBasis} · {r.transferMechanism}
                  </span>
                  <form action={revokePrivacyAction.bind(null, orgId, r.providerKey)}>
                    <Button type="submit" variant="secondary">
                      {t("idara.settings.privacy.revoke")}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          <form action={savePrivacyAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.provider")}
              <select
                name="providerKey"
                className="min-h-10 rounded-md border border-line bg-card px-2"
              >
                {(["openai", "anthropic"] as const).map((k) => (
                  <option key={k} value={k}>
                    {AI_PROVIDERS[k].name}
                    {registered.has(k) ? " ✓" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.lawful_basis")}
              <input
                type="text"
                name="lawfulBasis"
                required
                maxLength={200}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.dpa")}
              <input
                type="text"
                name="processorAgreementRef"
                required
                maxLength={200}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.transfer")}
              <input
                type="text"
                name="transferMechanism"
                required
                maxLength={200}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.retention")}
              <input
                type="text"
                name="retentionNote"
                maxLength={500}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">
              {t("idara.settings.privacy.ropa")}
              <input
                type="text"
                name="ropaRef"
                maxLength={200}
                className="min-h-10 rounded-md border border-line bg-card px-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
              <input type="checkbox" name="minimisationConfirmed" className="size-5" />
              {t("idara.settings.privacy.minimisation")}
            </label>
            <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
              <input type="checkbox" name="dpoChecked" className="size-5" />
              {t("idara.settings.privacy.dpo")}
            </label>
            <div className="sm:col-span-2">
              <Button type="submit">{t("idara.settings.privacy.save")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {admin ? (
        <Card>
          <p className="mb-1 font-medium text-ink">{t("idara.settings.byok.title")}</p>
          <p className="mb-2 text-sm text-ink-muted">{t("idara.settings.byok.intro")}</p>
          {byok.length > 0 ? (
            <ul className="mb-3 flex flex-col gap-2">
              {byok.map((k) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    {AI_PROVIDERS[k.providerKey as "openai" | "anthropic"].name} ·{" "}
                    {t("idara.settings.byok.last4")} {k.last4}
                  </span>
                  <form action={revokeByokAction.bind(null, orgId, k.id)}>
                    <Button type="submit" variant="secondary">
                      {t("idara.settings.byok.revoke")}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          {byokProvisioned() ? (
            <form action={storeByokAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-ink">
                {t("idara.settings.privacy.provider")}
                <select
                  name="providerKey"
                  className="min-h-10 rounded-md border border-line bg-card px-2"
                >
                  {(["openai", "anthropic"] as const).map((k) => (
                    <option key={k} value={k}>
                      {AI_PROVIDERS[k].name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-ink">
                {t("idara.settings.byok.secret")}
                <input
                  type="password"
                  name="secret"
                  autoComplete="off"
                  required
                  minLength={8}
                  maxLength={512}
                  className="min-h-10 rounded-md border border-line bg-card px-2"
                  dir="ltr"
                />
              </label>
              <div className="sm:col-span-2">
                <Button type="submit">{t("idara.settings.byok.store")}</Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-ink-secondary">
              {t("idara.settings.error.byok_unavailable")}
            </p>
          )}
          <p className="mt-2 text-xs text-ink-muted">{t("idara.settings.byok.mode_note")}</p>
        </Card>
      ) : null}

      <Card>
        <p className="mb-2 font-medium text-ink">{t("idara.settings.agents.title")}</p>
        <ul className="flex flex-col gap-2">
          {ACTIVE_AGENT_IDS.map((id) => {
            const def = AGENT_DEFS[id];
            return (
              <li
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {t(`idara.agents.${id}.name`)}
                  </p>
                  <p className="truncate text-xs text-ink-muted">
                    {t("idara.settings.agents.capability")}: {def.capability} ·{" "}
                    {t("idara.settings.agents.version")}: {def.version} ·{" "}
                    {t("idara.settings.agents.cost")}: {def.costClass} ·{" "}
                    {t("idara.settings.agents.sensitivity")}: {def.sensitivity}
                  </p>
                </div>
                {mayManageAgents ? (
                  <form
                    action={setAgentStateAction.bind(null, orgId)}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="agentId" value={id} />
                    <label className="flex items-center gap-1 text-sm text-ink">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={states[id] ?? def.defaultEnabled}
                        className="size-5"
                      />
                      {t("idara.settings.agents.enabled")}
                    </label>
                    <Button type="submit" variant="secondary">
                      {t("idara.settings.agents.toggle")}
                    </Button>
                  </form>
                ) : (
                  <Badge tone={(states[id] ?? def.defaultEnabled) ? "success" : "neutral"}>
                    {t("idara.settings.agents.enabled")}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
        {mayManageAgents ? (
          <div className="mt-3 border-t border-line pt-3">
            <p className="font-medium text-ink">{t("idara.settings.custom.title")}</p>
            <p className="text-sm text-ink-muted">{t("idara.settings.custom.intro")}</p>
            {custom.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">{t("idara.settings.custom.empty")}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {custom.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{c.nameEn}</span>
                    <span className="text-xs text-ink-muted">
                      {t("idara.settings.custom.base")}: {t(`idara.agents.${c.baseAgentId}.name`)} ·{" "}
                      {t("idara.settings.custom.status")}: {c.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/o/${orgId}/settings/ai/agents`}
              className="mt-2 inline-block text-sm text-brand hover:underline"
              prefetch={false}
            >
              {t("idara.settings.custom.manage")}
            </Link>
          </div>
        ) : null}
      </Card>

      <Card>
        <p className="mb-1 font-medium text-ink">{t("idara.settings.schedules.title")}</p>
        <p className="mb-2 text-sm text-ink-muted">{t("idara.settings.schedules.intro")}</p>
        <ul className="flex flex-col gap-3">
          {SCHEDULE_KINDS.map((kind) => {
            const s = schedules.find((x) => x.kind === kind);
            const pref = s ? prefs.find((p) => p.scheduleId === s.id) : undefined;
            return (
              <li key={kind} className="rounded-lg border border-line p-3">
                <p className="text-sm font-medium text-ink">
                  {t(`idara.settings.schedules.kind.${kind}`)}
                </p>
                <p className="text-xs text-ink-muted">
                  {t("idara.settings.schedules.last_run")}:{" "}
                  {s?.lastRunAt ? s.lastRunAt.slice(0, 16) : t("idara.settings.schedules.never")}
                </p>
                {mayManageAgents ? (
                  <form
                    action={saveScheduleAction.bind(null, orgId)}
                    className="mt-2 flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="kind" value={kind} />
                    <label className="flex flex-col gap-1 text-xs text-ink">
                      {t("idara.settings.schedules.cadence")}
                      <select
                        name="cadence"
                        defaultValue={s?.cadence ?? "daily"}
                        className="min-h-9 rounded-md border border-line bg-card px-2 text-sm"
                      >
                        <option value="daily">{t("idara.settings.schedules.daily")}</option>
                        <option value="weekly">{t("idara.settings.schedules.weekly")}</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-ink">
                      {t("idara.settings.schedules.hour")}
                      <input
                        type="number"
                        min={0}
                        max={23}
                        name="hourLocal"
                        defaultValue={s?.hourLocal ?? 8}
                        className="min-h-9 w-20 rounded-md border border-line bg-card px-2 text-sm"
                      />
                    </label>
                    <fieldset className="flex flex-wrap items-center gap-2">
                      <legend className="text-xs text-ink-muted">
                        {t("idara.settings.schedules.recipients")}
                      </legend>
                      {ROLES.map((r) => (
                        <label key={r} className="flex items-center gap-1 text-xs text-ink">
                          <input
                            type="checkbox"
                            name="recipients"
                            value={r}
                            defaultChecked={(
                              s?.recipients ?? ["owner", "admin", "manager"]
                            ).includes(r)}
                            className="size-4"
                          />
                          {r}
                        </label>
                      ))}
                    </fieldset>
                    <label className="flex items-center gap-1 text-sm text-ink">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={s?.enabled ?? false}
                        className="size-5"
                      />
                      {t("idara.settings.schedules.enabled")}
                    </label>
                    <Button type="submit" variant="secondary">
                      {t("idara.settings.schedules.save")}
                    </Button>
                  </form>
                ) : null}
                {s ? (
                  <form
                    action={saveSchedulePrefAction.bind(null, orgId)}
                    className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2"
                  >
                    <input type="hidden" name="scheduleId" value={s.id} />
                    <label className="flex items-center gap-1 text-sm text-ink">
                      <input
                        type="checkbox"
                        name="muted"
                        defaultChecked={pref?.muted ?? false}
                        className="size-5"
                      />
                      {t("idara.settings.schedules.mute")}
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-ink">
                      {t("idara.settings.schedules.snooze")}
                      <input
                        type="number"
                        min={0}
                        max={90}
                        name="snoozeDays"
                        className="min-h-9 w-20 rounded-md border border-line bg-card px-2 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-ink">
                      {t("idara.settings.schedules.frequency")}
                      <select
                        name="frequency"
                        defaultValue={pref?.frequency ?? "every"}
                        className="min-h-9 rounded-md border border-line bg-card px-2 text-sm"
                      >
                        <option value="every">{t("idara.settings.schedules.every")}</option>
                        <option value="daily">{t("idara.settings.schedules.daily")}</option>
                        <option value="weekly">{t("idara.settings.schedules.weekly")}</option>
                      </select>
                    </label>
                    <Button type="submit" variant="secondary">
                      {t("idara.settings.schedules.save_pref")}
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <p className="mb-1 font-medium text-ink">{t("idara.settings.memory.title")}</p>
        <p className="mb-2 text-sm text-ink-muted">{t("idara.settings.memory.intro")}</p>
        {memory.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("idara.settings.memory.empty")}</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-2">
            {memory.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="min-w-0 text-ink">
                  <span className="me-2 rounded bg-sunken px-1 text-xs text-ink-secondary">
                    {m.scope === "org"
                      ? t("idara.settings.memory.org")
                      : t("idara.settings.memory.user")}
                  </span>
                  <span className="font-medium">{m.key}</span>:{" "}
                  {typeof m.value === "string" ? m.value : JSON.stringify(m.value)}
                </span>
                <form action={forgetAction.bind(null, orgId, m.id)}>
                  <Button type="submit" variant="secondary">
                    {t("idara.settings.memory.forget")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={rememberAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.settings.memory.scope")}
            <select name="scope" className="min-h-10 rounded-md border border-line bg-card px-2">
              <option value="user">{t("idara.settings.memory.user")}</option>
              {admin ? <option value="org">{t("idara.settings.memory.org")}</option> : null}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink">
            {t("idara.settings.memory.key")}
            <input
              type="text"
              name="key"
              required
              pattern="[a-z0-9_.\-]{1,80}"
              className="min-h-10 rounded-md border border-line bg-card px-2"
              dir="ltr"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink sm:col-span-2">
            {t("idara.settings.memory.value")}
            <input
              type="text"
              name="value"
              required
              maxLength={1000}
              className="min-h-10 rounded-md border border-line bg-card px-2"
            />
          </label>
          <input type="hidden" name="kind" value="knowledge" />
          <div className="sm:col-span-4">
            <Button type="submit">{t("idara.settings.memory.add")}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
