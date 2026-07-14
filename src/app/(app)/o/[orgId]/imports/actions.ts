"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { stageImport, applyImport, IMPORT_KINDS, type ImportKind } from "@/modules/imports/service";

/** Minimal RFC-4180-ish CSV parse (quoted fields, doubled quotes, CR/LF). Header row → keys. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

export async function stageImportAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const kind = String(formData.get("kind") ?? "") as ImportKind;
  if (!IMPORT_KINDS.includes(kind)) redirect(`/o/${orgId}/imports?error=kind`);
  const rows = parseCsv(String(formData.get("csv") ?? ""));
  if (rows.length === 0) redirect(`/o/${orgId}/imports?error=empty`);
  try {
    const { batchId } = await stageImport(resolved.ctx, resolved.archetype, {
      kind,
      filename: String(formData.get("filename") ?? "") || undefined,
      rows,
    });
    revalidatePath(`/o/${orgId}/imports`);
    redirect(`/o/${orgId}/imports?batch=${batchId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/imports?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`);
  }
}

export async function applyImportAction(
  orgId: string,
  batchId: string,
  formData: FormData,
): Promise<void> {
  void formData;
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await applyImport(resolved.ctx, resolved.archetype, batchId);
    revalidatePath(`/o/${orgId}/imports`);
    redirect(`/o/${orgId}/imports?batch=${batchId}&applied=1`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/imports?batch=${batchId}&error=apply`);
  }
}
