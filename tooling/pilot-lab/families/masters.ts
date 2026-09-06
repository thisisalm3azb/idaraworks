/**
 * H33 Pilot Lab — family `masters`.
 *
 * The reference data every later family points at: customers and their
 * contacts, suppliers, the item catalogue, the Saudi manufacturer's bills of
 * material, and the minimal CRM consent / suppression records that make the
 * Revenue Studio's messaging gates real.
 *
 * Two layers, on purpose:
 *
 *   layoutFor(company)   — pure arithmetic over the volume profile: how many of
 *                          everything, which ordinals are inactive, which items
 *                          carry a recipe and in what state, which items are the
 *                          reorder / zero-stock candidates. No randomness at all,
 *                          so plan() and seed() agree to the row and verify()
 *                          can recompute the same skeleton afterwards.
 *   buildRows(ctx, …)    — the rows themselves: names, prices, dates, tags and
 *                          states drawn from ctx.rng, ids from ctx.id. Given the
 *                          same company the same rows come out every time.
 *   seed()               — inserts in foreign-key order, then drives the REAL
 *                          `activateBom` service for a representative subset of
 *                          draft recipes (skipped in dry-run, where nothing may
 *                          touch a database).
 *
 * Bills of material are inserted in the states the brief allows for direct
 * writes: `draft` (the born state), and `active` / `archived` written COMPLETE
 * — header and every line together, never edited afterwards — which is what
 * `bom_frozen_once_active` protects. Item category keys come from the org's
 * installed template (`config.categories.item`), because that is what the
 * product validates an item against; stage keys are not item categories.
 */
