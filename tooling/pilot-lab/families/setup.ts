/**
 * H33 Pilot Lab — family `setup`: the organisation's structure and configuration.
 *
 * Everything a company shapes before its first document: departments and cost
 * centres, positions, teams, work locations, shifts; warehouses with their
 * location trees and the unit set; tax codes and the VAT profile; the fiscal
 * calendar 2023–2026 and the chart of accounts; bank accounts; pay groups and
 * periods; leave types and policies; asset categories; CRM pipelines; the
 * document folder tree; a small FX rate book; the Saudi company's
 * establishments (no country pack adopted); the H31 app identity; and a few
 * personas' guided-tour progress.
 *
 * Two halves, on purpose:
 *   - `planSetup(ctx)` is PURE. It builds every directly-inserted row and the
 *     exact counts the domain services will add. `plan()` and the unit test read
 *     it; nothing in it touches a database.
 *   - `runServices(ctx, …)` drives the real finance services for the things
 *     that have a state machine or a guard (fiscal years and period status,
 *     the chart, bank accounts with their GL accounts, the UAE VAT pack and
 *     profile). It never runs in dry-run.
 *
 * Bulk rows are inserted in their born state with legal values; nothing here
 * fakes a terminal state.
 */
import { CHART_TEMPLATE, CHART_TEMPLATE_VERSION } from "@/modules/finance/chart";
import type {
  Check,
  Company,
  CompanyKey,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
} from "../types";
import { address, email, historyDays, iban, phone, taxNo } from "./_shared";

const FAMILY = "setup";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Bi = { en: string; ar: string };
export type PeriodStatus = "open" | "soft_closed" | "locked";

// ── Fiscal calendar law ──────────────────────────────────────────────────────

export const FISCAL_YEARS = [2023, 2024, 2025, 2026] as const;

/** 2023–2024 closed, 2025 mixed (a company behind on its close), 2026 open. */
export function periodStatusFor(year: number, periodNo: number): PeriodStatus {
  if (year <= 2024) return "locked";
  if (year === 2025) return periodNo <= 8 ? "locked" : periodNo <= 10 ? "soft_closed" : "open";
  return "open";
}

// ── Handoff ─────────────────────────────────────────────────────────────────

export type SetupHandoff = {
  departments: Record<string, string>;
  costCentres: Record<string, string>;
  positions: Record<string, { id: string; department: string }>;
  teams: Record<string, string>;
  workLocations: Record<string, string>;
  shifts: Record<string, string>;
  warehouses: Record<
    string,
    {
      id: string;
      receivingLocationId: string;
      issueLocationId: string;
      locations: Record<string, string>;
    }
  >;
  units: Record<string, { id: string; dimension: string; factorToBase: number; isBase: boolean }>;
  taxCodes: Record<string, string>;
  vatProfile: { trn: string; emirate: string; periodicity: string; registered: boolean } | null;
  glChart: {
    installed: boolean;
    templateVersion: string;
    accountsBySystemKey: Record<string, string>;
  };
  fiscalYears: Record<string, string>;
  fiscalPeriods: Array<{
    id: string;
    year: number;
    periodNo: number;
    startsOn: string;
    endsOn: string;
    status: PeriodStatus;
  }>;
  bankAccounts: Record<string, { id: string; glAccountId: string; kind: string; currency: string }>;
  payGroups: { activeId: string; periods: Record<string, string> };
  leaveTypes: Record<string, { id: string; policyId: string }>;
  assetCategories: Record<string, string>;
  pipelines: Record<
    string,
    { id: string; stages: Record<string, { id: string; category: string }> }
  >;
  folders: Record<string, string>;
  establishments: Record<string, string>;
};

// ── Company blueprints (names are invented; every one is bilingual) ─────────

type DeptSpec = { code: string; parent?: string; en: string; ar: string; active?: boolean };
type PosSpec = { key: string; dept: string; en: string; ar: string; grade: string };
type TeamSpec = { key: string; name: string; kind: "trade" | "line"; active?: boolean };
type LocSpec = { key: string; en: string; ar: string; city: string };
type ShiftSpec = {
  key: string;
  en: string;
  ar: string;
  start: string;
  end: string;
  brk: number;
  active?: boolean;
};
type ZoneSpec = { code: string; en: string; ar: string; bins: number };
type WhSpec = {
  code: string;
  en: string;
  ar: string;
  city: string;
  zones: ZoneSpec[];
  returns?: boolean;
};
type CatSpec = {
  code: string;
  parent?: string;
  en: string;
  ar: string;
  life?: number;
  residual?: number;
  active?: boolean;
};
type StageSpec = {
  key: string;
  en: string;
  ar: string;
  category: "open" | "won" | "lost";
  requirements?: string[];
  probability?: number;
  maxAge?: number;
};
type PipelineSpec = { key: string; en: string; ar: string; kind: string; stages: StageSpec[] };
type FolderSpec = {
  key: string;
  en: string;
  ar: string;
  children?: FolderSpec[];
  archived?: boolean;
};

const CORE_DEPARTMENTS: DeptSpec[] = [
  { code: "MGMT", en: "Management", ar: "الإدارة العامة" },
  { code: "FIN", en: "Finance & Accounts", ar: "المالية والحسابات" },
  { code: "HR", en: "People & Culture", ar: "الموارد البشرية" },
  { code: "OPS", en: "Operations", ar: "العمليات" },
  { code: "COMM", en: "Commercial", ar: "الشؤون التجارية" },
  { code: "SUPPLY", en: "Supply Chain", ar: "سلسلة الإمداد" },
];

const COMPANY_DEPARTMENTS: Record<CompanyKey, DeptSpec[]> = {
  gulfbuild: [
    { code: "PRJ", parent: "OPS", en: "Projects", ar: "المشاريع" },
    { code: "SITE", parent: "OPS", en: "Site Operations", ar: "عمليات الموقع" },
    { code: "MEP", parent: "OPS", en: "MEP Works", ar: "الأعمال الكهروميكانيكية" },
    { code: "QHSE", parent: "OPS", en: "QHSE", ar: "الجودة والصحة والسلامة والبيئة" },
    { code: "PLANT", parent: "SUPPLY", en: "Plant & Equipment", ar: "المعدات والآليات" },
    { code: "STORE", parent: "SUPPLY", en: "Central Stores", ar: "المخازن المركزية" },
    { code: "EST", parent: "COMM", en: "Estimation & Tendering", ar: "التقدير والعطاءات" },
  ],
  tradeline: [
    { code: "WH", parent: "SUPPLY", en: "Warehousing", ar: "المستودعات" },
    { code: "LOG", parent: "SUPPLY", en: "Logistics & Fleet", ar: "الخدمات اللوجستية والأسطول" },
    { code: "PROC", parent: "SUPPLY", en: "Procurement", ar: "المشتريات" },
    { code: "SALES", parent: "COMM", en: "Sales", ar: "المبيعات" },
    { code: "CS", parent: "COMM", en: "Customer Service", ar: "خدمة العملاء" },
    { code: "MKT", parent: "COMM", en: "Marketing", ar: "التسويق" },
  ],
  saudimfg: [
    { code: "PROD", parent: "OPS", en: "Production", ar: "الإنتاج" },
    { code: "QC", parent: "OPS", en: "Quality Control", ar: "مراقبة الجودة" },
    { code: "MAINT", parent: "OPS", en: "Maintenance", ar: "الصيانة" },
    { code: "ENG", parent: "OPS", en: "Engineering", ar: "الهندسة" },
    { code: "STORE", parent: "SUPPLY", en: "Stores", ar: "المخازن" },
    { code: "PROC", parent: "SUPPLY", en: "Procurement", ar: "المشتريات" },
    { code: "SALES", parent: "COMM", en: "Sales", ar: "المبيعات" },
  ],
  consult: [
    { code: "ADV", parent: "OPS", en: "Advisory", ar: "الاستشارات" },
    { code: "DEL", parent: "OPS", en: "Delivery & PMO", ar: "التنفيذ ومكتب إدارة المشاريع" },
    { code: "RES", parent: "OPS", en: "Research", ar: "البحوث" },
    { code: "BD", parent: "COMM", en: "Business Development", ar: "تطوير الأعمال" },
    { code: "ADMIN", parent: "MGMT", en: "Administration", ar: "الشؤون الإدارية" },
  ],
  facilico: [
    { code: "FIELD", parent: "OPS", en: "Field Operations", ar: "العمليات الميدانية" },
    { code: "MAINT", parent: "OPS", en: "Planned Maintenance", ar: "الصيانة المخططة" },
    { code: "HELP", parent: "OPS", en: "Helpdesk", ar: "مكتب المساعدة" },
    { code: "HSE", parent: "OPS", en: "HSE", ar: "الصحة والسلامة" },
    { code: "STORE", parent: "SUPPLY", en: "Spare Parts Store", ar: "مخزن قطع الغيار" },
    { code: "CONTR", parent: "COMM", en: "Contracts", ar: "العقود" },
  ],
};

const LEGACY_DEPARTMENT: DeptSpec = {
  code: "LEGACY",
  parent: "OPS",
  en: "Legacy Projects (closed)",
  ar: "المشاريع القديمة (مغلقة)",
  active: false,
};

const CORE_POSITIONS: PosSpec[] = [
  { key: "general_manager", dept: "MGMT", en: "General Manager", ar: "المدير العام", grade: "G1" },
  { key: "finance_manager", dept: "FIN", en: "Finance Manager", ar: "مدير المالية", grade: "G2" },
  { key: "accountant", dept: "FIN", en: "Accountant", ar: "محاسب", grade: "G4" },
  { key: "hr_manager", dept: "HR", en: "HR Manager", ar: "مدير الموارد البشرية", grade: "G2" },
  { key: "hr_officer", dept: "HR", en: "HR Officer", ar: "أخصائي موارد بشرية", grade: "G4" },
  {
    key: "operations_manager",
    dept: "OPS",
    en: "Operations Manager",
    ar: "مدير العمليات",
    grade: "G2",
  },
  {
    key: "procurement_officer",
    dept: "SUPPLY",
    en: "Procurement Officer",
    ar: "مسؤول المشتريات",
    grade: "G4",
  },
  { key: "storekeeper", dept: "SUPPLY", en: "Storekeeper", ar: "أمين مخزن", grade: "G5" },
  { key: "sales_executive", dept: "COMM", en: "Sales Executive", ar: "تنفيذي مبيعات", grade: "G4" },
  {
    key: "admin_assistant",
    dept: "MGMT",
    en: "Administrative Assistant",
    ar: "مساعد إداري",
    grade: "G5",
  },
  { key: "driver", dept: "SUPPLY", en: "Driver", ar: "سائق", grade: "G6" },
];

