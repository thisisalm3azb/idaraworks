/**
 * H26 — the governed template library (ADR-19, slice 3).
 *
 * Built-in templates ship in code (bilingual, real clauses, real fields).
 * Organisation templates live in `doc_template` with immutable published
 * versions in `doc_template_version`; a document pins the version it was
 * created from, so publishing a new version never rewrites an existing
 * document.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import {
  DEFAULT_SETTINGS,
  DOC_CATEGORIES,
  DocBody,
  DocError,
  DocSettings,
  type LeafBlock,
  type DocCategory,
  type DocLanguage,
} from "./types";

export type BuiltInTemplate = {
  key: string;
  nameEn: string;
  nameAr: string;
  category: DocCategory;
  description: string;
  language: DocLanguage;
  body: DocBody;
  settings: DocSettings;
};

const t = (en: string, ar: string) => ({ en, ar });
const heading = (id: string, level: 1 | 2 | 3, en: string, ar: string): LeafBlock => ({
  id,
  type: "heading",
  level,
  text: t(en, ar),
});
const para = (id: string, en: string, ar: string): LeafBlock => ({
  id,
  type: "paragraph",
  text: t(en, ar),
});
const clause = (
  id: string,
  titleEn: string,
  titleAr: string,
  en: string,
  ar: string,
): LeafBlock => ({
  id,
  type: "clause",
  title: t(titleEn, titleAr),
  text: t(en, ar),
});
const sig = (id: string, party: string, en: string, ar: string): LeafBlock => ({
  id,
  type: "signature",
  party,
  label: t(en, ar),
  parts: ["signature", "name", "title", "date"],
});

const PARTIES_INTRO = para(
  "parties",
  'This agreement is made between **{{issuer.legal_name}}** (TRN {{issuer.trn}}), of {{issuer.address}} (the "Company"), and **{{counterparty.name}}** (the "Counterparty"), effective {{document.effective_from}}.',
  'أُبرمت هذه الاتفاقية بين **{{issuer.legal_name}}** (الرقم الضريبي {{issuer.trn}})، وعنوانها {{issuer.address}} ("الشركة")، و**{{counterparty.name}}** ("الطرف الآخر")، وتسري اعتباراً من {{document.effective_from}}.',
);

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    key: "builtin.nda",
    nameEn: "Mutual non-disclosure agreement",
    nameAr: "اتفاقية عدم إفصاح متبادلة",
    category: "contract",
    description:
      "Protects confidential information exchanged between two parties for a fixed term.",
    language: "bilingual",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        heading("title", 1, "Mutual non-disclosure agreement", "اتفاقية عدم إفصاح متبادلة"),
        PARTIES_INTRO,
        clause(
          "c1",
          "Purpose",
          "الغرض",
          'The parties wish to exchange confidential information to evaluate a possible business relationship (the "Purpose").',
          'يرغب الطرفان في تبادل معلومات سرية لتقييم علاقة عمل محتملة ("الغرض").',
        ),
        clause(
          "c2",
          "Confidential information",
          "المعلومات السرية",
          "Confidential information means any non-public information disclosed by either party, in any form, that is marked confidential or would reasonably be understood to be confidential.",
          "تعني المعلومات السرية أي معلومات غير عامة يفصح عنها أي من الطرفين بأي شكل، مُعلَّمة بأنها سرية أو يُفهم بشكل معقول أنها سرية.",
        ),
        clause(
          "c3",
          "Obligations",
          "الالتزامات",
          "Each party shall use the other party's confidential information only for the Purpose, protect it with at least reasonable care, and disclose it only to personnel who need to know and are bound by written confidentiality obligations.",
          "يلتزم كل طرف باستخدام المعلومات السرية للطرف الآخر للغرض فقط، وحمايتها بعناية معقولة على الأقل، وعدم الإفصاح عنها إلا للموظفين الذين يحتاجون إليها والملتزمين كتابياً بالسرية.",
        ),
        clause(
          "c4",
          "Exclusions",
          "الاستثناءات",
          "These obligations do not apply to information that is or becomes public through no fault of the receiving party, was lawfully known before disclosure, is independently developed, or must be disclosed by law after prompt notice.",
          "لا تسري هذه الالتزامات على المعلومات التي تصبح عامة دون خطأ من الطرف المتلقي، أو كانت معروفة قانونياً قبل الإفصاح، أو طُوِّرت بشكل مستقل، أو يجب الإفصاح عنها بموجب القانون بعد إشعار فوري.",
        ),
        {
          id: "term_field",
          type: "field",
          key: "term_years",
          kind: "number",
          label: t("Term (years)", "المدة (بالسنوات)"),
          required: true,
          min: 1,
          max: 10,
          filledBy: "author",
        },
        clause(
          "c5",
          "Term",
          "المدة",
          "This agreement runs for {{term_years}} years from the effective date. The confidentiality obligations survive for three years after it ends.",
          "تسري هذه الاتفاقية لمدة {{term_years}} سنوات من تاريخ السريان. وتستمر التزامات السرية لمدة ثلاث سنوات بعد انتهائها.",
        ),
        clause(
          "c6",
          "Governing law",
          "القانون الواجب التطبيق",
          "This agreement is governed by the laws applicable at the Company's registered address. Disputes are referred to the competent courts of that jurisdiction.",
          "تخضع هذه الاتفاقية للقوانين السارية في العنوان المسجل للشركة، وتُحال النزاعات إلى المحاكم المختصة في تلك الولاية.",
        ),
        sig("sig_company", "company", "For the Company", "عن الشركة"),
        sig("sig_counterparty", "counterparty", "For the Counterparty", "عن الطرف الآخر"),
      ],
    },
  },
  {
    key: "builtin.service_agreement",
    nameEn: "Service agreement",
    nameAr: "اتفاقية خدمات",
    category: "agreement",
    description: "Scope, priced line items, payment terms and signatures for a service engagement.",
    language: "bilingual",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        heading("title", 1, "Service agreement", "اتفاقية خدمات"),
        PARTIES_INTRO,
        clause(
          "c1",
          "Scope",
          "النطاق",
          "The Company will provide the services described in the schedule below. Changes to scope are agreed in writing before work starts.",
          "تقدم الشركة الخدمات الموضحة في الجدول أدناه. ويُتفق على أي تغيير في النطاق كتابياً قبل بدء العمل.",
        ),
        heading("h_schedule", 2, "Schedule of services and fees", "جدول الخدمات والرسوم"),
        {
          id: "lines",
          type: "line_items",
          source: "manual",
          currency: "AED",
          items: [
            {
              description: t("Service as scoped", "الخدمة حسب النطاق"),
              qty: 1,
              unit: "lot",
              unitPriceMinor: 0,
              vatRate: 5,
            },
          ],
          showVat: true,
          showTotals: true,
        },
        {
          id: "payment_days",
          type: "field",
          key: "payment_days",
          kind: "number",
          label: t("Payment terms (days from invoice)", "شروط الدفع (أيام من تاريخ الفاتورة)"),
          required: true,
          min: 0,
          max: 120,
          filledBy: "author",
        },
        clause(
          "c2",
          "Payment",
          "الدفع",
          "Invoices are payable within {{payment_days}} days of the invoice date. Late amounts may be suspended from service until settled.",
          "تُدفع الفواتير خلال {{payment_days}} يوماً من تاريخ الفاتورة. ويجوز تعليق الخدمة عن المبالغ المتأخرة حتى سدادها.",
        ),
        {
          id: "deposit_section",
          type: "section",
          title: t("Deposit", "الدفعة المقدمة"),
          condition: { key: "document.amount", op: "gte", value: 50000 },
          blocks: [
            para(
              "deposit_p",
              "Because the total exceeds AED 50,000, a deposit of 30% is due before work starts and is credited against the final invoice.",
              "نظراً لتجاوز الإجمالي 50,000 درهم، تُستحق دفعة مقدمة بنسبة 30% قبل بدء العمل وتُخصم من الفاتورة النهائية.",
            ),
          ],
        },
        clause(
          "c3",
          "Warranties",
          "الضمانات",
          "The Company performs the services with reasonable skill and care. Liability under this agreement is limited to the fees paid for the services giving rise to the claim.",
          "تؤدي الشركة الخدمات بمهارة وعناية معقولتين. وتقتصر المسؤولية بموجب هذه الاتفاقية على الرسوم المدفوعة عن الخدمات محل المطالبة.",
        ),
        clause(
          "c4",
          "Termination",
          "الإنهاء",
          "Either party may terminate on 30 days' written notice. Work completed to the termination date is invoiced and payable.",
          "يجوز لأي من الطرفين الإنهاء بإشعار كتابي مدته 30 يوماً. ويُفوتَر العمل المنجز حتى تاريخ الإنهاء ويُستحق دفعه.",
        ),
        sig("sig_company", "company", "For the Company", "عن الشركة"),
        sig("sig_counterparty", "counterparty", "For the Client", "عن العميل"),
      ],
    },
  },
  {
    key: "builtin.offer_letter",
    nameEn: "Employment offer letter",
    nameAr: "خطاب عرض عمل",
    category: "letter",
    description:
      "An offer to a candidate or employee with position, start date and acceptance signature.",
    language: "bilingual",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        heading("title", 1, "Offer of employment", "عرض عمل"),
        para(
          "intro",
          "Dear {{counterparty.name}},\n\nWe are pleased to offer you employment with {{issuer.legal_name}} on the terms below.",
          "عزيزي/عزيزتي {{counterparty.name}}،\n\nيسرنا أن نقدم لك عرض عمل لدى {{issuer.legal_name}} وفق الشروط أدناه.",
        ),
        {
          id: "position",
          type: "field",
          key: "position",
          kind: "text",
          label: t("Position", "المسمى الوظيفي"),
          required: true,
          filledBy: "author",
        },
        {
          id: "start_date",
          type: "field",
          key: "start_date",
          kind: "date",
          label: t("Start date", "تاريخ المباشرة"),
          required: true,
          filledBy: "author",
        },
        {
          id: "probation",
          type: "field",
          key: "probation_months",
          kind: "number",
          label: t("Probation (months)", "فترة التجربة (أشهر)"),
          required: true,
          min: 0,
          max: 6,
          filledBy: "author",
        },
        para(
          "terms",
          "Your position will be **{{position}}**, starting on {{start_date}}, with a probation period of {{probation_months}} months. Detailed terms, including remuneration, are set out in your employment contract.",
          "سيكون مسماك الوظيفي **{{position}}** اعتباراً من {{start_date}}، مع فترة تجربة مدتها {{probation_months}} أشهر. وترد الشروط التفصيلية، بما فيها الأجر، في عقد العمل.",
        ),
        {
          id: "accept_by",
          type: "field",
          key: "accept_by",
          kind: "date",
          label: t("Please accept by", "يرجى القبول قبل"),
          required: false,
          filledBy: "author",
        },
        para(
          "close",
          "Please sign below to accept this offer. We look forward to working with you.",
          "يرجى التوقيع أدناه لقبول هذا العرض. نتطلع إلى العمل معك.",
        ),
        sig("sig_company", "company", "For the Company", "عن الشركة"),
        sig("sig_employee", "employee", "Accepted by", "قبول"),
      ],
    },
  },
  {
    key: "builtin.cover_letter",
    nameEn: "Letter on letterhead",
    nameAr: "خطاب على ورق رسمي",
    category: "letter",
    description: "A branded letter with a recipient block and free text.",
    language: "en",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        {
          id: "recipient",
          type: "field",
          key: "recipient",
          kind: "text",
          label: t("To", "إلى"),
          required: true,
          filledBy: "author",
        },
        {
          id: "subject",
          type: "field",
          key: "subject",
          kind: "text",
          label: t("Subject", "الموضوع"),
          required: true,
          filledBy: "author",
        },
        para(
          "body1",
          "Dear {{recipient}},\n\nRe: {{subject}}\n\n",
          "السادة {{recipient}}،\n\nالموضوع: {{subject}}\n\n",
        ),
        para("body2", "Write the letter here.", "اكتب نص الخطاب هنا."),
        para(
          "close",
          "Yours sincerely,\n\n{{issuer.signatory_name}}\n{{issuer.signatory_title}}\n{{issuer.legal_name}}",
          "وتفضلوا بقبول فائق الاحترام،\n\n{{issuer.signatory_name}}\n{{issuer.signatory_title}}\n{{issuer.legal_name}}",
        ),
      ],
    },
  },
  {
    key: "builtin.intake_form",
    nameEn: "Customer intake form",
    nameAr: "نموذج بيانات عميل",
    category: "form",
    description:
      "Collects the details needed to open a customer account; convertible to a customer record after review.",
    language: "bilingual",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        heading("title", 1, "Customer intake form", "نموذج بيانات عميل"),
        {
          id: "note",
          type: "note",
          tone: "info",
          text: t(
            "Your answers are reviewed by our team before an account is opened.",
            "تُراجع إجاباتك من قبل فريقنا قبل فتح الحساب.",
          ),
        },
        {
          id: "company_name",
          type: "field",
          key: "company_name",
          kind: "text",
          label: t("Company or full name", "اسم الشركة أو الاسم الكامل"),
          required: true,
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "contact_name",
          type: "field",
          key: "contact_name",
          kind: "text",
          label: t("Contact person", "الشخص المسؤول"),
          required: false,
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "email",
          type: "field",
          key: "email",
          kind: "email",
          label: t("Email", "البريد الإلكتروني"),
          required: true,
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "phone",
          type: "field",
          key: "phone",
          kind: "phone",
          label: t("Phone", "الهاتف"),
          required: true,
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "trn",
          type: "field",
          key: "trn",
          kind: "text",
          label: t("Tax registration number", "رقم التسجيل الضريبي"),
          required: false,
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "customer_type",
          type: "field",
          key: "customer_type",
          kind: "choice",
          label: t("Type", "النوع"),
          required: true,
          options: [t("Business", "شركة"), t("Individual", "فرد")],
          filledBy: "party",
          party: "respondent",
        },
        {
          id: "business_details",
          type: "section",
          title: t("Business details", "بيانات الشركة"),
          condition: { key: "customer_type", op: "eq", value: 0 },
          blocks: [
            {
              id: "license_no",
              type: "field",
              key: "license_no",
              kind: "text",
              label: t("Trade licence number", "رقم الرخصة التجارية"),
              required: false,
              filledBy: "party",
              party: "respondent",
            },
          ],
        },
        {
          id: "consent",
          type: "field",
          key: "consent",
          kind: "checkbox",
          label: t(
            "I confirm the information above is accurate.",
            "أؤكد أن المعلومات أعلاه صحيحة.",
          ),
          required: true,
          filledBy: "party",
          party: "respondent",
        },
      ],
    },
  },
  {
    key: "builtin.supplier_agreement",
    nameEn: "Supplier framework agreement",
    nameAr: "اتفاقية إطارية مع مورد",
    category: "agreement",
    description:
      "Terms under which purchase orders are placed with a supplier, with volume commitments when the annual value is high.",
    language: "bilingual",
    settings: DEFAULT_SETTINGS,
    body: {
      blocks: [
        heading("title", 1, "Supplier framework agreement", "اتفاقية إطارية مع مورد"),
        PARTIES_INTRO,
        clause(
          "c1",
          "Orders",
          "الطلبات",
          "Purchase orders issued by the Company under this agreement are binding once acknowledged by the Counterparty within two working days.",
          "تكون أوامر الشراء الصادرة عن الشركة بموجب هذه الاتفاقية ملزمة بمجرد إقرار الطرف الآخر بها خلال يومي عمل.",
        ),
        {
          id: "annual_value",
          type: "field",
          key: "annual_value",
          kind: "money",
          currency: "AED",
          label: t("Estimated annual value", "القيمة السنوية التقديرية"),
          required: true,
          filledBy: "author",
        },
        {
          id: "discount",
          type: "field",
          key: "volume_discount",
          kind: "number",
          label: t("Volume discount (%)", "خصم الكمية (%)"),
          required: false,
          min: 0,
          max: 50,
          filledBy: "author",
        },
        {
          id: "volume_section",
          type: "section",
          title: t("Volume commitments", "التزامات الكمية"),
          condition: { key: "annual_value", op: "gte", value: 10000000 },
          blocks: [
            para(
              "vol_p",
              "Given the estimated annual value, the Counterparty grants a volume discount of {{volume_discount}}% on list prices and holds safety stock for the Company's standard items.",
              "نظراً للقيمة السنوية التقديرية، يمنح الطرف الآخر خصم كمية بنسبة {{volume_discount}}% على أسعار القائمة ويحتفظ بمخزون احتياطي لأصناف الشركة القياسية.",
            ),
          ],
        },
        clause(
          "c2",
          "Delivery and inspection",
          "التسليم والفحص",
          "Goods are delivered to the address on each order. The Company may reject non-conforming goods within seven days of delivery.",
          "تُسلَّم البضائع إلى العنوان المحدد في كل طلب. ويجوز للشركة رفض البضائع غير المطابقة خلال سبعة أيام من التسليم.",
        ),
        clause(
          "c3",
          "Term",
          "المدة",
          "This agreement runs from the effective date until {{document.expires_at}} unless terminated earlier on 60 days' written notice.",
          "تسري هذه الاتفاقية من تاريخ السريان حتى {{document.expires_at}} ما لم تُنهَ قبل ذلك بإشعار كتابي مدته 60 يوماً.",
        ),
        sig("sig_company", "company", "For the Company", "عن الشركة"),
        sig("sig_counterparty", "counterparty", "For the Supplier", "عن المورد"),
      ],
    },
  },
];

for (const tpl of BUILT_IN_TEMPLATES) DocBody.parse(tpl.body);

export type TemplateSummary = {
  id: string | null;
  key: string;
  nameEn: string;
  nameAr: string;
  category: DocCategory;
  description: string | null;
  builtIn: boolean;
  status: "draft" | "published" | "retired";
  currentVersion: number;
  language: DocLanguage;
  workflowId: string | null;
  updatedAt: string | null;
};

export async function listTemplates(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<TemplateSummary[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select t.id::text as id, t.key, t.name_en, t.name_ar, t.category, t.description, t.status,
             t.current_version, t.workflow_id::text as workflow_id, t.updated_at::text as updated_at,
             coalesce((select v.settings->>'language' from public.doc_template_version v
                       where v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version), 'en') as language
      from public.doc_template t
      where t.org_id = ${ctx.orgId} and t.status <> 'retired'
      order by t.name_en
    `),
  )) as unknown as Array<Record<string, unknown>>;
  const org: TemplateSummary[] = rows.map((r) => ({
    id: r.id as string,
    key: r.key as string,
    nameEn: r.name_en as string,
    nameAr: r.name_ar as string,
    category: r.category as DocCategory,
    description: (r.description as string | null) ?? null,
    builtIn: false,
    status: r.status as TemplateSummary["status"],
    currentVersion: Number(r.current_version),
    language: ((r.language as string) || "en") as DocLanguage,
    workflowId: (r.workflow_id as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
  }));
  const builtIns: TemplateSummary[] = BUILT_IN_TEMPLATES.map((b) => ({
    id: null,
    key: b.key,
    nameEn: b.nameEn,
    nameAr: b.nameAr,
    category: b.category,
    description: b.description,
    builtIn: true,
    status: "published",
    currentVersion: 1,
    language: b.language,
    workflowId: null,
    updatedAt: null,
  }));
  return [...builtIns, ...org];
}

export type TemplateDetail = TemplateSummary & {
  versions: Array<{
    id: string;
    version: number;
    publishedAt: string | null;
    changeNote: string | null;
    createdAt: string;
    body: DocBody;
    settings: DocSettings & { language?: DocLanguage };
  }>;
};

export async function getTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  templateId: string,
): Promise<TemplateDetail> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select t.id::text as id, t.key, t.name_en, t.name_ar, t.category, t.description, t.status,
             t.current_version, t.workflow_id::text as workflow_id, t.updated_at::text as updated_at
      from public.doc_template t where t.id = ${templateId} and t.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) throw new DocError("template not found", "not_found");
    const vs = (await tx.execute(sql`
      select id::text as id, version, body, settings, change_note, published_at::text as published_at,
             created_at::text as created_at
      from public.doc_template_version where template_id = ${templateId} and org_id = ${ctx.orgId}
      order by version desc
    `)) as unknown as Array<Record<string, unknown>>;
    const versions = vs.map((v) => ({
      id: v.id as string,
      version: Number(v.version),
      publishedAt: (v.published_at as string | null) ?? null,
      changeNote: (v.change_note as string | null) ?? null,
      createdAt: v.created_at as string,
      body: DocBody.safeParse(v.body).data ?? { blocks: [] },
      settings: {
        ...(DocSettings.safeParse(v.settings).data ?? DEFAULT_SETTINGS),
        language: (v.settings as { language?: DocLanguage })?.language,
      },
    }));
    const current = versions.find((v) => v.version === Number(r.current_version));
    return {
      id: r.id as string,
      key: r.key as string,
      nameEn: r.name_en as string,
      nameAr: r.name_ar as string,
      category: r.category as DocCategory,
      description: (r.description as string | null) ?? null,
      builtIn: false,
      status: r.status as TemplateSummary["status"],
      currentVersion: Number(r.current_version),
      language: current?.settings.language ?? "en",
      workflowId: (r.workflow_id as string | null) ?? null,
      updatedAt: (r.updated_at as string | null) ?? null,
      versions,
    };
  });
}

/** The body a new document starts from (built-in, or the template's current published version). */
export async function templateBodyIn(
  tx: TenantTx,
  ctx: Ctx,
  ref: { templateId?: string; builtinKey?: string },
): Promise<{
  body: DocBody;
  settings: DocSettings;
  versionId: string | null;
  templateId: string | null;
  language: DocLanguage;
}> {
  if (ref.builtinKey) {
    const b = BUILT_IN_TEMPLATES.find((x) => x.key === ref.builtinKey);
    if (!b) throw new DocError("unknown built-in template", "not_found");
    return {
      body: b.body,
      settings: b.settings,
      versionId: null,
      templateId: null,
      language: b.language,
    };
  }
  const rows = (await tx.execute(sql`
    select v.id::text as id, v.body, v.settings, t.status
    from public.doc_template t
    join public.doc_template_version v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version
    where t.id = ${ref.templateId ?? null} and t.org_id = ${ctx.orgId}
  `)) as unknown as Array<{ id: string; body: unknown; settings: unknown; status: string }>;
  const r = rows[0];
  if (!r) throw new DocError("template has no published version", "state");
  if (r.status !== "published") throw new DocError("template is not published", "state");
  const { language: storedLanguage, ...settingsRaw } = (r.settings ?? {}) as Record<
    string,
    unknown
  >;
  return {
    body: DocBody.parse(r.body),
    settings: DocSettings.parse({ ...DEFAULT_SETTINGS, ...settingsRaw }),
    versionId: r.id,
    templateId: ref.templateId ?? null,
    language: ((storedLanguage as DocLanguage | undefined) ?? "en") as DocLanguage,
  };
}

