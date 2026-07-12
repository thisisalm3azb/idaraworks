/**
 * Terminology catalogue (doc 07). Domain nouns are STRUCTURED ENTRIES, not
 * strings — Arabic adjectives/verbs agree with the noun's gender, so ICU
 * select/plural in the message catalogs needs the metadata (doc 07 D-7.1).
 *
 * This file holds the PLATFORM DEFAULTS for every canonical TERM_KEY in both
 * shipped languages. Templates (e.g. boat-building) and orgs override values,
 * never keys — same closed-registry discipline as docs 02/05.
 */
import { TERM_KEYS, type TermKey } from "@/platform/registries";

export type Gender = "m" | "f";

/** One term in one language. `gender` is required for `ar` (grammar agreement). */
export type TermForm = {
  singular: string;
  plural: string;
  gender?: Gender; // required for ar; ignored for en
};

/** A term entry: required languages = the org's enabled languages (validated in config). */
export type TermEntry = {
  en: TermForm;
  ar: TermForm;
};

export type TerminologyMap = Partial<Record<TermKey, TermEntry>>;

/**
 * Platform defaults — generic operational vocabulary. A boat-building org sees
 * "Boat" via the template map (template-boat.ts); a contractor keeps "Job".
 */
export const PLATFORM_DEFAULT_TERMS: Record<TermKey, TermEntry> = {
  job: {
    en: { singular: "Job", plural: "Jobs" },
    ar: { singular: "مشروع", plural: "مشاريع", gender: "m" },
  },
  job_stage: {
    en: { singular: "Stage", plural: "Stages" },
    ar: { singular: "مرحلة", plural: "مراحل", gender: "f" },
  },
  daily_report: {
    en: { singular: "Daily report", plural: "Daily reports" },
    ar: { singular: "تقرير يومي", plural: "تقارير يومية", gender: "m" },
  },
  material_request: {
    en: { singular: "Material request", plural: "Material requests" },
    ar: { singular: "طلب مواد", plural: "طلبات مواد", gender: "m" },
  },
  purchase_order: {
    en: { singular: "Purchase order", plural: "Purchase orders" },
    ar: { singular: "أمر شراء", plural: "أوامر شراء", gender: "m" },
  },
  goods_receipt: {
    en: { singular: "Goods receipt", plural: "Goods receipts" },
    ar: { singular: "إيصال استلام", plural: "إيصالات استلام", gender: "m" },
  },
  expense: {
    en: { singular: "Expense", plural: "Expenses" },
    ar: { singular: "مصروف", plural: "مصروفات", gender: "m" },
  },
  payment: {
    en: { singular: "Payment", plural: "Payments" },
    ar: { singular: "دفعة", plural: "دفعات", gender: "f" },
  },
  task: {
    en: { singular: "Task", plural: "Tasks" },
    ar: { singular: "مهمة", plural: "مهام", gender: "f" },
  },
  issue: {
    en: { singular: "Issue", plural: "Issues" },
    ar: { singular: "ملاحظة", plural: "ملاحظات", gender: "f" },
  },
  customer: {
    en: { singular: "Customer", plural: "Customers" },
    ar: { singular: "عميل", plural: "عملاء", gender: "m" },
  },
  supplier: {
    en: { singular: "Supplier", plural: "Suppliers" },
    ar: { singular: "مورّد", plural: "موردون", gender: "m" },
  },
  employee: {
    en: { singular: "Employee", plural: "Employees" },
    ar: { singular: "موظف", plural: "موظفون", gender: "m" },
  },
  team: {
    en: { singular: "Team", plural: "Teams" },
    ar: { singular: "فريق", plural: "فرق", gender: "m" },
  },
  quote: {
    en: { singular: "Quote", plural: "Quotes" },
    ar: { singular: "عرض سعر", plural: "عروض أسعار", gender: "m" },
  },
  invoice: {
    en: { singular: "Invoice", plural: "Invoices" },
    ar: { singular: "فاتورة", plural: "فواتير", gender: "f" },
  },
};

// Compile-time completeness: every TERM_KEY has a default (the `Record` type
// already enforces this, but keep the assertion explicit for the coverage test).
export const TERM_KEY_COUNT = TERM_KEYS.length;
