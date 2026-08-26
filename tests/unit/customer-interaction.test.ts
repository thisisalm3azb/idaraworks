/**
 * 003C — the reusable interaction primitives + customer surfaces (SSR render):
 * Dialog accessibility wiring, RelationshipField permission gating and
 * structure, lifecycle confirmation content, edit-form pre-population, quote
 * form state design, and RTL/physical-class safety. Behavioral flows (open/
 * submit/select) live in the integration + e2e layers — these tests pin the
 * accessible structure and the permission-driven rendering.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));

import { Dialog, RelationshipField } from "@/platform/ui";
import { CustomerLifecycle } from "@/app/(app)/o/[orgId]/customers/[customerId]/CustomerLifecycle";
import { CustomerEditForm } from "@/app/(app)/o/[orgId]/customers/[customerId]/edit/CustomerEditForm";
import { QuoteForm } from "@/app/(app)/o/[orgId]/quotes/new/QuoteForm";

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right)|origin-(left|right))\b/;

const noop = async () => ({ ok: false as const, error: "failed" });

const REL_LABELS = {
  addNew: "إضافة عميل جديد",
  dialogTitle: "عميل جديد",
  dialogDescription: "يُنشأ هنا ويُختار لهذا النموذج.",
  create: "Add",
  cancel: "Cancel",
  close: "Close",
  created: "{name} was created and selected.",
  similar: "A record named {name} already exists.",
  useExisting: "Use the existing one",
  reference: "Reference:",
  errors: { failed: "Failed" },
};

describe("Dialog — accessible structure", () => {
  const html = renderToStaticMarkup(
    h(Dialog, {
      open: true,
      onClose: () => {},
      title: "Archive العميل؟",
      description: "الأرشفة قابلة للتراجع.",
      tone: "danger",
      closeLabel: "إغلاق",
      children: h("p", null, "content"),
    }),
  );

  it("labels itself via aria-labelledby/-describedby and offers a named close control", () => {
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)![1]!;
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain('aria-label="إغلاق"');
    expect(html).toContain("Archive العميل؟");
  });

  it("danger tone styles the title; content renders as children; no physical classes", () => {
    expect(html).toContain("text-danger");
    expect(html).toContain("content");
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), classes).toBe(false);
  });
});

describe("RelationshipField — permission-driven structure", () => {
  const base = {
    label: "العميل",
    name: "customer_id",
    options: [
      { id: "c1", label: "Gulf Marine" },
      { id: "c2", label: "Alpha Trading" },
    ],
    placeholder: "—",
    createFields: [{ name: "name", label: "Name", required: true }],
    labels: REL_LABELS,
    createAction: noop,
  };

  it("renders the labelled select with all ACTIVE options and a polite status region", () => {
    const html = renderToStaticMarkup(h(RelationshipField, { ...base, canCreate: true }));
    expect(html).toContain('name="customer_id"');
    expect(html).toContain("Gulf Marine");
    expect(html).toContain("Alpha Trading");
    expect(html).toMatch(/<label[^>]*for="customer_id-select"/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("إضافة عميل جديد");
  });

  it("hides the add affordance entirely without customers.manage", () => {
    const html = renderToStaticMarkup(h(RelationshipField, { ...base, canCreate: false }));
    expect(html).not.toContain("إضافة عميل جديد");
    expect(html).toContain("Gulf Marine"); // selection still fully works
  });

  it("honors a default selection and stays RTL-safe", () => {
    const html = renderToStaticMarkup(
      h(RelationshipField, { ...base, canCreate: true, defaultValue: "c2" }),
    );
    expect(html).toMatch(/<option[^>]*selected[^>]*value="c2"|<option[^>]*value="c2"[^>]*selected/);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), classes).toBe(false);
  });
});

describe("CustomerLifecycle — the confirmation explains impact BEFORE acting", () => {
  const dict = {
    archive: "أرشفة العميل",
    reactivate: "إعادة تفعيل العميل",
    confirm_title: "أرشفة Gulf Marine؟",
    confirm_body: "الأرشفة إجراء قابل للتراجع — لا يُحذف أي شيء.",
    impact_selectors: "يختفي من الاختيارات الجديدة.",
    impact_history: "تبقى السجلات كما هي.",
    impact_reversible: "يمكنك إعادة التفعيل في أي وقت.",
    confirm: "أرشفة",
    cancel: "إلغاء",
    close: "إغلاق",
    failed: "فشل",
  };
  const action = async () => ({ ok: true });

  it("active → archive button + a dialog carrying all three impact statements", () => {
    const html = renderToStaticMarkup(h(CustomerLifecycle, { active: true, dict, action }));
    expect(html).toContain("أرشفة العميل");
    expect(html).toContain("يختفي من الاختيارات الجديدة.");
    expect(html).toContain("تبقى السجلات كما هي.");
    expect(html).toContain("يمكنك إعادة التفعيل في أي وقت.");
    expect(html).not.toContain("إعادة تفعيل العميل");
  });

  it("archived → a single explicit reactivate action, no confirm ceremony", () => {
    const html = renderToStaticMarkup(h(CustomerLifecycle, { active: false, dict, action }));
    expect(html).toContain("إعادة تفعيل العميل");
    expect(html).not.toContain("أرشفة العميل");
  });
});

describe("CustomerEditForm — pre-populated, URL-free, cancellable", () => {
  const html = renderToStaticMarkup(
    h(CustomerEditForm, {
      initial: {
        name: "Gulf Marine LLC",
        contactName: "Salem",
        country: "AE",
        phone: "+971 50 000 0000",
        email: "salem@gulf.example",
        taxRegNo: "100123456700003",
        notes: "VIP",
      },
      cancelHref: "/o/x/customers/c1",
      saveAction: noop,
      dict: {
        name: "Name",
        contact_name: "Contact",
        country: "Country",
        phone: "Phone",
        email: "Email",
        tax_no: "TRN",
        notes: "Notes",
        save: "Save",
        cancel: "Cancel",
        saved: "Saved",
        reference: "Reference:",
        errors: { server_error: "Something went wrong." },
      },
    }),
  );

  it("every editable field arrives pre-populated", () => {
    for (const v of [
      "Gulf Marine LLC",
      "Salem",
      "AE",
      "+971 50 000 0000",
      "salem@gulf.example",
      "100123456700003",
      "VIP",
    ]) {
      expect(html).toContain(`value="${v}"`);
    }
  });

  it("posts through a function action — sensitive values never enter a URL", () => {
    expect(html).not.toMatch(/method="get"/i);
    expect(html).not.toMatch(/action="[^"]*(email|phone|tax)[^"]*"/i);
    expect(html).toContain("Cancel");
  });
});

describe("QuoteForm — state-preserving structure with inline customer create", () => {
  const html = renderToStaticMarkup(
    h(QuoteForm, {
      orgId: "org1",
      customers: [{ id: "c1", label: "Gulf Marine" }],
      presets: [{ id: "p1", name: "Skiff 18" }],
      defaultCustomerId: "c1",
      canCreateCustomer: true,
      createAction: noop,
      submitAction: async () => ({ ok: false as const, error: "failed" }),
      relationshipLabels: REL_LABELS,
      dict: {
        customer: "العميل",
        customer_placeholder: "—",
        preset: "Preset",
        description: "الوصف",
        qty: "الكمية",
        unit: "الوحدة",
        vat: "VAT",
        unit_price: "سعر الوحدة",
        terms: "الشروط",
        submit: "إنشاء",
        contact_name: "جهة الاتصال",
        phone: "الهاتف",
        errors: { failed: "فشل" },
      },
    }),
  );

  it("keeps the single-line semantics and embeds the relationship field + add-new", () => {
    expect(html).toContain('name="description"');
    expect(html).toContain('name="qty"');
    expect(html).toContain('name="unit_price"');
    expect(html).toContain('name="terms"');
    expect(html).toContain('name="preset_id"');
    expect(html).toContain('name="customer_id"');
    expect(html).toContain("إضافة عميل جديد");
    expect(html).toContain("Skiff 18");
  });

  it("numeric inputs are LTR islands; no physical-direction classes", () => {
    expect(html).toMatch(/name="qty"[^>]*dir="ltr"|dir="ltr"[^>]*name="qty"/);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), classes).toBe(false);
  });
});
