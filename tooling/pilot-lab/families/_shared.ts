/**
 * H33 Pilot Lab — pure helpers every family reuses.
 *
 * Everything here is deterministic given the company's Rng, and everything it
 * produces is unmistakably fictional: reserved email domain, non-allocatable
 * phone ranges, tax numbers and IBANs with a fixed impossible prefix.
 */
import type { Rng } from "../../simulation/rng";
import type { SimClock } from "../../simulation/dates";
import type { Company } from "../types";

// ── Name pools ──────────────────────────────────────────────────────────────

export const FIRST_EN = [
  "Ahmed",
  "Fatima",
  "Omar",
  "Layla",
  "Khalid",
  "Maryam",
  "Yousef",
  "Noor",
  "Salem",
  "Huda",
  "Rashid",
  "Amal",
  "Tariq",
  "Reem",
  "Bilal",
  "Dana",
  "Hamad",
  "Sara",
  "Faisal",
  "Lina",
  "Nasser",
  "Mona",
  "Saif",
  "Hessa",
  "Majid",
  "Rania",
  "Ziad",
  "Nouf",
  "Karim",
  "Ghada",
  "Ravi",
  "Priya",
  "Arjun",
  "Meera",
  "John",
  "Grace",
  "Peter",
  "Elena",
  "Marco",
  "Sofia",
];
export const FIRST_AR = [
  "أحمد",
  "فاطمة",
  "عمر",
  "ليلى",
  "خالد",
  "مريم",
  "يوسف",
  "نور",
  "سالم",
  "هدى",
  "راشد",
  "أمل",
  "طارق",
  "ريم",
  "بلال",
  "دانة",
  "حمد",
  "سارة",
  "فيصل",
  "لينا",
  "ناصر",
  "منى",
  "سيف",
  "حصة",
  "ماجد",
  "رانيا",
  "زياد",
  "نوف",
  "كريم",
  "غادة",
  "رافي",
  "بريا",
  "أرجون",
  "ميرا",
  "جون",
  "غريس",
  "بيتر",
  "إيلينا",
  "ماركو",
  "صوفيا",
];
export const LAST_EN = [
  "Al Mansouri",
  "Haddad",
  "Suleiman",
  "Al Nahdi",
  "Qassim",
  "Rehman",
  "Karam",
  "Tarek",
  "Farouk",
  "Aziz",
  "Mansour",
  "Idris",
  "Nasser",
  "Menon",
  "Hamdan",
  "Jaber",
  "Zaki",
  "Al Harbi",
  "Al Otaibi",
  "Al Qahtani",
  "Al Shehri",
  "Al Dossari",
  "Al Ghamdi",
  "Al Mutairi",
  "Al Zahrani",
  "Shafik",
  "Hourani",
  "Makki",
  "Sabbagh",
  "Odeh",
  "Kassab",
  "Younes",
  "Fadel",
  "Darwish",
  "Salloum",
  "Khoury",
  "Pillai",
  "Sabri",
  "Amer",
  "Rashed",
  "Fernandes",
  "D'Souza",
  "Okafor",
  "Petrov",
];
export const LAST_AR = [
  "المنصوري",
  "حداد",
  "سليمان",
  "النهدي",
  "قاسم",
  "رحمن",
  "كرم",
  "طارق",
  "فاروق",
  "عزيز",
  "منصور",
  "إدريس",
  "ناصر",
  "مينون",
  "حمدان",
  "جابر",
  "زكي",
  "الحربي",
  "العتيبي",
  "القحطاني",
  "الشهري",
  "الدوسري",
  "الغامدي",
  "المطيري",
  "الزهراني",
  "شفيق",
  "حوراني",
  "مكي",
  "صباغ",
  "عودة",
  "كساب",
  "يونس",
  "فاضل",
  "درويش",
  "سلوم",
  "خوري",
  "بيلاي",
  "صبري",
  "عامر",
  "راشد",
  "فرنانديز",
  "دسوزا",
  "أوكافور",
  "بيتروف",
];

