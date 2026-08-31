/**
 * H22.0 Part F — visual verification.
 *
 * Renders the nine required cases straight from the canonical model, so what is
 * inspected is the same code path the app serves. No database and no server:
 * only the renderer and the PDF engine are under test here.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDocument, type DocumentRenderModel } from "@/platform/documents/render";
import { renderPdf, embeddedDocumentFonts, closePdfBrowser } from "@/platform/documents/pdf";
import type { DocumentShellIssuer } from "@/platform/documents/shell";

const OUT = process.argv[2] ?? "";
if (!OUT) {
  console.error("usage: tsx tooling/scripts/document-samples.ts <output-directory>");
  process.exit(1);
}

const ISSUER: DocumentShellIssuer = {
  tradingName: "Gulf Marine Works",
  legalName: "Gulf Marine Works Marine Services L.L.C.",
  trn: "100234567800003",
  licenseNo: "CN-1180422",
  addressLineEn: "Warehouse 14, Al Quoz Industrial 3, Dubai, United Arab Emirates",
  addressLineAr: "مستودع 14، القوز الصناعية 3، دبي، الإمارات العربية المتحدة",
  phone: "+971 4 338 1200",
  email: "accounts@gulfmarineworks.ae",
  website: "www.gulfmarineworks.ae",
  footer: "Gulf Marine Works Marine Services L.L.C. · Dubai, United Arab Emirates",
  signatoryName: "Rashid Al Marzooqi",
  signatoryTitle: "Operations Director",
  paymentInstructions:
    "Emirates NBD, Al Quoz Branch. IBAN AE07 0331 2345 6789 0123 456. Payment due 30 days from the invoice date.",
  logoDataUri: null,
};

/** An issuer with every optional field absent, for the fallback case. */
const BARE_ISSUER: DocumentShellIssuer = {
  tradingName: "Nadeen Trading",
  legalName: "Nadeen Trading",
  trn: null,
  licenseNo: null,
  addressLineEn: null,
  addressLineAr: null,
  phone: null,
  email: null,
  website: null,
  footer: null,
  signatoryName: null,
  signatoryTitle: null,
  paymentInstructions: null,
  logoDataUri: null,
};

function quote(language: "en" | "ar"): DocumentRenderModel {
  const ar = language === "ar";
  return {
    kind: "quote",
    language,
    issuer: ISSUER,
    recipient: {
      name: ar ? "شركة الخليج للقوارب" : "Gulf Boats Trading L.L.C.",
      lines: [ar ? "دبي، الإمارات العربية المتحدة" : "Dubai, United Arab Emirates"],
      trn: "100987654300003",
    },
    titleEn: "Quotation",
    titleAr: "عرض سعر",
    reference: "QT-2026-0148",
    dateText: ar ? "٣١ أغسطس ٢٠٢٦" : "31 August 2026",
    statusText: ar ? "مرسل" : "Sent",
    watermark: null,
    fields: [
      {
        label: ar ? "صالح حتى" : "Valid until",
        value: ar ? "٣٠ سبتمبر ٢٠٢٦" : "30 September 2026",
      },
      { label: ar ? "رقم الفرصة" : "Opportunity", value: "OPP-2026-0091", ltr: true },
    ],
    sections: [
      {
        columns: ar
          ? ["#", "الوصف", "الكمية", "الوحدة", "سعر الوحدة", "المبلغ"]
          : ["#", "Description", "Qty", "Unit", "Unit price", "Amount"],
        lines: [
          {
            position: "1",
            description: ar ? "تجديد هيكل قارب 32 قدم" : "Hull refit, 32 ft vessel",
            detail: ar ? "كشط كامل وطبقتان من الجل كوت" : "Full strip and two-coat gelcoat",
            quantity: "1",
            unit: ar ? "عدد" : "job",
            unitPrice: "AED 48,500.00",
            amount: "AED 48,500.00",
          },
          {
            position: "2",
            description: ar ? "خدمة المحرك الخارجي" : "Outboard engine service",
            detail: null,
            quantity: "2",
            unit: ar ? "وحدة" : "unit",
            unitPrice: "AED 3,250.00",
            amount: "AED 6,500.00",
          },
          {
            position: "3",
            description: ar ? "استبدال أجهزة سطح السفينة" : "Deck hardware replacement",
            detail: ar ? "فولاذ مقاوم للصدأ 316" : "316 stainless steel throughout",
            quantity: "1",
            unit: ar ? "طقم" : "set",
            unitPrice: "AED 12,750.00",
            amount: "AED 12,750.00",
          },
        ],
      },
    ],
    totals: [
      { label: ar ? "المجموع الفرعي" : "Subtotal", value: "AED 67,750.00" },
      { label: ar ? "ضريبة القيمة المضافة 5%" : "VAT 5%", value: "AED 3,387.50" },
      { label: ar ? "الإجمالي" : "Total", value: "AED 71,137.50", strong: true },
    ],
    termsTitle: ar ? "الشروط" : "Terms",
    terms: ar
      ? "الأسعار سارية لمدة 30 يوماً. يبدأ العمل بعد استلام أمر الشراء."
      : "Prices hold for 30 days. Work begins on receipt of a purchase order.",
    attribution: [
      { label: ar ? "أعده" : "Prepared by", value: "Layla Haddad" },
      { label: ar ? "اعتمده" : "Approved by", value: "Rashid Al Marzooqi" },
    ],
    showSignatory: true,
  };
}