import { TEMPLATES } from "@/platform/config/templates";
import type { Check, Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import {
  companyName,
  email,
  historyDays,
  paragraph,
  personName,
  phone,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  taxNo,
  weighted,
} from "./_shared";

// ── Layout: the arithmetic skeleton plan(), seed() and verify() all share ────

/** Draft recipes put in force through the real service, per company. */
export const SERVICE_ACTIVATIONS = 4;

export type ItemKind = "inventory" | "consumable" | "service" | "asset" | "manufactured";
export type BomStatus = "draft" | "active" | "archived";

export type BomSpec = {
  /** Item ordinal of the parent. */
  parent: number;
  version: number;
  status: BomStatus;
  /** Component item ordinals in line order: raw materials, sub-assemblies, module. */
  components: number[];
  /** Born as a draft here and activated through `activateBom` in seed(). */
  viaService: boolean;
};

export type MastersLayout = {
  customers: number;
  /** Contacts per customer ordinal (1–3). */
  contactsOf: number[];
  contacts: number;
  /** Customer ordinals carrying a consent row. */
  customerConsents: number[];
  /** (customer ordinal, contact index) pairs carrying a consent row. */
  contactConsents: Array<[number, number]>;
  /** Customer ordinals whose e-mail / phone is suppressed. */
  emailSuppressions: number[];
  smsSuppressions: number[];
  suppliers: number;
  items: number;
  itemKind: ItemKind[];
  itemActive: boolean[];
  /** Manufactured items (ordinals 0 … bomParents-1); 0 when the company has no BOM. */
  bomParents: number;
  /** The first `subAssemblies` parents are level-1 recipes made of raw materials only. */
  subAssemblies: number;
  boms: BomSpec[];
  bomLines: number;
  /** Inventory items the stock family should leave at or below min_qty. */
  lowStockCandidates: number[];
  /** Inventory items the stock family should leave at zero. */
  zeroStockCandidates: number[];
  expected: Record<string, number>;
};

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function itemKindOf(i: number, bomParents: number): ItemKind {
  if (i < bomParents) return "manufactured";
  if (i % 23 === 0) return "service";
  if (i % 17 === 0) return "consumable";
  if (i % 41 === 0) return "asset";
  return "inventory";
}

/** Recipe parents are always live; roughly one item in twenty-five is retired. */
export function itemActiveOf(i: number, kind: ItemKind): boolean {
  if (kind === "manufactured") return true;
  return !(i % 29 === 0 || i % 53 === 0);
}

export function itemLifecycleOf(i: number, kind: ItemKind): "active" | "inactive" | "discontinued" {
  if (kind === "manufactured") return "active";
  if (i % 53 === 0) return "discontinued";
  if (i % 29 === 0) return "inactive";
  return "active";
}

/**
 * Components of one recipe version. Raw materials are read off the inventory
 * pool with a start and stride that depend only on the parent and version, so
 * a recipe never names the same component twice (stride × lines < pool size).
 * Top-level parents add one or two sub-assemblies, and every fifth late parent
 * adds an earlier top-level "module" — three levels deep. Raw materials carry
 * no recipe of their own, and every edge to a manufactured item points at a
 * LOWER ordinal, so the graph cannot cycle.
 */
function componentsOf(
  parent: number,
  version: number,
  subAssemblies: number,
  rawPool: number[],
): number[] {
  const size = rawPool.length;
  const raws = 3 + ((parent * 3 + version) % 5); // 3 … 7
  const start = (parent * 97 + version * 31) % size;
  const step = 1 + (parent % 5); // 1 … 5
  const out: number[] = [];
  for (let j = 0; j < raws; j++) out.push(rawPool[(start + j * step) % size]!);
  if (parent >= subAssemblies) {
    out.push(parent % subAssemblies);
    if (parent % 2 === 1) out.push((parent + 1) % subAssemblies);
    if (parent >= subAssemblies + 8 && parent % 5 === 0) out.push(parent - 8);
  }
  return out;
}

export function layoutFor(company: Company): MastersLayout {
  const p = company.profile;
  const customers = p.customers;
  const contactsOf = range(customers).map((i) => 1 + ((i * 7 + 3) % 3));
  const contacts = contactsOf.reduce((a, b) => a + b, 0);
  const customerConsents = range(customers).filter((i) => i % 5 === 0);
  const contactConsents: Array<[number, number]> = [];
  let g = 0;
  for (let i = 0; i < customers; i++) {
    for (let j = 0; j < contactsOf[i]!; j++, g++) if (g % 11 === 0) contactConsents.push([i, j]);
  }
  const emailSuppressions = range(customers).filter((i) => i % 40 === 0);
  const smsSuppressions = range(customers).filter((i) => i % 97 === 0);

  const items = p.items;
  const bomEnabled = p.enables.bom;
  const bomParents = bomEnabled ? clamp(Math.round(items * 0.02), 8, 80) : 0;
  const subAssemblies = bomEnabled ? Math.max(2, Math.floor(bomParents * 0.25)) : 0;
  const itemKind = range(items).map((i) => itemKindOf(i, bomParents));
  const itemActive = range(items).map((i) => itemActiveOf(i, itemKind[i]!));

  const boms: BomSpec[] = [];
  if (bomEnabled) {
    const rawPool = range(items).filter(
      (i) => i >= bomParents && itemKind[i] === "inventory" && itemActive[i],
    );
    if (rawPool.length < 64) {
      throw new Error(`masters: ${company.key} has too few inventory items for bills of material`);
    }
    let drafts = 0;
    for (let parent = 0; parent < bomParents; parent++) {
      const kind = parent % 20;
      const versions: Array<{ version: number; status: BomStatus; viaService: boolean }> =
        kind <= 10
          ? [{ version: 1, status: "active", viaService: false }]
          : kind <= 14
            ? [
                { version: 1, status: "archived", viaService: false },
                { version: 2, status: "active", viaService: false },
              ]
            : kind <= 17
              ? [{ version: 1, status: "draft", viaService: drafts++ < SERVICE_ACTIVATIONS }]
              : [
                  { version: 1, status: "active", viaService: false },
                  { version: 2, status: "draft", viaService: false },
                ];
      for (const v of versions) {
        boms.push({
          parent,
          version: v.version,
          status: v.status,
          viaService: v.viaService,
          components: componentsOf(parent, v.version, subAssemblies, rawPool),
        });
      }
    }
  }
  const bomLines = boms.reduce((a, b) => a + b.components.length, 0);

  const lowStockCandidates = range(items).filter(
    (i) => itemKind[i] === "inventory" && itemActive[i] && i % 20 === 0,
  );
  const zeroStockCandidates = range(items).filter(
    (i) => itemKind[i] === "inventory" && itemActive[i] && i % 31 === 0 && i % 20 !== 0,
  );

  const expected: Record<string, number> = {
    customer: customers,
    customer_contact: contacts,
    crm_consent: customerConsents.length + contactConsents.length,
    crm_suppression: emailSuppressions.length + smsSuppressions.length,
    supplier: p.suppliers,
    item: items,
  };
  if (bomEnabled) {
    expected.bom = boms.length;
    expected.bom_line = bomLines;
  }

  return {
    customers,
    contactsOf,
    contacts,
    customerConsents,
    contactConsents,
    emailSuppressions,
    smsSuppressions,
    suppliers: p.suppliers,
    items,
    itemKind,
    itemActive,
    bomParents,
    subAssemblies,
    boms,
    bomLines,
    lowStockCandidates,
    zeroStockCandidates,
    expected,
  };
}

// ── Units of measure: from the setup handoff, else from the database ─────────

export type UnitRef = { id: string; code: string };

/** Accepts the shapes a setup family would plausibly publish. */
export function unitsFromHandoff(h: unknown): UnitRef[] {
  if (!h || typeof h !== "object") return [];
  const obj = h as Record<string, unknown>;
  for (const key of ["units", "unitIds", "unitIdByCode", "unitsByCode", "unitOfMeasure"]) {
    const v = obj[key];
    if (Array.isArray(v)) {
      const out = v
        .map((u) => u as { id?: unknown; code?: unknown })
        .filter((u) => typeof u.id === "string" && typeof u.code === "string")
        .map((u) => ({ id: u.id as string, code: u.code as string }));
      if (out.length) return out;
    } else if (v && typeof v === "object") {
      const out: UnitRef[] = [];
      for (const [code, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out.push({ id: val, code });
        else if (val && typeof val === "object" && typeof (val as { id?: unknown }).id === "string")
          out.push({ id: (val as { id: string }).id, code });
      }
      if (out.length) return out;
    }
  }
  return [];
}

async function resolveUnits(ctx: LabContext): Promise<UnitRef[]> {
  let handoff: unknown;
  try {
    handoff = ctx.handoff("setup");
  } catch {
    handoff = undefined;
  }
  const fromHandoff = unitsFromHandoff(handoff);
  if (fromHandoff.length) return fromHandoff;
  if (ctx.dryRun) throw new Error("masters: the setup handoff carries no units of measure");
  const rows = (await ctx.sql`
    select id::text as id, code from public.unit_of_measure
    where org_id = ${ctx.orgId} and active
    order by is_base desc, code
  `) as unknown as UnitRef[];
  if (!rows.length) throw new Error("masters: no units of measure — has the setup family run?");
  return rows;
}

/*
 * Unit codes are the ones the setup family creates (pcs, pair, pack6, dz, box24,
 * kg, g, t, m, cm, mm, roll50, l, ml, drum200, m2, sqft, hr, day, wk); a code
 * that does not exist for the organisation is simply skipped, and the count
 * codes are the final fallback so an item is never left without a unit.
 */
const COUNT_CODES = ["pcs", "pc", "ea", "each", "unit", "nos", "no"];
const SERVICE_CODES = ["hr", "day", "svc", "hour", "job"];
const UNIT_PREFS: Record<string, string[]> = {
  cement_aggregates: ["kg", "t"],
  steel_rebar: ["kg", "t", "pcs"],
  blockwork: ["pcs", "box24"],
  timber_joinery: ["pcs", "m"],
  electrical_materials: ["m", "roll50", "pcs"],
  plumbing_drainage: ["m", "pcs"],
  hvac: ["m2", "roll50", "pcs"],
  paint_finishes: ["l", "drum200", "pcs"],
  tiles_flooring: ["m2", "box24", "pcs"],
  gypsum_partitions: ["pcs", "m2"],
  waterproofing: ["roll50", "kg", "pcs"],
  scaffolding_access: ["pcs", "m"],
  safety_equipment: ["pcs", "pair"],
  general_materials: ["pcs", "box24"],
  office_admin_supplies: ["box24", "pack6", "pcs"],
  equipment: ["pcs"],
  consumables: ["pcs", "box24", "roll50"],
  spare_parts: ["pcs", "pack6"],
  services: ["hr", "day", "pcs"],
  packaging: ["pcs", "roll50", "box24"],
  sheet_metal: ["kg", "m2", "pcs"],
  structural_steel: ["m", "kg", "pcs"],
  aluminium: ["m", "kg", "pcs"],
  fasteners: ["pcs", "box24", "kg"],
  welding_consumables: ["kg", "pack6", "pcs"],
  coatings_paint: ["l", "drum200", "kg"],
  timber_boards: ["m2", "pcs"],
  composites_resins: ["kg", "l", "pcs"],
  machine_parts: ["pcs"],
  abrasives: ["pcs", "box24"],
  gases: ["pcs"],
  electrical_components: ["pcs", "box24"],
  cleaning_supplies: ["l", "pcs", "box24"],
  tools_accessories: ["pcs", "pair"],
  electrical_parts: ["pcs", "box24"],
  plumbing_parts: ["pcs", "m"],
  filters_fluids: ["pcs", "l"],
};

/**
 * The unit an item is stocked in. Among the category's preferred codes that
 * exist for this organisation, the item ordinal picks one — no randomness, so
 * the choice is reproducible from the layout alone.
 */
export function unitFor(units: UnitRef[], kind: ItemKind, category: string, i: number): UnitRef {
  const byCode = new Map(units.map((u) => [u.code.toLowerCase(), u]));
  const prefs =
    kind === "service"
      ? SERVICE_CODES
      : kind === "manufactured"
        ? COUNT_CODES
        : (UNIT_PREFS[category] ?? COUNT_CODES);
  const available = prefs.map((c) => byCode.get(c)).filter((u): u is UnitRef => !!u);
  if (available.length) return available[i % available.length]!;
  for (const code of COUNT_CODES) {
    const u = byCode.get(code);
    if (u) return u;
  }
  return units[0]!;
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Item names by template category: [English, Arabic]. */
const ITEM_NOUNS: Record<string, Array<[string, string]>> = {
  cement_aggregates: [
    ["OPC Cement 50kg", "أسمنت بورتلاندي 50 كجم"],
    ["Washed Sand", "رمل مغسول"],
    ["Aggregate 20mm", "حصى 20 مم"],
  ],
  steel_rebar: [
    ["Rebar", "حديد تسليح"],
    ["Binding Wire", "سلك رباط"],
    ["Steel Mesh", "شبك حديد"],
  ],
  blockwork: [
    ["Hollow Block", "طوب مفرغ"],
    ["Solid Block", "طوب مصمت"],
    ["Thermal Block", "طوب حراري"],
  ],
  timber_joinery: [
    ["Plywood Sheet", "لوح خشب رقائقي"],
    ["Timber Batten", "عارضة خشبية"],
    ["MDF Board", "لوح MDF"],
  ],
  electrical_materials: [
    ["Copper Cable", "كابل نحاس"],
    ["Conduit Pipe", "ماسورة كهرباء"],
    ["Distribution Board", "لوحة توزيع"],
  ],
  plumbing_drainage: [
    ["PPR Pipe", "ماسورة PPR"],
    ["uPVC Drain Pipe", "ماسورة صرف uPVC"],
    ["Ball Valve", "محبس كروي"],
  ],
  hvac: [
    ["Duct Sheet", "صاج دكت"],
    ["Insulation Roll", "لفة عزل"],
    ["Air Diffuser", "موزع هواء"],
  ],
  paint_finishes: [
    ["Emulsion Paint", "دهان إيملشن"],
    ["Primer", "برايمر"],
    ["Wall Putty", "معجون حوائط"],
  ],
  tiles_flooring: [
    ["Porcelain Tile", "بلاط بورسلين"],
    ["Ceramic Tile", "بلاط سيراميك"],
    ["Tile Adhesive", "غراء بلاط"],
  ],
  gypsum_partitions: [
    ["Gypsum Board", "لوح جبس"],
    ["Metal Stud", "قائم معدني"],
    ["Joint Compound", "معجون فواصل"],
  ],
  waterproofing: [
    ["Bitumen Membrane", "رول بيتومين"],
    ["Cementitious Coating", "طلاء أسمنتي"],
    ["Sealant", "مادة مانعة للتسرب"],
  ],
  scaffolding_access: [
    ["Scaffold Tube", "ماسورة سقالة"],
    ["Scaffold Plank", "لوح سقالة"],
    ["Coupler", "قفل سقالة"],
  ],
  safety_equipment: [
    ["Safety Helmet", "خوذة سلامة"],
    ["Safety Boots", "حذاء سلامة"],
    ["Full-body Harness", "حزام أمان"],
  ],
  general_materials: [
    ["General Material", "مادة عامة"],
    ["Fixing Kit", "طقم تثبيت"],
    ["Adhesive Tape", "شريط لاصق"],
  ],
  office_admin_supplies: [
    ["Copy Paper A4", "ورق تصوير A4"],
    ["Toner Cartridge", "خرطوشة حبر"],
    ["Ring Binder", "ملف حلقي"],
  ],
  equipment: [
    ["Power Drill", "مثقاب كهربائي"],
    ["Angle Grinder", "جلاخة زاوية"],
    ["Pressure Washer", "غسالة ضغط"],
  ],
  consumables: [
    ["Cleaning Cloth", "قطعة تنظيف"],
    ["Cutting Disc", "قرص قطع"],
    ["Cable Ties", "رباط كابلات"],
  ],
  spare_parts: [
    ["Bearing", "رولمان بلي"],
    ["Drive Belt", "سير نقل"],
    ["Gasket Set", "طقم جوانات"],
  ],
  services: [
    ["Installation Service", "خدمة تركيب"],
    ["Site Survey", "مسح موقع"],
    ["Technician Hour", "ساعة فني"],
  ],
  packaging: [
    ["Carton Box", "كرتون تغليف"],
    ["Stretch Film", "فيلم تغليف"],
    ["Wooden Pallet", "طبلية خشبية"],
  ],
  other: [
    ["Miscellaneous Item", "صنف متنوع"],
    ["Sundry Supply", "مستلزم متفرق"],
  ],
  sheet_metal: [
    ["Galvanised Sheet", "صاج مجلفن"],
    ["Stainless Sheet 304", "صاج ستانلس 304"],
    ["Mild Steel Plate", "لوح حديد طري"],
  ],
  structural_steel: [
    ["Angle Bar", "زاوية حديد"],
    ["Channel Section", "قطاع C"],
    ["I-Beam", "عارضة I"],
  ],
  aluminium: [
    ["Aluminium Profile", "بروفيل ألمنيوم"],
    ["Aluminium Sheet", "لوح ألمنيوم"],
    ["Aluminium Tube", "ماسورة ألمنيوم"],
  ],
  fasteners: [
    ["Hex Bolt", "برغي سداسي"],
    ["Rivet", "برشام"],
    ["Self-tapping Screw", "برغي ذاتي القلوظة"],
  ],
  welding_consumables: [
    ["Welding Electrode", "إلكترود لحام"],
    ["MIG Wire", "سلك لحام MIG"],
    ["Welding Flux", "فلكس لحام"],
  ],
  coatings_paint: [
    ["Epoxy Primer", "برايمر إيبوكسي"],
    ["Powder Coat", "طلاء بودرة"],
    ["Thinner", "مخفف"],
  ],
  timber_boards: [
    ["Hardwood Board", "لوح خشب صلب"],
    ["Plywood", "خشب رقائقي"],
  ],
  composites_resins: [
    ["Polyester Resin", "راتنج بوليستر"],
    ["Fibreglass Mat", "حصيرة فايبرجلاس"],
    ["Gelcoat", "جل كوت"],
  ],
  machine_parts: [
    ["Spindle", "عمود دوران"],
    ["Gearbox", "علبة تروس"],
    ["Linear Guide", "دليل خطي"],
  ],
  abrasives: [
    ["Flap Disc", "قرص تنعيم"],
    ["Sanding Belt", "سير صنفرة"],
    ["Grinding Wheel", "حجر جلخ"],
  ],
  gases: [
    ["Argon Cylinder", "أسطوانة أرجون"],
    ["Oxygen Cylinder", "أسطوانة أكسجين"],
    ["CO2 Cylinder", "أسطوانة ثاني أكسيد الكربون"],
  ],
  electrical_components: [
    ["Contactor", "كونتاكتور"],
    ["Terminal Block", "بلوك توصيل"],
    ["Limit Switch", "مفتاح حدي"],
  ],
  cleaning_supplies: [
    ["Floor Cleaner", "منظف أرضيات"],
    ["Disinfectant", "مطهر"],
    ["Microfibre Cloth", "قطعة مايكروفايبر"],
  ],
  tools_accessories: [
    ["Screwdriver Set", "طقم مفكات"],
    ["Multimeter", "جهاز قياس متعدد"],
    ["Tool Bag", "حقيبة عدة"],
  ],
  electrical_parts: [
    ["MCB Breaker", "قاطع كهربائي"],
    ["Socket Outlet", "مقبس كهربائي"],
    ["LED Driver", "محول LED"],
  ],
  plumbing_parts: [
    ["Flexible Hose", "خرطوم مرن"],
    ["Mixer Cartridge", "خرطوشة خلاط"],
    ["Float Valve", "عوامة خزان"],
  ],
  filters_fluids: [
    ["AC Filter", "فلتر تكييف"],
    ["Compressor Oil", "زيت ضاغط"],
    ["Refrigerant R410A", "غاز تبريد R410A"],
  ],
};

const ASSEMBLY_NOUNS: Array<[string, string]> = [
  ["Control Panel Assembly", "مجموعة لوحة تحكم"],
  ["Steel Frame Module", "وحدة إطار حديدي"],
  ["Enclosure Unit", "وحدة صندوق معدني"],
  ["Conveyor Section", "قطاع ناقل"],
  ["Storage Rack", "رف تخزين"],
  ["Cabinet Unit", "وحدة كابينة"],
  ["Bracket Kit", "طقم حوامل"],
  ["Door Leaf", "درفة باب"],
  ["Hopper", "قادوس"],
  ["Gate Section", "قطاع بوابة"],
];

const BRANDS = ["Nova", "Atlas", "Zenith", "Onyx", "Quartz", "Falcon", "Meridian"];
const ROLE_TITLES: Array<[string, string]> = [
  ["Procurement Manager", "مدير المشتريات"],
  ["Accounts Payable", "حسابات الدفع"],
  ["Project Engineer", "مهندس مشروع"],
  ["Owner", "المالك"],
  ["Operations Manager", "مدير العمليات"],
  ["Site Supervisor", "مشرف موقع"],
  ["Facilities Coordinator", "منسق المرافق"],
];
const SUPPLIER_TERMS: Array<[string, string]> = [
  [
    "Net 30 days from invoice date. Deliveries to site between 07:00 and 15:00; a delivery note is required for every consignment.",
    "الدفع خلال 30 يوماً من تاريخ الفاتورة. التسليم إلى الموقع بين السابعة صباحاً والثالثة عصراً؛ مذكرة تسليم لكل شحنة.",
  ],
  [
    "50% advance with the purchase order, balance on delivery. Prices valid for 14 days.",
    "50% مقدماً مع أمر الشراء والباقي عند التسليم. الأسعار سارية لمدة 14 يوماً.",
  ],
  [
    "Net 60 days. Returns accepted within 7 days of receipt in original packaging.",
    "الدفع خلال 60 يوماً. تُقبل المرتجعات خلال 7 أيام من الاستلام في التغليف الأصلي.",
  ],
  ["Cash on delivery. No credit terms.", "الدفع عند التسليم. لا توجد شروط ائتمان."],
  [
    "Net 45 days; 2% early-payment discount if settled within 10 days. Minimum order value applies.",
    "الدفع خلال 45 يوماً؛ خصم 2% للسداد المبكر خلال 10 أيام. ينطبق حد أدنى لقيمة الطلب.",
  ],
];
const GCC = ["SA", "QA", "OM", "KW", "BH", "AE"];

const ARABIC = /[؀-ۿ]/;
function isArabic(s: string): boolean {
  return ARABIC.test(s);
}

/** Company initials, letters only: "Sadaf Trading & Distribution" → "STD". */
export function skuPrefix(company: Company): string {
  const letters = company.nameEn
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase());
  return (letters.join("").slice(0, 3) || "ITM").padEnd(3, "X");
}

/** The item category keys the org's template installs (what the product validates against). */
export function itemCategoryKeys(company: Company): string[] {
  const manifest = TEMPLATES[company.templateKey];
  if (!manifest) throw new Error(`masters: unknown template ${company.templateKey}`);
  return manifest.category_sets.item.categories.filter((c) => !c.retired).map((c) => c.key);
}

/** Round a minor amount to a "realistic" list figure, the way priceMinor does. */
function niceMinor(minor: number): number {
  const major = Math.round(minor / 100);
  const nice =
    major >= 1000 ? Math.round(major / 50) * 50 : major >= 100 ? Math.round(major / 5) * 5 : major;
  return Math.max(1, nice) * 100;
}

// ── Rows ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export type ItemHandoff = {
  unit: string;
  unitId: string;
  cost: number;
  price: number;
  category: string;
  type: ItemKind;
  tracking: "none" | "lot" | "serial";
};

export type MastersHandoff = {
  customerIds: string[];
  inactiveCustomerIds: string[];
  supplierIds: string[];
  inactiveSupplierIds: string[];
  itemIds: string[];
  /** Item id → the attributes later families need without a query. */
  items: Record<string, ItemHandoff>;
  inactiveItemIds: string[];
  lowStockCandidateItemIds: string[];
  zeroStockItemIds: string[];
  itemCategoryKeys: string[];
  bomIds: string[];
  activeBomIds: string[];
  bomParentItemIds: string[];
  serviceActivatedBomIds: string[];
};

export type MastersRows = {
  tables: Record<string, Row[]>;
  handoff: MastersHandoff;
};

/** Every row for the family, in insert order, from one deterministic pass. */
export function buildRows(ctx: LabContext, layout: MastersLayout, units: UnitRef[]): MastersRows {
  const { company, rng, clock, users } = ctx;
  const org = ctx.orgId;
  const arabicFirst = company.languages[0] === "ar";
  const total = historyDays(company);
  const owners = [users.manager, users.owner, users.finance];

  // ── customers + contacts ──────────────────────────────────────────────────
  const customers: Row[] = [];
  const contacts: Row[] = [];
  const consents: Row[] = [];
  const suppressions: Row[] = [];
  const customerDays = spreadDates(rng, company, layout.customers);
  const customerEmail: string[] = [];
  const customerPhone: string[] = [];
  const contactIds: string[][] = [];
  const inactiveCustomerIds: string[] = [];
  let contactOrdinal = 0;

  for (let i = 0; i < layout.customers; i++) {
    const id = ctx.id("customer", i);
    const daysAgo = customerDays[i]!;
    const cn = companyName(rng, i);
    const pn = personName(rng, i);
    const individual = i % 13 === 0;
    let name: string;
    let lang: "en" | "ar";
    if (individual) {
      lang = arabicFirst ? (i % 3 === 0 ? "en" : "ar") : i % 4 === 0 ? "ar" : "en";
      name = lang === "ar" ? pn.ar : pn.en;
    } else {
      name = arabicFirst && i % 2 === 0 ? cn.ar : cn.display;
      lang = isArabic(name) && !name.includes(" — ") ? "ar" : "en";
      if (i % 9 === 0) {
        name +=
          lang === "ar"
            ? " — فرع المنطقة الصناعية الثانية، قسم إدارة المرافق والصيانة"
            : " — Branch of Industrial Area 2, Facilities & Maintenance Division";
      }
    }
    name = name.slice(0, 160);
    const active = i % 12 !== 11;
    if (!active) inactiveCustomerIds.push(id);
    const country =
      i % 10 === 7
        ? pick(
            rng,
            GCC.filter((c) => c !== company.country),
          )
        : i % 30 === 3
          ? pick(rng, ["GB", "IN", "EG", "JO"])
          : company.country;
    const mail = email(individual ? pn.en.split(" ")[0]! : cn.en.split(" ")[0]!, i);
    const tel = phone(company, i);
    customerEmail.push(mail);
    customerPhone.push(tel);
    const n = layout.contactsOf[i]!;
    const ids: string[] = [];
    let primaryName = individual ? name : "";
    for (let j = 0; j < n; j++, contactOrdinal++) {
      const cid = ctx.id("customer_contact", i, j);
      ids.push(cid);
      const person = personName(rng, i * 3 + j + 7);
      const cLang: "en" | "ar" =
        lang === "ar" ? (j === 2 ? "en" : "ar") : j === 1 && i % 3 === 0 ? "ar" : "en";
      const cName = individual && j === 0 ? name : cLang === "ar" ? person.ar : person.en;
      if (j === 0) primaryName = cName;
      const role = pick(rng, ROLE_TITLES);
      const cActive = j === 0 ? true : !(j === 2 && i % 5 === 0);
      const cMail = email(person.en.split(" ")[0]!, 100_000 + contactOrdinal);
      const cTel = j === 0 ? tel : phone(company, 7000 + (contactOrdinal % 3000));
      const cDays = Math.max(0, daysAgo - rng.int(0, Math.min(daysAgo, 90)));
      contacts.push({
        id: cid,
        org_id: org,
        customer_id: id,
        name: cName.slice(0, 120),
        role_title: cLang === "ar" ? role[1] : role[0],
        email: rng.chance(0.85) ? cMail : null,
        phone: cTel,
        preferred_method: rng.chance(0.6) ? "phone" : "email",
        is_primary: j === 0,
        active: cActive,
        created_at: clock.tsAgo(cDays, 9 + (j % 6)),
        updated_at: clock.tsAgo(cDays, 9 + (j % 6)),
        role_kind: weighted(rng, {
          decision_maker: 3,
          economic_buyer: 1,
          influencer: 2,
          champion: 1,
          user: 2,
          procurement: 3,
          finance: 2,
          technical: 2,
          blocker: 0.3,
          other: 1,
        }),
        notes: rng.chance(0.2) ? sentence(rng, cLang) : null,
        language: cLang,
      });
    }
    contactIds.push(ids);
    customers.push({
      id,
      org_id: org,
      name,
      country,
      contact_name: primaryName.slice(0, 120),
      phone: tel,
      email: mail,
      tax_reg_no: individual || i % 3 === 2 ? null : taxNo(company, i),
      notes: i % 4 === 0 ? paragraph(rng, lang, 2) : null,
      active,
      created_at: clock.tsAgo(daysAgo, 8 + (i % 8)),
      updated_at: clock.tsAgo(daysAgo, 8 + (i % 8)),
      payment_terms_days: individual ? 0 : pick(rng, [0, 15, 30, 30, 45, 60]),
      credit_limit_minor: individual || i % 2 === 1 ? null : priceMinor(rng, 5_000, 250_000),
      owner_user_id: pick(rng, owners),
      territory_id: null,
      tags: weighted(rng, { none: 6, vip: 1, priority: 1, key: 1, dormant: 0.5 }) as string,
      segment: individual
        ? "individual"
        : pick(rng, ["key_account", "sme", "government", "retail", "contractor", "sme"]),
      merged_into_customer_id: null,
      source_kind: weighted(rng, {
        manual: 5,
        import: 3,
        referral: 1,
        campaign: 1,
        lead: 1,
        form: 0.5,
      }),
    });
  }
  // tags: the weighted key becomes a real text[] (JSON array → text[] through json_populate_recordset).
  for (const c of customers) {
    const t = c.tags as string;
    c.tags = t === "none" ? [] : t === "key" ? ["key_account", "priority"] : [t];
  }

  // ── consent + suppression ─────────────────────────────────────────────────
  for (const i of layout.customerConsents) {
    const daysAgo = Math.max(0, customerDays[i]! - rng.int(0, 30));
    consents.push({
      id: ctx.id("crm_consent", "customer", i),
      org_id: org,
      customer_id: ctx.id("customer", i),
      contact_id: null,
      lead_id: null,
      channel: weighted(rng, { email: 5, whatsapp: 2, phone: 2, sms: 1 }),
      status: weighted(rng, { granted: 7, withdrawn: 1, unknown: 1 }),
      source: weighted(rng, { form: 3, written: 2, verbal: 2, import: 2, customer_request: 1 }),
      evidence: sentence(rng, arabicFirst ? "ar" : "en"),
      effective_at: clock.tsAgo(daysAgo, 10),
      actor_user_id: users.manager,
      created_at: clock.tsAgo(daysAgo, 10),
    });
  }
  for (const [i, j] of layout.contactConsents) {
    const daysAgo = Math.max(0, customerDays[i]! - rng.int(0, 60));
    consents.push({
      id: ctx.id("crm_consent", "contact", i, j),
      org_id: org,
      customer_id: null,
      contact_id: contactIds[i]![j]!,
      lead_id: null,
      channel: weighted(rng, { email: 5, whatsapp: 3, phone: 1, sms: 1 }),
      status: weighted(rng, { granted: 6, withdrawn: 2, unknown: 1 }),
      source: weighted(rng, { form: 4, written: 1, verbal: 2, unsubscribe: 1, system: 0.5 }),
      evidence: sentence(rng, "en"),
      effective_at: clock.tsAgo(daysAgo, 11),
      actor_user_id: users.manager,
      created_at: clock.tsAgo(daysAgo, 11),
    });
  }
  for (const i of layout.emailSuppressions) {
    const daysAgo = Math.max(0, customerDays[i]! - rng.int(0, 45));
    suppressions.push({
      id: ctx.id("crm_suppression", "email", i),
      org_id: org,
      channel: "email",
      address: customerEmail[i]!.toLowerCase(),
      reason: weighted(rng, { unsubscribe: 4, bounce: 3, complaint: 1, objection: 1 }),
      note: rng.chance(0.5) ? sentence(rng, "en") : null,
      actor_user_id: users.manager,
      created_at: clock.tsAgo(daysAgo, 12),
    });
  }
  for (const i of layout.smsSuppressions) {
    const daysAgo = Math.max(0, customerDays[i]! - rng.int(0, 45));
    suppressions.push({
      id: ctx.id("crm_suppression", "sms", i),
      org_id: org,
      channel: "sms",
      address: customerPhone[i]!.replace(/\s+/g, ""),
      reason: weighted(rng, { objection: 3, manual: 2, legal: 1 }),
      note: null,
      actor_user_id: users.manager,
      created_at: clock.tsAgo(daysAgo, 12),
    });
  }

  // ── suppliers ─────────────────────────────────────────────────────────────
  const suppliers: Row[] = [];
  const supplierIds: string[] = [];
  const inactiveSupplierIds: string[] = [];
  const supplierDays = spreadDates(rng, company, layout.suppliers);
  for (let i = 0; i < layout.suppliers; i++) {
    const id = ctx.id("supplier", i);
    supplierIds.push(id);
    const cn = companyName(rng, i + 500);
    const name = (arabicFirst && i % 2 === 1 ? cn.ar : cn.display).slice(0, 160);
    const lang: "en" | "ar" = isArabic(name) && !name.includes(" — ") ? "ar" : "en";
    const active = i % 12 !== 0;
    if (!active) inactiveSupplierIds.push(id);
    const terms = pick(rng, SUPPLIER_TERMS);
    const daysAgo = supplierDays[i]!;
    suppliers.push({
      id,
      org_id: org,
      name,
      tax_reg_no: i % 5 === 4 ? null : taxNo(company, 50_000 + i),
      terms_text: lang === "ar" ? terms[1] : terms[0],
      phone: phone(company, 5000 + i),
      email: email(cn.en.split(" ")[0]! + ".ap", 5000 + i),
      active,
      created_at: clock.tsAgo(daysAgo, 9),
      updated_at: clock.tsAgo(daysAgo, 9),
      payment_terms_days: pick(rng, [0, 30, 30, 45, 60, 90]),
      credit_limit_minor: i % 3 === 0 ? priceMinor(rng, 10_000, 500_000) : null,
    });
  }

  // ── items ─────────────────────────────────────────────────────────────────
  const items: Row[] = [];
  const itemIds: string[] = [];
  const itemHandoff: Record<string, ItemHandoff> = {};
  const inactiveItemIds: string[] = [];
  const cats = itemCategoryKeys(company);
  const prefix = skuPrefix(company);
  const itemDays = spreadDates(rng, company, layout.items);
  const unitOf: UnitRef[] = [];
  const parentCats = ["machine_parts", "structural_steel", "sheet_metal", "equipment"].filter((c) =>
    cats.includes(c),
  );
  for (let i = 0; i < layout.items; i++) {
    const id = ctx.id("item", i);
    itemIds.push(id);
    const kind = layout.itemKind[i]!;
    const active = layout.itemActive[i]!;
    if (!active) inactiveItemIds.push(id);
    const category =
      kind === "manufactured"
        ? (parentCats[i % Math.max(1, parentCats.length)] ?? cats[(i * 31) % cats.length]!)
        : kind === "service"
          ? (cats.find((c) => c === "services") ?? cats.find((c) => c === "other") ?? cats[0]!)
          : cats[(i * 31) % cats.length]!;
    const unit = unitFor(units, kind, category, i);
    unitOf.push(unit);
    const noun =
      kind === "manufactured"
        ? ASSEMBLY_NOUNS[i % ASSEMBLY_NOUNS.length]!
        : pick(
            rng,
            ITEM_NOUNS[category] ?? [
              [category.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()), "صنف"],
            ],
          );
    const spec =
      kind === "service"
        ? ""
        : rng.chance(0.5)
          ? ` ${rng.int(2, 120)}mm`
          : ` ${pick(rng, ["A", "B", "C", "HD", "XL"])}-${rng.int(100, 999)}`;
    const sub = kind === "manufactured" && i < layout.subAssemblies;
    let nameEn = `${noun[0]}${spec}${sub ? " Sub-assembly" : ""}`;
    let nameAr = `${noun[1]}${spec}${sub ? " (مجموعة فرعية)" : ""}`;
    if (i % 15 === 0) {
      nameEn +=
        " — Grade A, ISO-certified, supplied with mill test certificates and batch traceability";
      nameAr += " — درجة أولى، معتمد ISO، يُورَّد مع شهادات فحص المصنع وإمكانية تتبع الدفعة";
    }
    const arabicName = arabicFirst && i % 2 === 0;
    const name = (arabicName ? nameAr : nameEn).slice(0, 160);
    const name_ar = arabicFirst || i % 3 !== 2 ? nameAr.slice(0, 160) : null;
    const [lo, hi] = kind === "service" ? [50, 800] : kind === "asset" ? [500, 20_000] : [2, 3_000];
    const cost = priceMinor(rng, lo, hi);
    const price = Math.max(cost, niceMinor(Math.round(cost * rng.float(1.15, 1.9))));
    const tracking: ItemHandoff["tracking"] =
      kind === "inventory" && company.profile.enables.serials && i % 19 === 0
        ? "serial"
        : kind === "inventory" && company.profile.enables.lots && i % 7 === 0
          ? "lot"
          : "none";
    const minQty = kind === "inventory" && i % 4 === 0 ? rng.int(5, 200) : null;
    const gtin = i % 6 === 0 && kind !== "service" ? `2${String(i + 1).padStart(13, "0")}` : null;
    const preferredSupplier =
      i % 3 === 0 && kind !== "service" && supplierIds.length
        ? supplierIds[(i * 5) % supplierIds.length]!
        : null;
    const daysAgo = itemDays[i]!;
    items.push({
      id,
      org_id: org,
      sku: `${prefix}-${category.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(5, "0")}`,
      name,
      category_key: category,
      unit: unit.code,
      unit_cost_minor: cost,
      selling_price_minor: price,
      min_qty: minQty,
      active,
      created_at: clock.tsAgo(daysAgo, 10),
      updated_at: clock.tsAgo(daysAgo, 10),
      item_type: kind,
      description_en: rng.chance(0.3) ? sentence(rng, "en") : null,
      name_ar,
      description_ar: rng.chance(0.3) ? sentence(rng, "ar") : null,
      brand:
        kind === "service" || kind === "manufactured"
          ? null
          : rng.chance(0.4)
            ? pick(rng, BRANDS)
            : null,
      gtin,
      gtin_raw: gtin,
      code_kind: gtin ? "internal" : "none",
      base_unit_id: unit.id,
      purchase_unit_id: unit.id,
      issue_unit_id: unit.id,
      preferred_supplier_id: preferredSupplier,
      supplier_item_code: preferredSupplier ? `SUP-${String(i + 1).padStart(5, "0")}` : null,
      tax_category: i % 25 === 0 ? "zero" : "standard",
      tracking,
      expiry_tracked: tracking === "lot" && i % 14 === 0,
      cost_method: tracking === "lot" && i % 2 === 0 ? "fifo" : null,
      allow_negative_stock: kind === "inventory" && i % 101 === 0,
      reorder_point: minQty,
      reorder_qty: minQty === null ? null : minQty * pick(rng, [2, 3, 5]),
      lifecycle: itemLifecycleOf(i, kind),
    });
    itemHandoff[id] = {
      unit: unit.code,
      unitId: unit.id,
      cost,
      price,
      category,
      type: kind,
      tracking,
    };
  }

  // ── bills of material (complete on insert; drafts are the born state) ─────
  const boms: Row[] = [];
  const bomLines: Row[] = [];
  const bomIds: string[] = [];
  const activeBomIds: string[] = [];
  const serviceActivatedBomIds: string[] = [];
  const bomParentItemIds = range(layout.bomParents).map((i) => ctx.id("item", i));
  const archivedAtOf = new Map<number, string>();
  // Second pass ordering: a v2 decides when its v1 was archived, so read v2 first.
  const byParent = new Map<number, BomSpec[]>();
  for (const b of layout.boms) byParent.set(b.parent, [...(byParent.get(b.parent) ?? []), b]);
  for (const [parent, versions] of byParent) {
    const v2 = versions.find((b) => b.version === 2);
    const v1 = versions.find((b) => b.version === 1)!;
    const ageMax = Math.max(120, total - 1);
    let days1: number;
    let days2: number | null = null;
    if (v1.status === "draft") days1 = rng.int(0, 60);
    else if (v2?.status === "active") {
      days1 = rng.int(Math.min(200, ageMax - 20), ageMax);
      days2 = rng.int(20, Math.max(21, days1 - 10));
      archivedAtOf.set(parent, clock.tsAgo(days2, 8));
    } else if (v2?.status === "draft") {
      days1 = rng.int(Math.min(90, ageMax - 1), ageMax);
      days2 = rng.int(0, 30);
    } else days1 = rng.int(30, ageMax);
    for (const b of versions) {
      const id = ctx.id("bom", b.parent, b.version);
      bomIds.push(id);
      if (b.status === "active") activeBomIds.push(id);
      if (b.viaService) serviceActivatedBomIds.push(id);
      const days = b.version === 1 ? days1 : days2!;
      const lang: "en" | "ar" = arabicFirst ? "ar" : "en";
      boms.push({
        id,
        org_id: org,
        item_id: ctx.id("item", b.parent),
        version: b.version,
        status: b.status,
        output_qty: b.parent % 7 === 0 ? pick(rng, [10, 25, 50]) : 1,
        unit_id: unitOf[b.parent]!.id,
        notes: rng.chance(0.3) ? sentence(rng, lang) : null,
        effective_from: b.status === "draft" ? null : clock.dayAgo(days),
        archived_at: b.status === "archived" ? archivedAtOf.get(parent)! : null,
        created_by: users.manager,
        created_at: clock.tsAgo(days, 9),
        updated_at: b.status === "archived" ? archivedAtOf.get(parent)! : clock.tsAgo(days, 9),
      });
      b.components.forEach((component, j) => {
        const isSub = component < layout.bomParents;
        bomLines.push({
          id: ctx.id("bom_line", b.parent, b.version, j),
          org_id: org,
          bom_id: id,
          component_item_id: ctx.id("item", component),
          qty_per: isSub ? rng.int(1, 4) : rng.float(0.5, 24, 3),
          unit_id: unitOf[component]!.id,
          scrap_pct: isSub ? 0 : Number(weighted(rng, { "0": 6, "2": 2, "3.5": 1, "5": 1 })),
          sort: j,
          created_at: clock.tsAgo(days, 9, 5 + j),
        });
      });
    }
  }

  const tables: Record<string, Row[]> = {
    customer: customers,
    customer_contact: contacts,
    crm_consent: consents,
    crm_suppression: suppressions,
    supplier: suppliers,
    item: items,
  };
  if (company.profile.enables.bom) {
    tables.bom = boms;
    tables.bom_line = bomLines;
  }
  return {
    tables,
    handoff: {
      customerIds: customers.map((c) => c.id as string),
      inactiveCustomerIds,
      supplierIds,
      inactiveSupplierIds,
      itemIds,
      items: itemHandoff,
      inactiveItemIds,
      lowStockCandidateItemIds: layout.lowStockCandidates.map((i) => ctx.id("item", i)),
      zeroStockItemIds: layout.zeroStockCandidates.map((i) => ctx.id("item", i)),
      itemCategoryKeys: cats,
      bomIds,
      activeBomIds,
      bomParentItemIds,
      serviceActivatedBomIds,
    },
  };
}