export const COMPANY_WORDS_EN = [
  "Horizon",
  "Falcon",
  "Oasis",
  "Marina",
  "Summit",
  "Crescent",
  "Pearl",
  "Dune",
  "Harbour",
  "Meridian",
  "Corniche",
  "Palm",
  "Sandstone",
  "Lighthouse",
  "Compass",
  "Anchor",
  "Beacon",
  "Granite",
  "Cedar",
  "Saffron",
  "Amber",
  "Coral",
  "Ivory",
  "Onyx",
  "Quartz",
  "Sable",
  "Topaz",
  "Zenith",
  "Atlas",
  "Nova",
];
export const COMPANY_WORDS_AR = [
  "الأفق",
  "الصقر",
  "الواحة",
  "المارينا",
  "القمة",
  "الهلال",
  "اللؤلؤ",
  "الكثيب",
  "المرفأ",
  "الزوال",
  "الكورنيش",
  "النخيل",
  "الحجر الرملي",
  "المنارة",
  "البوصلة",
  "المرساة",
  "الشعلة",
  "الجرانيت",
  "الأرز",
  "الزعفران",
  "الكهرمان",
  "المرجان",
  "العاج",
  "الجزع",
  "الكوارتز",
  "السمور",
  "التوباز",
  "الذروة",
  "أطلس",
  "نوفا",
];
export const COMPANY_SUFFIX_EN = [
  "Trading LLC",
  "Contracting LLC",
  "Holdings",
  "Group",
  "Facilities Management",
  "Engineering Consultants",
  "Logistics",
  "Real Estate",
  "Hospitality",
  "Retail",
  "Industries",
  "Technical Services",
  "General Maintenance",
  "Interiors",
  "Landscaping",
  "Medical Supplies",
  "Foodstuff Trading",
  "Building Materials",
  "Electromechanical Works",
  "Properties",
];
export const COMPANY_SUFFIX_AR = [
  "للتجارة ذ.م.م",
  "للمقاولات ذ.م.م",
  "القابضة",
  "المجموعة",
  "لإدارة المرافق",
  "للاستشارات الهندسية",
  "للخدمات اللوجستية",
  "للعقارات",
  "للضيافة",
  "للتجزئة",
  "للصناعات",
  "للخدمات الفنية",
  "للصيانة العامة",
  "للديكور الداخلي",
  "لتنسيق الحدائق",
  "للمستلزمات الطبية",
  "لتجارة المواد الغذائية",
  "لمواد البناء",
  "للأعمال الكهروميكانيكية",
  "للعقارات",
];

export const CITIES_AE = [
  "Dubai",
  "Abu Dhabi",
  "Sharjah",
  "Ajman",
  "Ras Al Khaimah",
  "Fujairah",
  "Al Ain",
  "Umm Al Quwain",
];
export const CITIES_SA = [
  "Riyadh",
  "Jeddah",
  "Dammam",
  "Khobar",
  "Mecca",
  "Medina",
  "Jubail",
  "Yanbu",
];
export const CITIES_AR: Record<string, string> = {
  Dubai: "دبي",
  "Abu Dhabi": "أبوظبي",
  Sharjah: "الشارقة",
  Ajman: "عجمان",
  "Ras Al Khaimah": "رأس الخيمة",
  Fujairah: "الفجيرة",
  "Al Ain": "العين",
  "Umm Al Quwain": "أم القيوين",
  Riyadh: "الرياض",
  Jeddah: "جدة",
  Dammam: "الدمام",
  Khobar: "الخبر",
  Mecca: "مكة",
  Medina: "المدينة",
  Jubail: "الجبيل",
  Yanbu: "ينبع",
};

export function personName(rng: Rng, i: number): { en: string; ar: string } {
  const f = i % FIRST_EN.length;
  const l = (i * 7 + rng.int(0, 3)) % LAST_EN.length;
  return { en: `${FIRST_EN[f]} ${LAST_EN[l]}`, ar: `${FIRST_AR[f]} ${LAST_AR[l]}` };
}

