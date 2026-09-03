/**
 * H26 — live bindings (ADR-19). A document CONNECTS to records; it never
 * copies them while drafting. Every value here is read through the owning
 * module's door under the acting user's permissions, so a binding to a
 * record the actor may not read resolves to "not available", never to a
 * value. Issuing freezes the resolved values into the snapshot.
 */
import { ForbiddenError } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { formatIssuerAddress } from "@/platform/documents/issuer";
import { getDocumentProfile, type DocumentProfile } from "@/modules/branding/service";
import { getCustomer, getSupplier } from "@/modules/masters/service";
import { getEmployeeProfile } from "@/modules/hr/service";
import { getQuote } from "@/modules/quotes/service";
import { getInvoice } from "@/modules/invoices/service";
import { getJob } from "@/modules/jobs/service";
import { evaluateExpression } from "./expressions";
import type { ResolvedValues } from "./render";
import {
  fieldBlocks,
  flattenBlocks,
  type DocBody,
  type DocVariables,
  type LocaleText,
} from "./types";
import type { Locale } from "@/platform/registries";

export type DocFacts = {
  id: string;
  reference: string;
  title: string;
  category: string;
  language: string;
  issuedAt: string | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  counterpartyKind: string | null;
  counterpartyId: string | null;
  counterpartyLabel: string | null;
  recordType: string | null;
  recordId: string | null;
};

type Lines = ResolvedValues["lineItems"][string];

async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