const COMPANY_POSITIONS: Record<CompanyKey, PosSpec[]> = {
  gulfbuild: [
    { key: "project_manager", dept: "PRJ", en: "Project Manager", ar: "مدير مشروع", grade: "G2" },
    { key: "site_engineer", dept: "SITE", en: "Site Engineer", ar: "مهندس موقع", grade: "G3" },
    { key: "foreman", dept: "SITE", en: "Foreman", ar: "مراقب عمال", grade: "G5" },
    { key: "skilled_labourer", dept: "SITE", en: "Skilled Labourer", ar: "عامل ماهر", grade: "G6" },
    {
      key: "mep_technician",
      dept: "MEP",
      en: "MEP Technician",
      ar: "فني كهروميكانيك",
      grade: "G5",
    },
    { key: "safety_officer", dept: "QHSE", en: "Safety Officer", ar: "مسؤول السلامة", grade: "G4" },
    {
      key: "quantity_surveyor",
      dept: "EST",
      en: "Quantity Surveyor",
      ar: "مسّاح كميات",
      grade: "G3",
    },
  ],
  tradeline: [
    {
      key: "warehouse_supervisor",
      dept: "WH",
      en: "Warehouse Supervisor",
      ar: "مشرف مستودع",
      grade: "G3",
    },
    { key: "picker_packer", dept: "WH", en: "Picker / Packer", ar: "عامل تجهيز", grade: "G6" },
    {
      key: "fleet_coordinator",
      dept: "LOG",
      en: "Fleet Coordinator",
      ar: "منسق أسطول",
      grade: "G4",
    },
    {
      key: "key_account_manager",
      dept: "SALES",
      en: "Key Account Manager",
      ar: "مدير حسابات رئيسية",
      grade: "G3",
    },
    {
      key: "customer_service_agent",
      dept: "CS",
      en: "Customer Service Agent",
      ar: "موظف خدمة عملاء",
      grade: "G5",
    },
  ],
  saudimfg: [
    {
      key: "production_supervisor",
      dept: "PROD",
      en: "Production Supervisor",
      ar: "مشرف إنتاج",
      grade: "G3",
    },
    { key: "cnc_operator", dept: "PROD", en: "CNC Operator", ar: "مشغّل CNC", grade: "G5" },
    { key: "welder", dept: "PROD", en: "Welder", ar: "لحّام", grade: "G5" },
    { key: "quality_inspector", dept: "QC", en: "Quality Inspector", ar: "مفتش جودة", grade: "G4" },
    {
      key: "maintenance_technician",
      dept: "MAINT",
      en: "Maintenance Technician",
      ar: "فني صيانة",
      grade: "G5",
    },
    {
      key: "process_engineer",
      dept: "ENG",
      en: "Process Engineer",
      ar: "مهندس عمليات",
      grade: "G3",
    },
  ],
  consult: [
    {
      key: "principal_consultant",
      dept: "ADV",
      en: "Principal Consultant",
      ar: "مستشار رئيسي",
      grade: "G2",
    },
    {
      key: "senior_consultant",
      dept: "ADV",
      en: "Senior Consultant",
      ar: "مستشار أول",
      grade: "G3",
    },
    { key: "analyst", dept: "ADV", en: "Analyst", ar: "محلل", grade: "G4" },
    {
      key: "project_coordinator",
      dept: "DEL",
      en: "Project Coordinator",
      ar: "منسق مشاريع",
      grade: "G4",
    },
    {
      key: "bd_manager",
      dept: "BD",
      en: "Business Development Manager",
      ar: "مدير تطوير الأعمال",
      grade: "G3",
    },
  ],
  facilico: [
    {
      key: "field_supervisor",
      dept: "FIELD",
      en: "Field Supervisor",
      ar: "مشرف ميداني",
      grade: "G3",
    },
    { key: "hvac_technician", dept: "FIELD", en: "HVAC Technician", ar: "فني تكييف", grade: "G5" },
    { key: "electrician", dept: "FIELD", en: "Electrician", ar: "كهربائي", grade: "G5" },
    { key: "plumber", dept: "FIELD", en: "Plumber", ar: "سباك", grade: "G5" },
    {
      key: "helpdesk_agent",
      dept: "HELP",
      en: "Helpdesk Agent",
      ar: "موظف مكتب مساعدة",
      grade: "G5",
    },
    {
      key: "maintenance_planner",
      dept: "MAINT",
      en: "Maintenance Planner",
      ar: "مخطط صيانة",
      grade: "G4",
    },
    { key: "hse_officer", dept: "HSE", en: "HSE Officer", ar: "مسؤول الصحة والسلامة", grade: "G4" },
  ],
};

const COMPANY_TEAMS: Record<CompanyKey, TeamSpec[]> = {
  gulfbuild: [
    { key: "civil_a", name: "Civil Crew A", kind: "trade" },
    { key: "civil_b", name: "Civil Crew B", kind: "trade" },
    { key: "mep", name: "MEP Crew", kind: "trade" },
    { key: "finishing", name: "Finishing Crew", kind: "trade" },
    { key: "plant", name: "Plant Operators", kind: "trade" },
  ],
  tradeline: [
    { key: "picking", name: "Picking Line", kind: "line" },
    { key: "packing", name: "Packing Line", kind: "line" },
    { key: "fleet", name: "Delivery Fleet", kind: "line" },
    { key: "field_sales", name: "Field Sales", kind: "trade" },
  ],
  saudimfg: [
    { key: "machining_1", name: "خط التشغيل 1", kind: "line" },
    { key: "machining_2", name: "خط التشغيل 2", kind: "line" },
    { key: "assembly", name: "خط التجميع", kind: "line" },
    { key: "welding", name: "ورشة اللحام", kind: "trade" },
    { key: "qc", name: "فريق الجودة", kind: "trade" },
  ],
  consult: [
    { key: "pod_a", name: "Advisory Pod A", kind: "trade" },
    { key: "pod_b", name: "Advisory Pod B", kind: "trade" },
    { key: "research", name: "Research Desk", kind: "trade" },
  ],
  facilico: [
    { key: "hvac", name: "HVAC Crew", kind: "trade" },
    { key: "electrical", name: "Electrical Crew", kind: "trade" },
    { key: "plumbing", name: "Plumbing Crew", kind: "trade" },
    { key: "soft_services", name: "Soft Services Crew", kind: "trade" },
    { key: "night_response", name: "Night Response", kind: "trade" },
  ],
};
const LEGACY_TEAM: TeamSpec = {
  key: "legacy",
  name: "Legacy Crew (disbanded)",
  kind: "trade",
  active: false,
};

const COMPANY_LOCATIONS: Record<CompanyKey, LocSpec[]> = {
  gulfbuild: [
    { key: "hq", en: "Head Office — Abu Dhabi", ar: "المكتب الرئيسي — أبوظبي", city: "Abu Dhabi" },
    {
      key: "site_alain",
      en: "Site Office — Al Ain Phase 2",
      ar: "مكتب الموقع — العين المرحلة الثانية",
      city: "Al Ain",
    },
    {
      key: "site_marina",
      en: "Site Office — Abu Dhabi Marina",
      ar: "مكتب الموقع — مارينا أبوظبي",
      city: "Abu Dhabi",
    },
    { key: "yard", en: "Plant Yard — Mussafah", ar: "ساحة المعدات — مصفح", city: "Abu Dhabi" },
  ],
  tradeline: [
    { key: "hq", en: "Head Office — Dubai", ar: "المكتب الرئيسي — دبي", city: "Dubai" },
    {
      key: "jafz",
      en: "Jebel Ali Distribution Centre",
      ar: "مركز التوزيع — جبل علي",
      city: "Dubai",
    },
    { key: "shj", en: "Sharjah Branch", ar: "فرع الشارقة", city: "Sharjah" },
    { key: "auh", en: "Abu Dhabi Branch", ar: "فرع أبوظبي", city: "Abu Dhabi" },
  ],
  saudimfg: [
    {
      key: "plant",
      en: "Riyadh Plant — 2nd Industrial City",
      ar: "مصنع الرياض — المدينة الصناعية الثانية",
      city: "Riyadh",
    },
    { key: "hq", en: "Riyadh Office", ar: "مكتب الرياض", city: "Riyadh" },
    { key: "dmm", en: "Dammam Branch", ar: "فرع الدمام", city: "Dammam" },
  ],
  consult: [
    { key: "hq", en: "Dubai Office", ar: "مكتب دبي", city: "Dubai" },
    { key: "auh", en: "Abu Dhabi Office", ar: "مكتب أبوظبي", city: "Abu Dhabi" },
    { key: "remote", en: "Client Sites / Remote", ar: "مواقع العملاء / عن بُعد", city: "Dubai" },
  ],
  facilico: [
    { key: "hq", en: "Head Office — Sharjah", ar: "المكتب الرئيسي — الشارقة", city: "Sharjah" },
    {
      key: "auh",
      en: "Regional Office — Abu Dhabi",
      ar: "المكتب الإقليمي — أبوظبي",
      city: "Abu Dhabi",
    },
    { key: "sites", en: "Client Sites Pool", ar: "مواقع العملاء", city: "Dubai" },
  ],
};

const SHIFTS: Record<string, ShiftSpec> = {
  office: {
    key: "office",
    en: "Office Hours",
    ar: "ساعات المكتب",
    start: "08:30",
    end: "17:30",
    brk: 60,
  },
  day: {
    key: "day",
    en: "Day Shift",
    ar: "الوردية النهارية",
    start: "07:00",
    end: "16:00",
    brk: 60,
  },
  morning: {
    key: "morning",
    en: "Morning Shift",
    ar: "الوردية الصباحية",
    start: "06:00",
    end: "14:00",
    brk: 30,
  },
  evening: {
    key: "evening",
    en: "Evening Shift",
    ar: "الوردية المسائية",
    start: "14:00",
    end: "22:00",
    brk: 30,
  },
  night: {
    key: "night",
    en: "Night Shift",
    ar: "الوردية الليلية",
    start: "22:00",
    end: "06:00",
    brk: 30,
  },
  ramadan: {
    key: "ramadan",
    en: "Ramadan Hours",
    ar: "ساعات رمضان",
    start: "09:00",
    end: "15:00",
    brk: 0,
  },
  split_retired: {
    key: "split_retired",
    en: "Summer Split Shift (retired)",
    ar: "وردية الصيف المقسمة (ملغاة)",
    start: "06:00",
    end: "12:00",
    brk: 0,
    active: false,
  },
};
const COMPANY_SHIFTS: Record<CompanyKey, string[]> = {
  gulfbuild: ["day", "morning", "evening", "split_retired"],
  tradeline: ["office", "morning", "evening"],
  saudimfg: ["morning", "evening", "night", "ramadan"],
  consult: ["office"],
  facilico: ["day", "evening", "night", "split_retired"],
};

