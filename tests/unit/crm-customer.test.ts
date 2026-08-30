/**
 * H19 — Customer 360 unit surface: the honest presentation model, the
 * legacy-contact compatibility adapter, duplicate normalization, customer
 * filter parsing/building round-trips, the jobs-page filter pin, archive
 * rules (no delete path), and copy integrity (en/ar parity, no internal
 * keys, no em dash, no construction-specific customer language).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { presentCustomer } from "@/modules/crm/service";
import {
  normalizeEmailForMatch,
  normalizePhoneForMatch,
  phonesMatch,
  presentPrimaryContact,
  type CustomerContactRow,
  type CustomerDetail,
} from "@/modules/masters/service";
import {
  arHref,
  invoicesHref,
  jobsHref,
  parseArSearch,
  parseCustomerParam,
  parseInvoicesSearch,
  parseJobsSearch,
  parseQuotesSearch,
  quotesHref,
} from "@/modules/dashboard/service";

const EN = en as Record<string, string>;
const AR = ar as Record<string, string>;

const detail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  id: "c1",
  name: "Al Reem Holdings",
  country: null,
  contactName: null,
  phone: null,
  email: null,
  taxRegNo: null,
  notes: null,
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  ...over,
});

const contact = (over: Partial<CustomerContactRow> = {}): CustomerContactRow => ({
  id: "ct1",
  name: "Fatima",
  roleTitle: null,
  email: null,
  phone: null,
  preferredMethod: "phone",
  isPrimary: false,
  active: true,
  ...over,
});

describe("H19 — presentation model (honest to the real schema)", () => {
  it("presents identity without fabricating kind, reference or addresses", () => {
    const p = presentCustomer(detail(), []);
    expect(p.displayName).toBe("Al Reem Holdings");
    expect(p.primaryContact).toBeNull(); // no contact data → null, not ""
    expect(Object.keys(p)).not.toContain("kind"); // no org/individual invention
    expect(Object.keys(p)).not.toContain("legalName");
  });

  it("no email, no company, no UAE field is ever required", () => {
    // An individual with only a phone is a complete customer.
    const p = presentCustomer(detail({ name: "أحمد المنصوري", phone: "+971501234567" }), []);
    expect(p.primaryContact?.phone).toBe("+971501234567");
    expect(p.primaryContact?.email).toBeNull();
    expect(p.country).toBeNull();
    expect(p.taxRegNo).toBeNull();
  });

  it("compatibility adapter: legacy embedded contact becomes a virtual primary", () => {
    const p = presentPrimaryContact(
      { contactName: "Om Kalthoum", phone: "050 111", email: null },
      [],
    );
    expect(p?.legacy).toBe(true);
    expect(p?.name).toBe("Om Kalthoum");
    // A normalized primary WINS over the legacy embedded fields.
    const n = presentPrimaryContact({ contactName: "Legacy", phone: "1", email: null }, [
      contact({ isPrimary: true, name: "Normalized" }),
    ]);
    expect(n?.name).toBe("Normalized");
    expect(n?.legacy).toBeUndefined();
    // First active row stands in when no explicit primary exists.
    const f = presentPrimaryContact({ contactName: null, phone: null, email: null }, [
      contact({ name: "OnlyOne" }),
    ]);
    expect(f?.name).toBe("OnlyOne");
  });
});

describe("H19 — duplicate normalization (comparison only, never rewrites)", () => {
  it("email: trim + lowercase; empty → null", () => {
    expect(normalizeEmailForMatch("  Sales@Example.COM ")).toBe("sales@example.com");
    expect(normalizeEmailForMatch("")).toBeNull();
    expect(normalizeEmailForMatch(null)).toBeNull();
  });

  it("phone: international prefix normalizes to E.164; local keeps national digits", () => {
    expect(normalizePhoneForMatch("+971 50 123 4567")).toEqual({
      kind: "e164",
      value: "971501234567",
    });
    expect(normalizePhoneForMatch("00971 50 123 4567")).toEqual({
      kind: "e164",
      value: "971501234567",
    });
    expect(normalizePhoneForMatch("050-123-4567")).toEqual({
      kind: "national",
      value: "501234567",
    });
    // A country hint upgrades a local number to E.164.
    expect(normalizePhoneForMatch("050-123-4567", "AE")).toEqual({
      kind: "e164",
      value: "971501234567",
    });
    expect(normalizePhoneForMatch("04-555-0100")).toEqual({ kind: "national", value: "45550100" });
  });

  it("phone: malformed and empty values normalize to null (never compared)", () => {
    expect(normalizePhoneForMatch("12345")).toBeNull(); // too short to judge
    expect(normalizePhoneForMatch("+12")).toBeNull(); // impossible E.164 length
    expect(normalizePhoneForMatch("+1234567890123456")).toBeNull(); // 16 digits, over E.164
    expect(normalizePhoneForMatch("")).toBeNull();
    expect(normalizePhoneForMatch("   ")).toBeNull();
    expect(normalizePhoneForMatch(null)).toBeNull();
    expect(normalizePhoneForMatch(undefined)).toBeNull();
  });

  it("phonesMatch: UAE local and international forms of the same line match", () => {
    const m = (a: string, b: string, hintA?: string, hintB?: string) =>
      phonesMatch(normalizePhoneForMatch(a, hintA), normalizePhoneForMatch(b, hintB));
    expect(m("+971 50 123 4567", "050-123-4567")).toBe(true); // e164 vs national
    expect(m("+971 4 555 0100", "04-555-0100")).toBe(true); // landline, trunk 0
    expect(m("+971501234567", "+971 50 123 4567")).toBe(true); // formatting only
    expect(m("050 123 4567", "0501234567")).toBe(true); // national vs national
    expect(m("050-123-4567", "+971 50 123 4567", "AE")).toBe(true); // hinted e164 both sides
  });

  it("phonesMatch: unrelated international numbers sharing a suffix NEVER match", () => {
    const m = (a: string, b: string) =>
      phonesMatch(normalizePhoneForMatch(a), normalizePhoneForMatch(b));
    // Same last seven digits, different countries — the old contract's failure.
    expect(m("+1 415 555 1234", "+968 9555 1234")).toBe(false);
    expect(m("+971 50 555 1234", "+966 50 555 1234")).toBe(false);
    // Different subscriber numbers in the same country.
    expect(m("+971 50 123 4567", "+971 50 123 4568")).toBe(false);
    // National forms must equal in FULL, never by suffix.
    expect(m("050 123 4567", "123 4567")).toBe(false);
    // E.164 vs national only matches when the remainder is a plausible calling code (1..4 digits).
    expect(m("+99999 123 4567", "123 4567")).toBe(false); // suffix matches but 5-digit remainder
    // Null inputs never match anything.
    expect(phonesMatch(null, normalizePhoneForMatch("+971 50 123 4567"))).toBe(false);
    expect(phonesMatch(null, null)).toBe(false);
  });
});

describe("H19 — customer filter contracts", () => {
  it("validates the customer param server-side and ignores junk", () => {
    const good = "a7b9c1d3-1234-4abc-9def-0123456789ab";
    expect(parseCustomerParam({ customer: good }).customerId).toBe(good);
    expect(parseCustomerParam({ customer: "1 OR 1=1" }).customerId).toBeNull();
    expect(parseCustomerParam({}).customerId).toBeNull();
  });

  it("builders and parsers round-trip on every destination", () => {
    const id = "a7b9c1d3-1234-4abc-9def-0123456789ab";
    const jq = Object.fromEntries(
      new URL(`http://x${jobsHref("o", { customerId: id })}`).searchParams,
    );
    expect(parseJobsSearch(jq).customerId).toBe(id);
    expect(
      parseQuotesSearch(
        Object.fromEntries(new URL(`http://x${quotesHref("o", true, id)}`).searchParams),
      ),
    ).toEqual({ awaiting: true, customerId: id, expiringDays: null });
    // H20: the expiring window round-trips too.
    expect(
      parseQuotesSearch(
        Object.fromEntries(new URL(`http://x${quotesHref("o", false, null, 14)}`).searchParams),
      ),
    ).toEqual({ awaiting: false, customerId: null, expiringDays: 14 });
    expect(
      parseInvoicesSearch(
        Object.fromEntries(new URL(`http://x${invoicesHref("o", id)}`).searchParams),
      ).customerId,
    ).toBe(id);
    const aq = Object.fromEntries(new URL(`http://x${arHref("o", "over90", id)}`).searchParams);
    expect(parseArSearch(aq)).toEqual({ view: "over90", customerId: id });
  });

  it("the jobs page FILTERS the list by customer (not just form preselect)", () => {
    const src = readFileSync("src/app/(app)/o/[orgId]/jobs/page.tsx", "utf8");
    expect(src).toMatch(/customerId: f\.customerId \?\? undefined/);
    // The create-form preselect continuity is preserved too.
    expect(src).toMatch(/customers\.some\(\(c\) => c\.active && c\.id === customer\)/);
  });
});

describe("H19 — archive rules and legacy compatibility", () => {
  it("no delete path exists for customers or contacts (archive only)", () => {
    const masters = readFileSync("src/modules/masters/service.ts", "utf8");
    expect(masters).not.toMatch(/delete from public\.customer/);
    const migration = readFileSync("supabase/migrations/0077_customer_contacts.sql", "utf8");
    expect(migration).not.toMatch(/grant[^;]*delete/i);
    expect(migration).toMatch(/No DELETE/);
  });

  it("legacy embedded contact columns are untouched by the migration", () => {
    const migration = readFileSync("supabase/migrations/0077_customer_contacts.sql", "utf8");
    expect(migration).not.toMatch(/alter table public\.customer\b/);
    expect(migration).not.toMatch(/update public\.customer\b/);
  });
});

describe("H19 — copy integrity", () => {
  it("crm.* and customer filter keys exist in both languages, clean", () => {
    const keys = Object.keys(EN).filter(
      (k) => k.startsWith("crm.") || k === "filters.customer" || k === "filters.customer_generic",
    );
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      expect(AR[k], `ar missing ${k}`).toBeTruthy();
      expect(EN[k], k).not.toContain("—");
      expect(AR[k], k).not.toContain("—");
      expect(EN[k], k).not.toMatch(/cap\.[a-z_]|_v1|customer_id|uuid/);
      // No construction-specific customer language (villa/site/boat...).
      expect(EN[k], k).not.toMatch(/villa|site|boat|construction|contractor/i);
    }
  });
});