export const CreateTemplateInput = z
  .object({
    key: z.string().regex(/^[a-z0-9_.-]{1,60}$/),
    nameEn: z.string().trim().min(1).max(160),
    nameAr: z.string().trim().min(1).max(160),
    category: z.enum(DOC_CATEGORIES),
    description: z.string().trim().max(2000).optional(),
    language: z.enum(["en", "ar", "bilingual"]).default("en"),
    /** Start from a built-in, from a document's latest content, or empty. */
    fromBuiltinKey: z
      .string()
      .regex(/^[a-z0-9_.-]{1,60}$/)
      .optional(),
    fromDocumentId: z.string().uuid().optional(),
    body: DocBody.optional(),
    settings: DocSettings.optional(),
    workflowId: z.string().uuid().nullable().optional(),
  })
  .strict();

export async function createTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; versionId: string }> {
  assertCan(archetype, "documents.templates.manage");
  const input = CreateTemplateInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "documents.template.create",
        entityType: "document_template",
        entityId: r.id,
        summary: `Created template "${input.nameEn}"`,
      }),
    },
    async (tx) => {
      let body: DocBody = input.body ?? { blocks: [] };
      let settings: DocSettings = input.settings ?? DEFAULT_SETTINGS;
      let builtin: string | null = null;
      if (input.fromBuiltinKey) {
        const b = await templateBodyIn(tx, ctx, { builtinKey: input.fromBuiltinKey });
        body = b.body;
        settings = b.settings;
        builtin = input.fromBuiltinKey;
      } else if (input.fromDocumentId) {
        const rows = (await tx.execute(sql`
          select r.body, r.settings from public.doc_revision r
          where r.document_id = ${input.fromDocumentId} and r.org_id = ${ctx.orgId}
          order by r.revision_no desc limit 1
        `)) as unknown as Array<{ body: unknown; settings: unknown }>;
        if (!rows[0]) throw new DocError("document not found", "not_found");
        body = DocBody.parse(rows[0].body);
        settings = DocSettings.parse(rows[0].settings ?? {});
      }
      const dup = (await tx.execute(sql`
        select 1 from public.doc_template where org_id = ${ctx.orgId} and key = ${input.key}
      `)) as unknown[];
      if (dup.length > 0) throw new DocError("a template with that key already exists", "conflict");
      const rows = (await tx.execute(sql`
        insert into public.doc_template (org_id, key, name_en, name_ar, category, description, builtin_key, workflow_id, created_by)
        values (${ctx.orgId}, ${input.key}, ${input.nameEn}, ${input.nameAr}, ${input.category},
                ${input.description ?? null}, ${builtin}, ${input.workflowId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      const v = (await tx.execute(sql`
        insert into public.doc_template_version (org_id, template_id, version, body, settings, created_by)
        values (${ctx.orgId}, ${id}, 1, ${JSON.stringify(body)}::jsonb,
                ${JSON.stringify({ ...settings, language: input.language })}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id, versionId: v[0]!.id };
    },
  );
}