const COMPANY_WAREHOUSES: Record<CompanyKey, WhSpec[]> = {
  gulfbuild: [
    {
      code: "MAIN",
      en: "Central Stores — Mussafah Yard",
      ar: "المخازن المركزية — ساحة مصفح",
      city: "Abu Dhabi",
      zones: [
        { code: "A", en: "Rack A — consumables", ar: "الرف أ — مستهلكات", bins: 6 },
        { code: "B", en: "Rack B — MEP materials", ar: "الرف ب — مواد كهروميكانيكية", bins: 6 },
      ],
    },
    {
      code: "SITE-ALN",
      en: "Site Store — Al Ain Phase 2",
      ar: "مخزن الموقع — العين المرحلة الثانية",
      city: "Al Ain",
      zones: [{ code: "S", en: "Site laydown", ar: "منطقة التخزين بالموقع", bins: 4 }],
    },
    {
      code: "SITE-AUH",
      en: "Site Store — Abu Dhabi Marina",
      ar: "مخزن الموقع — مارينا أبوظبي",
      city: "Abu Dhabi",
      zones: [{ code: "S", en: "Site laydown", ar: "منطقة التخزين بالموقع", bins: 4 }],
    },
  ],
  tradeline: [
    {
      code: "JAFZ",
      en: "Jebel Ali Distribution Centre",
      ar: "مركز التوزيع — جبل علي",
      city: "Dubai",
      returns: true,
      zones: [
        { code: "A", en: "Ambient aisle A", ar: "الممر أ — درجة حرارة عادية", bins: 8 },
        { code: "B", en: "Ambient aisle B", ar: "الممر ب — درجة حرارة عادية", bins: 8 },
        { code: "C", en: "Chilled room", ar: "غرفة التبريد", bins: 4 },
      ],
    },
    {
      code: "SHJ",
      en: "Sharjah Branch Store",
      ar: "مخزن فرع الشارقة",
      city: "Sharjah",
      zones: [{ code: "A", en: "Branch racks", ar: "أرفف الفرع", bins: 4 }],
    },
    {
      code: "AUH",
      en: "Abu Dhabi Branch Store",
      ar: "مخزن فرع أبوظبي",
      city: "Abu Dhabi",
      zones: [{ code: "A", en: "Branch racks", ar: "أرفف الفرع", bins: 4 }],
    },
  ],
  saudimfg: [
    {
      code: "RM",
      en: "Raw Material Store",
      ar: "مخزن المواد الخام",
      city: "Riyadh",
      zones: [
        { code: "A", en: "Steel & alloys", ar: "الفولاذ والسبائك", bins: 6 },
        { code: "B", en: "Consumables", ar: "المستهلكات", bins: 4 },
      ],
    },
    {
      code: "WIP",
      en: "Shop Floor WIP",
      ar: "أرضية المصنع — قيد التشغيل",
      city: "Riyadh",
      zones: [{ code: "L", en: "Line buffers", ar: "مخازن الخطوط المؤقتة", bins: 3 }],
    },
    {
      code: "FG",
      en: "Finished Goods Store",
      ar: "مخزن المنتجات التامة",
      city: "Riyadh",
      zones: [{ code: "F", en: "FG racks", ar: "أرفف المنتجات التامة", bins: 6 }],
    },
  ],
  consult: [
    {
      code: "OFF",
      en: "Office Supplies Store",
      ar: "مخزن اللوازم المكتبية",
      city: "Dubai",
      zones: [{ code: "A", en: "Cupboard A", ar: "الخزانة أ", bins: 3 }],
    },
  ],
  facilico: [
    {
      code: "MAIN",
      en: "Central Store — Al Quoz",
      ar: "المخزن المركزي — القوز",
      city: "Dubai",
      zones: [
        { code: "A", en: "Consumables", ar: "المستهلكات", bins: 6 },
        { code: "B", en: "Chemicals", ar: "المواد الكيميائية", bins: 4 },
      ],
    },
    {
      code: "SPARE",
      en: "Spare Parts Store",
      ar: "مخزن قطع الغيار",
      city: "Dubai",
      zones: [{ code: "P", en: "Parts racks", ar: "أرفف القطع", bins: 8 }],
    },
    {
      code: "VAN",
      en: "Van Stock — mobile crews",
      ar: "مخزون المركبات — الفرق المتنقلة",
      city: "Dubai",
      zones: [{ code: "V", en: "Van bins", ar: "صناديق المركبات", bins: 4 }],
    },
  ],
};

type UnitSpec = { code: string; en: string; ar: string; dimension: string; factor: number };
const UNITS: UnitSpec[] = [
  { code: "pcs", en: "Piece", ar: "قطعة", dimension: "count", factor: 1 },
  { code: "pair", en: "Pair", ar: "زوج", dimension: "count", factor: 2 },
  { code: "pack6", en: "Pack of 6", ar: "عبوة 6", dimension: "count", factor: 6 },
  { code: "dz", en: "Dozen", ar: "دستة", dimension: "count", factor: 12 },
  { code: "box24", en: "Box of 24", ar: "صندوق 24", dimension: "count", factor: 24 },
  { code: "kg", en: "Kilogram", ar: "كيلوغرام", dimension: "mass", factor: 1 },
  { code: "g", en: "Gram", ar: "غرام", dimension: "mass", factor: 0.001 },
  { code: "t", en: "Tonne", ar: "طن", dimension: "mass", factor: 1000 },
  { code: "m", en: "Metre", ar: "متر", dimension: "length", factor: 1 },
  { code: "cm", en: "Centimetre", ar: "سنتيمتر", dimension: "length", factor: 0.01 },
  { code: "mm", en: "Millimetre", ar: "مليمتر", dimension: "length", factor: 0.001 },
  { code: "roll50", en: "Roll (50 m)", ar: "لفة (50 م)", dimension: "length", factor: 50 },
  { code: "l", en: "Litre", ar: "لتر", dimension: "volume", factor: 1 },
  { code: "ml", en: "Millilitre", ar: "مليلتر", dimension: "volume", factor: 0.001 },
  { code: "drum200", en: "Drum (200 l)", ar: "برميل (200 لتر)", dimension: "volume", factor: 200 },
  { code: "m2", en: "Square metre", ar: "متر مربع", dimension: "area", factor: 1 },
  { code: "sqft", en: "Square foot", ar: "قدم مربع", dimension: "area", factor: 0.09290304 },
  { code: "hr", en: "Hour", ar: "ساعة", dimension: "time", factor: 1 },
  { code: "day", en: "Man-day (8 h)", ar: "يوم عمل (8 ساعات)", dimension: "time", factor: 8 },
  { code: "wk", en: "Man-week (40 h)", ar: "أسبوع عمل (40 ساعة)", dimension: "time", factor: 40 },
];

const CORE_ASSET_CATEGORIES: CatSpec[] = [
  { code: "VEH", en: "Vehicles", ar: "المركبات", life: 60, residual: 10 },
  {
    code: "VEH-LCV",
    parent: "VEH",
    en: "Light commercial vehicles",
    ar: "مركبات تجارية خفيفة",
    life: 60,
    residual: 10,
  },
  { code: "VEH-CAR", parent: "VEH", en: "Cars", ar: "سيارات", life: 60, residual: 15 },
  { code: "IT", en: "IT equipment", ar: "معدات تقنية المعلومات", life: 36, residual: 0 },
  {
    code: "IT-LAP",
    parent: "IT",
    en: "Laptops & workstations",
    ar: "حواسيب محمولة ومحطات عمل",
    life: 36,
    residual: 0,
  },
  {
    code: "IT-NET",
    parent: "IT",
    en: "Network & servers",
    ar: "الشبكات والخوادم",
    life: 48,
    residual: 0,
  },
  {
    code: "OFF",
    en: "Office furniture & fittings",
    ar: "الأثاث والتجهيزات المكتبية",
    life: 84,
    residual: 0,
  },
  { code: "TOOL", en: "Tools & instruments", ar: "العدد والأدوات", life: 48, residual: 0 },
  {
    code: "OLD",
    en: "Retired asset class",
    ar: "فئة أصول ملغاة",
    life: 12,
    residual: 0,
    active: false,
  },
];
const COMPANY_ASSET_CATEGORIES: Record<CompanyKey, CatSpec[]> = {
  gulfbuild: [
    { code: "PLANT", en: "Plant & machinery", ar: "المعدات والآليات", life: 120, residual: 5 },
    {
      code: "PLANT-EXC",
      parent: "PLANT",
      en: "Excavators & loaders",
      ar: "حفارات ولوادر",
      life: 120,
      residual: 10,
    },
    { code: "PLANT-GEN", parent: "PLANT", en: "Generators", ar: "مولدات", life: 96, residual: 5 },
  ],
  tradeline: [
    {
      code: "MHE",
      en: "Material handling equipment",
      ar: "معدات مناولة المواد",
      life: 84,
      residual: 5,
    },
    { code: "MHE-FLT", parent: "MHE", en: "Forklifts", ar: "رافعات شوكية", life: 84, residual: 5 },
  ],
  saudimfg: [
    { code: "PLANT", en: "Plant & machinery", ar: "المعدات والآليات", life: 120, residual: 5 },
    {
      code: "PLANT-CNC",
      parent: "PLANT",
      en: "CNC machines",
      ar: "ماكينات CNC",
      life: 120,
      residual: 5,
    },
    {
      code: "PLANT-WELD",
      parent: "PLANT",
      en: "Welding equipment",
      ar: "معدات اللحام",
      life: 72,
      residual: 0,
    },
  ],
  consult: [],
  facilico: [
    {
      code: "HVAC",
      en: "HVAC & MEP equipment",
      ar: "معدات التكييف والكهروميكانيك",
      life: 120,
      residual: 5,
    },
    {
      code: "TOOL-TEST",
      parent: "TOOL",
      en: "Test instruments",
      ar: "أجهزة الفحص",
      life: 48,
      residual: 0,
    },
  ],
};

/** The product's default stage keys, so `ensurePipelineStages` finds them later. */
const DEFAULT_STAGES: StageSpec[] = [
  {
    key: "new",
    en: "New",
    ar: "جديدة",
    category: "open",
    requirements: ["customer"],
    probability: 10,
    maxAge: 30,
  },
  {
    key: "contacted",
    en: "Contacted",
    ar: "تم التواصل",
    category: "open",
    requirements: ["contact"],
    probability: 20,
    maxAge: 30,
  },
  {
    key: "qualified",
    en: "Qualified",
    ar: "مؤهلة",
    category: "open",
    requirements: ["value", "close_date"],
    probability: 40,
    maxAge: 45,
  },
  {
    key: "proposal",
    en: "Proposal",
    ar: "عرض مقدم",
    category: "open",
    requirements: ["quote"],
    probability: 60,
    maxAge: 45,
  },
  {
    key: "negotiation",
    en: "Negotiation",
    ar: "تفاوض",
    category: "open",
    requirements: ["stakeholder", "next_action"],
    probability: 80,
    maxAge: 30,
  },
  { key: "won", en: "Won", ar: "مكسوبة", category: "won", probability: 100 },
  { key: "lost", en: "Lost", ar: "مفقودة", category: "lost", probability: 0 },
];
const RENEWALS_PIPELINE: PipelineSpec = {
  key: "renewals",
  en: "Contract renewals",
  ar: "تجديد العقود",
  kind: "renewal",
  stages: [
    {
      key: "rn_due",
      en: "Renewal due",
      ar: "تجديد مستحق",
      category: "open",
      requirements: ["customer"],
      probability: 50,
      maxAge: 60,
    },
    {
      key: "rn_contacted",
      en: "Client contacted",
      ar: "تم التواصل مع العميل",
      category: "open",
      requirements: ["contact"],
      probability: 65,
      maxAge: 30,
    },
    {
      key: "rn_proposed",
      en: "Renewal proposed",
      ar: "عرض التجديد مقدم",
      category: "open",
      requirements: ["value", "quote"],
      probability: 80,
      maxAge: 30,
    },
    { key: "rn_renewed", en: "Renewed", ar: "تم التجديد", category: "won", probability: 100 },
    { key: "rn_churned", en: "Churned", ar: "لم يُجدَّد", category: "lost", probability: 0 },
  ],
};
const EXPANSION_PIPELINE: PipelineSpec = {
  key: "expansion",
  en: "Account expansion",
  ar: "توسيع الحسابات",
  kind: "expansion",
  stages: [
    {
      key: "ex_identified",
      en: "Opportunity identified",
      ar: "فرصة محددة",
      category: "open",
      requirements: ["customer"],
      probability: 30,
      maxAge: 45,
    },
    {
      key: "ex_proposed",
      en: "Range proposed",
      ar: "تشكيلة مقترحة",
      category: "open",
      requirements: ["value", "product"],
      probability: 60,
      maxAge: 45,
    },
    { key: "ex_won", en: "Range added", ar: "أُضيفت التشكيلة", category: "won", probability: 100 },
    { key: "ex_lost", en: "Declined", ar: "مرفوضة", category: "lost", probability: 0 },
  ],
};
const COMPANY_PIPELINES: Record<CompanyKey, PipelineSpec[]> = {
  gulfbuild: [],
  tradeline: [EXPANSION_PIPELINE],
  saudimfg: [],
  consult: [RENEWALS_PIPELINE],
  facilico: [RENEWALS_PIPELINE],
};