/** A fictional company name; roughly one in four is Arabic-first, one in six is bilingual. */
export function companyName(
  rng: Rng,
  i: number,
): { en: string; ar: string; primary: "en" | "ar"; display: string } {
  const w = (i * 13 + rng.int(0, 5)) % COMPANY_WORDS_EN.length;
  const s = (i * 3 + rng.int(0, 2)) % COMPANY_SUFFIX_EN.length;
  const en = `${COMPANY_WORDS_EN[w]} ${COMPANY_SUFFIX_EN[s]}`;
  const ar = `${COMPANY_WORDS_AR[w]} ${COMPANY_SUFFIX_AR[s]}`;
  const r = rng.next();
  const primary: "en" | "ar" = r < 0.25 ? "ar" : "en";
  const display = r < 0.25 ? ar : r < 0.4 ? `${en} — ${ar}` : en;
  return { en, ar, primary, display };
}

export function city(company: Company, rng: Rng): { en: string; ar: string } {
  const list = company.country === "SA" ? CITIES_SA : CITIES_AE;
  const c = list[rng.int(0, list.length - 1)]!;
  return { en: c, ar: CITIES_AR[c] ?? c };
}

// ── Obviously fake identifiers ──────────────────────────────────────────────

/** +971 50 000 0xxx / +966 50 000 0xxx — the 000 0 block is not allocated. */
export function phone(company: Company, i: number): string {
  const cc = company.country === "SA" ? "+966" : "+971";
  return `${cc} 50 000 ${String(i % 10000).padStart(4, "0")}`;
}
/** Reserved domain: cannot resolve, cannot deliver. */
export function email(local: string, i: number): string {
  return `${local.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${i}@example.invalid`;
}
/** UAE TRNs are 15 digits; real ones start 100. These start 1999 — impossible. */
export function taxNo(company: Company, i: number): string {
  return company.country === "SA"
    ? `399999${String(i).padStart(9, "0")}`
    : `1999${String(i).padStart(11, "0")}`;
}
/** IBAN with a zero bank code and zero check digits — structurally invalid on purpose. */
export function iban(company: Company, i: number): string {
  return company.country === "SA"
    ? `SA00 0000 ${String(i).padStart(18, "0")}`
    : `AE00 0000 ${String(i).padStart(16, "0")}`;
}
export function address(company: Company, rng: Rng, i: number): { en: string; ar: string } {
  const c = city(company, rng);
  const n = 100 + (i % 900);
  return {
    en: `Unit ${n}, Test Tower, Fictional District, ${c.en}`,
    ar: `وحدة ${n}، برج الاختبار، الحي الافتراضي، ${c.ar}`,
  };
}

// ── Time ────────────────────────────────────────────────────────────────────

/** Days between the company's first day and its as-of date. */
export function historyDays(company: Company): number {
  const from = new Date(company.history.from + "T00:00:00Z").getTime();
  const asOf = new Date(company.history.asOf + "T00:00:00Z").getTime();
  return Math.floor((asOf - from) / 86_400_000);
}

/**
 * Spread `n` events across the history with a seasonality curve: quieter in
 * the summer (July–August) and around year end, busier in spring and autumn,
 * and denser toward the present (a company that grew). Returns days-ago
 * values, oldest first.
 */
export function spreadDates(rng: Rng, company: Company, n: number): number[] {
  const total = historyDays(company);
  const out: number[] = [];
  const asOf = new Date(company.history.asOf + "T00:00:00Z");
  let guard = 0;
  while (out.length < n && guard++ < n * 20) {
    // Growth: bias toward recent (square root of uniform → denser near 0 days ago).
    const u = rng.next();
    const daysAgo = Math.floor(total * (1 - Math.sqrt(u)));
    const d = new Date(asOf.getTime() - daysAgo * 86_400_000);
    const month = d.getUTCMonth();
    const seasonal =
      month === 6 || month === 7
        ? 0.55
        : month === 11
          ? 0.7
          : month === 2 || month === 3 || month === 9 || month === 10
            ? 1.0
            : 0.85;
    if (rng.next() > seasonal) continue;
    out.push(daysAgo);
  }
  while (out.length < n) out.push(rng.int(0, total));
  return out.sort((a, b) => b - a);
}

/** Move a days-ago onto a working day (Fri/Sat off for a six-day GCC week the Sat; Fri always). */
export function workingDayAgo(clock: SimClock, daysAgo: number, sixDay: boolean): number {
  const d = new Date(clock.dayAgo(daysAgo) + "T00:00:00Z").getUTCDay();
  if (d === 5) return daysAgo + 1; // Friday → Thursday
  if (d === 6 && !sixDay) return daysAgo + 2; // Saturday → Thursday for a five-day week
  return daysAgo;
}