function money(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (minor === null || minor === undefined) return null;
  try {
    return formatMoney(minor, (currency ?? "AED") as CurrencyCode);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

function date(iso: string | null | undefined, locale: Locale): string | null {
  if (!iso) return null;
  try {
    return formatDate(iso, { locale });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Resolve every binding, line-item source, computed field and document fact. */
export async function resolveValues(
  ctx: Ctx,
  archetype: RoleArchetype,
  facts: DocFacts,
  body: DocBody,
  variables: DocVariables,
  profile?: DocumentProfile,
): Promise<ResolvedValues> {
  const locale: Locale = facts.language === "ar" ? "ar" : "en";
  const bindings: Record<string, string | null> = {};
  const prof = profile ?? (await getDocumentProfile(ctx));
  const id = prof.identity;
  bindings["issuer.trading_name"] = id.tradingName || id.legalName || null;
  bindings["issuer.legal_name"] = id.legalName || null;
  bindings["issuer.trn"] = id.trn ?? null;
  bindings["issuer.license_no"] = id.licenseNo ?? null;
  bindings["issuer.address"] = formatIssuerAddress(id, locale) || null;
  bindings["issuer.phone"] = id.phone ?? null;
  bindings["issuer.email"] = id.email ?? null;
  bindings["issuer.website"] = id.website ?? null;
  bindings["issuer.signatory_name"] = id.signatoryName ?? null;
  bindings["issuer.signatory_title"] = id.signatoryTitle ?? null;

  bindings["document.reference"] = facts.reference;
  bindings["document.title"] = facts.title;
  bindings["document.category"] = facts.category;
  bindings["document.language"] = facts.language;
  bindings["document.issued_at"] = date(facts.issuedAt, locale);
  bindings["document.effective_from"] = date(facts.effectiveFrom, locale);
  bindings["document.expires_at"] = date(facts.expiresAt, locale);
  bindings["document.counterparty_kind"] = facts.counterpartyKind;
  bindings["today"] = date(new Date().toISOString(), locale);

  // Counterparty
  for (const k of ["name", "address", "trn", "email", "phone", "contact"])
    bindings[`counterparty.${k}`] = null;
  for (const k of ["name", "employee_no", "position", "department", "hire_date", "nationality"])
    bindings[`employee.${k}`] = null;
  if (facts.counterpartyKind === "customer" && facts.counterpartyId) {
    const c = await guarded(() => getCustomer(ctx, archetype, facts.counterpartyId!));
    if (c) {
      bindings["counterparty.name"] = c.name;
      bindings["counterparty.address"] = c.country ?? null;
      bindings["counterparty.trn"] = c.taxRegNo;
      bindings["counterparty.email"] = c.email;
      bindings["counterparty.phone"] = c.phone;
      bindings["counterparty.contact"] = c.contactName;
      bindings["counterparty.country"] = c.country ?? null;
    }
  } else if (facts.counterpartyKind === "supplier" && facts.counterpartyId) {
    const s = await guarded(() => getSupplier(ctx, archetype, facts.counterpartyId!));
    if (s) {
      bindings["counterparty.name"] = s.name;
      bindings["counterparty.trn"] = s.taxRegNo;
      bindings["counterparty.email"] = s.email;
      bindings["counterparty.phone"] = s.phone;
    }
  } else if (facts.counterpartyKind === "employee" && facts.counterpartyId) {
    const e = await guarded(() => getEmployeeProfile(ctx, archetype, facts.counterpartyId!));
    if (e) {
      const name = locale === "ar" ? (e.nameAr ?? e.legalName ?? e.name) : (e.legalName ?? e.name);
      bindings["counterparty.name"] = name;
      bindings["counterparty.email"] = e.email;
      bindings["counterparty.phone"] = e.phone;
      bindings["employee.name"] = name;
      bindings["employee.employee_no"] = e.employeeNo;
      bindings["employee.position"] = e.positionName;
      bindings["employee.department"] = e.departmentName;
      bindings["employee.hire_date"] = date(e.hireDate, locale);
      bindings["employee.nationality"] = e.nationality;
    }
  } else if (facts.counterpartyKind === "other") {
    bindings["counterparty.name"] = facts.counterpartyLabel;
  }

  // Linked record
  for (const k of ["reference", "title", "total", "currency", "date"])
    bindings[`record.${k}`] = null;
  const lineSources: { quote?: Lines; invoice?: Lines } = {};
  if (facts.recordType === "quote" && facts.recordId) {
    const q = await guarded(() => getQuote(ctx, archetype, facts.recordId!));
    if (q) {
      const row = q as unknown as Record<string, unknown>;
      bindings["record.reference"] = q.reference;
      bindings["record.title"] = (row.customerName as string | null) ?? null;
      bindings["record.currency"] = (row.currency as string | null) ?? null;
      bindings["record.total"] = money(
        row.totalMinor as number | null,
        row.currency as string | null,
      );
      bindings["record.date"] = date((row.createdAt as string | null) ?? null, locale);
      lineSources.quote = q.lines.map((l) => ({
        description: { en: l.description, ar: l.description },
        qty: l.qty,
        unit: l.unit,
        unitPriceMinor: l.unitPriceMinor ?? 0,
        vatRate: l.vatRate,
      }));
      if (q.lines.some((l) => l.unitPriceMinor === null)) lineSources.quote = [];
    }
  } else if (facts.recordType === "invoice" && facts.recordId) {
    const inv = await guarded(() => getInvoice(ctx, archetype, facts.recordId!));
    if (inv) {
      const row = inv as unknown as Record<string, unknown>;
      bindings["record.reference"] = inv.reference;
      bindings["record.title"] = (row.customerName as string | null) ?? null;
      bindings["record.currency"] = (row.currency as string | null) ?? null;
      bindings["record.total"] = money(
        row.totalMinor as number | null,
        row.currency as string | null,
      );
      bindings["record.date"] = date(
        (row.issuedAt as string | null) ?? (row.createdAt as string | null) ?? null,
        locale,
      );
      lineSources.invoice = inv.lines.map((l) => ({
        description: { en: l.description, ar: l.description },
        qty: l.qty,
        unit: l.unit,
        unitPriceMinor: l.unitPriceMinor ?? 0,
        vatRate: l.vatRate,
      }));
      if (inv.lines.some((l) => l.unitPriceMinor === null)) lineSources.invoice = [];
    }
  } else if (facts.recordType === "job" && facts.recordId) {
    const j = await guarded(() => getJob(ctx, archetype, facts.recordId!));
    if (j) {
      bindings["record.reference"] = j.reference;
      bindings["record.title"] = j.name;
      bindings["record.date"] = date(j.dueDate ?? null, locale);
    }
  }

  // Line items per block
  const lineItems: ResolvedValues["lineItems"] = {};
  let amountMinor = 0;
  for (const b of flattenBlocks(body)) {
    if (b.type !== "line_items") continue;
    const rows = b.source === "manual" ? b.items : (lineSources[b.source] ?? []);
    lineItems[b.id] = rows;
    for (const r of rows) {
      const line = Math.round(r.qty * r.unitPriceMinor);
      amountMinor += line + Math.round((line * (r.vatRate ?? 0)) / 100);
    }
  }
  bindings["document.amount_minor"] = String(amountMinor);
  bindings["document.amount"] = (amountMinor / 100).toFixed(2);

  // Computed fields (a few passes so dependencies settle in any order).
  const vars: DocVariables = { ...variables };
  const computed = fieldBlocks(body).filter((f) => f.computed);
  for (let pass = 0; pass < 4 && computed.length > 0; pass += 1) {
    for (const f of computed) {
      try {
        const scope: Record<string, number | string | boolean | null | undefined> = {
          ...vars,
          amount: amountMinor / 100,
          amount_minor: amountMinor,
        };
        vars[f.key] = evaluateExpression(f.computed!, scope);
      } catch {
        vars[f.key] = null;
      }
    }
  }
  for (const f of fieldBlocks(body)) {
    const v = vars[f.key];
    if (v === undefined) continue;
    bindings[`field.${f.key}`] = v === null ? null : String(v);
  }

  return { bindings, lineItems, variables: vars };
}

/** Bindings a template author can choose from, grouped for the inspector. */
export function bindingGroups(): Array<{ group: string; paths: string[] }> {
  const groups: Record<string, string[]> = {};
  for (const p of [
    "document.reference",
    "document.title",
    "document.issued_at",
    "document.effective_from",
    "document.expires_at",
    "issuer.trading_name",
    "issuer.legal_name",
    "issuer.trn",
    "issuer.license_no",
    "issuer.address",
    "issuer.phone",
    "issuer.email",
    "issuer.website",
    "issuer.signatory_name",
    "issuer.signatory_title",
    "counterparty.name",
    "counterparty.address",
    "counterparty.trn",
    "counterparty.email",
    "counterparty.phone",
    "counterparty.contact",
    "employee.name",
    "employee.employee_no",
    "employee.position",
    "employee.department",
    "employee.hire_date",
    "employee.nationality",
    "record.reference",
    "record.title",
    "record.total",
    "record.currency",
    "record.date",
    "today",
  ]) {
    const g = p.includes(".") ? p.split(".")[0]! : "general";
    (groups[g] ??= []).push(p);
  }
  return Object.entries(groups).map(([group, paths]) => ({ group, paths }));
}

export type { LocaleText };