const OPS_FOLDERS: Record<CompanyKey, FolderSpec[]> = {
  gulfbuild: [
    { key: "ops/site_reports", en: "Site reports", ar: "تقارير الموقع" },
    { key: "ops/method_statements", en: "Method statements", ar: "بيانات طرق التنفيذ" },
  ],
  tradeline: [
    { key: "ops/delivery_notes", en: "Delivery notes", ar: "مذكرات التسليم" },
    { key: "ops/returns", en: "Returns", ar: "المرتجعات" },
  ],
  saudimfg: [
    { key: "ops/work_orders", en: "Work orders", ar: "أوامر العمل" },
    { key: "ops/quality_records", en: "Quality records", ar: "سجلات الجودة" },
  ],
  consult: [
    { key: "ops/proposals", en: "Proposals", ar: "العروض" },
    { key: "ops/deliverables", en: "Deliverables", ar: "المخرجات" },
  ],
  facilico: [
    { key: "ops/work_orders", en: "Work orders", ar: "أوامر العمل" },
    { key: "ops/ppm_schedules", en: "PPM schedules", ar: "جداول الصيانة الوقائية" },
  ],
};
function folderTree(company: Company): FolderSpec[] {
  return [
    {
      key: "contracts",
      en: "Contracts",
      ar: "العقود",
      children: [
        { key: "contracts/customer", en: "Customer contracts", ar: "عقود العملاء" },
        { key: "contracts/supplier", en: "Supplier agreements", ar: "اتفاقيات المورّدين" },
        { key: "contracts/employment", en: "Employment contracts", ar: "عقود العمل" },
      ],
    },
    {
      key: "finance",
      en: "Finance",
      ar: "المالية",
      children: [
        { key: "finance/bank_audit", en: "Bank & audit", ar: "البنك والتدقيق" },
        { key: "finance/tax", en: "Tax filings", ar: "الإقرارات الضريبية" },
      ],
    },
    {
      key: "people",
      en: "People & policies",
      ar: "الموظفون والسياسات",
      children: [
        { key: "people/policies", en: "Policies — السياسات", ar: "السياسات" },
        { key: "people/forms", en: "Forms & templates", ar: "النماذج والقوالب" },
      ],
    },
    { key: "ops", en: "Operations", ar: "العمليات", children: OPS_FOLDERS[company.key] },
    { key: "archive_2023", en: "Archive 2023", ar: "أرشيف 2023", archived: true },
  ];
}

type LeaveSpec = {
  key: string;
  en: string;
  ar: string;
  paid: boolean;
  attachment: boolean;
  basis: "working_days" | "calendar_days";
  halfDay: boolean;
  accrual: "annual_fixed" | "monthly_accrual" | "none";
  annualDays: number | null;
  carryover: number | null;
  minService: number | null;
  rules: Record<string, unknown>;
};
function leaveTypes(company: Company): LeaveSpec[] {
  const sa = company.country === "SA";
  const list: LeaveSpec[] = [
    {
      key: "annual",
      en: "Annual leave",
      ar: "إجازة سنوية",
      paid: true,
      attachment: false,
      basis: "calendar_days",
      halfDay: true,
      accrual: "monthly_accrual",
      annualDays: sa ? 21 : 30,
      carryover: sa ? 21 : 30,
      minService: 6,
      rules: sa ? { after_five_years_days: 30 } : { first_six_months_days_per_month: 2 },
    },
    {
      key: "sick",
      en: "Sick leave",
      ar: "إجازة مرضية",
      paid: true,
      attachment: true,
      basis: "calendar_days",
      halfDay: false,
      accrual: "annual_fixed",
      annualDays: sa ? 120 : 90,
      carryover: 0,
      minService: 3,
      rules: sa
        ? {
            tiers: [
              { days: 30, pay: 1 },
              { days: 60, pay: 0.75 },
              { days: 30, pay: 0 },
            ],
          }
        : {
            tiers: [
              { days: 15, pay: 1 },
              { days: 30, pay: 0.5 },
              { days: 45, pay: 0 },
            ],
          },
    },
    {
      key: "unpaid",
      en: "Unpaid leave",
      ar: "إجازة بدون راتب",
      paid: false,
      attachment: false,
      basis: "calendar_days",
      halfDay: false,
      accrual: "none",
      annualDays: null,
      carryover: null,
      minService: 0,
      rules: {},
    },
    {
      key: "maternity",
      en: "Maternity leave",
      ar: "إجازة وضع",
      paid: true,
      attachment: true,
      basis: "calendar_days",
      halfDay: false,
      accrual: "annual_fixed",
      annualDays: sa ? 70 : 60,
      carryover: 0,
      minService: 0,
      rules: {},
    },
    {
      key: "paternity",
      en: "Paternity leave",
      ar: "إجازة أبوة",
      paid: true,
      attachment: false,
      basis: "working_days",
      halfDay: false,
      accrual: "annual_fixed",
      annualDays: sa ? 3 : 5,
      carryover: 0,
      minService: 0,
      rules: {},
    },
    {
      key: "compassionate",
      en: "Compassionate leave",
      ar: "إجازة عزاء",
      paid: true,
      attachment: false,
      basis: "calendar_days",
      halfDay: false,
      accrual: "annual_fixed",
      annualDays: 5,
      carryover: 0,
      minService: 0,
      rules: {},
    },
  ];
  if (sa)
    list.push({
      key: "hajj",
      en: "Hajj leave",
      ar: "إجازة حج",
      paid: true,
      attachment: false,
      basis: "calendar_days",
      halfDay: false,
      accrual: "annual_fixed",
      annualDays: 10,
      carryover: 0,
      minService: 24,
      rules: { once_per_employment: true },
    });
  return list;
}

type BankSpec = {
  key: string;
  name: string;
  kind: "bank" | "cash" | "petty_cash" | "card_clearing";
  glCode: string;
  ibanIndex: number | null;
  bankName: string | null;
  cheques: boolean;
};
function bankAccounts(company: Company): BankSpec[] {
  const bankName =
    company.country === "SA" ? "Test Bank KSA (fictional)" : "Test Bank UAE (fictional)";
  const third: BankSpec =
    company.key === "consult"
      ? {
          key: "card",
          name: "Corporate card clearing",
          kind: "card_clearing",
          glCode: "1113",
          ibanIndex: null,
          bankName,
          cheques: false,
        }
      : {
          key: "collections",
          name: "Collections Account",
          kind: "bank",
          glCode: "1112",
          ibanIndex: 2,
          bankName,
          cheques: false,
        };
  return [
    {
      key: "main",
      name: `Main Operating Account (${company.currency})`,
      kind: "bank",
      glCode: "1111",
      ibanIndex: 1,
      bankName,
      cheques: true,
    },
    third,
    {
      key: "petty",
      name: "Petty Cash — Head Office",
      kind: "petty_cash",
      glCode: "1101",
      ibanIndex: null,
      bankName: null,
      cheques: false,
    },
  ];
}

const VAT_EMIRATE: Record<CompanyKey, string> = {
  gulfbuild: "AUH",
  tradeline: "DXB",
  saudimfg: "—",
  consult: "DXB",
  facilico: "SHJ",
};

// ── Pure helpers ────────────────────────────────────────────────────────────

function ymd(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}
/** Calendar months from the month of `from` to the month of `asOf`, inclusive. */
export function monthSpans(from: string, asOf: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 1;
  const endY = Number(asOf.slice(0, 4));
  const endM = Number(asOf.slice(5, 7)) - 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ start: ymd(y, m, 1), end: ymd(y, m + 1, 0) });
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}
/** The company's first day, then every quarter start up to as-of. */
function rateDates(from: string, asOf: string): string[] {
  const dates = [from];
  for (const s of monthSpans(from, asOf)) {
    const month = Number(s.start.slice(5, 7)) - 1;
    if (month % 3 === 0 && s.start > from) dates.push(s.start);
  }
  return dates;
}
/** A Saudi VAT number that passes the pack's shape (3…3) but starts 39999 — impossible. */
function saVatNo(i: number): string {
  return `399999${String(i).padStart(8, "0")}3`;
}
function isArabicFirst(company: Company): boolean {
  return company.languages[0] === "ar";
}
function nm(company: Company, b: Bi): string {
  return isArabicFirst(company) ? b.ar : b.en;
}

// ── The pure plan ───────────────────────────────────────────────────────────

export type SetupBlueprint = {
  rows: Tables;
  conflict: Record<string, string>;
  service: Record<string, number>;
  bankAccounts: BankSpec[];
  vatProfile: SetupHandoff["vatProfile"];
  periodPlan: Array<{ year: number; periodNo: number; status: PeriodStatus }>;
  handoff: SetupHandoff;
};