function invoice(language: "en" | "ar"): DocumentRenderModel {
  const ar = language === "ar";
  return {
    ...quote(language),
    kind: "invoice",
    titleEn: "Tax invoice",
    titleAr: "فاتورة ضريبية",
    reference: "INV-2026-0311",
    statusText: ar ? "صادرة" : "Issued",
    fields: [
      {
        label: ar ? "تاريخ الاستحقاق" : "Due date",
        value: ar ? "٣٠ سبتمبر ٢٠٢٦" : "30 September 2026",
      },
      { label: ar ? "عرض السعر" : "Quotation", value: "QT-2026-0148", ltr: true },
    ],
    showPaymentInstructions: true,
  };
}

function weekPlan(language: "en" | "ar"): DocumentRenderModel {
  const ar = language === "ar";
  const cols = ar ? ["#", "المهمة", "المسؤول", "الحالة"] : ["#", "Task", "Owner", "State"];
  return {
    kind: "week_plan",
    language,
    issuer: ISSUER,
    recipient: null,
    titleEn: "Weekly work plan",
    titleAr: "خطة العمل الأسبوعية",
    reference: "WP-2026-W36",
    dateText: ar ? "٣١ أغسطس ٢٠٢٦" : "31 August 2026",
    statusText: ar ? "صادرة" : "Issued",
    fields: [
      {
        label: ar ? "الأسبوع" : "Week",
        value: ar ? "٣١ أغسطس – ٦ سبتمبر ٢٠٢٦" : "31 August to 6 September 2026",
      },
      { label: ar ? "المدير المسؤول" : "Responsible manager", value: "Rashid Al Marzooqi" },
    ],
    sections: [
      {
        title: ar ? "JOB-0142 · تجديد هيكل قارب 32 قدم" : "JOB-0142 · Hull refit, 32 ft vessel",
        columns: cols,
        lines: [
          {
            position: "1",
            description: ar ? "كشط الجل كوت القديم" : "Strip old gelcoat",
            quantity: null,
            unit: null,
            detail: ar ? "يستحق ٢ سبتمبر" : "Due 2 September",
            state: ar ? "قيد التنفيذ" : "In progress",
          },
          {
            position: "2",
            description: ar ? "إصلاح الشقوق في المقدمة" : "Repair bow cracks",
            detail: ar ? "معطل: بانتظار المواد" : "Blocked: waiting on materials",
            state: ar ? "معطل" : "Blocked",
          },
        ],
      },
      {
        title: ar ? "JOB-0147 · خدمة المحرك الخارجي" : "JOB-0147 · Outboard engine service",
        columns: cols,
        lines: [
          {
            position: "1",
            description: ar ? "فحص المحرك الأول" : "Service first engine",
            detail: ar ? "يستحق ٣ سبتمبر" : "Due 3 September",
            state: ar ? "مخطط" : "Planned",
          },
        ],
      },
    ],
    notesTitle: ar ? "ملاحظات" : "Notes",
    notes: ar
      ? "الأولوية لقارب JOB-0142 قبل تسليم يوم الأحد."
      : "JOB-0142 takes priority ahead of the Sunday handover.",
    attribution: [{ label: ar ? "أصدره" : "Issued by", value: "Rashid Al Marzooqi" }],
    showSignatory: true,
  };
}

