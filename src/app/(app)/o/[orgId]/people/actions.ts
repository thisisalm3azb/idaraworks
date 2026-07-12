"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  createEmployee,
  createTeam,
  setEmployeeHr,
  setEmployeeTerms,
  updateEmployee,
} from "@/modules/masters/service";

async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

export async function createEmployeeAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const base = `/o/${orgId}/people`;
  try {
    await createEmployee(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      teamId: (formData.get("team_id") as string) || undefined,
      phone: (formData.get("phone") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=create_failed`);
  }
  revalidatePath(base);
  redirect(base);
}

export async function createTeamAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const base = `/o/${orgId}/people`;
  try {
    await createTeam(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      kind: (formData.get("kind") as "trade" | "line") || "trade",
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=create_failed`);
  }
  revalidatePath(base);
  redirect(base);
}

export async function updateEmployeeAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const id = String(formData.get("employee_id") ?? "");
  const base = `/o/${orgId}/people/${id}`;
  try {
    await updateEmployee(resolved.ctx, resolved.archetype, id, {
      name: String(formData.get("name") ?? ""),
      teamId: (formData.get("team_id") as string) || undefined,
      phone: (formData.get("phone") as string) || undefined,
      active: formData.get("active") === "on",
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=update_failed`);
  }
  revalidatePath(base);
  redirect(base);
}

export async function setTermsAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const id = String(formData.get("employee_id") ?? "");
  const base = `/o/${orgId}/people/${id}`;
  try {
    const hourlyRaw = String(formData.get("hourly_cost_minor") ?? "").trim();
    await setEmployeeTerms(resolved.ctx, resolved.archetype, id, {
      salaryMinor: Number(formData.get("salary_minor") ?? 0),
      hourlyCostMinor: hourlyRaw ? Number(hourlyRaw) : undefined,
      otRate: Number(formData.get("ot_rate") ?? 1.25),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=terms_failed`);
  }
  revalidatePath(base);
  redirect(base);
}

export async function setHrAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const id = String(formData.get("employee_id") ?? "");
  const base = `/o/${orgId}/people/${id}`;
  try {
    await setEmployeeHr(resolved.ctx, resolved.archetype, id, {
      idNumber: (formData.get("id_number") as string) || undefined,
      idExpiry: (formData.get("id_expiry") as string) || undefined,
      passportNumber: (formData.get("passport_number") as string) || undefined,
      passportExpiry: (formData.get("passport_expiry") as string) || undefined,
      visaExpiry: (formData.get("visa_expiry") as string) || undefined,
      notes: (formData.get("notes") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=hr_failed`);
  }
  revalidatePath(base);
  redirect(base);
}