export function planSetup(ctx: LabContext): SetupBlueprint {
  const { company, orgId, rng, clock } = ctx;
  const id = (...ordinal: Array<string | number>) => ctx.id(FAMILY, ...ordinal);
  const start = historyDays(company);
  const t0 = clock.tsAgo(start, 8);
  const t1 = clock.tsAgo(start - 1, 9);
  const t2 = clock.tsAgo(start - 2, 10);
  const users = ctx.users;
  const rows: Tables = {};
  const conflict: Record<string, string> = {};
  const service: Record<string, number> = {};
  const handoff: SetupHandoff = {
    departments: {},
    costCentres: {},
    positions: {},
    teams: {},
    workLocations: {},
    shifts: {},
    warehouses: {},
    units: {},
    taxCodes: {},
    vatProfile: null,
    glChart: { installed: false, templateVersion: CHART_TEMPLATE_VERSION, accountsBySystemKey: {} },
    fiscalYears: {},
    fiscalPeriods: [],
    bankAccounts: {},
    payGroups: { activeId: "", periods: {} },
    leaveTypes: {},
    assetCategories: {},
    pipelines: {},
    folders: {},
    establishments: {},
  };

  // ── departments + cost centres ────────────────────────────────────────────
  const depts = [...CORE_DEPARTMENTS, ...COMPANY_DEPARTMENTS[company.key], LEGACY_DEPARTMENT];
  rows.department = depts.map((d, i) => {
    const did = id("department", d.code);
    handoff.departments[d.code] = did;
    return {
      id: did,
      org_id: orgId,
      parent_id: d.parent ? id("department", d.parent) : null,
      name_en: d.en,
      name_ar: d.ar,
      code: d.code,
      cost_centre: `CC-${d.code}`,
      sort: i,
      active: d.active ?? true,
      created_at: t0,
    };
  });
  rows.cost_centre = depts.map((d) => {
    const cid = id("cost_centre", d.code);
    handoff.costCentres[`CC-${d.code}`] = cid;
    return {
      id: cid,
      org_id: orgId,
      code: `CC-${d.code}`,
      name_en: d.en,
      name_ar: d.ar,
      parent_id: d.parent ? id("cost_centre", d.parent) : null,
      active: d.active ?? true,
      created_at: t0,
    };
  });

  // ── positions ─────────────────────────────────────────────────────────────
  const positions = [...CORE_POSITIONS, ...COMPANY_POSITIONS[company.key]];
  rows.position = positions.map((p, i) => {
    const pid = id("position", p.key);
    handoff.positions[p.key] = { id: pid, department: p.dept };
    return {
      id: pid,
      org_id: orgId,
      name_en: p.en,
      name_ar: p.ar,
      department_id: id("department", p.dept),
      grade: p.grade,
      sort: i,
      active: true,
      created_at: t0,
    };
  });

  // ── teams ─────────────────────────────────────────────────────────────────
  rows.team = [...COMPANY_TEAMS[company.key], LEGACY_TEAM].map((t, i) => {
    const tid = id("team", t.key);
    handoff.teams[t.key] = tid;
    return {
      id: tid,
      org_id: orgId,
      name: t.name,
      kind: t.kind,
      sort: i,
      active: t.active ?? true,
      created_at: t0,
    };
  });

  // ── work locations ────────────────────────────────────────────────────────
  rows.work_location = COMPANY_LOCATIONS[company.key].map((l, i) => {
    const lid = id("work_location", l.key);
    handoff.workLocations[l.key] = lid;
    const a = address(company, rng, i);
    return {
      id: lid,
      org_id: orgId,
      name_en: l.en,
      name_ar: l.ar,
      address: `${a.en} — ${a.ar}`,
      country: company.country,
      sort: i,
      active: true,
      created_at: t0,
    };
  });

  // ── shifts ────────────────────────────────────────────────────────────────
  rows.shift = COMPANY_SHIFTS[company.key].map((k) => {
    const s = SHIFTS[k]!;
    const sid = id("shift", s.key);
    handoff.shifts[s.key] = sid;
    return {
      id: sid,
      org_id: orgId,
      name_en: s.en,
      name_ar: s.ar,
      starts_at: s.start,
      ends_at: s.end,
      break_minutes: s.brk,
      active: s.active ?? true,
      created_at: t0,
    };
  });

  // ── warehouses, locations, units ──────────────────────────────────────────
  if (company.profile.enables.stock) {
    const whRows: Row[] = [];
    const locRows: Row[] = [];
    const countryName = company.country === "SA" ? "Saudi Arabia" : "United Arab Emirates";
    COMPANY_WAREHOUSES[company.key].forEach((w, wi) => {
      const wid = id("warehouse", w.code);
      whRows.push({
        id: wid,
        org_id: orgId,
        code: w.code,
        name_en: w.en,
        name_ar: w.ar,
        address_line: address(company, rng, 50 + wi).en,
        city: w.city,
        country: countryName,
        phone: phone(company, 900 + wi),
        email: email(`stores.${w.code}`, wi),
        manager_user_id: users.warehouse,
        active: true,
        created_by: users.warehouse,
        created_at: t1,
      });
      const locations: Record<string, string> = {};
      const loc = (
        code: string,
        en: string,
        ar: string,
        kind: string,
        opts: { parent?: string; hold?: boolean; recv?: boolean; issue?: boolean } = {},
      ) => {
        const lid = id("stock_location", w.code, code);
        locations[code] = lid;
        locRows.push({
          id: lid,
          org_id: orgId,
          warehouse_id: wid,
          parent_id: opts.parent ? id("stock_location", w.code, opts.parent) : null,
          code,
          name_en: en,
          name_ar: ar,
          kind,
          can_hold_stock: opts.hold ?? true,
          is_default_receiving: opts.recv ?? false,
          is_default_issue: opts.issue ?? false,
          active: true,
          created_at: t1,
        });
        return lid;
      };
      const recv = loc("RECV", "Receiving bay", "منطقة الاستلام", "receiving", { recv: true });
      loc("DISP", "Dispatch bay", "منطقة الصرف", "dispatch");
      loc("QUAR", "Quarantine", "الحجر", "quarantine");
      if (w.returns) loc("RET", "Returns", "المرتجعات", "returns");
      let issue = "";
      w.zones.forEach((z, zi) => {
        loc(z.code, z.en, z.ar, "storage", { hold: false });
        for (let b = 1; b <= z.bins; b++) {
          const code = `${z.code}-${String(b).padStart(2, "0")}`;
          const lid = loc(code, `${z.en} — bin ${b}`, `${z.ar} — خانة ${b}`, "storage", {
            parent: z.code,
            issue: zi === 0 && b === 1,
          });
          if (zi === 0 && b === 1) issue = lid;
        }
      });
      handoff.warehouses[w.code] = {
        id: wid,
        receivingLocationId: recv,
        issueLocationId: issue,
        locations,
      };
    });
    rows.warehouse = whRows;
    rows.stock_location = locRows;

    rows.unit_of_measure = UNITS.map((u) => {
      const uid = id("unit", u.code);
      handoff.units[u.code] = {
        id: uid,
        dimension: u.dimension,
        factorToBase: u.factor,
        isBase: u.factor === 1,
      };
      return {
        id: uid,
        org_id: orgId,
        code: u.code,
        name_en: u.en,
        name_ar: u.ar,
        dimension: u.dimension,
        factor_to_base: u.factor,
        is_base: u.factor === 1,
        active: true,
        created_at: t1,
      };
    });
  }

  // ── tax codes ─────────────────────────────────────────────────────────────
  if (company.country === "AE") {
    // The finance tax module installs the UAE pack and the VAT profile (services).
    service.tax_code = 5;
    service.app_settings = (service.app_settings ?? 0) + 1; // config.tax.vat
    handoff.vatProfile = {
      trn: taxNo(company, 1),
      emirate: VAT_EMIRATE[company.key],
      periodicity: company.key === "tradeline" ? "monthly" : "quarterly",
      registered: true,
    };
  } else {
    // No Saudi pack in the tax module and country packs stay off: custom codes,
    // never labelled government-compliant (is_custom = true, no pack_version).
    const codes = [
      {
        code: "SA-STD",
        en: "Standard rate 15%",
        ar: "النسبة الأساسية 15٪",
        treatment: "standard",
        rate: 15,
        recoverable: true,
      },
      {
        code: "SA-ZERO",
        en: "Zero rated",
        ar: "الخاضع لنسبة الصفر",
        treatment: "zero_rated",
        rate: 0,
        recoverable: true,
      },
      {
        code: "SA-EXEMPT",
        en: "Exempt",
        ar: "المعفى",
        treatment: "exempt",
        rate: 0,
        recoverable: false,
      },
      {
        code: "SA-OOS",
        en: "Out of scope",
        ar: "خارج النطاق",
        treatment: "out_of_scope",
        rate: 0,
        recoverable: false,
      },
    ];
    rows.tax_code = codes.map((c) => {
      const tid = id("tax_code", c.code);
      handoff.taxCodes[c.code] = tid;
      return {
        id: tid,
        org_id: orgId,
        code: c.code,
        name_en: c.en,
        name_ar: c.ar,
        jurisdiction: "SA",
        pack_version: null,
        tax_type: "vat",
        treatment: c.treatment,
        rate_percent: c.rate,
        calculation: "exclusive",
        recoverable: c.recoverable,
        reporting_box: null,
        effective_from: "2020-07-01",
        effective_to: null,
        is_custom: true,
        active: true,
        created_by: users.finance,
        created_at: t1,
      };
    });
  }

  // ── fiscal calendar, chart, bank accounts (services) ──────────────────────
  service.fiscal_year = FISCAL_YEARS.length;
  service.fiscal_period = FISCAL_YEARS.length * 12;
  service.app_settings = (service.app_settings ?? 0) + 1; // config.finance
  const banks = bankAccounts(company);
  service.gl_account = CHART_TEMPLATE.length + banks.length;
  service.bank_account = banks.length;
  const periodPlan: SetupBlueprint["periodPlan"] = [];
  for (const y of FISCAL_YEARS)
    for (let p = 1; p <= 12; p++)
      periodPlan.push({ year: y, periodNo: p, status: periodStatusFor(y, p) });

  // ── pay groups and periods ────────────────────────────────────────────────
  if (company.profile.enables.payroll) {
    const activeId = id("pay_group", "monthly");
    handoff.payGroups.activeId = activeId;
    rows.pay_group = [
      {
        id: activeId,
        org_id: orgId,
        name_en: "Monthly payroll",
        name_ar: "الرواتب الشهرية",
        frequency: "monthly",
        rounding_minor: 1,
        active: true,
        created_at: t2,
      },
      {
        id: id("pay_group", "weekly_retired"),
        org_id: orgId,
        name_en: "Weekly labour payroll (retired)",
        name_ar: "رواتب العمالة الأسبوعية (ملغاة)",
        frequency: "weekly",
        rounding_minor: 5,
        active: false,
        created_at: t2,
      },
    ];
    rows.pay_period = monthSpans(company.history.from, company.history.asOf).map((s) => {
      const pid = id("pay_period", s.start);
      handoff.payGroups.periods[s.start.slice(0, 7)] = pid;
      return {
        id: pid,
        org_id: orgId,
        pay_group_id: activeId,
        period_start: s.start,
        period_end: s.end,
      };
    });
  }

  // ── leave types and policies ──────────────────────────────────────────────
  const leaves = leaveTypes(company);
  rows.leave_type = leaves.map((l, i) => ({
    id: id("leave_type", l.key),
    org_id: orgId,
    key: l.key,
    label: { en: l.en, ar: l.ar },
    paid: l.paid,
    requires_attachment: l.attachment,
    count_basis: l.basis,
    allow_half_day: l.halfDay,
    sort: i,
    active: true,
    created_at: t2,
  }));
  rows.leave_policy = leaves.map((l) => {
    const pid = id("leave_policy", l.key, 1);
    handoff.leaveTypes[l.key] = { id: id("leave_type", l.key), policyId: pid };
    return {
      id: pid,
      org_id: orgId,
      leave_type_id: id("leave_type", l.key),
      version: 1,
      accrual_basis: l.accrual,
      annual_days: l.annualDays,
      monthly_accrual_days:
        l.accrual === "monthly_accrual" && l.annualDays
          ? Math.round((l.annualDays / 12) * 100) / 100
          : null,
      carryover_cap_days: l.carryover,
      min_service_months: l.minService,
      rules: l.rules,
      active: true,
      created_by: users.hr,
      created_at: t2,
    };
  });

  // ── asset categories ──────────────────────────────────────────────────────
  if (company.profile.enables.assets) {
    rows.asset_category = [...CORE_ASSET_CATEGORIES, ...COMPANY_ASSET_CATEGORIES[company.key]].map(
      (c) => {
        const cid = id("asset_category", c.code);
        handoff.assetCategories[c.code] = cid;
        return {
          id: cid,
          org_id: orgId,
          parent_id: c.parent ? id("asset_category", c.parent) : null,
          code: c.code,
          name_en: c.en,
          name_ar: c.ar,
          default_useful_life_months: c.life ?? null,
          default_residual_pct: c.residual ?? null,
          active: c.active ?? true,
          created_by: users.manager,
          created_at: t2,
        };
      },
    );
  }

  // ── CRM pipelines and stages ──────────────────────────────────────────────
  if (company.profile.enables.revenue) {
    const pipelines: PipelineSpec[] = [
      { key: "default", en: "Sales", ar: "المبيعات", kind: "new_business", stages: DEFAULT_STAGES },
      ...COMPANY_PIPELINES[company.key],
    ];
    const stageRows: Row[] = [];
    rows.crm_pipeline = pipelines.map((p) => {
      const pid = id("crm_pipeline", p.key);
      const stages: Record<string, { id: string; category: string }> = {};
      p.stages.forEach((s, i) => {
        const sid = id("pipeline_stage", s.key);
        stages[s.key] = { id: sid, category: s.category };
        stageRows.push({
          id: sid,
          org_id: orgId,
          key: s.key,
          label: { en: s.en, ar: s.ar },
          sort: i,
          category: s.category,
          active: true,
          pipeline_id: pid,
          requirements: s.requirements ?? [],
          exit_criteria: null,
          default_probability: s.probability ?? null,
          max_age_days: s.maxAge ?? null,
          created_at: t2,
        });
      });
      handoff.pipelines[p.key] = { id: pid, stages };
      return {
        id: pid,
        org_id: orgId,
        key: p.key,
        name: { en: p.en, ar: p.ar },
        kind: p.kind,
        is_default: p.key === "default",
        active: true,
        created_by: users.manager,
        created_at: t2,
      };
    });
    rows.pipeline_stage = stageRows;
  }

  // ── document folders ──────────────────────────────────────────────────────
  if (company.profile.enables.docstudio) {
    const folderRows: Row[] = [];
    const walk = (list: FolderSpec[], parent: string | null) => {
      for (const f of list) {
        const fid = id("doc_folder", f.key);
        handoff.folders[f.key] = fid;
        folderRows.push({
          id: fid,
          org_id: orgId,
          name: nm(company, f),
          parent_id: parent,
          archived_at: f.archived ? clock.tsAgo(Math.max(1, start - 400), 12) : null,
          created_by: users.admin,
          created_at: t2,
        });
        if (f.children) walk(f.children, fid);
      }
    };
    walk(folderTree(company), null);
    rows.doc_folder = folderRows;
  }

  // ── FX rate book: multi-currency is real (currency_rate, journal_line currency) ──
  const base = company.currency;
  const foreign: Array<{ code: string; fixed: number | null; jitter: [number, number] }> =
    base === "SAR"
      ? [
          { code: "USD", fixed: 3.75, jitter: [3.75, 3.75] },
          { code: "EUR", fixed: null, jitter: [4.02, 4.25] },
          { code: "AED", fixed: 1.0211, jitter: [1.0211, 1.0211] },
        ]
      : [
          { code: "USD", fixed: 3.6725, jitter: [3.6725, 3.6725] },
          { code: "EUR", fixed: null, jitter: [3.95, 4.15] },
          { code: "SAR", fixed: 0.9793, jitter: [0.9793, 0.9793] },
        ];
  const rateRows: Row[] = [];
  for (const d of rateDates(company.history.from, company.history.asOf)) {
    for (const f of foreign) {
      rateRows.push({
        id: id("currency_rate", f.code, d),
        org_id: orgId,
        from_currency: f.code,
        to_currency: base,
        rate: f.fixed ?? rng.float(f.jitter[0], f.jitter[1], 4),
        effective_at: `${d}T06:00:00.000Z`,
        source: "manual",
        created_by: users.finance,
        created_at: `${d}T06:00:00.000Z`,
      });
    }
  }
  rows.currency_rate = rateRows;

  // ── establishments (Saudi company only; no country pack adopted) ──────────
  if (company.profile.enables.establishment) {
    const hq = id("establishment", "HQ-RUH");
    const br = id("establishment", "BR-DMM");
    handoff.establishments["HQ-RUH"] = hq;
    handoff.establishments["BR-DMM"] = br;
    const est = (
      eid: string,
      code: string,
      legalEn: string,
      tradingEn: string,
      city: string,
      primary: boolean,
    ) => ({
      id: eid,
      org_id: orgId,
      code,
      legal_name: legalEn,
      trading_name: tradingEn,
      legal_name_local: company.nameAr,
      country: company.country,
      pack_key: null,
      timezone: company.timezone,
      base_currency: company.currency,
      working_days: ["sun", "mon", "tue", "wed", "thu"],
      address: {
        buildingNumber: "0000",
        street: "Test Industrial Street",
        district: "Fictional District",
        city,
        postalCode: "00000",
        additionalNumber: "0000",
      },
      invoice_identity: {},
      banking: {},
      is_primary: primary,
      status: "active",
      verification_state: "unverified",
      created_at: t0,
    });
    rows.establishment = [
      est(hq, "HQ-RUH", company.legalNameEn, company.nameEn, "Riyadh", true),
      est(
        br,
        "BR-DMM",
        `${company.legalNameEn} — Dammam branch`,
        `${company.nameEn} — Dammam`,
        "Dammam",
        false,
      ),
    ];
    const reg = (
      eid: string,
      code: string,
      key: string,
      kind: string,
      authority: string,
      value: string,
    ) => ({
      id: id("establishment_registration", code, key),
      org_id: orgId,
      establishment_id: eid,
      identifier_key: key,
      kind,
      authority,
      value,
      issued_on: company.history.from,
      expires_on: null,
      verification_state: "unverified",
      created_at: t0,
    });
    rows.establishment_registration = [
      reg(
        hq,
        "HQ-RUH",
        "vat_number",
        "tax_registration",
        "Zakat, Tax and Customs Authority",
        saVatNo(1),
      ),
      reg(
        hq,
        "HQ-RUH",
        "commercial_registration",
        "commercial_registration",
        "Ministry of Commerce",
        "0000000001",
      ),
      reg(
        hq,
        "HQ-RUH",
        "gosi_establishment",
        "payroll_establishment",
        "General Organization for Social Insurance",
        "GOSI-TEST-000001",
      ),
      reg(
        br,
        "BR-DMM",
        "commercial_registration",
        "commercial_registration",
        "Ministry of Commerce",
        "0000000002",
      ),
    ];
  }

  // ── H31 identity: branding + app brand (no tenant host claimed) ───────────
  rows.org_branding = [
    {
      org_id: orgId,
      accent_color: company.brandColor,
      display_name: company.nameEn,
      footer_details: `${company.legalNameEn} · ${company.nameAr} · Fictional pilot company — no real business, TRN or bank details`,
    },
  ];
  conflict.org_branding =
    "on conflict (org_id) do update set accent_color = excluded.accent_color, display_name = excluded.display_name, footer_details = excluded.footer_details, updated_at = now()";
  const shortName = (isArabicFirst(company) ? company.nameAr : company.nameEn)
    .split(" ")[0]!
    .slice(0, 12);
  rows.org_app_brand = [
    {
      org_id: orgId,
      app_name: `${company.nameEn} Ops`.slice(0, 60),
      app_short_name: shortName,
      app_description: `Internal operations app for ${company.nameEn} — a fictional H33 pilot company.`,
      brand_color: company.brandColor,
      background_color: "#ffffff",
      default_locale: company.languages[0] ?? "en",
    },
  ];
  conflict.org_app_brand =
    "on conflict (org_id) do update set app_name = excluded.app_name, app_short_name = excluded.app_short_name, app_description = excluded.app_description, brand_color = excluded.brand_color, background_color = excluded.background_color, default_locale = excluded.default_locale, updated_at = now()";

  // ── guided-tour progress for a few personas (the rest have none) ──────────
  rows.onboarding_state = [
    {
      org_id: orgId,
      user_id: users.field,
      status: "completed",
      step_index: 6,
      tour_key: "field",
      tour_version: 1,
      completed_at: clock.tsAgo(20, 7),
      dismissed_at: null,
    },
    {
      org_id: orgId,
      user_id: users.restricted,
      status: "skipped",
      step_index: 1,
      tour_key: "field",
      tour_version: 1,
      completed_at: null,
      dismissed_at: clock.tsAgo(12, 8),
    },
    {
      org_id: orgId,
      user_id: users.hr,
      status: "in_progress",
      step_index: 2,
      tour_key: "owner",
      tour_version: 1,
      completed_at: null,
      dismissed_at: null,
    },
  ];
  conflict.onboarding_state =
    "on conflict (org_id, user_id) do update set status = excluded.status, step_index = excluded.step_index, tour_key = excluded.tour_key, tour_version = excluded.tour_version, completed_at = excluded.completed_at, dismissed_at = excluded.dismissed_at, updated_at = now()";

  return {
    rows,
    conflict,
    service,
    bankAccounts: banks,
    vatProfile: handoff.vatProfile,
    periodPlan,
    handoff,
  };
}