/** 60 lines, to prove page breaks, repeated headers and page numbering. */
function longQuote(): DocumentRenderModel {
  const base = quote("en");
  return {
    ...base,
    reference: "QT-2026-0149",
    sections: [
      {
        columns: base.sections[0]!.columns,
        lines: Array.from({ length: 60 }, (_, i) => ({
          position: String(i + 1),
          description: `Line item ${i + 1}: replacement fitting, marine grade`,
          detail: i % 3 === 0 ? "316 stainless steel, polished finish" : null,
          quantity: String((i % 5) + 1),
          unit: "unit",
          unitPrice: "AED 1,250.00",
          amount: `AED ${(((i % 5) + 1) * 1250).toLocaleString("en-US")}.00`,
        })),
      },
    ],
  };
}

/** Every optional field absent: no logo, no TRN, no address, no terms. */
function minimalQuote(): DocumentRenderModel {
  return {
    kind: "quote",
    language: "en",
    issuer: BARE_ISSUER,
    recipient: null,
    titleEn: "Quotation",
    titleAr: "عرض سعر",
    reference: "QT-0001",
    watermark: "draft",
    sections: [
      {
        columns: ["#", "Description", "Qty", "Unit", "Unit price", "Amount"],
        lines: [
          {
            position: "1",
            description: "Consulting",
            quantity: "1",
            unit: "day",
            unitPrice: "AED 1,500.00",
            amount: "AED 1,500.00",
          },
        ],
      },
    ],
    totals: [{ label: "Total", value: "AED 1,500.00", strong: true }],
  };
}

/** Long names, long addresses, long descriptions: nothing may overflow. */
function longNames(): DocumentRenderModel {
  const base = quote("en");
  return {
    ...base,
    reference: "QT-2026-0150-REVISION-3",
    issuer: {
      ...ISSUER,
      tradingName: "Gulf Marine Works and Offshore Fabrication Services",
      legalName:
        "Gulf Marine Works Marine Services and Offshore Fabrication Contracting Limited Liability Company",
      addressLineEn:
        "Warehouse 14 and 15, Plot 598-1042, Al Quoz Industrial Area Three, Near Al Khail Road Interchange 4, Dubai, United Arab Emirates",
    },
    recipient: {
      name: "Arabian Peninsula Marine Transport and Logistics Holding Company L.L.C.",
      lines: [
        "Office 2204, Twenty Second Floor, Marina Plaza Tower, Dubai Marina, Dubai, United Arab Emirates",
      ],
      trn: "100987654300003",
    },
    sections: [
      {
        columns: base.sections[0]!.columns,
        lines: [
          {
            position: "1",
            description:
              "Complete hull refurbishment including full gelcoat strip, osmosis treatment, epoxy barrier coat application and antifouling for a thirty two foot fibreglass vessel",
            detail:
              "Includes haul-out, pressure wash, moisture readings taken at seven-day intervals, and re-launch with sea trial",
            quantity: "1",
            unit: "job",
            unitPrice: "AED 148,500.00",
            amount: "AED 148,500.00",
          },
        ],
      },
    ],
  };
}

const CASES: Array<[string, DocumentRenderModel]> = [
  ["quote-en", quote("en")],
  ["quote-ar", quote("ar")],
  ["invoice-en", invoice("en")],
  ["invoice-ar", invoice("ar")],
  ["week-plan-en", weekPlan("en")],
  ["week-plan-ar", weekPlan("ar")],
  ["long-multipage", longQuote()],
  ["minimal-fields", minimalQuote()],
  ["long-names", longNames()],
];

async function main() {
  const fonts = await embeddedDocumentFonts();
  for (const [name, model] of CASES) {
    const html = renderDocument(model, { delivery: "embed", embedded: fonts });
    writeFileSync(join(OUT, `${name}.html`), html, "utf8");
    const pdf = await renderPdf(html, {
      pageNumbers: true,
      rtl: model.language !== "en",
    });
    writeFileSync(join(OUT, `${name}.pdf`), pdf);
    console.log(`${name}: html ${html.length} bytes, pdf ${pdf.length} bytes`);
  }
  await closePdfBrowser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