export const UpdateTemplateInput = z
  .object({
    templateId: z.string().uuid(),
    expectedRowVersion: z.number().int().positive().optional(),
    nameEn: z.string().trim().min(1).max(160).optional(),
    nameAr: z.string().trim().min(1).max(160).optional(),
    category: z.enum(DOC_CATEGORIES).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    workflowId: z.string().uuid().nullable().optional(),
    language: z.enum(["en", "ar", "bilingual"]).optional(),
    /** Content goes to the unpublished draft version (created if the current one is published). */
    body: DocBody.optional(),
    settings: DocSettings.optional(),
  })
  .strict();

export async function updateTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ draftVersionId: string | null }> {
  assertCan(archetype, "documents.templates.manage");
  const input = UpdateTemplateInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.template.update",
        entityType: "document_template",
        entityId: input.templateId,
        summary: "Updated template",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, status, current_version, row_version from public.doc_template
        where id = ${input.templateId} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<{
        id: string;
        status: string;
        current_version: number;
        row_version: number;
      }>;
      const t = rows[0];
      if (!t) throw new DocError("template not found", "not_found");
      if (t.status === "retired") throw new DocError("template is retired", "state");
      if (
        input.expectedRowVersion !== undefined &&
        Number(t.row_version) !== input.expectedRowVersion
      )
        throw new DocError("template changed since you loaded it", "conflict");
      await tx.execute(sql`
        update public.doc_template set
          name_en = coalesce(${input.nameEn ?? null}, name_en),
          name_ar = coalesce(${input.nameAr ?? null}, name_ar),
          category = coalesce(${input.category ?? null}, category),
          description = case when ${input.description !== undefined} then ${input.description ?? null} else description end,
          workflow_id = case when ${input.workflowId !== undefined} then ${input.workflowId ?? null} else workflow_id end,
          row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${t.id} and org_id = ${ctx.orgId}
      `);
      let draftVersionId: string | null = null;
      if (input.body || input.settings || input.language) {
        const draft = (await tx.execute(sql`
          select id::text as id, version, body, settings from public.doc_template_version
          where template_id = ${t.id} and org_id = ${ctx.orgId} and published_at is null
          order by version desc limit 1
        `)) as unknown as Array<{ id: string; version: number; body: unknown; settings: unknown }>;
        const latest = (await tx.execute(sql`
          select version, body, settings from public.doc_template_version
          where template_id = ${t.id} and org_id = ${ctx.orgId} order by version desc limit 1
        `)) as unknown as Array<{ version: number; body: unknown; settings: unknown }>;
        const baseSettings = ((draft[0] ?? latest[0])?.settings ?? {}) as Record<string, unknown>;
        const nextSettings = {
          ...baseSettings,
          ...(input.settings ?? {}),
          language: input.language ?? (baseSettings.language as string | undefined) ?? "en",
        };
        const nextBody =
          input.body ?? DocBody.parse((draft[0] ?? latest[0])?.body ?? { blocks: [] });
        if (draft[0]) {
          await tx.execute(sql`
            update public.doc_template_version
            set body = ${JSON.stringify(nextBody)}::jsonb, settings = ${JSON.stringify(nextSettings)}::jsonb
            where id = ${draft[0].id} and org_id = ${ctx.orgId}
          `);
          draftVersionId = draft[0].id;
        } else {
          const v = (await tx.execute(sql`
            insert into public.doc_template_version (org_id, template_id, version, body, settings, created_by)
            values (${ctx.orgId}, ${t.id}, ${Number(latest[0]?.version ?? 0) + 1}, ${JSON.stringify(nextBody)}::jsonb,
                    ${JSON.stringify(nextSettings)}::jsonb, ${ctx.userId})
            returning id::text as id
          `)) as unknown as Array<{ id: string }>;
          draftVersionId = v[0]!.id;
        }
      }
      return { draftVersionId };
    },
  );
}