/** Expected rows per table: direct inserts plus what the services will create. */
export function expectedCounts(b: SetupBlueprint): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, r] of Object.entries(b.rows)) if (r.length) out[t] = (out[t] ?? 0) + r.length;
  for (const [t, n] of Object.entries(b.service)) out[t] = (out[t] ?? 0) + n;
  return out;
}

// ── Service-driven transitions (never in dry-run) ──────────────────────────

type Sqlish = LabContext["sql"];

async function runServices(
  ctx: LabContext,
  b: SetupBlueprint,
  handoff: SetupHandoff,
  notes: string[],
): Promise<Record<string, number>> {
  const created: Record<string, number> = {};
  const bump = (t: string, n = 1) => (created[t] = (created[t] ?? 0) + n);
  const owner = ctx.ctxFor("owner");
  const ownerArch = ctx.archetypeOf("owner");
  const finance = ctx.ctxFor("finance");
  const financeArch = ctx.archetypeOf("finance");
  const sql: Sqlish = ctx.sql;
  const ledger = await import("@/modules/finance/ledger");
  const chart = await import("@/modules/finance/chart");
  const banking = await import("@/modules/finance/banking");
  const tax = await import("@/modules/finance/tax");

  // 1) Fiscal years 2023–2026 (find-or-create: the exclusion constraint refuses overlaps).
  const existingYears = (await sql`
    select id::text as id, starts_on::text as starts_on from public.fiscal_year where org_id = ${ctx.orgId}
  `) as unknown as Array<{ id: string; starts_on: string }>;
  for (const y of FISCAL_YEARS) {
    const found = existingYears.find((r) => r.starts_on.startsWith(String(y)));
    if (found) {
      handoff.fiscalYears[String(y)] = found.id;
      continue;
    }
    const r = await ledger.createFiscalYear(owner, ownerArch, {
      label: `FY ${y}`,
      startsOn: `${y}-01-01`,
      endsOn: `${y}-12-31`,
    });
    handoff.fiscalYears[String(y)] = r.id;
    bump("fiscal_year");
    bump("fiscal_period", r.periods);
  }
  ctx.log(`fiscal_year: ${FISCAL_YEARS.length} years, ${created.fiscal_period ?? 0} new periods`);

  // 2) The chart of accounts and the finance config (idempotent in the product).
  const setup = await chart.installFinanceSetup(owner, ownerArch, {
    booksStartDate: ctx.company.history.from,
  });
  bump("gl_account", setup.accountsCreated);
  if (setup.fiscalYearCreated)
    notes.push("installFinanceSetup created an extra fiscal year (unexpected)");
  handoff.glChart.installed = true;
  ctx.log(`gl_account: chart ${CHART_TEMPLATE_VERSION}, ${setup.accountsCreated} accounts seeded`);

  // 3) Bank accounts (find-or-create by unique name); each brings its GL account.
  const existingBanks = (await sql`
    select id::text as id, name, kind, currency, gl_account_id::text as gl from public.bank_account where org_id = ${ctx.orgId}
  `) as unknown as Array<{ id: string; name: string; kind: string; currency: string; gl: string }>;
  for (const spec of b.bankAccounts) {
    const found = existingBanks.find((r) => r.name === spec.name);
    if (found) {
      handoff.bankAccounts[spec.key] = {
        id: found.id,
        glAccountId: found.gl,
        kind: found.kind,
        currency: found.currency,
      };
      continue;
    }
    const r = await banking.createBankAccount(finance, financeArch, {
      name: spec.name,
      kind: spec.kind,
      accountNo: spec.ibanIndex ? String(spec.ibanIndex).padStart(12, "0") : undefined,
      iban: spec.ibanIndex ? iban(ctx.company, spec.ibanIndex) : undefined,
      bankName: spec.bankName ?? undefined,
      chequesEnabled: spec.cheques,
      glCode: spec.glCode,
    });
    handoff.bankAccounts[spec.key] = {
      id: r.id,
      glAccountId: r.glAccountId,
      kind: spec.kind,
      currency: ctx.company.currency,
    };
    bump("bank_account");
    bump("gl_account");
  }
  ctx.log(`bank_account: ${b.bankAccounts.length} accounts`);

  // 4) Tax: the UAE pack and profile through the tax module (nothing for SA — no pack, packs off).
  if (b.vatProfile) {
    const pack = await tax.installUaeVatPack(finance, financeArch);
    bump("tax_code", pack.created);
    await tax.setVatProfile(finance, financeArch, b.vatProfile);
    bump("app_settings");
    ctx.log(`tax_code: UAE VAT pack (${pack.created} new), VAT profile ${b.vatProfile.emirate}`);
  } else {
    notes.push(
      "SA: custom VAT codes only; no VAT profile (tax module is UAE-only) and no country pack adopted",
    );
  }
  bump("app_settings"); // config.finance from installFinanceSetup

  // 5) Period statuses, last, through the service (guarded transitions).
  const periods = (await sql`
    select p.id::text as id, p.period_no, p.starts_on::text as starts_on, p.ends_on::text as ends_on, p.status
    from public.fiscal_period p where p.org_id = ${ctx.orgId} order by p.starts_on
  `) as unknown as Array<{
    id: string;
    period_no: number;
    starts_on: string;
    ends_on: string;
    status: PeriodStatus;
  }>;
  let moved = 0;
  for (const p of periods) {
    const year = Number(p.starts_on.slice(0, 4));
    const target = periodStatusFor(year, p.period_no);
    if (p.status !== target) {
      if (p.status === "locked") {
        notes.push(`period ${p.starts_on} is locked; left as is`);
      } else {
        await ledger.setPeriodStatus(owner, ownerArch, {
          periodId: p.id,
          status: target,
          reason: "H33 pilot lab fiscal calendar plan",
        });
        moved++;
      }
    }
    handoff.fiscalPeriods.push({
      id: p.id,
      year,
      periodNo: p.period_no,
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      status: p.status === "locked" ? "locked" : target,
    });
  }
  ctx.log(`fiscal_period: ${periods.length} periods, ${moved} status changes`);

  // 6) Read back the ids the services minted.
  const accounts = (await sql`
    select system_key, id::text as id from public.gl_account
    where org_id = ${ctx.orgId} and system_key is not null and archived_at is null
  `) as unknown as Array<{ system_key: string; id: string }>;
  for (const a of accounts) handoff.glChart.accountsBySystemKey[a.system_key] = a.id;
  const codes = (await sql`
    select code, id::text as id from public.tax_code where org_id = ${ctx.orgId} and active
  `) as unknown as Array<{ code: string; id: string }>;
  for (const c of codes) handoff.taxCodes[c.code] = c.id;
  return created;
}