// ── The family ──────────────────────────────────────────────────────────────

/** Insert order respects every foreign key: suppliers before items, items before recipes. */
const INSERT_ORDER = [
  "customer",
  "customer_contact",
  "crm_consent",
  "crm_suppression",
  "supplier",
  "item",
  "bom",
  "bom_line",
];

async function count(
  ctx: LabContext,
  text: string,
  params: Array<string | number>,
): Promise<number> {
  const rows = (await ctx.sql.unsafe(text, params)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

export type SeedOptions = {
  /**
   * Drive the real `activateBom` service for the representative drafts. Off in
   * dry-run (nothing may touch a database) and in the unit test (there is no
   * database); the direct inserts are identical either way.
   */
  services: boolean;
};

/** The family's seed with the service step under an explicit switch. */
export async function seedMasters(ctx: LabContext, opts: SeedOptions): Promise<FamilyReport> {
  const layout = layoutFor(ctx.company);
  const units = await resolveUnits(ctx);
  const { tables, handoff } = buildRows(ctx, layout, units);
  const counts: Record<string, number> = {};
  for (const table of INSERT_ORDER) {
    const rows = tables[table];
    if (!rows) continue;
    const r = await ctx.insert(table, rows);
    counts[table] = r.attempted;
    ctx.log(`${table}: ${r.attempted} rows`);
  }

  // A representative subset of draft recipes goes through the real service, so
  // the audit trail, the cycle walk and the archive-the-previous rule are all
  // the product's own. Never in dry-run: nothing may touch a database there.
  const notes: string[] = [];
  const toActivate = handoff.serviceActivatedBomIds.length;
  if (toActivate && opts.services && !ctx.dryRun) {
    const { activateBom } = await import("@/modules/inventory/assembly");
    const asManager = ctx.ctxFor("manager");
    const archetype = ctx.archetypeOf("manager");
    for (const bomId of handoff.serviceActivatedBomIds) {
      await activateBom(asManager, archetype, bomId);
    }
    handoff.activeBomIds = [...handoff.activeBomIds, ...handoff.serviceActivatedBomIds];
    ctx.log(`bom: ${toActivate} draft recipe(s) activated via activateBom`);
    notes.push(`${toActivate} BOM activations through the service`);
  } else if (toActivate) {
    notes.push(`${toActivate} BOM activations skipped (no service run)`);
  }
  return { family: "masters", counts, handoff, notes };
}

export const masters: Family = {
  key: "masters",
  deps: ["setup", "people"],
  appliesTo: () => true,

  plan(ctx): FamilyPlan {
    return { family: "masters", expected: layoutFor(ctx.company).expected };
  },

  seed(ctx): Promise<FamilyReport> {
    return seedMasters(ctx, { services: !ctx.dryRun });
  },

  async verify(ctx): Promise<Check[]> {
    const company = ctx.company;
    const layout = layoutFor(company);
    const org = ctx.orgId;
    const checks: Check[] = [];

    for (const [table, expected] of Object.entries(layout.expected)) {
      const n = await count(
        ctx,
        `select count(*)::int as n from public.${table} where org_id = $1`,
        [org],
      );
      checks.push({
        name: `count:${table}`,
        ok: n === expected,
        detail: `${n} live, ${expected} planned`,
      });
    }

    const customers = await count(
      ctx,
      `select count(*)::int as n from public.customer where org_id = $1`,
      [org],
    );
    const items = await count(ctx, `select count(*)::int as n from public.item where org_id = $1`, [
      org,
    ]);
    if (company.profile.customers > 1205)
      checks.push({
        name: "customers exceed the 1,205 page mark",
        ok: customers > 1205,
        detail: `${customers}`,
      });
    if (company.profile.items > 1205)
      checks.push({
        name: "items exceed the 1,205 page mark",
        ok: items > 1205,
        detail: `${items}`,
      });
    if (company.profile.items > 3000)
      checks.push({ name: "items exceed 3,000", ok: items > 3000, detail: `${items}` });

    const noPrimary = await count(
      ctx,
      `select count(*)::int as n from public.customer c
       where c.org_id = $1 and not exists (
         select 1 from public.customer_contact cc
         where cc.customer_id = c.id and cc.org_id = c.org_id and cc.is_primary and cc.active)`,
      [org],
    );
    checks.push({
      name: "every customer has one active primary contact",
      ok: noPrimary === 0,
      detail: `${noPrimary} without`,
    });

    const badUnits = await count(
      ctx,
      `select count(*)::int as n from public.item i
       where i.org_id = $1 and (i.base_unit_id is null or not exists (
         select 1 from public.unit_of_measure u
         where u.id = i.base_unit_id and u.org_id = i.org_id and u.code = i.unit))`,
      [org],
    );
    checks.push({
      name: "every item's unit code is a real unit of measure",
      ok: badUnits === 0,
      detail: `${badUnits} unresolved`,
    });

    const arabicItems = await count(
      ctx,
      `select count(*)::int as n from public.item where org_id = $1 and name_ar is not null`,
      [org],
    );
    checks.push({
      name: "a third or more of items carry an Arabic name",
      ok: items > 0 && arabicItems * 3 >= items,
      detail: `${arabicItems}/${items}`,
    });
    const arabicCustomers = await count(
      ctx,
      `select count(*)::int as n from public.customer where org_id = $1 and name ~ '[\\u0600-\\u06FF]'`,
      [org],
    );
    checks.push({
      name: "Arabic customer names present",
      ok: arabicCustomers > 0,
      detail: `${arabicCustomers}`,
    });

    const inactive = {
      customer: await count(
        ctx,
        `select count(*)::int as n from public.customer where org_id = $1 and not active`,
        [org],
      ),
      supplier: await count(
        ctx,
        `select count(*)::int as n from public.supplier where org_id = $1 and not active`,
        [org],
      ),
      item: await count(
        ctx,
        `select count(*)::int as n from public.item where org_id = $1 and not active`,
        [org],
      ),
    };
    checks.push({
      name: "inactive customers, suppliers and items exist",
      ok: inactive.customer > 0 && inactive.supplier > 0 && inactive.item > 0,
      detail: `${inactive.customer}/${inactive.supplier}/${inactive.item}`,
    });

    const lowIds = layout.lowStockCandidates.map((i) => ctx.id("item", i));
    const lowLive = lowIds.length
      ? await count(
          ctx,
          `select count(*)::int as n from public.item where org_id = $1 and id = any($2::uuid[]) and min_qty > 0 and active`,
          [org, `{${lowIds.join(",")}}`],
        )
      : 0;
    checks.push({
      name: "reorder candidates carry a min_qty",
      ok: lowLive === lowIds.length,
      detail: `${lowLive}/${lowIds.length}`,
    });

    const withSupplier = await count(
      ctx,
      `select count(*)::int as n from public.item where org_id = $1 and preferred_supplier_id is not null`,
      [org],
    );
    checks.push({
      name: "items link to preferred suppliers",
      ok: withSupplier > 0,
      detail: `${withSupplier}`,
    });

    const fakeOnly = await count(
      ctx,
      `select count(*)::int as n from public.customer
       where org_id = $1 and (email not like '%@example.invalid'
         or (tax_reg_no is not null and tax_reg_no not like '1999%' and tax_reg_no not like '399999%')
         or phone not like '+9__ 50 000 %')`,
      [org],
    );
    checks.push({
      name: "only fake e-mails, TRNs and phones",
      ok: fakeOnly === 0,
      detail: `${fakeOnly} suspicious`,
    });

    const badAddress = await count(
      ctx,
      `select count(*)::int as n from public.crm_suppression
       where org_id = $1 and address !~ '^(\\+9[0-9]{11}|[a-z0-9.]+@example\\.invalid)$'`,
      [org],
    );
    checks.push({
      name: "suppression addresses are normalised and fake",
      ok: badAddress === 0,
      detail: `${badAddress}`,
    });

    if (company.profile.enables.bom) {
      const emptyActive = await count(
        ctx,
        `select count(*)::int as n from public.bom b where b.org_id = $1 and b.status <> 'draft'
         and not exists (select 1 from public.bom_line l where l.bom_id = b.id and l.org_id = b.org_id)`,
        [org],
      );
      checks.push({
        name: "active and archived recipes have components",
        ok: emptyActive === 0,
        detail: `${emptyActive} empty`,
      });

      const self = await count(
        ctx,
        `select count(*)::int as n from public.bom_line l join public.bom b on b.id = l.bom_id and b.org_id = l.org_id
         where l.org_id = $1 and l.component_item_id = b.item_id`,
        [org],
      );
      checks.push({ name: "no recipe contains its own parent", ok: self === 0 });

      const states = {
        draft: await count(
          ctx,
          `select count(*)::int as n from public.bom where org_id = $1 and status = 'draft'`,
          [org],
        ),
        active: await count(
          ctx,
          `select count(*)::int as n from public.bom where org_id = $1 and status = 'active'`,
          [org],
        ),
        archived: await count(
          ctx,
          `select count(*)::int as n from public.bom where org_id = $1 and status = 'archived'`,
          [org],
        ),
      };
      checks.push({
        name: "recipe states are mixed",
        ok: states.draft > 0 && states.active > 0 && states.archived > 0,
        detail: `${states.draft} draft / ${states.active} active / ${states.archived} archived`,
      });

      const viaService = layout.boms
        .filter((b) => b.viaService)
        .map((b) => ctx.id("bom", b.parent, b.version));
      const activated = viaService.length
        ? await count(
            ctx,
            `select count(*)::int as n from public.bom where org_id = $1 and id = any($2::uuid[]) and status = 'active'`,
            [org, `{${viaService.join(",")}}`],
          )
        : 0;
      checks.push({
        name: "service-activated recipes are active",
        ok: activated === viaService.length,
        detail: `${activated}/${viaService.length}`,
      });

      const depth3 = await count(
        ctx,
        `select count(*)::int as n
         from public.bom b1
         join public.bom_line l1 on l1.bom_id = b1.id and l1.org_id = b1.org_id
         join public.bom b2 on b2.item_id = l1.component_item_id and b2.org_id = b1.org_id and b2.status = 'active'
         join public.bom_line l2 on l2.bom_id = b2.id and l2.org_id = b2.org_id
         join public.bom b3 on b3.item_id = l2.component_item_id and b3.org_id = b2.org_id and b3.status = 'active'
         where b1.org_id = $1 and b1.status = 'active'`,
        [org],
      );
      checks.push({
        name: "recipes nest three levels deep",
        ok: depth3 > 0,
        detail: `${depth3} chains`,
      });
    }

    return checks;
  },
};
