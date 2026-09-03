import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import {
  AI_MODELS,
  AI_PROVIDERS,
  isPlatformOperator,
  operatorAudit,
  operatorEconomics,
  operatorOrgs,
  operatorProviderHealth,
  operatorSwitches,
} from "@/platform/ai";
import { getSessionUser } from "@/platform/auth/resolve";
import { idaraEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import {
  grantCreditsAction,
  setKillSwitchAction,
  setOrgPolicyAction,
  setProviderEnabledAction,
} from "./actions";

/**
 * H28 — the IdaraWorks owner's AI economics centre (ADR-55). Operator-only:
 * the session's user must hold an active `platform_operator` row, proved by
 * the database (security definer), not by a role in any organisation. Every
 * number here comes from the usage ledger and drills down to its rows.
 */
export default async function PlatformAiPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; ok?: string; error?: string }>;
}) {
  if (!idaraEnabled()) notFound(); // page-level gate: a layout gate does not stop this page from rendering
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/platform/ai");
  if (!(await isPlatformOperator(user.id))) notFound();
  const t = await getT();
  const days = Math.min(Math.max(Number(sp.days ?? 30), 1), 180);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const [economics, orgs, switches, health, audit] = await Promise.all([
    operatorEconomics(user.id, from, to),
    operatorOrgs(user.id),
    operatorSwitches(user.id),
    operatorProviderHealth(user.id),
    operatorAudit(user.id, 20),
  ]);
  const usd = (micros: bigint | string) =>
    `$${(Number(BigInt(micros.toString())) / 1_000_000).toFixed(2)}`;
  const globalStopped = switches.some((s) => s.scope === "global");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t("platform.ai.title")}</h1>
        <p className="text-sm text-ink-muted">{t("platform.ai.subtitle")}</p>
      </header>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("idara.settings.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
          {t("idara.settings.error.failed")}
        </p>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-ink">{t("platform.ai.emergency")}</p>
          <form action={setKillSwitchAction.bind(null, "global", "")}>
            <input type="hidden" name="active" value={globalStopped ? "off" : "on"} />
            <input
              type="hidden"
              name="reason"
              value={globalStopped ? "resumed by owner" : "emergency stop by owner"}
            />
            <Button type="submit" variant={globalStopped ? "secondary" : "danger"}>
              {globalStopped ? t("platform.ai.resume_all") : t("platform.ai.stop_all")}
            </Button>
          </form>
        </div>
        <p className="mt-1 text-xs text-ink-muted">{t("platform.ai.emergency_note")}</p>
        {switches.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {switches.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5"
              >
                <span className="text-ink">
                  {s.scope}
                  {s.scopeKey ? `: ${s.scopeKey}` : ""} · {s.reason ?? ""}
                </span>
                <form action={setKillSwitchAction.bind(null, s.scope as "global", s.scopeKey)}>
                  <input type="hidden" name="active" value="off" />
                  <input type="hidden" name="reason" value="cleared by owner" />
                  <Button type="submit" variant="secondary">
                    {t("platform.ai.clear")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("platform.ai.economics")}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-muted">{t("platform.ai.orgs")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">
              {economics.organisations}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("idara.settings.usage.requests")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">{economics.requests}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("platform.ai.failed_denied")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">
              {economics.failed} / {economics.denied}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("idara.settings.usage.credits")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]">{economics.credits}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("platform.ai.est_cost")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]" dir="ltr">
              {usd(economics.estCostMicros)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("platform.ai.actual_cost")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]" dir="ltr">
              {economics.actualCostMicros === 0n
                ? t("platform.ai.not_reported")
                : usd(economics.actualCostMicros)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("platform.ai.forecast")}</dt>
            <dd className="text-ink [font-variant-numeric:tabular-nums]" dir="ltr">
              {usd(economics.forecastMonthEndMicros)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("platform.ai.revenue_margin")}</dt>
            <dd className="text-ink">{t("platform.ai.no_charging")}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("platform.ai.providers")}</p>
        <ul className="flex flex-col gap-2">
          {(Object.keys(AI_PROVIDERS) as Array<keyof typeof AI_PROVIDERS>)
            .filter((k) => AI_PROVIDERS[k].kind === "external")
            .map((k) => {
              const state = health.find((h) => h.providerKey === k);
              const enabled = state?.enabled ?? true;
              return (
                <li
                  key={k}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-sm text-ink">
                    {AI_PROVIDERS[k].name} · {state?.health ?? "unknown"}
                    {state?.consecutiveFailures
                      ? ` · ${state.consecutiveFailures} ${t("platform.ai.failures")}`
                      : ""}
                    {state?.breakerOpenUntil
                      ? ` · ${t("platform.ai.breaker_until")} ${state.breakerOpenUntil.slice(0, 16)}`
                      : ""}
                  </span>
                  <form
                    action={setProviderEnabledAction.bind(null, k)}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
                    <input
                      type="hidden"
                      name="reason"
                      value={enabled ? "disabled by owner" : "enabled by owner"}
                    />
                    <Badge tone={enabled ? "success" : "neutral"}>
                      {enabled ? t("idara.settings.agents.enabled") : t("idara.mode.disabled")}
                    </Badge>
                    <Button type="submit" variant="secondary">
                      {enabled ? t("platform.ai.disable") : t("platform.ai.enable")}
                    </Button>
                  </form>
                </li>
              );
            })}
        </ul>
        <p className="mt-2 text-xs text-ink-muted">
          {t("platform.ai.models")}: {Object.keys(AI_MODELS).length}
        </p>
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("platform.ai.by_org")}</p>
        <div className="w-0 min-w-full overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-sunken text-xs uppercase text-ink-muted">
              <tr>
                <th className="px-2 py-1 text-start">{t("platform.ai.org")}</th>
                <th className="px-2 py-1 text-start">{t("idara.settings.allowance.mode")}</th>
                <th className="px-2 py-1 text-start">{t("idara.settings.usage.requests")}</th>
                <th className="px-2 py-1 text-start">{t("idara.settings.usage.credits")}</th>
                <th className="px-2 py-1 text-start">{t("platform.ai.est_cost")}</th>
                <th className="px-2 py-1 text-start">{t("platform.ai.controls")}</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const usage = economics.byOrg.filter((r) => r.orgId === o.orgId);
                const requests = usage.reduce((n, r) => n + r.requests, 0);
                const credits = usage.reduce((n, r) => n + r.credits, 0);
                const cost = usage.reduce((n, r) => n + BigInt(r.estCostMicros || "0"), 0n);
                const stopped = switches.some((s) => s.scope === "org" && s.scopeKey === o.orgId);
                return (
                  <tr key={o.orgId} className="border-t border-line align-top">
                    <td className="px-2 py-1 text-ink">
                      {o.orgName}
                      {o.byokProviders.length ? (
                        <span className="ms-1 text-xs text-ink-muted">BYOK</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1 text-ink">
                      {o.mode ? t(`idara.mode.${o.mode}`) : t("idara.mode.disabled")}
                    </td>
                    <td className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]">
                      {requests}
                    </td>
                    <td className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]">
                      {credits}
                    </td>
                    <td
                      className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]"
                      dir="ltr"
                    >
                      {usd(cost)}
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex flex-wrap gap-1">
                        <form action={setKillSwitchAction.bind(null, "org", o.orgId)}>
                          <input type="hidden" name="active" value={stopped ? "off" : "on"} />
                          <input
                            type="hidden"
                            name="reason"
                            value={stopped ? "resumed by owner" : "paused by owner"}
                          />
                          <Button type="submit" variant="secondary">
                            {stopped ? t("platform.ai.resume") : t("platform.ai.pause")}
                          </Button>
                        </form>
                        <form
                          action={setOrgPolicyAction.bind(null, o.orgId)}
                          className="flex items-center gap-1"
                        >
                          <select
                            name="mode"
                            defaultValue={o.mode ?? "disabled"}
                            className="min-h-8 rounded border border-line bg-card px-1 text-xs"
                            aria-label={t("idara.settings.allowance.mode")}
                          >
                            {(
                              [
                                "disabled",
                                "trial",
                                "included",
                                "prepaid",
                                "enterprise",
                                "byok",
                              ] as const
                            ).map((m) => (
                              <option key={m} value={m}>
                                {t(`idara.mode.${m}`)}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            name="monthlyCredits"
                            min={0}
                            placeholder="credits"
                            className="min-h-8 w-24 rounded border border-line bg-card px-1 text-xs"
                            aria-label={t("idara.settings.usage.credits")}
                          />
                          <Button type="submit" variant="secondary">
                            {t("platform.ai.apply")}
                          </Button>
                        </form>
                        <form
                          action={grantCreditsAction.bind(null, o.orgId)}
                          className="flex items-center gap-1"
                        >
                          <input
                            type="number"
                            name="credits"
                            min={1}
                            placeholder="grant"
                            className="min-h-8 w-20 rounded border border-line bg-card px-1 text-xs"
                            aria-label={t("platform.ai.grant")}
                          />
                          <Button type="submit" variant="secondary">
                            {t("platform.ai.grant")}
                          </Button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("platform.ai.by_agent_model")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="w-0 min-w-full overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-sunken text-xs uppercase text-ink-muted">
                <tr>
                  <th className="px-2 py-1 text-start">{t("idara.settings.usage.agent")}</th>
                  <th className="px-2 py-1 text-start">{t("idara.settings.usage.requests")}</th>
                  <th className="px-2 py-1 text-start">{t("platform.ai.est_cost")}</th>
                </tr>
              </thead>
              <tbody>
                {economics.byAgent.map((a) => (
                  <tr key={a.agentId} className="border-t border-line">
                    <td className="px-2 py-1 text-ink">{a.agentId}</td>
                    <td className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]">
                      {a.requests}
                    </td>
                    <td
                      className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]"
                      dir="ltr"
                    >
                      {usd(a.estCostMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="w-0 min-w-full overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-sunken text-xs uppercase text-ink-muted">
                <tr>
                  <th className="px-2 py-1 text-start">{t("platform.ai.model")}</th>
                  <th className="px-2 py-1 text-start">{t("idara.settings.usage.requests")}</th>
                  <th className="px-2 py-1 text-start">{t("platform.ai.est_cost")}</th>
                </tr>
              </thead>
              <tbody>
                {economics.byModel.map((m) => (
                  <tr key={m.model} className="border-t border-line">
                    <td className="px-2 py-1 text-ink">{m.model}</td>
                    <td className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]">
                      {m.requests}
                    </td>
                    <td
                      className="px-2 py-1 text-ink [font-variant-numeric:tabular-nums]"
                      dir="ltr"
                    >
                      {usd(m.estCostMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card>
        <p className="mb-2 font-medium text-ink">{t("platform.ai.audit")}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {audit.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-2 border-b border-line py-1 last:border-0">
              <span className="text-xs text-ink-muted" dir="ltr">
                {a.createdAt.slice(0, 16)}
              </span>
              <span className="text-ink">{a.action}</span>
              <span className="text-ink-muted">
                {a.scope}
                {a.scopeKey ? `: ${a.scopeKey}` : ""}
              </span>
              <span className="text-ink-secondary">{a.summary}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