// ── Verification ────────────────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/;
async function countRows(ctx: LabContext, table: string, extra = ""): Promise<number> {
  if (!IDENT.test(table)) throw new Error(`unsafe table ${table}`);
  const rows = (await ctx.sql.unsafe(
    `select count(*)::int as n from public.${table} where org_id = $1 ${extra}`,
    [ctx.orgId],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Tables another family may legitimately extend; the rest must match exactly. */
const GROWING = new Set([
  "gl_account",
  "pay_period",
  "doc_folder",
  "currency_rate",
  "app_settings",
]);

async function verifySetup(ctx: LabContext): Promise<Check[]> {
  const checks: Check[] = [];
  const b = planSetup(ctx);
  const expected = expectedCounts(b);
  const c = ctx.company;
  const q = async <T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    (await ctx.sql(strings, ...(values as never[]))) as unknown as T[];

  for (const [table, n] of Object.entries(expected)) {
    const actual =
      table === "app_settings"
        ? await countRows(ctx, table, "and key in ('config.finance','config.tax.vat')")
        : await countRows(ctx, table);
    const ok = GROWING.has(table) ? actual >= n : actual === n;
    checks.push({
      name: `${table} count`,
      ok,
      detail: `${actual} ${GROWING.has(table) ? ">=" : "="} ${n}`,
    });
  }

  const orphanPositions = await q<{ n: number }>`
    select count(*)::int as n from public.position p
    left join public.department d on d.id = p.department_id and d.org_id = p.org_id
    where p.org_id = ${ctx.orgId} and d.id is null`;
  checks.push({
    name: "positions link to a department",
    ok: orphanPositions[0]!.n === 0,
    detail: `${orphanPositions[0]!.n} orphans`,
  });

  const cc = await q<{ depts: number; centres: number; unmatched: number }>`
    select (select count(*)::int from public.department d where d.org_id = ${ctx.orgId}) as depts,
           (select count(*)::int from public.cost_centre c where c.org_id = ${ctx.orgId}) as centres,
           (select count(*)::int from public.department d
              left join public.cost_centre c on c.org_id = d.org_id and c.code = d.cost_centre
              where d.org_id = ${ctx.orgId} and c.id is null) as unmatched`;
  checks.push({
    name: "every department has a cost centre of the same code",
    ok: cc[0]!.depts > 0 && cc[0]!.depts === cc[0]!.centres && cc[0]!.unmatched === 0,
    detail: `${cc[0]!.depts} departments, ${cc[0]!.centres} cost centres, ${cc[0]!.unmatched} unmatched`,
  });

  const tree = await q<{ dept_orphans: number; inactive_depts: number; inactive_teams: number }>`
    select (select count(*)::int from public.department d
              left join public.department p on p.id = d.parent_id and p.org_id = d.org_id
              where d.org_id = ${ctx.orgId} and d.parent_id is not null and p.id is null) as dept_orphans,
           (select count(*)::int from public.department d where d.org_id = ${ctx.orgId} and not d.active) as inactive_depts,
           (select count(*)::int from public.team t where t.org_id = ${ctx.orgId} and not t.active) as inactive_teams`;
  checks.push({
    name: "department tree resolves; a closed department and a disbanded team exist",
    ok: tree[0]!.dept_orphans === 0 && tree[0]!.inactive_depts >= 1 && tree[0]!.inactive_teams >= 1,
    detail: `${tree[0]!.dept_orphans} orphans, ${tree[0]!.inactive_depts} inactive departments, ${tree[0]!.inactive_teams} inactive teams`,
  });

  if (c.profile.enables.stock) {
    const locs = await q<{ cross: number; zones: number; bins: number; kinds: number }>`
      select (select count(*)::int from public.stock_location l
                join public.stock_location p on p.id = l.parent_id
                where l.org_id = ${ctx.orgId} and p.warehouse_id <> l.warehouse_id) as cross,
             (select count(*)::int from public.stock_location l where l.org_id = ${ctx.orgId} and not l.can_hold_stock) as zones,
             (select count(*)::int from public.stock_location l where l.org_id = ${ctx.orgId} and l.parent_id is not null and l.can_hold_stock) as bins,
             (select count(distinct kind)::int from public.stock_location l where l.org_id = ${ctx.orgId}) as kinds`;
    checks.push({
      name: "location trees stay inside their warehouse: zones group, bins hold, several kinds",
      ok: locs[0]!.cross === 0 && locs[0]!.zones >= 1 && locs[0]!.bins >= 3 && locs[0]!.kinds >= 3,
      detail: `${locs[0]!.cross} cross-warehouse parents, ${locs[0]!.zones} zones, ${locs[0]!.bins} bins, ${locs[0]!.kinds} kinds`,
    });
    const wh = await q<{ id: string; recv: number; issue: number }>`
      select w.id::text as id,
        (select count(*)::int from public.stock_location l where l.warehouse_id = w.id and l.is_default_receiving and l.active and l.can_hold_stock) as recv,
        (select count(*)::int from public.stock_location l where l.warehouse_id = w.id and l.is_default_issue and l.active and l.can_hold_stock) as issue
      from public.warehouse w where w.org_id = ${ctx.orgId}`;
    checks.push({
      name: "every warehouse has one default receiving and one default issue location",
      ok: wh.length > 0 && wh.every((w) => w.recv === 1 && w.issue === 1),
      detail: `${wh.length} warehouses`,
    });
    const bases = await q<{ dimension: string; n: number; bad: number }>`
      select dimension, count(*) filter (where is_base)::int as n, count(*) filter (where is_base and factor_to_base <> 1)::int as bad
      from public.unit_of_measure where org_id = ${ctx.orgId} and active group by dimension`;
    checks.push({
      name: "exactly one base unit per dimension, factor 1",
      ok: bases.length === 6 && bases.every((r) => r.n === 1 && r.bad === 0),
      detail: bases.map((r) => `${r.dimension}:${r.n}`).join(" "),
    });
  }

  const periods = await q<{
    starts_on: string;
    ends_on: string;
    period_no: number;
    status: string;
  }>`
    select starts_on::text as starts_on, ends_on::text as ends_on, period_no, status
    from public.fiscal_period where org_id = ${ctx.orgId} order by starts_on`;
  const wrong = periods.filter(
    (p) => p.status !== periodStatusFor(Number(p.starts_on.slice(0, 4)), p.period_no),
  );
  checks.push({
    name: "fiscal periods: 2023–2024 locked, 2025 mixed, 2026 open",
    ok: periods.length === 48 && wrong.length === 0,
    detail: `${periods.length} periods, ${wrong.length} off-plan`,
  });
  checks.push({
    name: "fiscal calendar covers 2023-01-01 … 2026-12-31 without gaps",
    ok:
      periods[0]?.starts_on === "2023-01-01" &&
      periods[periods.length - 1]?.ends_on === "2026-12-31" &&
      periods.every((p, i) => i === 0 || addDays(periods[i - 1]!.ends_on, 1) === p.starts_on),
  });

  const sys = await q<{ n: number }>`
    select count(*)::int as n from public.gl_account
    where org_id = ${ctx.orgId} and system_key in ('ar_control','ap_control','bank_default','cash_on_hand','inventory','vat_input') and archived_at is null`;
  checks.push({
    name: "chart of accounts: system accounts present",
    ok: sys[0]!.n === 6,
    detail: `${sys[0]!.n}/6`,
  });

  const banks = await q<{ n: number; bad: number; fake: number }>`
    select count(*)::int as n,
      count(*) filter (where not g.is_control or g.control_kind not in ('bank','cash'))::int as bad,
      count(*) filter (where b.iban is not null and b.iban not like ${c.country === "SA" ? "SA00 0000 %" : "AE00 0000 %"})::int as fake
    from public.bank_account b join public.gl_account g on g.id = b.gl_account_id
    where b.org_id = ${ctx.orgId}`;
  checks.push({
    name: "bank accounts sit on bank/cash control accounts with fake IBANs",
    ok: banks[0]!.n === b.bankAccounts.length && banks[0]!.bad === 0 && banks[0]!.fake === 0,
    detail: `${banks[0]!.n} accounts`,
  });

  if (c.country === "AE") {
    const pack = await q<{ n: number }>`
      select count(*)::int as n from public.tax_code where org_id = ${ctx.orgId} and jurisdiction = 'AE' and pack_version is not null and not is_custom`;
    const profile = await q<{ value: { trn?: string } }>`
      select value from public.app_settings where org_id = ${ctx.orgId} and key = 'config.tax.vat'`;
    checks.push({
      name: "UAE VAT pack installed (5 codes)",
      ok: pack[0]!.n === 5,
      detail: `${pack[0]!.n}`,
    });
    checks.push({
      name: "VAT profile set with an impossible TRN prefix",
      ok: !!profile[0] && String(profile[0].value?.trn ?? "").startsWith("1999"),
    });
  } else {
    const custom = await q<{ n: number; bad: number }>`
      select count(*)::int as n, count(*) filter (where not is_custom or pack_version is not null)::int as bad
      from public.tax_code where org_id = ${ctx.orgId}`;
    checks.push({
      name: "SA tax codes are custom, never pack-labelled",
      ok: custom[0]!.n === 4 && custom[0]!.bad === 0,
    });
  }

  if (c.profile.enables.payroll) {
    const pg = await q<{
      n: number;
    }>`select count(*)::int as n from public.pay_group where org_id = ${ctx.orgId} and active`;
    checks.push({
      name: "exactly one active pay group",
      ok: pg[0]!.n === 1,
      detail: `${pg[0]!.n}`,
    });
    const pp = await q<{ period_start: string; period_end: string }>`
      select period_start::text as period_start, period_end::text as period_end from public.pay_period
      where org_id = ${ctx.orgId} and pay_group_id = ${b.handoff.payGroups.activeId} order by period_start`;
    checks.push({
      name: "monthly pay periods are contiguous through as-of",
      ok:
        pp.length === (b.rows.pay_period?.length ?? 0) &&
        pp.every((p, i) => i === 0 || addDays(pp[i - 1]!.period_end, 1) === p.period_start) &&
        (pp[pp.length - 1]?.period_end ?? "") >= c.history.asOf,
      detail: `${pp.length} periods`,
    });
  }

  const lp = await q<{ types: number; covered: number }>`
    select (select count(*)::int from public.leave_type t where t.org_id = ${ctx.orgId}) as types,
           (select count(distinct p.leave_type_id)::int from public.leave_policy p where p.org_id = ${ctx.orgId} and p.active and p.version = 1) as covered`;
  checks.push({
    name: "every leave type has an active v1 policy",
    ok: lp[0]!.types > 0 && lp[0]!.types === lp[0]!.covered,
  });

  if (c.profile.enables.assets) {
    const cat = await q<{ n: number }>`
      select count(*)::int as n from public.asset_category a
      left join public.asset_category p on p.id = a.parent_id and p.org_id = a.org_id
      where a.org_id = ${ctx.orgId} and a.parent_id is not null and p.id is null`;
    checks.push({ name: "asset category parents resolve", ok: cat[0]!.n === 0 });
  }

  if (c.profile.enables.revenue) {
    const pl = await q<{ defaults: number; unattached: number; won: number; lost: number }>`
      select (select count(*)::int from public.crm_pipeline p where p.org_id = ${ctx.orgId} and p.is_default) as defaults,
             (select count(*)::int from public.pipeline_stage s where s.org_id = ${ctx.orgId} and s.pipeline_id is null) as unattached,
             (select count(*)::int from public.pipeline_stage s join public.crm_pipeline p on p.id = s.pipeline_id where s.org_id = ${ctx.orgId} and p.is_default and s.category = 'won') as won,
             (select count(*)::int from public.pipeline_stage s join public.crm_pipeline p on p.id = s.pipeline_id where s.org_id = ${ctx.orgId} and p.is_default and s.category = 'lost') as lost`;
    checks.push({
      name: "one default pipeline; every stage attached; default has won and lost",
      ok: pl[0]!.defaults === 1 && pl[0]!.unattached === 0 && pl[0]!.won === 1 && pl[0]!.lost === 1,
    });
  }

  if (c.profile.enables.docstudio) {
    const fo = await q<{ orphans: number; archived: number }>`
      select (select count(*)::int from public.doc_folder f left join public.doc_folder p on p.id = f.parent_id
               where f.org_id = ${ctx.orgId} and f.parent_id is not null and p.id is null) as orphans,
             (select count(*)::int from public.doc_folder f where f.org_id = ${ctx.orgId} and f.archived_at is not null) as archived`;
    checks.push({
      name: "folder tree resolves, one archived folder",
      ok: fo[0]!.orphans === 0 && fo[0]!.archived >= 1,
    });
  }

  if (c.profile.enables.establishment) {
    const es = await q<{ primary: number; verified: number; packed: number; adoptions: number }>`
      select (select count(*)::int from public.establishment e where e.org_id = ${ctx.orgId} and e.is_primary) as primary,
             (select count(*)::int from public.establishment e where e.org_id = ${ctx.orgId} and e.verification_state <> 'unverified') as verified,
             (select count(*)::int from public.establishment e where e.org_id = ${ctx.orgId} and e.pack_key is not null) as packed,
             (select count(*)::int from public.establishment_pack_adoption a where a.org_id = ${ctx.orgId}) as adoptions`;
    checks.push({
      name: "SA establishments: one primary, unverified, no pack adopted",
      ok:
        es[0]!.primary === 1 &&
        es[0]!.verified === 0 &&
        es[0]!.packed === 0 &&
        es[0]!.adoptions === 0,
    });
  }

  const fx = await q<{ pairs: number; bad: number; first: string | null }>`
    select count(distinct from_currency)::int as pairs,
           count(*) filter (where to_currency <> ${c.currency} or rate <= 0)::int as bad,
           min(effective_at)::date::text as first
    from public.currency_rate where org_id = ${ctx.orgId}`;
  checks.push({
    name: "FX rate book: three foreign currencies into the base, from the first day of history",
    ok: fx[0]!.pairs === 3 && fx[0]!.bad === 0 && fx[0]!.first === c.history.from,
    detail: `${fx[0]!.pairs} currencies, first rate ${fx[0]!.first ?? "none"}`,
  });

  const brand = await q<{ accent: string | null; app: string | null; hosts: number }>`
    select (select accent_color from public.org_branding where org_id = ${ctx.orgId}) as accent,
           (select brand_color from public.org_app_brand where org_id = ${ctx.orgId}) as app,
           (select count(*)::int from public.tenant_host where org_id = ${ctx.orgId}) as hosts`;
  checks.push({
    name: "branding and app identity carry the company colour; no tenant host claimed",
    ok:
      brand[0]!.accent === c.brandColor && brand[0]!.app === c.brandColor && brand[0]!.hosts === 0,
  });

  const ob = await q<{ user_id: string; status: string }>`
    select user_id::text as user_id, status from public.onboarding_state where org_id = ${ctx.orgId}`;
  const st = (p: keyof LabContext["users"]) => ob.find((r) => r.user_id === ctx.users[p])?.status;
  checks.push({
    name: "onboarding: field completed, restricted skipped, hr in progress",
    ok: st("field") === "completed" && st("restricted") === "skipped" && st("hr") === "in_progress",
    detail: `${ob.length} rows`,
  });

  checks.push({
    name: "pagination threshold",
    ok: true,
    detail: "not applicable — every setup table is bounded by design (no >1,205 surface)",
  });
  return checks;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ── The family ──────────────────────────────────────────────────────────────

export type SeedSetupOptions = {
  /**
   * Drive the finance services (fiscal calendar, chart, banks, VAT pack).
   * Defaults to `!ctx.dryRun`; the unit test passes `false` so `seed` runs end
   * to end against an in-memory insert with no database at all.
   */
  services?: boolean;
};

/** The seed, with the service half switchable so it can run without a database. */
export async function seedSetup(
  ctx: LabContext,
  opts: SeedSetupOptions = {},
): Promise<FamilyReport> {
  const services = (opts.services ?? true) && !ctx.dryRun;
  const b = planSetup(ctx);
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(b.rows)) {
    if (rows.length === 0) continue;
    const r = await ctx.insert(table, rows, b.conflict[table] ?? "nothing");
    counts[table] = r.attempted;
  }
  ctx.log(
    `structure: ${Object.entries(counts)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ")}`,
  );
  const notes: string[] = [];
  if (services) {
    const svc = await runServices(ctx, b, b.handoff, notes);
    for (const [t, n] of Object.entries(svc)) counts[t] = (counts[t] ?? 0) + n;
  } else {
    notes.push(
      `finance services skipped (${ctx.dryRun ? "dry-run" : "by flag"}); planned: ${Object.entries(
        b.service,
      )
        .map(([t, n]) => `${t}=${n}`)
        .join(" ")}`,
    );
  }
  return {
    family: FAMILY,
    counts,
    handoff: b.handoff as unknown as Record<string, unknown>,
    notes,
  };
}

export const setup: Family = {
  key: FAMILY,
  deps: [],
  appliesTo: () => true,

  plan(ctx: LabContext): FamilyPlan {
    return { family: FAMILY, expected: expectedCounts(planSetup(ctx)) };
  },

  seed: (ctx: LabContext) => seedSetup(ctx),

  verify: verifySetup,
};
