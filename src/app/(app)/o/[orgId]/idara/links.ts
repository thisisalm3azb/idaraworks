/**
 * H28 — record links and context capsule derivation for the dock (client-safe).
 * The capsule is derived from the current path: the dock understands the page
 * without the person explaining it, and only the records they keep are shared.
 */
import type { RecordRef } from "@/modules/idara/service";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

const ROUTES: Array<{ re: RegExp; type: string }> = [
  { re: new RegExp(`/customers/${UUID}`), type: "customer" },
  { re: new RegExp(`/revenue/customers/${UUID}`), type: "customer" },
  { re: new RegExp(`/revenue/deals/${UUID}`), type: "opportunity" },
  { re: new RegExp(`/revenue/leads/${UUID}`), type: "lead" },
  { re: new RegExp(`/jobs/${UUID}`), type: "job" },
  { re: new RegExp(`/documents/${UUID}`), type: "document" },
  { re: new RegExp(`/studio/${UUID}`), type: "studio_plan" },
  { re: new RegExp(`/finance/journals/${UUID}`), type: "journal_entry" },
  { re: new RegExp(`/finance/budgets/${UUID}`), type: "budget" },
  { re: new RegExp(`/people/${UUID}`), type: "employee" },
  { re: new RegExp(`/payroll/runs/${UUID}`), type: "pay_run" },
  { re: new RegExp(`/inventory/items/${UUID}`), type: "item" },
];

/** The record the current page shows, if any (the page's own kind and id only). */
export function contextFromPath(pathname: string): RecordRef | null {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (m) return { type: r.type, id: m[1]! };
  }
  return null;
}

/** Where a record opens in the app (null when the kind has no page). */
export function hrefFor(orgId: string, ref: RecordRef): string | null {
  const base = `/o/${orgId}`;
  switch (ref.type) {
    case "customer":
      return `${base}/customers/${ref.id}`;
    case "opportunity":
      return `${base}/revenue/deals/${ref.id}`;
    case "lead":
      return `${base}/revenue/leads/${ref.id}`;
    case "job":
      return `${base}/jobs/${ref.id}`;
    case "task":
      return `${base}/jobs?task=${ref.id}`;
    case "document":
      return `${base}/documents/${ref.id}`;
    case "studio_plan":
      return `${base}/studio/${ref.id}`;
    case "journal_entry":
      return `${base}/finance/journals/${ref.id}`;
    case "budget":
      return `${base}/finance/budgets/${ref.id}`;
    case "tax_return":
      return `${base}/finance/tax`;
    case "bank_account":
      return `${base}/finance/banking`;
    case "employee":
      return `${base}/people/${ref.id}`;
    case "pay_run":
      return `${base}/payroll/runs/${ref.id}`;
    case "item":
      return `${base}/inventory/items/${ref.id}`;
    case "stock_movement":
      return `${base}/inventory/movements`;
    case "exception":
      return `${base}/exceptions`;
    case "activity":
      return `${base}/revenue`;
    case "gl_account":
      return `${base}/finance/accounts`;
    default:
      return null;
  }
}