/** Publish the unpublished draft version: it becomes current and immutable. */
export async function publishTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ version: number }> {
  assertCan(archetype, "documents.templates.manage");
  const input = z
    .object({ templateId: z.string().uuid(), changeNote: z.string().trim().max(1000).optional() })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { version: number }) => ({
        action: "documents.template.publish",
        entityType: "document_template",
        entityId: input.templateId,
        summary: `Published template version ${r.version}`,
      }),
    },
    async (tx) => {
      const draft = (await tx.execute(sql`
        select v.id::text as id, v.version, v.body from public.doc_template_version v
        join public.doc_template t on t.id = v.template_id and t.org_id = v.org_id
        where v.template_id = ${input.templateId} and v.org_id = ${ctx.orgId} and v.published_at is null
          and t.status <> 'retired'
        order by v.version desc limit 1
      `)) as unknown as Array<{ id: string; version: number; body: unknown }>;
      const d = draft[0];
      if (!d) throw new DocError("nothing to publish", "state");
      const body = DocBody.parse(d.body);
      if (body.blocks.length === 0)
        throw new DocError("an empty template cannot be published", "validation");
      await tx.execute(sql`
        update public.doc_template_version
        set published_at = now(), published_by = ${ctx.userId}, change_note = ${input.changeNote ?? null}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        update public.doc_template set status = 'published', current_version = ${Number(d.version)},
          row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${input.templateId} and org_id = ${ctx.orgId}
      `);
      return { version: Number(d.version) };
    },
  );
}

export async function retireTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.templates.manage");
  const input = z.object({ templateId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.template.retire",
        entityType: "document_template",
        entityId: input.templateId,
        summary: "Retired template",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_template set status = 'retired', row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${input.templateId} and org_id = ${ctx.orgId} and status <> 'retired'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("template not found", "not_found");
      return { id: rows[0].id };
    },
  );
}
