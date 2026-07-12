import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { listEmployees, listTeams } from "@/modules/masters/service";
import { createEmployeeAction, createTeamAction } from "./actions";

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const { error } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const employeeTerm = term("employee", terms, "singular");
  const employeesTerm = term("employee", terms, "plural");

  const employees = await listEmployees(resolved.ctx, resolved.archetype);
  const teams = await listTeams(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "employees.manage");
  const addEmployee = createEmployeeAction.bind(null, orgId);
  const addTeam = createTeamAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("people.employees", { employees: employeesTerm })} />
        {error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {employees.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {employees.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/o/${orgId}/people/${e.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-ink">{e.name}</p>
                    <p className="text-xs text-ink-muted">{e.teamName ?? ""}</p>
                  </div>
                  <Badge tone={e.active ? "success" : "neutral"}>
                    {e.active ? t("common.active") : t("common.inactive")}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader title={t("people.add_employee", { employee: employeeTerm })} />
          <form action={addEmployee} className="flex flex-col gap-4">
            <Field label={t("common.name")} name="name" required />
            <Field label={t("common.phone")} name="phone" />
            {teams.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="team_id" className="text-sm font-medium text-ink">
                  {t("people.team")}
                </label>
                <select
                  id="team_id"
                  name="team_id"
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("people.teams.title")} />
        {teams.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {teams.map((tm) => (
              <li key={tm.id} className="flex min-h-11 items-center justify-between py-2">
                <p className="text-sm text-ink">{tm.name}</p>
                <Badge tone="neutral">{tm.kind}</Badge>
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <form action={addTeam} className="mt-4 flex flex-col gap-4">
            <Field label={t("people.add_team")} name="name" required />
            <Button type="submit" variant="secondary">
              {t("common.add")}
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
