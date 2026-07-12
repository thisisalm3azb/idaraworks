import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getEmployee, getEmployeeHr, getEmployeeTerms, listTeams } from "@/modules/masters/service";
import { setHrAction, setTermsAction, updateEmployeeAction } from "../actions";

export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; employeeId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId, employeeId } = await params;
  const { error } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();

  const employee = await getEmployee(resolved.ctx, resolved.archetype, employeeId);
  if (!employee) notFound();
  const teams = await listTeams(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "employees.manage");
  const canTerms = can(resolved.archetype, "employees.terms.manage");
  const canHr = can(resolved.archetype, "employees.hr.manage");
  // DB walls decide row visibility (0020) — a non-privileged ctx reads null.
  const employeeTerms = resolved.ctx.costPrivileged
    ? await getEmployeeTerms(resolved.ctx, employeeId)
    : null;
  const hr = canHr ? await getEmployeeHr(resolved.ctx, employeeId) : null;

  const update = updateEmployeeAction.bind(null, orgId);
  const saveTerms = setTermsAction.bind(null, orgId);
  const saveHr = setHrAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={employee.name}
          meta={
            <Badge tone={employee.active ? "success" : "neutral"}>
              {employee.active ? t("common.active") : t("common.inactive")}
            </Badge>
          }
        />
        {error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {canManage ? (
          <form action={update} className="flex flex-col gap-4">
            <input type="hidden" name="employee_id" value={employeeId} />
            <Field label={t("common.name")} name="name" defaultValue={employee.name} required />
            <Field label={t("common.phone")} name="phone" defaultValue={employee.phone ?? ""} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="team_id" className="text-sm font-medium text-ink">
                {t("people.team")}
              </label>
              <select
                id="team_id"
                name="team_id"
                defaultValue={employee.teamId ?? ""}
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
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="active" defaultChecked={employee.active} />
              {t("common.active")}
            </label>
            <Button type="submit">{t("common.save")}</Button>
          </form>
        ) : (
          <p className="text-sm text-ink-secondary">{employee.phone ?? ""}</p>
        )}
      </Card>

      {canTerms ? (
        <Card>
          <CardHeader title={t("people.terms.title")} />
          <form action={saveTerms} className="flex flex-col gap-4">
            <input type="hidden" name="employee_id" value={employeeId} />
            <Field
              label={t("people.terms.salary")}
              name="salary_minor"
              type="number"
              defaultValue={employeeTerms ? String(employeeTerms.salaryMinor) : ""}
              required
            />
            <Field
              label={t("people.terms.hourly")}
              name="hourly_cost_minor"
              type="number"
              defaultValue={employeeTerms ? String(employeeTerms.hourlyCostMinor) : ""}
            />
            <Field
              label={t("people.terms.ot")}
              name="ot_rate"
              type="number"
              step="0.05"
              defaultValue={employeeTerms ? String(employeeTerms.otRate) : "1.25"}
            />
            <Button type="submit">{t("common.save")}</Button>
          </form>
        </Card>
      ) : null}

      {canHr ? (
        <Card>
          <CardHeader title={t("people.hr.title")} />
          <form action={saveHr} className="flex flex-col gap-4">
            <input type="hidden" name="employee_id" value={employeeId} />
            <Field
              label={t("people.hr.id_number")}
              name="id_number"
              defaultValue={hr?.idNumber ?? ""}
            />
            <Field
              label={t("people.hr.id_expiry")}
              name="id_expiry"
              type="date"
              defaultValue={hr?.idExpiry ?? ""}
            />
            <Field
              label={t("people.hr.passport")}
              name="passport_number"
              defaultValue={hr?.passportNumber ?? ""}
            />
            <Field
              label={t("people.hr.passport_expiry")}
              name="passport_expiry"
              type="date"
              defaultValue={hr?.passportExpiry ?? ""}
            />
            <Field
              label={t("people.hr.visa_expiry")}
              name="visa_expiry"
              type="date"
              defaultValue={hr?.visaExpiry ?? ""}
            />
            <Field label={t("common.notes")} name="notes" defaultValue={hr?.notes ?? ""} />
            <Button type="submit">{t("common.save")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
