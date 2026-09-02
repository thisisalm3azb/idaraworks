/**
 * PUBLIC form page (H26, ADR-24). Whoever holds a live form link sees the
 * issued form's fields and submits answers into a quarantined row. Nothing
 * else of the organisation is readable from here; unknown, expired, revoked
 * and exhausted links all render the same page.
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";
import { documentStudioEnabled } from "@/platform/flags";
import { loadFormSnapshot, resolveFormToken } from "@/modules/docstudio/service";
import { FormRenderer, type FormField } from "./FormRenderer";
import { submitFormAction } from "./actions";

export const dynamic = "force-dynamic";

const COPY = {
  en: {
    unavailable: "This form is not available",
    unavailableHint: "The link may have expired, been withdrawn, or reached its limit.",
    submitted: "Thank you, your answers were received",
    submittedHint: "The team will review them before anything is created.",
    other: "العربية",
    submit: "Submit",
    name: "Your name",
    email: "Your email",
    required: "Required",
    problems: {
      required: "This answer is required.",
      number: "Enter a number.",
      email: "Enter a valid email address.",
      date: "Enter a date.",
      choice: "Choose one of the options.",
      min: "Too small.",
      max: "Too large.",
      pattern: "This answer does not match the expected format.",
    },
  },
  ar: {
    unavailable: "هذا النموذج غير متاح",
    unavailableHint: "ربما انتهت صلاحية الرابط أو سُحب أو بلغ حدّه.",
    submitted: "شكراً، تم استلام إجاباتك",
    submittedHint: "سيراجعها الفريق قبل إنشاء أي سجل.",
    other: "English",
    submit: "إرسال",
    name: "اسمك",
    email: "بريدك الإلكتروني",
    required: "إلزامي",
    problems: {
      required: "هذه الإجابة إلزامية.",
      number: "أدخل رقماً.",
      email: "أدخل بريداً إلكترونياً صحيحاً.",
      date: "أدخل تاريخاً.",
      choice: "اختر أحد الخيارات.",
      min: "القيمة صغيرة جداً.",
      max: "القيمة كبيرة جداً.",
      pattern: "الإجابة لا تطابق الصيغة المتوقعة.",
    },
  },
} as const;

export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string; outcome?: string; problems?: string; values?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { token } = await params;
  const sp = await searchParams;
  const lang: "en" | "ar" = sp.lang === "ar" ? "ar" : "en";
  const c = COPY[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const h = await headers();
  const gate = await rateLimit("share", clientIpFromHeaders(h));
  const shell = (title: string, body: React.ReactNode) => (
    <div
      lang={lang}
      dir={dir}
      style={{
        flex: 1,
        minHeight: "100vh",
        margin: 0,
        background: "#f6f5f1",
        color: "#1c2321",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px 64px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "8px 0" }}>{title}</h1>
          <a href={`?lang=${lang === "ar" ? "en" : "ar"}`} style={{ fontSize: 14 }}>
            {c.other}
          </a>
        </div>
        {body}
      </main>
    </div>
  );
  if (!gate.allowed) return shell(c.unavailable, <p>{c.unavailableHint}</p>);
  if (sp.outcome === "submitted") return shell(c.submitted, <p>{c.submittedHint}</p>);
  if (sp.outcome === "unavailable") return shell(c.unavailable, <p>{c.unavailableHint}</p>);

  const resolved = await resolveFormToken(token);
  const form = resolved ? await loadFormSnapshot(resolved) : null;
  if (!resolved || !form) return shell(c.unavailable, <p>{c.unavailableHint}</p>);

  const fields: FormField[] = [];
  const add = (
    b: (typeof form.snapshot.body.blocks)[number],
    section?: { condition?: FormField["condition"]; title?: FormField["sectionTitle"] },
  ) => {
    if (b.type !== "field" || b.filledBy !== "party") return;
    fields.push({
      id: b.id,
      key: b.key,
      kind: b.kind,
      label: b.label,
      help: b.help,
      required: b.required,
      options: b.options,
      currency: b.currency,
      min: b.min,
      max: b.max,
      condition: b.condition,
      sectionCondition: section?.condition,
      sectionTitle: section?.title,
    });
  };
  for (const b of form.snapshot.body.blocks) {
    if (b.type === "section")
      for (const child of b.blocks) add(child, { condition: b.condition, title: b.title });
    else add(b);
  }
  let problems: Record<string, string> = {};
  let initial: Record<string, string> = {};
  try {
    problems = sp.problems ? (JSON.parse(sp.problems) as Record<string, string>) : {};
    initial = sp.values ? (JSON.parse(sp.values) as Record<string, string>) : {};
  } catch {
    problems = {};
    initial = {};
  }
  const submit = submitFormAction.bind(null, token, lang);
  const title = lang === "ar" ? form.title : form.title;
  return shell(
    title,
    <section
      style={{ background: "#fff", border: "1px solid #d9d6cc", borderRadius: 8, padding: 16 }}
    >
      <FormRenderer
        action={submit}
        fields={fields}
        lang={lang}
        problems={problems}
        initial={initial}
        dict={{
          submit: c.submit,
          name: c.name,
          email: c.email,
          required: c.required,
          problems: c.problems,
        }}
      />
    </section>,
  );
}