// ── State mixing ────────────────────────────────────────────────────────────

/** Pick a status by weight; weights need not sum to 1. */
export function weighted<T extends string>(rng: Rng, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

/** Older things are more likely to be finished. p(done) rises with age. */
export function doneByAge(rng: Rng, daysAgo: number, horizonDays: number): boolean {
  const p = Math.min(0.97, 0.15 + (daysAgo / horizonDays) * 0.9);
  return rng.next() < p;
}

// ── Text ────────────────────────────────────────────────────────────────────

export const LOREM_EN = [
  "Site access agreed with the client representative; hoarding to be completed before mobilisation.",
  "Delivery delayed by two days because of a port inspection; revised schedule shared with the site team.",
  "Quality check passed on the first batch; second batch to follow after curing.",
  "Client requested an additional variation for the mezzanine finishes; awaiting written instruction.",
  "Safety toolbox talk held at 07:00; all crew present; no incidents.",
  "Material received short by twelve units; supplier to deliver the balance tomorrow.",
  "Invoice queried by the client's accounts team; supporting delivery notes attached.",
  "Preventive maintenance completed on the chiller; filters replaced and readings logged.",
  "Follow-up call scheduled after the proposal review meeting.",
  "Scope confirmed; kick-off next Sunday at the client's office.",
];
export const LOREM_AR = [
  "تم الاتفاق على الوصول إلى الموقع مع ممثل العميل؛ يُستكمل السياج قبل التحرك.",
  "تأخر التسليم يومين بسبب فحص الميناء؛ تمت مشاركة الجدول المعدّل مع فريق الموقع.",
  "اجتاز فحص الجودة الدفعة الأولى؛ تليها الدفعة الثانية بعد المعالجة.",
  "طلب العميل تعديلاً إضافياً لتشطيبات الميزانين؛ بانتظار تعليمات مكتوبة.",
  "عُقد اجتماع السلامة الصباحي في السابعة؛ حضر جميع الطاقم؛ لا حوادث.",
  "وصلت المواد ناقصة اثنتي عشرة وحدة؛ سيسلّم المورّد الباقي غداً.",
  "استفسر فريق حسابات العميل عن الفاتورة؛ أُرفقت مذكرات التسليم الداعمة.",
  "اكتملت الصيانة الوقائية للمبرّد؛ استُبدلت الفلاتر وسُجّلت القراءات.",
  "جُدولت مكالمة متابعة بعد اجتماع مراجعة العرض.",
  "تم تأكيد النطاق؛ الانطلاق يوم الأحد القادم في مكتب العميل.",
];

export function sentence(rng: Rng, lang: "en" | "ar"): string {
  const pool = lang === "ar" ? LOREM_AR : LOREM_EN;
  return pool[rng.int(0, pool.length - 1)]!;
}
export function paragraph(rng: Rng, lang: "en" | "ar", sentences = 3): string {
  return Array.from({ length: sentences }, () => sentence(rng, lang)).join(" ");
}
/** A long, descriptive title — the kind that tests truncation and wrapping. */
export function longTitle(rng: Rng, lang: "en" | "ar", base: string): string {
  const tails =
    lang === "ar"
      ? [
          " — المرحلة الثانية، الطابق الثالث، الجناح الشمالي",
          " (مراجعة شاملة وإعادة تقييم نطاق العمل)",
          " — عقد سنوي مع خيار تمديد لسنتين",
        ]
      : [
          " — Phase 2, Level 3, North Wing",
          " (comprehensive review and scope re-baseline)",
          " — annual contract with a two-year extension option",
        ];
  return rng.chance(0.3) ? base + tails[rng.int(0, tails.length - 1)]! : base;
}

/** Deterministic pick from an array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[rng.int(0, arr.length - 1)]!;
}

/** Quantised money in minor units: rounds to a "realistic" figure. */
export function priceMinor(rng: Rng, minMajor: number, maxMajor: number): number {
  const major = rng.int(minMajor, maxMajor);
  const nice =
    major >= 1000 ? Math.round(major / 50) * 50 : major >= 100 ? Math.round(major / 5) * 5 : major;
  return nice * 100;
}
