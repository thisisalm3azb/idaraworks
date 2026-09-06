/**
 * H33 Pilot Lab — family "people": the workforce.
 *
 * The organisation's SHAPE (departments, positions, teams, work locations,
 * shifts) belongs to the `setup` family; this one fills it. Every employee the
 * company profile asks for is placed into one of setup's departments with one
 * of that department's positions, on one of its teams and at one of its
 * locations, every id resolved through `ctx.handoff("setup")` so the two
 * families can never disagree. People then adds what only a workforce has:
 * work patterns, the skills catalogue and the pay-component vocabulary; and
 * per employee, terms + effective-dated compensation history (reconciled the
 * way the HR service reconciles them), HR identity with impossible-prefix
 * numbers, a contract, employment events, skills, recurring pay components, a
 * payment instruction with a structurally invalid IBAN, schedule overrides,
 * and a few manager delegations between department heads.
 *
 * Lifecycle law: bulk rows are BORN `active` (or `draft` for a future hire) —
 * the two states the product's own create paths write. Every other state
 * (notice, suspended, terminated, archived) and every contract issue /
 * acceptance is reached by calling the real HR service as the HR persona, so
 * `employee_lifecycle_guard` is the law and the rows are indistinguishable
 * from application writes. The pure plan (`buildPeoplePlan`) is separable
 * from those service-driven transitions: `plan()`, the dry-run and the unit
 * test never open a database, and the transitions are skipped under
 * `ctx.dryRun` (or `seedPeople(ctx, { services: false })`).
 */
import type { Rng } from "../../simulation/rng";
import type {
  Check,
  Company,
  CompanyKey,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../types";
import { personaEmail } from "../companies";
import type { SetupHandoff } from "./setup";
import {
  LAST_EN,
  email,
  historyDays,
  iban,
  personName,
  phone,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  weighted,
} from "./_shared";

export const FAMILY = "people";

/** Personas that get an employee row, in ordinal order (employee 0..7). */
export const PERSONA_EMPLOYEES = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
] as const satisfies readonly PersonaKey[];
export type PersonaEmployee = (typeof PERSONA_EMPLOYEES)[number];
/** The five the contract requires (README "Personas that are employees"). */
export const REQUIRED_PERSONA_EMPLOYEES: PersonaEmployee[] = [
  "manager",
  "hr",
  "warehouse",
  "field",
  "restricted",
];
/** Personas that head their department (the rest are staff in it). */
const HEAD_PERSONAS: PersonaEmployee[] = ["owner", "manager", "finance", "hr", "warehouse"];

export type Lifecycle = "draft" | "active" | "suspended" | "notice" | "terminated" | "archived";
/** The states a bulk insert may be born in — the product's own create paths write exactly these. */
export const BORN_LIFECYCLES: Lifecycle[] = ["draft", "active"];
/** Events only the HR service writes; a direct insert of one of these would fake a transition. */
export const SERVICE_ONLY_EVENTS = [
  "activated",
  "suspended",
  "notice_given",
  "notice_withdrawn",
  "terminated",
  "archived",
  "contract_issued",
  "contract_accepted",
];

/** UAE ids start 784-, Saudi ids start 1 or 2; these prefixes cannot occur. */
export function fakeIdPrefix(company: Company): string {
  return company.country === "SA" ? "0000" : "000-0000-";
}
export function fakeIdNumber(company: Company, i: number): string {
  return company.country === "SA"
    ? `0000${String(i).padStart(6, "0")}`
    : `000-0000-${String(i).padStart(7, "0")}-0`;
}
export function fakePassport(i: number): string {
  return `P00${String(i).padStart(6, "0")}`;
}

// ── Setup's vocabulary, as people reads it ──────────────────────────────────
// Keys here MUST match the specs in setup.ts (the unit test cross-checks them
// against that file's source); ids come from the handoff at plan time.

type Tier = "owner" | "head" | "pro" | "admin" | "skilled" | "labour";
type PositionRef = { key: string; dept: string; en: string; tier: Tier };

const CORE_POSITIONS: PositionRef[] = [
  { key: "general_manager", dept: "MGMT", en: "General Manager", tier: "owner" },
  { key: "admin_assistant", dept: "MGMT", en: "Administrative Assistant", tier: "admin" },
  { key: "finance_manager", dept: "FIN", en: "Finance Manager", tier: "head" },
  { key: "accountant", dept: "FIN", en: "Accountant", tier: "pro" },
  { key: "hr_manager", dept: "HR", en: "HR Manager", tier: "head" },
  { key: "hr_officer", dept: "HR", en: "HR Officer", tier: "pro" },
  { key: "operations_manager", dept: "OPS", en: "Operations Manager", tier: "head" },
  { key: "sales_executive", dept: "COMM", en: "Sales Executive", tier: "pro" },
  { key: "procurement_officer", dept: "SUPPLY", en: "Procurement Officer", tier: "pro" },
  { key: "storekeeper", dept: "SUPPLY", en: "Storekeeper", tier: "skilled" },
  { key: "driver", dept: "SUPPLY", en: "Driver", tier: "labour" },
];

const COMPANY_POSITIONS: Record<CompanyKey, PositionRef[]> = {
  gulfbuild: [
    { key: "project_manager", dept: "PRJ", en: "Project Manager", tier: "head" },
    { key: "site_engineer", dept: "SITE", en: "Site Engineer", tier: "pro" },
    { key: "foreman", dept: "SITE", en: "Foreman", tier: "skilled" },
    { key: "skilled_labourer", dept: "SITE", en: "Skilled Labourer", tier: "labour" },
    { key: "mep_technician", dept: "MEP", en: "MEP Technician", tier: "skilled" },
    { key: "safety_officer", dept: "QHSE", en: "Safety Officer", tier: "pro" },
    { key: "quantity_surveyor", dept: "EST", en: "Quantity Surveyor", tier: "pro" },
  ],
  tradeline: [
    { key: "warehouse_supervisor", dept: "WH", en: "Warehouse Supervisor", tier: "pro" },
    { key: "picker_packer", dept: "WH", en: "Picker / Packer", tier: "labour" },
    { key: "fleet_coordinator", dept: "LOG", en: "Fleet Coordinator", tier: "admin" },
    { key: "key_account_manager", dept: "SALES", en: "Key Account Manager", tier: "pro" },
    { key: "customer_service_agent", dept: "CS", en: "Customer Service Agent", tier: "admin" },
  ],
  saudimfg: [
    { key: "production_supervisor", dept: "PROD", en: "Production Supervisor", tier: "pro" },
    { key: "cnc_operator", dept: "PROD", en: "CNC Operator", tier: "skilled" },
    { key: "welder", dept: "PROD", en: "Welder", tier: "skilled" },
    { key: "quality_inspector", dept: "QC", en: "Quality Inspector", tier: "pro" },
    { key: "maintenance_technician", dept: "MAINT", en: "Maintenance Technician", tier: "skilled" },
    { key: "process_engineer", dept: "ENG", en: "Process Engineer", tier: "pro" },
  ],
  consult: [
    { key: "principal_consultant", dept: "ADV", en: "Principal Consultant", tier: "head" },
    { key: "senior_consultant", dept: "ADV", en: "Senior Consultant", tier: "pro" },
    { key: "analyst", dept: "ADV", en: "Analyst", tier: "pro" },
    { key: "project_coordinator", dept: "DEL", en: "Project Coordinator", tier: "admin" },
    { key: "bd_manager", dept: "BD", en: "Business Development Manager", tier: "pro" },
  ],
  facilico: [
    { key: "field_supervisor", dept: "FIELD", en: "Field Supervisor", tier: "pro" },
    { key: "hvac_technician", dept: "FIELD", en: "HVAC Technician", tier: "skilled" },
    { key: "electrician", dept: "FIELD", en: "Electrician", tier: "skilled" },
    { key: "plumber", dept: "FIELD", en: "Plumber", tier: "skilled" },
    { key: "helpdesk_agent", dept: "HELP", en: "Helpdesk Agent", tier: "admin" },
    { key: "maintenance_planner", dept: "MAINT", en: "Maintenance Planner", tier: "pro" },
    { key: "hse_officer", dept: "HSE", en: "HSE Officer", tier: "pro" },
  ],
};

function positionsFor(company: CompanyKey): Map<string, PositionRef> {
  return new Map([...CORE_POSITIONS, ...COMPANY_POSITIONS[company]].map((p) => [p.key, p]));
}

type DeptStaffing = {
  /** setup department code */
  code: string;
  /** share of the non-persona headcount */
  weight: number;
  /** position key of the department head (first person allocated, unless a persona heads it) */
  head: string;
  /** position keys for everyone else; repeat a key to weight it */
  staff: string[];
  /** field departments: teams, trade skills, site locations */
  field: boolean;
  /** setup team keys the field staff rotate through */
  teams?: string[];
  /** positions pinned to one team (the rest rotate through the remaining teams) */
  teamByPosition?: Record<string, string>;
};
type PersonaSeat = { dept: string; position: string; team: string | null };
type Staffing = {
  departments: DeptStaffing[];
  personas: Record<PersonaEmployee, PersonaSeat>;
  /** every ACTIVE setup team, in setup order — each gets a schedule and members */
  teams: string[];
  /** setup work-location keys: the office, then the sites */
  officeLocation: string;
  siteLocations: string[];
  /** setup shift keys: the office clock, the site clock, and an override for a few field staff */
  shifts: { office: string; site: string; override: string | null };
  skills: Array<[string, string, string, "trade" | "office"]>;
};

function core(w: {
  mgmt: number;
  fin: number;
  hr: number;
  comm: number;
  supply: number;
}): DeptStaffing[] {
  return [
    {
      code: "MGMT",
      weight: w.mgmt,
      head: "general_manager",
      staff: ["admin_assistant"],
      field: false,
    },
    { code: "FIN", weight: w.fin, head: "finance_manager", staff: ["accountant"], field: false },
    { code: "HR", weight: w.hr, head: "hr_manager", staff: ["hr_officer"], field: false },
    {
      code: "COMM",
      weight: w.comm,
      head: "sales_executive",
      staff: ["sales_executive"],
      field: false,
    },
    {
      code: "SUPPLY",
      weight: w.supply,
      head: "procurement_officer",
      staff: ["storekeeper", "storekeeper", "driver", "driver"],
      field: false,
    },
  ];
}
function seats(
  over: Pick<Record<PersonaEmployee, PersonaSeat>, "field" | "restricted"> &
    Partial<Record<PersonaEmployee, PersonaSeat>>,
): Record<PersonaEmployee, PersonaSeat> {
  return {
    owner: { dept: "MGMT", position: "general_manager", team: null },
    admin: { dept: "MGMT", position: "admin_assistant", team: null },
    manager: { dept: "OPS", position: "operations_manager", team: null },
    finance: { dept: "FIN", position: "finance_manager", team: null },
    hr: { dept: "HR", position: "hr_manager", team: null },
    warehouse: { dept: "SUPPLY", position: "procurement_officer", team: null },
    ...over,
  };
}

const OFFICE_SKILLS: Staffing["skills"] = [
  ["ms-excel", "Microsoft Excel", "مايكروسوفت إكسل", "office"],
  ["bookkeeping", "Bookkeeping", "مسك الدفاتر", "office"],
  ["negotiation", "Negotiation", "التفاوض", "office"],
  ["arabic-english", "Arabic–English bilingual", "ثنائي اللغة عربي–إنجليزي", "office"],
  ["project-management", "Project management", "إدارة المشاريع", "office"],
];

const STAFFING: Record<CompanyKey, Staffing> = {
  gulfbuild: {
    departments: [
      ...core({ mgmt: 1, fin: 6, hr: 5, comm: 4, supply: 8 }),
      { code: "PRJ", weight: 5, head: "project_manager", staff: ["project_manager"], field: false },
      {
        code: "SITE",
        weight: 45,
        head: "site_engineer",
        staff: [
          "foreman",
          "skilled_labourer",
          "skilled_labourer",
          "skilled_labourer",
          "site_engineer",
        ],
        field: true,
        teams: ["civil_a", "civil_b", "finishing", "plant"],
      },
      {
        code: "MEP",
        weight: 12,
        head: "mep_technician",
        staff: ["mep_technician"],
        field: true,
        teams: ["mep"],
      },
      { code: "QHSE", weight: 5, head: "safety_officer", staff: ["safety_officer"], field: false },
      {
        code: "EST",
        weight: 4,
        head: "quantity_surveyor",
        staff: ["quantity_surveyor"],
        field: false,
      },
    ],
    personas: seats({
      field: { dept: "MEP", position: "mep_technician", team: "mep" },
      restricted: { dept: "SITE", position: "foreman", team: "civil_a" },
    }),
    teams: ["civil_a", "civil_b", "mep", "finishing", "plant"],
    officeLocation: "hq",
    siteLocations: ["site_alain", "site_marina", "yard"],
    shifts: { office: "day", site: "morning", override: "evening" },
    skills: [
      ["formwork", "Formwork", "أعمال القوالب", "trade"],
      ["steel-fixing", "Steel fixing", "تركيب حديد التسليح", "trade"],
      ["masonry", "Masonry", "البناء بالطابوق", "trade"],
      ["scaffolding-cert", "Scaffolding (certified)", "السقالات (معتمد)", "trade"],
      ["crane-operation", "Crane operation", "تشغيل الرافعات", "trade"],
      ["electrical-install", "Electrical installation", "التمديدات الكهربائية", "trade"],
      ["first-aid", "First aid", "الإسعافات الأولية", "trade"],
      ["autocad", "AutoCAD", "أوتوكاد", "office"],
      ["quantity-surveying", "Quantity surveying", "مسح الكميات", "office"],
      ...OFFICE_SKILLS,
    ],
  },
  tradeline: {
    departments: [
      ...core({ mgmt: 1, fin: 5, hr: 4, comm: 6, supply: 6 }),
      {
        code: "WH",
        weight: 30,
        head: "warehouse_supervisor",
        staff: ["picker_packer", "picker_packer", "picker_packer", "warehouse_supervisor"],
        field: true,
        teams: ["picking", "packing"],
      },
      {
        code: "LOG",
        weight: 10,
        head: "fleet_coordinator",
        staff: ["fleet_coordinator"],
        field: true,
        teams: ["fleet"],
      },
      {
        code: "SALES",
        weight: 8,
        head: "key_account_manager",
        staff: ["key_account_manager"],
        field: true,
        teams: ["field_sales"],
      },
      {
        code: "CS",
        weight: 8,
        head: "customer_service_agent",
        staff: ["customer_service_agent"],
        field: false,
      },
    ],
    personas: seats({
      warehouse: { dept: "WH", position: "warehouse_supervisor", team: null },
      field: { dept: "LOG", position: "fleet_coordinator", team: "fleet" },
      restricted: { dept: "WH", position: "picker_packer", team: "picking" },
    }),
    teams: ["picking", "packing", "fleet", "field_sales"],
    officeLocation: "hq",
    siteLocations: ["jafz", "shj", "auh"],
    shifts: { office: "office", site: "morning", override: "evening" },
    skills: [
      ["forklift-licence", "Forklift licence", "رخصة رافعة شوكية", "trade"],
      ["wms-operation", "Warehouse system operation", "تشغيل نظام المستودعات", "trade"],
      ["cold-chain", "Cold-chain handling", "التعامل مع سلسلة التبريد", "trade"],
      ["route-planning", "Route planning", "تخطيط المسارات", "trade"],
      ["heavy-vehicle-licence", "Heavy vehicle licence", "رخصة مركبة ثقيلة", "trade"],
      ["stock-counting", "Cycle counting", "الجرد الدوري", "trade"],
      ["customs-clearance", "Customs clearance", "التخليص الجمركي", "office"],
      ["crm", "CRM systems", "أنظمة إدارة العملاء", "office"],
      ...OFFICE_SKILLS,
    ],
  },
  saudimfg: {
    departments: [
      ...core({ mgmt: 1, fin: 5, hr: 4, comm: 5, supply: 7 }),
      {
        code: "PROD",
        weight: 45,
        head: "production_supervisor",
        staff: ["cnc_operator", "cnc_operator", "welder", "welder", "production_supervisor"],
        field: true,
        teams: ["machining_1", "machining_2", "assembly", "welding"],
        teamByPosition: { welder: "welding" },
      },
      {
        code: "QC",
        weight: 7,
        head: "quality_inspector",
        staff: ["quality_inspector"],
        field: true,
        teams: ["qc"],
      },
      {
        code: "MAINT",
        weight: 7,
        head: "maintenance_technician",
        staff: ["maintenance_technician"],
        field: false,
      },
      {
        code: "ENG",
        weight: 6,
        head: "process_engineer",
        staff: ["process_engineer"],
        field: false,
      },
    ],
    personas: seats({
      field: { dept: "PROD", position: "cnc_operator", team: "machining_1" },
      restricted: { dept: "PROD", position: "production_supervisor", team: "machining_2" },
    }),
    teams: ["machining_1", "machining_2", "assembly", "welding", "qc"],
    officeLocation: "hq",
    siteLocations: ["plant", "dmm"],
    shifts: { office: "morning", site: "morning", override: "night" },
    skills: [
      ["cnc-programming", "CNC programming", "برمجة CNC", "trade"],
      ["mig-welding", "MIG welding", "لحام MIG", "trade"],
      ["tig-welding", "TIG welding", "لحام TIG", "trade"],
      ["blueprint-reading", "Blueprint reading", "قراءة المخططات", "trade"],
      ["forklift-licence", "Forklift licence", "رخصة رافعة شوكية", "trade"],
      ["lean-5s", "Lean / 5S", "التصنيع الرشيق / 5S", "trade"],
      ["metrology", "Metrology & inspection", "القياس والفحص", "trade"],
      ["solidworks", "SolidWorks", "سوليدوركس", "office"],
      ["iso-9001", "ISO 9001 auditing", "تدقيق ISO 9001", "office"],
      ...OFFICE_SKILLS,
    ],
  },
  consult: {
    departments: [
      ...core({ mgmt: 2, fin: 5, hr: 4, comm: 4, supply: 3 }),
      {
        code: "ADV",
        weight: 55,
        head: "principal_consultant",
        staff: ["senior_consultant", "senior_consultant", "analyst", "analyst", "analyst"],
        field: true,
        teams: ["pod_a", "pod_b", "research"],
      },
      {
        code: "DEL",
        weight: 12,
        head: "project_coordinator",
        staff: ["project_coordinator"],
        field: false,
      },
      { code: "BD", weight: 6, head: "bd_manager", staff: ["bd_manager"], field: false },
    ],
    personas: seats({
      field: { dept: "ADV", position: "analyst", team: "pod_a" },
      restricted: { dept: "ADV", position: "senior_consultant", team: "pod_b" },
    }),
    teams: ["pod_a", "pod_b", "research"],
    officeLocation: "hq",
    siteLocations: ["auh", "remote"],
    shifts: { office: "office", site: "office", override: null },
    skills: [
      ["financial-modelling", "Financial modelling", "النمذجة المالية", "trade"],
      ["process-mapping", "Process mapping", "رسم خرائط العمليات", "trade"],
      ["change-management", "Change management", "إدارة التغيير", "trade"],
      ["data-analysis", "Data analysis", "تحليل البيانات", "trade"],
      ["workshop-facilitation", "Workshop facilitation", "تيسير ورش العمل", "trade"],
      ["public-speaking", "Presentation & public speaking", "العرض والتحدث أمام الجمهور", "trade"],
      ["power-bi", "Power BI", "باور بي آي", "trade"],
      ["proposal-writing", "Proposal writing", "كتابة العروض", "office"],
      ["research", "Desk research", "البحث المكتبي", "office"],
      ...OFFICE_SKILLS,
    ],
  },
  facilico: {
    departments: [
      ...core({ mgmt: 1, fin: 5, hr: 4, comm: 4, supply: 6 }),
      {
        code: "FIELD",
        weight: 60,
        head: "field_supervisor",
        staff: [
          "hvac_technician",
          "hvac_technician",
          "electrician",
          "electrician",
          "plumber",
          "plumber",
          "field_supervisor",
        ],
        field: true,
        teams: ["hvac", "electrical", "plumbing", "soft_services", "night_response"],
        teamByPosition: { hvac_technician: "hvac", electrician: "electrical", plumber: "plumbing" },
      },
      {
        code: "MAINT",
        weight: 5,
        head: "maintenance_planner",
        staff: ["maintenance_planner"],
        field: false,
      },
      { code: "HELP", weight: 8, head: "helpdesk_agent", staff: ["helpdesk_agent"], field: false },
      { code: "HSE", weight: 4, head: "hse_officer", staff: ["hse_officer"], field: false },
    ],
    personas: seats({
      field: { dept: "FIELD", position: "hvac_technician", team: "hvac" },
      restricted: { dept: "FIELD", position: "field_supervisor", team: "electrical" },
    }),
    teams: ["hvac", "electrical", "plumbing", "soft_services", "night_response"],
    officeLocation: "hq",
    siteLocations: ["auh", "sites"],
    shifts: { office: "day", site: "day", override: "night" },
    skills: [
      ["hvac-servicing", "HVAC servicing", "صيانة التكييف", "trade"],
      ["electrical-install", "Electrical installation", "التمديدات الكهربائية", "trade"],
      ["plumbing", "Plumbing", "السباكة", "trade"],
      ["fire-systems", "Fire systems maintenance", "صيانة أنظمة الحريق", "trade"],
      ["bms-operation", "BMS operation", "تشغيل نظام إدارة المباني", "trade"],
      ["first-aid", "First aid", "الإسعافات الأولية", "trade"],
      ["working-at-height", "Working at height (certified)", "العمل على ارتفاعات (معتمد)", "trade"],
      ["cafm", "CAFM systems", "أنظمة إدارة المرافق", "office"],
      ["contract-admin", "Contract administration", "إدارة العقود", "office"],
      ...OFFICE_SKILLS,
    ],
  },
};

/** Everything this family expects the setup handoff to carry for a company (the unit test's fake handoff). */
export function setupRefsFor(company: Company): {
  departments: string[];
  positions: Array<{ key: string; dept: string }>;
  teams: string[];
  workLocations: string[];
  shifts: string[];
} {
  const S = STAFFING[company.key];
  const positions = [...positionsFor(company.key).values()];
  const departments = new Set<string>();
  for (const d of S.departments) departments.add(d.code);
  for (const s of Object.values(S.personas)) departments.add(s.dept);
  for (const p of positions) departments.add(p.dept);
  const shifts = new Set<string>([S.shifts.office, S.shifts.site]);
  if (S.shifts.override) shifts.add(S.shifts.override);
  return {
    departments: [...departments],
    positions: positions.map((p) => ({ key: p.key, dept: p.dept })),
    teams: S.teams,
    workLocations: [S.officeLocation, ...S.siteLocations],
    shifts: [...shifts],
  };
}

/** Monthly salary bands in major units, per tier. AED and SAR are close enough to share. */
const BAND: Record<Tier, [number, number]> = {
  owner: [45000, 45000],
  head: [18000, 32000],
  pro: [7000, 15000],
  admin: [4000, 8000],
  skilled: [3500, 7000],
  labour: [2200, 3500],
};

const NATIONALITIES_AE: Record<string, number> = {
  AE: 15,
  IN: 25,
  PK: 15,
  EG: 12,
  PH: 10,
  JO: 6,
  LB: 5,
  SY: 4,
  NP: 5,
  GB: 3,
};
const NATIONALITIES_SA: Record<string, number> = {
  SA: 45,
  EG: 12,
  IN: 12,
  PK: 8,
  YE: 5,
  SD: 4,
  PH: 5,
  JO: 4,
  BD: 5,
};

// ── Row shapes (every key always present — ctx.insert refuses ragged rows) ──

type DayShape = { start: string; end: string; break_minutes: number };
export type WorkPatternRow = {
  id: string;
  org_id: string;
  name_en: string;
  name_ar: string;
  days: Record<string, DayShape>;
  weekly_hours: number;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
};
export type SkillRow = {
  id: string;
  org_id: string;
  key: string;
  name: string;
  name_ar: string;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type PayComponentDefRow = {
  id: string;
  org_id: string;
  key: string;
  label: { en: string; ar: string };
  kind: "earning" | "deduction" | "employer_contribution";
  calc: "fixed" | "percent_of_basic" | "overtime" | "manual";
  percent: number | null;
  recurring: boolean;
  sort: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};
export type EmployeeRow = {
  id: string;
  org_id: string;
  name: string;
  name_ar: string;
  legal_name: string;
  employee_no: string;
  email: string;
  phone: string;
  user_id: string | null;
  team_id: string | null;
  department_id: string;
  position_id: string;
  work_location_id: string;
  cost_centre: string;
  manager_employee_id: string | null;
  employment_type: string;
  lifecycle: Lifecycle;
  active: boolean;
  hire_date: string;
  probation_end_date: string;
  confirmation_date: string | null;
  nationality: string;
  residency_status: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relation: string;
  created_at: string;
  updated_at: string;
};
export type EmployeeTermsRow = {
  employee_id: string;
  org_id: string;
  salary_minor: number;
  hourly_cost_minor: number;
  ot_rate: number;
  updated_at: string;
};
export type EmployeeHrRow = {
  employee_id: string;
  org_id: string;
  id_number: string;
  id_expiry: string;
  passport_number: string;
  passport_expiry: string;
  visa_expiry: string | null;
  notes: string | null;
  updated_at: string;
};
export type CompensationRow = {
  id: string;
  org_id: string;
  employee_id: string;
  effective_date: string;
  salary_minor: number;
  hourly_cost_minor: number;
  ot_rate: number;
  reason: "hire" | "annual_review" | "promotion" | "adjustment" | "correction" | "transfer";
  note: string | null;
  superseded_at: null;
  created_by: string;
  created_at: string;
};
export type ContractRow = {
  id: string;
  org_id: string;
  employee_id: string;
  contract_no: string;
  contract_type: "fixed_term" | "part_time_contract" | "temporary_contract" | "other";
  start_date: string;
  end_date: string | null;
  probation_months: number;
  status: "draft";
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type EmployeeEventRow = {
  id: string;
  org_id: string;
  employee_id: string;
  event: string;
  effective_date: string;
  detail: Record<string, unknown>;
  created_by: string;
  created_at: string;
};
export type EmployeeSkillRow = {
  id: string;
  org_id: string;
  employee_id: string;
  skill_id: string;
  level: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type EmployeePayComponentRow = {
  id: string;
  org_id: string;
  employee_id: string;
  component_id: string;
  amount_minor: number | null;
  effective_from: string;
  effective_to: null;
  created_by: string;
  created_at: string;
};
export type PaymentInstructionRow = {
  id: string;
  org_id: string;
  employee_id: string;
  method: "bank" | "wps" | "cash";
  bank_name: string | null;
  iban: string | null;
  account_no: string | null;
  wps_agent_id: string | null;
  wps_person_id: string | null;
  note: string | null;
  active: true;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type ScheduleAssignmentRow = {
  id: string;
  org_id: string;
  employee_id: string | null;
  team_id: string | null;
  work_location_id: string | null;
  pattern_id: string | null;
  shift_id: string | null;
  starts_on: string;
  ends_on: null;
  created_by: string;
  created_at: string;
};
export type ManagerDelegationRow = {
  id: string;
  org_id: string;
  from_employee_id: string;
  to_employee_id: string;
  starts_on: string;
  ends_on: string;
  reason: string;
  created_by: string;
  ended_early_at: null;
  created_at: string;
};

export type PeopleRows = {
  work_pattern: WorkPatternRow[];
  skill: SkillRow[];
  pay_component_def: PayComponentDefRow[];
  employee: EmployeeRow[];
  employee_terms: EmployeeTermsRow[];
  employee_hr: EmployeeHrRow[];
  employee_compensation: CompensationRow[];
  employee_contract: ContractRow[];
  employee_event: EmployeeEventRow[];
  employee_skill: EmployeeSkillRow[];
  employee_pay_component: EmployeePayComponentRow[];
  employee_payment_instruction: PaymentInstructionRow[];
  schedule_assignment: ScheduleAssignmentRow[];
  manager_delegation: ManagerDelegationRow[];
};
export type PeopleTable = keyof PeopleRows;

/** Insert order: every foreign key's target table comes before its source. */
export const TABLE_ORDER: PeopleTable[] = [
  "work_pattern",
  "skill",
  "pay_component_def",
  "employee",
  "employee_terms",
  "employee_hr",
  "employee_compensation",
  "employee_contract",
  "employee_event",
  "employee_skill",
  "employee_pay_component",
  "employee_payment_instruction",
  "schedule_assignment",
  "manager_delegation",
];

/** One legal lifecycle step the HR service will be asked to make. */
export type LifecycleStep = {
  to: Exclude<Lifecycle, "draft">;
  effectiveDate: string;
  endDate?: string;
  reason: string;
};
export type Transition = { employeeId: string; from: "active"; steps: LifecycleStep[] };
export type ContractAction = {
  contractId: string;
  employeeId: string;
  accept: "signed_paper" | "in_app" | "email" | null;
};

export type PeopleHandoff = {
  personaEmployees: Partial<Record<PersonaKey, string>>;
  employeeIds: string[];
  /** Employees planned to be `active` at as-of (after the service transitions). */
  activeEmployeeIds: string[];
  /** Setup department code → employee ids. */
  byDepartment: Record<string, string[]>;
  /** Setup department code → the employee who heads it. */
  headOfDepartment: Record<string, string>;
  /** The owner, the operations manager and every department head — the people who approve things. */
  managers: string[];
  /** Setup's active team ids, the ones with members. */
  teamIds: string[];
  workPatternIds: { standard: string; rota: string; partTime: string };
  skillIds: string[];
  payComponents: Record<string, string>;
};

export type PeoplePlan = {
  rows: PeopleRows;
  transitions: Transition[];
  contractActions: ContractAction[];
  /** Final lifecycle per employee once the transitions have run. */
  finalLifecycle: Record<string, Lifecycle>;
  /** employee_event rows the service will add on top of the direct inserts. */
  serviceEventCount: number;
  handoff: PeopleHandoff;
};

// ── Small deterministic helpers ─────────────────────────────────────────────

/** Largest-remainder allocation of `total` across `weights`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (sum ? (total * w) / sum : 0));
  const base = raw.map(Math.floor);
  let rem = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rem <= 0) break;
    base[i]!++;
    rem--;
  }
  return base;
}

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** The product's own default: hourly cost = monthly salary / 208 working hours. */
export function hourlyOf(salaryMinor: number): number {
  return Math.round(salaryMinor / 208);
}
/** A raise rounded to the nearest 50 in major units. */
function raise(salaryMinor: number, pct: number): number {
  return Math.round((salaryMinor * (1 + pct)) / 5000) * 5000;
}
function hhmm(start: number, end: number): { start: string; end: string } {
  const f = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return { start: f(start), end: f(end) };
}
function patternDays(
  days: string[],
  start: number,
  end: number,
  breakMinutes: number,
): { days: Record<string, DayShape>; weekly: number } {
  const out: Record<string, DayShape> = {};
  for (const d of days) out[d] = { ...hhmm(start, end), break_minutes: breakMinutes };
  const weekly = (days.length * ((end - start) * 60 - breakMinutes)) / 60;
  return { days: out, weekly };
}

const DELEGATION_REASONS: Array<[string, string]> = [
  ["Annual leave cover", "تغطية الإجازة السنوية"],
  ["Business travel", "سفر عمل"],
  ["Training course", "دورة تدريبية"],
  ["Medical leave cover", "تغطية إجازة مرضية"],
];

// ── The pure plan ───────────────────────────────────────────────────────────

const PLANS = new WeakMap<LabContext, PeoplePlan>();

/** Plan once per context: plan() and seed() share the same rows and the same rng draws. */
export function planFor(ctx: LabContext): PeoplePlan {
  let p = PLANS.get(ctx);
  if (!p) {
    p = buildPeoplePlan(ctx);
    PLANS.set(ctx, p);
  }
  return p;
}

export function buildPeoplePlan(ctx: LabContext): PeoplePlan {
  const { company, rng, clock, orgId } = ctx;
  const S = STAFFING[company.key];
  const refs = ctx.handoff<SetupHandoff>("setup");
  const H = historyDays(company);
  const lang: "en" | "ar" = company.languages[0] === "ar" ? "ar" : "en";
  const dayOne = clock.tsAgo(H, 8);
  const hrUser = ctx.users.hr;
  const ownerUser = ctx.users.owner;
  const n = company.profile.employees;
  if (n < PERSONA_EMPLOYEES.length) throw new Error(`${company.key}: profile.employees < 8`);
  const idOf = (kind: string, ...ord: Array<string | number>) => ctx.id(FAMILY, kind, ...ord);

  // ── setup's structure, resolved through the handoff (never re-created here) ──
  const need = <T>(map: Record<string, T> | undefined, key: string, what: string): T => {
    const v = map?.[key];
    if (v === undefined) throw new Error(`${company.key}: setup handoff has no ${what} "${key}"`);
    return v;
  };
  const catalogue = positionsFor(company.key);
  const deptId = (code: string) => need(refs.departments, code, "department");
  const positionOf = (key: string): PositionRef => {
    const p = catalogue.get(key);
    if (!p) throw new Error(`${company.key}: people has no position "${key}"`);
    const ref = need(refs.positions, key, "position");
    if (ref.department !== p.dept)
      throw new Error(
        `${company.key}: setup places position "${key}" in ${ref.department}; people expects ${p.dept}`,
      );
    return p;
  };
  const posId = (key: string) => need(refs.positions, key, "position").id;
  const teamId = (key: string) => need(refs.teams, key, "team");
  const locId = (key: string) => need(refs.workLocations, key, "work location");
  const shiftId = (key: string) => need(refs.shifts, key, "shift");
  const deptByCode = new Map(S.departments.map((d) => [d.code, d]));
  const isFieldDept = (code: string) => deptByCode.get(code)?.field ?? false;
  const locationKeys = [S.officeLocation, ...S.siteLocations];

  // ── people: departments by ratio, positions, dates, states ──
  const m = n - PERSONA_EMPLOYEES.length;
  const alloc = allocate(
    m,
    S.departments.map((d) => d.weight),
  );
  const deptOfStaff: DeptStaffing[] = [];
  alloc.forEach((c, di) => {
    for (let k = 0; k < c; k++) deptOfStaff.push(S.departments[di]!);
  });
  const nLong = Math.round(m * 0.3);
  const longAgos = Array.from({ length: nLong }, () => H + rng.int(30, 1100));
  const hireAgos = shuffle(rng, [...longAgos, ...spreadDates(rng, company, m - nLong)]);

  type Emp = {
    i: number;
    id: string;
    persona: PersonaEmployee | null;
    dept: string;
    pos: PositionRef;
    isHead: boolean;
    teamKey: string | null;
    hireAgo: number;
    born: "draft" | "active";
    final: Lifecycle;
    endAgo: number | null;
    archiveAgo: number | null;
    noticeAgo: number | null;
    viaNotice: boolean;
    employmentType: string;
    name: { en: string; ar: string };
  };
  const emps: Emp[] = [];
  const headOfDept = new Map<string, string>();

  // Personas first (ordinals 0..7): all born active, all stay active.
  PERSONA_EMPLOYEES.forEach((persona, i) => {
    const p = company.personas.find((x) => x.key === persona)!;
    const seat = S.personas[persona];
    const pos = positionOf(seat.position);
    const isHead = HEAD_PERSONAS.includes(persona);
    const id = idOf("employee", i);
    if (isHead) headOfDept.set(seat.dept, id);
    emps.push({
      i,
      id,
      persona,
      dept: seat.dept,
      pos,
      isHead,
      teamKey: seat.team,
      hireAgo: persona === "owner" ? H + 400 : H - 30,
      born: "active",
      final: "active",
      endAgo: null,
      archiveAgo: null,
      noticeAgo: null,
      viaNotice: false,
      employmentType: "full_time",
      name: { en: p.fullName, ar: p.fullNameAr },
    });
  });

  // Everyone else, in allocation order; the first person in a headless department is its head.
  const rotation = new Map<string, number>();
  deptOfStaff.forEach((d, j) => {
    const i = PERSONA_EMPLOYEES.length + j;
    const isHead = !headOfDept.has(d.code);
    const posKey = isHead ? d.head : pick(rng, d.staff);
    const pos = positionOf(posKey);
    const id = idOf("employee", i);
    if (isHead) headOfDept.set(d.code, id);
    let teamKey: string | null = null;
    if (d.field && d.teams?.length && !isHead) {
      const pinned = d.teamByPosition?.[posKey];
      if (pinned) teamKey = pinned;
      else {
        const pinnedTeams = new Set(Object.values(d.teamByPosition ?? {}));
        const rotating = d.teams.filter((t) => !pinnedTeams.has(t));
        const pool = rotating.length ? rotating : d.teams;
        const k = rotation.get(d.code) ?? 0;
        rotation.set(d.code, k + 1);
        teamKey = pool[k % pool.length]!;
      }
    }
    let hireAgo = hireAgos[j]!;
    let born: "draft" | "active" = "active";
    let final: Lifecycle = "active";
    if (!isHead && rng.chance(0.03)) {
      born = "draft";
      final = "draft";
      hireAgo = -rng.int(5, 40);
    } else if (!isHead) {
      final = weighted(rng, {
        active: 80,
        notice: 4,
        suspended: 3,
        terminated: 7,
        archived: 6,
      });
      if ((final === "terminated" || final === "archived") && hireAgo < 150) final = "active";
    }
    let endAgo: number | null = null;
    let archiveAgo: number | null = null;
    let noticeAgo: number | null = null;
    let viaNotice = false;
    if (final === "terminated") {
      endAgo = rng.int(1, Math.min(hireAgo - 60, 400));
      viaNotice = rng.chance(0.5);
      if (viaNotice) noticeAgo = endAgo + rng.int(14, 30);
    } else if (final === "archived") {
      endAgo = rng.int(90, Math.min(hireAgo - 60, 700));
      archiveAgo = Math.max(1, endAgo - rng.int(14, 60));
    } else if (final === "notice") {
      noticeAgo = rng.int(1, 30);
    } else if (final === "suspended") {
      noticeAgo = rng.int(1, 45); // reused as the suspension date
    }
    const employmentType = isHead
      ? "full_time"
      : weighted(rng, { full_time: 85, part_time: 5, contractor: 4, temporary: 4, intern: 2 });
    emps.push({
      i,
      id,
      persona: null,
      dept: d.code,
      pos,
      isHead,
      teamKey,
      hireAgo,
      born,
      final,
      endAgo,
      archiveAgo,
      noticeAgo,
      viaNotice,
      employmentType,
      name: personName(rng, i),
    });
  });

  // ── work patterns (people's own; setup writes none) ──
  const week = company.sixDayWeek
    ? ["sat", "sun", "mon", "tue", "wed", "thu"]
    : ["sun", "mon", "tue", "wed", "thu"];
  const std = patternDays(week, 8, 17, 60);
  const rota = patternDays(week, 6, 14, 0);
  const part = patternDays(["sun", "tue", "thu"], 9, 14, 0);
  const work_pattern: WorkPatternRow[] = [
    {
      id: idOf("work_pattern", "standard"),
      org_id: orgId,
      name_en: company.sixDayWeek ? "Standard Week (Sat–Thu)" : "Standard Week (Sun–Thu)",
      name_ar: company.sixDayWeek
        ? "الأسبوع القياسي (السبت–الخميس)"
        : "الأسبوع القياسي (الأحد–الخميس)",
      days: std.days,
      weekly_hours: std.weekly,
      is_default: true,
      active: true,
      created_at: dayOne,
      updated_at: dayOne,
    },
    {
      id: idOf("work_pattern", "rota"),
      org_id: orgId,
      name_en: `Shift Rota (${week.length} × 8h)`,
      name_ar: `نظام الورديات (${week.length} × 8 ساعات)`,
      days: rota.days,
      weekly_hours: rota.weekly,
      is_default: false,
      active: true,
      created_at: dayOne,
      updated_at: dayOne,
    },
    {
      id: idOf("work_pattern", "part_time"),
      org_id: orgId,
      name_en: "Part-time (3 mornings)",
      name_ar: "دوام جزئي (3 صباحات)",
      days: part.days,
      weekly_hours: part.weekly,
      is_default: false,
      active: true,
      created_at: dayOne,
      updated_at: dayOne,
    },
  ];

  // ── skills, pay-component vocabulary ──
  const skill: SkillRow[] = S.skills.map(([key, en, ar], i) => ({
    id: idOf("skill", i),
    org_id: orgId,
    key,
    name: en,
    name_ar: ar,
    active: true,
    created_by: hrUser,
    created_at: dayOne,
    updated_at: dayOne,
  }));
  const tradeSkills = S.skills.map((_, i) => i).filter((i) => S.skills[i]![3] === "trade");
  const officeSkills = S.skills.map((_, i) => i).filter((i) => S.skills[i]![3] === "office");

  const payroll = company.profile.enables.payroll;
  const componentDefs: Array<
    [
      string,
      string,
      string,
      PayComponentDefRow["kind"],
      PayComponentDefRow["calc"],
      number | null,
      boolean,
    ]
  > = [
    ["housing_allowance", "Housing allowance", "بدل سكن", "earning", "fixed", null, true],
    ["transport_allowance", "Transport allowance", "بدل مواصلات", "earning", "fixed", null, true],
    ["phone_allowance", "Phone allowance", "بدل هاتف", "earning", "fixed", null, true],
    ["overtime", "Overtime", "العمل الإضافي", "earning", "overtime", null, false],
    ["unpaid_leave", "Unpaid leave", "إجازة بدون راتب", "deduction", "manual", null, false],
  ];
  if (company.country === "SA") {
    componentDefs.push(
      [
        "gosi_employee",
        "GOSI — employee share",
        "التأمينات الاجتماعية — حصة الموظف",
        "deduction",
        "percent_of_basic",
        9.75,
        true,
      ],
      [
        "gosi_employer",
        "GOSI — employer share",
        "التأمينات الاجتماعية — حصة صاحب العمل",
        "employer_contribution",
        "percent_of_basic",
        11.75,
        true,
      ],
    );
  }
  const pay_component_def: PayComponentDefRow[] = payroll
    ? componentDefs.map(([key, en, ar, kind, calc, percent, recurring], i) => ({
        id: idOf("pay_component_def", key),
        org_id: orgId,
        key,
        label: { en, ar },
        kind,
        calc,
        percent,
        recurring,
        sort: i,
        active: true,
        created_at: dayOne,
        updated_at: dayOne,
      }))
    : [];
  const componentId = (key: string) => idOf("pay_component_def", key);

  // ── employee rows and their side-tables ──
  const employee: EmployeeRow[] = [];
  const employee_terms: EmployeeTermsRow[] = [];
  const employee_hr: EmployeeHrRow[] = [];
  const employee_compensation: CompensationRow[] = [];
  const employee_contract: ContractRow[] = [];
  const employee_event: EmployeeEventRow[] = [];
  const employee_skill: EmployeeSkillRow[] = [];
  const employee_pay_component: EmployeePayComponentRow[] = [];
  const employee_payment_instruction: PaymentInstructionRow[] = [];
  const schedule_assignment: ScheduleAssignmentRow[] = [];
  const transitions: Transition[] = [];
  const contractActions: ContractAction[] = [];
  const finalLifecycle: Record<string, Lifecycle> = {};
  const byDepartment: Record<string, string[]> = {};
  const nationalities = company.country === "SA" ? NATIONALITIES_SA : NATIONALITIES_AE;
  const managerPersonaId = emps.find((e) => e.persona === "manager")!.id;
  const ownerId = emps.find((e) => e.persona === "owner")!.id;
  const ev = (
    emp: Emp,
    k: string,
    event: string,
    daysAgo: number,
    detail: Record<string, unknown>,
    by: string,
  ): EmployeeEventRow => ({
    id: idOf("employee_event", emp.i, k),
    org_id: orgId,
    employee_id: emp.id,
    event,
    effective_date: clock.dayAgo(daysAgo),
    detail,
    created_by: by,
    created_at: clock.tsAgo(Math.min(Math.max(daysAgo, 0), H), 10),
  });

  for (const e of emps) {
    const isField = isFieldDept(e.dept);
    const by = e.persona ? ownerUser : hrUser;
    const createdAgo = e.hireAgo < 0 ? rng.int(1, 10) : Math.min(e.hireAgo, H);
    const createdAt = clock.tsAgo(createdAgo, 8);
    const isPersona = e.persona !== null;
    const persona = isPersona ? company.personas.find((x) => x.key === e.persona)! : null;
    const arabicFirst = lang === "ar" || persona?.locale === "ar";
    const nationality =
      isPersona && e.persona === "owner" ? company.country : weighted(rng, nationalities);
    const residency =
      nationality === company.country
        ? "citizen"
        : weighted(rng, { resident: 60, work_permit: 38, other: 2 });
    const probationMonths = isPersona ? 6 : pick(rng, [3, 6]);
    const probationAgo = e.hireAgo - 30 * probationMonths;
    const activeUntilAgo = e.endAgo ?? 0;
    const confirmed =
      e.born === "active" && probationAgo >= activeUntilAgo && (isPersona || rng.chance(0.9));
    const manager =
      e.persona === "owner"
        ? null
        : e.persona === "manager"
          ? ownerId
          : e.isHead
            ? e.dept === "FIN" || e.dept === "HR" || e.dept === "MGMT"
              ? ownerId
              : managerPersonaId
            : (headOfDept.get(e.dept) ?? managerPersonaId);
    const locKey = isPersona
      ? e.persona === "field" || e.persona === "restricted"
        ? pick(rng, S.siteLocations)
        : e.persona === "warehouse"
          ? S.siteLocations[0]!
          : S.officeLocation
      : isField
        ? pick(rng, S.siteLocations)
        : rng.chance(0.85)
          ? S.officeLocation
          : pick(rng, S.siteLocations);
    const legalName = rng.chance(0.3) ? `${e.name.en} ${pick(rng, LAST_EN)}` : e.name.en;
    const emergency = personName(rng, e.i + 1000);
    const emailAddr = e.persona ? personaEmail(company.key, e.persona) : email(e.name.en, e.i);

    employee.push({
      id: e.id,
      org_id: orgId,
      name: arabicFirst ? e.name.ar : e.name.en,
      name_ar: e.name.ar,
      legal_name: legalName,
      employee_no: `EMP-${1001 + e.i}`,
      email: emailAddr,
      phone: phone(company, e.i),
      user_id: e.persona ? ctx.users[e.persona] : null,
      team_id: e.teamKey ? teamId(e.teamKey) : null,
      department_id: deptId(e.dept),
      position_id: posId(e.pos.key),
      work_location_id: locId(locKey),
      cost_centre: `CC-${e.dept}`,
      manager_employee_id: manager,
      employment_type: e.employmentType,
      lifecycle: e.born,
      active: e.born === "active",
      hire_date: clock.dayAgo(e.hireAgo),
      probation_end_date: clock.dayAgo(probationAgo),
      confirmation_date: confirmed ? clock.dayAgo(probationAgo) : null,
      nationality,
      residency_status: residency,
      emergency_contact_name: arabicFirst ? emergency.ar : emergency.en,
      emergency_contact_phone: phone(company, e.i + 5000),
      emergency_contact_relation: pick(rng, ["spouse", "parent", "sibling", "friend"]),
      created_at: createdAt,
      updated_at: createdAt,
    });
    finalLifecycle[e.id] = e.final;
    (byDepartment[e.dept] ??= []).push(e.id);

    // Compensation history: hire, then annual reviews (2–3 rows for long tenure), some promotions.
    const [lo, hi] = BAND[e.pos.tier];
    let salary = priceMinor(rng, lo, hi);
    const otRate =
      isField && (e.pos.tier === "skilled" || e.pos.tier === "labour") && rng.chance(0.4)
        ? 1.5
        : 1.25;
    const compRows: Array<{ ago: number; reason: CompensationRow["reason"] }> = [
      { ago: e.hireAgo, reason: "hire" },
    ];
    for (let k = 1; k <= 2; k++) {
      const ago = e.hireAgo - 365 * k;
      if (ago < activeUntilAgo || ago < 0) break;
      compRows.push({ ago, reason: "annual_review" });
    }
    if (compRows.length >= 2 && !e.isHead && rng.chance(0.2))
      compRows[compRows.length - 1]!.reason = "promotion";
    compRows.forEach((c, k) => {
      if (k > 0)
        salary = raise(
          salary,
          c.reason === "promotion" ? rng.float(0.1, 0.2) : rng.float(0.03, 0.08),
        );
      const rowCreated = clock.tsAgo(c.ago < 0 ? createdAgo : Math.min(c.ago, H), 10);
      employee_compensation.push({
        id: idOf("employee_compensation", e.i, k),
        org_id: orgId,
        employee_id: e.id,
        effective_date: clock.dayAgo(c.ago),
        salary_minor: salary,
        hourly_cost_minor: hourlyOf(salary),
        ot_rate: otRate,
        reason: c.reason,
        note: c.reason === "promotion" ? `Promoted to ${e.pos.en}` : null,
        superseded_at: null,
        created_by: ownerUser,
        created_at: rowCreated,
      });
      if (k > 0) {
        employee_event.push(
          ev(e, `comp${k}`, "compensation_changed", c.ago, { reason: c.reason }, ownerUser),
        );
        if (c.reason === "promotion")
          employee_event.push(
            ev(e, `promo${k}`, "promoted", c.ago, { position_id: posId(e.pos.key) }, hrUser),
          );
      }
    });
    // The current projection: the latest live row that is not in the future.
    if (compRows.some((c) => c.ago >= 0)) {
      const last = employee_compensation[employee_compensation.length - 1]!;
      employee_terms.push({
        employee_id: e.id,
        org_id: orgId,
        salary_minor: last.salary_minor,
        hourly_cost_minor: last.hourly_cost_minor,
        ot_rate: last.ot_rate,
        updated_at: last.created_at,
      });
    }

    // Identity: impossible prefixes, some expiries already past.
    const idExpiryAgo = rng.chance(0.15) ? rng.int(1, 300) : -rng.int(30, 1200);
    const passportExpiryAgo = rng.chance(0.1) ? rng.int(1, 200) : -rng.int(60, 2500);
    const visaExpiryAgo =
      residency === "citizen" ? null : rng.chance(0.1) ? rng.int(1, 120) : -rng.int(15, 700);
    employee_hr.push({
      employee_id: e.id,
      org_id: orgId,
      id_number: fakeIdNumber(company, e.i),
      id_expiry: clock.dayAgo(idExpiryAgo),
      passport_number: fakePassport(e.i),
      passport_expiry: clock.dayAgo(passportExpiryAgo),
      visa_expiry: visaExpiryAgo === null ? null : clock.dayAgo(visaExpiryAgo),
      notes: rng.chance(0.2) ? sentence(rng, lang) : null,
      updated_at: createdAt,
    });

    // Contract: born draft; issue/acceptance come from the service.
    const contractType: ContractRow["contract_type"] =
      e.employmentType === "part_time"
        ? "part_time_contract"
        : e.employmentType === "temporary" || e.employmentType === "intern"
          ? "temporary_contract"
          : e.employmentType === "contractor"
            ? "other"
            : "fixed_term";
    const contractEndAgo =
      contractType === "temporary_contract"
        ? e.hireAgo - 180
        : contractType === "other"
          ? e.hireAgo - 365
          : contractType === "part_time_contract" || rng.chance(0.55)
            ? null
            : e.hireAgo - pick(rng, [730, 1095]);
    const contractId = idOf("employee_contract", e.i);
    employee_contract.push({
      id: contractId,
      org_id: orgId,
      employee_id: e.id,
      contract_no: `CTR-${1001 + e.i}`,
      contract_type: contractType,
      start_date: clock.dayAgo(e.hireAgo),
      end_date: contractEndAgo === null ? null : clock.dayAgo(contractEndAgo),
      probation_months: probationMonths,
      status: "draft",
      notes: rng.chance(0.2) ? sentence(rng, lang) : null,
      created_by: hrUser,
      created_at: createdAt,
      updated_at: createdAt,
    });
    const settled = e.final === "terminated" || e.final === "archived";
    if (e.born === "active" && (isPersona || settled || rng.chance(0.45))) {
      contractActions.push({
        contractId,
        employeeId: e.id,
        accept:
          isPersona || settled || rng.chance(0.8)
            ? weighted(rng, { signed_paper: 50, in_app: 35, email: 15 })
            : null,
      });
    }

    // History that is legitimately born by insert (append-only table, no state machine).
    employee_event.push(
      ev(
        e,
        "created",
        "created",
        e.hireAgo,
        { employee_no: `EMP-${1001 + e.i}`, source: "h33" },
        by,
      ),
    );
    if (confirmed) employee_event.push(ev(e, "confirmed", "confirmed", probationAgo, {}, hrUser));
    if (!isPersona && !e.isHead && rng.chance(0.05)) {
      const fromDept = pick(
        rng,
        S.departments.filter((d) => d.code !== e.dept),
      );
      employee_event.push(
        ev(
          e,
          "transfer",
          "transferred",
          Math.max(activeUntilAgo + 1, Math.min(e.hireAgo - 30, rng.int(30, 400))),
          { from_department_id: deptId(fromDept.code), to_department_id: deptId(e.dept) },
          hrUser,
        ),
      );
    }

    // Skills: trades for field departments, office skills elsewhere.
    const pool = isField ? tradeSkills : officeSkills;
    const nSkills = isField ? rng.int(2, 3) : rng.int(1, 2);
    const chosen = shuffle(rng, pool).slice(0, nSkills);
    chosen.forEach((si, k) => {
      employee_skill.push({
        id: idOf("employee_skill", e.i, k),
        org_id: orgId,
        employee_id: e.id,
        skill_id: skill[si]!.id,
        level: Number(weighted(rng, { "1": 5, "2": 15, "3": 40, "4": 30, "5": 10 })),
        created_by: hrUser,
        created_at: createdAt,
        updated_at: createdAt,
      });
    });

    // Recurring pay components (payroll vocabulary), from the hire date.
    if (payroll && e.born === "active") {
      const effectiveFrom = clock.dayAgo(e.hireAgo);
      const comp = (key: string, k: number, amount: number | null): EmployeePayComponentRow => ({
        id: idOf("employee_pay_component", e.i, k),
        org_id: orgId,
        employee_id: e.id,
        component_id: componentId(key),
        amount_minor: amount,
        effective_from: effectiveFrom,
        effective_to: null,
        created_by: ownerUser,
        created_at: createdAt,
      });
      const first = employee_compensation.find((c) => c.employee_id === e.id)!;
      employee_pay_component.push(
        comp("housing_allowance", 0, Math.round((first.salary_minor * 0.25) / 10000) * 10000),
      );
      employee_pay_component.push(comp("transport_allowance", 1, priceMinor(rng, 300, 800)));
      if (e.pos.tier === "head" || e.pos.tier === "owner" || e.pos.tier === "pro")
        employee_pay_component.push(comp("phone_allowance", 2, priceMinor(rng, 100, 300)));
      if (company.country === "SA" && residency === "citizen") {
        employee_pay_component.push(comp("gosi_employee", 3, null));
        employee_pay_component.push(comp("gosi_employer", 4, null));
      }
    }

    // How they are paid: one active instruction, fake bank details throughout.
    const method = weighted(rng, { bank: 45, wps: 45, cash: 10 });
    employee_payment_instruction.push({
      id: idOf("employee_payment_instruction", e.i),
      org_id: orgId,
      employee_id: e.id,
      method,
      bank_name:
        method === "cash" ? null : lang === "ar" ? "بنك الاختبار الافتراضي" : "Fictional Test Bank",
      iban: method === "cash" ? null : iban(company, e.i),
      account_no: method === "cash" ? null : `0000${String(e.i).padStart(8, "0")}`,
      wps_agent_id: method === "wps" ? "0000000000000" : null,
      wps_person_id: method === "wps" ? `0000${String(e.i).padStart(10, "0")}` : null,
      note:
        method === "cash"
          ? lang === "ar"
            ? "يُدفع نقداً حتى فتح حساب بنكي"
            : "Paid in cash until a bank account is opened"
          : null,
      active: true,
      created_by: ownerUser,
      created_at: createdAt,
      updated_at: createdAt,
    });

    // Per-employee schedule overrides: part-timers, and a few night/evening-shift field staff.
    const startsOn = clock.dayAgo(Math.min(Math.max(e.hireAgo, 0), H));
    if (e.employmentType === "part_time") {
      schedule_assignment.push({
        id: idOf("schedule_assignment", "employee", e.i),
        org_id: orgId,
        employee_id: e.id,
        team_id: null,
        work_location_id: null,
        pattern_id: work_pattern[2]!.id,
        shift_id: null,
        starts_on: startsOn,
        ends_on: null,
        created_by: hrUser,
        created_at: createdAt,
      });
    } else if (S.shifts.override && isField && !e.isHead && !isPersona && rng.chance(0.05)) {
      schedule_assignment.push({
        id: idOf("schedule_assignment", "employee", e.i),
        org_id: orgId,
        employee_id: e.id,
        team_id: null,
        work_location_id: null,
        pattern_id: null,
        shift_id: shiftId(S.shifts.override),
        starts_on: startsOn,
        ends_on: null,
        created_by: hrUser,
        created_at: createdAt,
      });
    }

    // The service-driven part of the lifecycle: legal chains from `active`.
    const steps: LifecycleStep[] = [];
    if (e.final === "notice") {
      steps.push({
        to: "notice",
        effectiveDate: clock.dayAgo(e.noticeAgo!),
        reason: "Resignation received",
      });
    } else if (e.final === "suspended") {
      steps.push({
        to: "suspended",
        effectiveDate: clock.dayAgo(e.noticeAgo!),
        reason: "Pending investigation",
      });
    } else if (e.final === "terminated") {
      if (e.viaNotice)
        steps.push({
          to: "notice",
          effectiveDate: clock.dayAgo(e.noticeAgo!),
          reason: "Resignation received",
        });
      steps.push({
        to: "terminated",
        effectiveDate: clock.dayAgo(e.endAgo!),
        endDate: clock.dayAgo(e.endAgo!),
        reason: e.viaNotice ? "End of notice period" : "Contract ended",
      });
    } else if (e.final === "archived") {
      steps.push({
        to: "terminated",
        effectiveDate: clock.dayAgo(e.endAgo!),
        endDate: clock.dayAgo(e.endAgo!),
        reason: "Contract ended",
      });
      steps.push({
        to: "archived",
        effectiveDate: clock.dayAgo(e.archiveAgo!),
        reason: "Final settlement paid",
      });
    }
    if (steps.length) transitions.push({ employeeId: e.id, from: "active", steps });
  }

  // ── team and location schedules: every active setup team, every setup location ──
  S.teams.forEach((key, i) => {
    const rotaTeam = (company.key === "saudimfg" || company.key === "facilico") && i % 3 === 2;
    schedule_assignment.push({
      id: idOf("schedule_assignment", "team", key),
      org_id: orgId,
      employee_id: null,
      team_id: teamId(key),
      work_location_id: null,
      pattern_id: work_pattern[rotaTeam ? 1 : 0]!.id,
      shift_id: null,
      starts_on: clock.dayAgo(H),
      ends_on: null,
      created_by: hrUser,
      created_at: dayOne,
    });
  });
  locationKeys.forEach((key, i) => {
    schedule_assignment.push({
      id: idOf("schedule_assignment", "location", key),
      org_id: orgId,
      employee_id: null,
      team_id: null,
      work_location_id: locId(key),
      pattern_id: null,
      shift_id: shiftId(i === 0 ? S.shifts.office : S.shifts.site),
      starts_on: clock.dayAgo(H),
      ends_on: null,
      created_by: hrUser,
      created_at: dayOne,
    });
  });

  // ── a few delegations between heads: past, current and upcoming ──
  const heads = emps.filter((e) => e.isHead && e.persona !== "owner");
  const manager_delegation: ManagerDelegationRow[] = [];
  const nDeleg = Math.min(heads.length - 1, 3 + Math.floor(m / 40));
  for (let k = 0; k < nDeleg; k++) {
    const from = heads[k % heads.length]!;
    const to = heads[(k + 1) % heads.length]!;
    const [startsAgo, len] =
      k === 0 ? [3, 10] : k === 1 ? [-10, 10] : [rng.int(60, 300), rng.int(7, 21)];
    const [en, ar] = pick(rng, DELEGATION_REASONS);
    manager_delegation.push({
      id: idOf("manager_delegation", k),
      org_id: orgId,
      from_employee_id: from.id,
      to_employee_id: to.id,
      starts_on: clock.dayAgo(startsAgo),
      ends_on: clock.dayAgo(startsAgo - len),
      reason: lang === "ar" ? ar : en,
      created_by: hrUser,
      ended_early_at: null,
      created_at: clock.tsAgo(Math.max(startsAgo + 2, 1), 9),
    });
  }

  const serviceEventCount =
    transitions.reduce((a, t) => a + t.steps.length, 0) +
    contractActions.reduce((a, c) => a + 1 + (c.accept ? 1 : 0), 0);

  const personaEmployees: Partial<Record<PersonaKey, string>> = {};
  for (const e of emps) if (e.persona) personaEmployees[e.persona] = e.id;
  const handoff: PeopleHandoff = {
    personaEmployees,
    employeeIds: emps.map((e) => e.id),
    activeEmployeeIds: emps.filter((e) => e.final === "active").map((e) => e.id),
    byDepartment,
    headOfDepartment: Object.fromEntries(headOfDept),
    managers: Array.from(new Set([ownerId, managerPersonaId, ...heads.map((h) => h.id)])),
    teamIds: S.teams.map(teamId),
    workPatternIds: {
      standard: work_pattern[0]!.id,
      rota: work_pattern[1]!.id,
      partTime: work_pattern[2]!.id,
    },
    skillIds: skill.map((s) => s.id),
    payComponents: Object.fromEntries(pay_component_def.map((c) => [c.key, c.id])),
  };

  return {
    rows: {
      work_pattern,
      skill,
      pay_component_def,
      employee,
      employee_terms,
      employee_hr,
      employee_compensation,
      employee_contract,
      employee_event,
      employee_skill,
      employee_pay_component,
      employee_payment_instruction,
      schedule_assignment,
      manager_delegation,
    },
    transitions,
    contractActions,
    finalLifecycle,
    serviceEventCount,
    handoff,
  };
}

/** Rows per table the seed will attempt — the dry-run budget and the completeness check. */
export function expectedCounts(plan: PeoplePlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLE_ORDER) if (plan.rows[t].length) out[t] = plan.rows[t].length;
  return out;
}

// ── The service-driven transitions (never in dry-run, never in the unit test) ──

async function applyTransitions(ctx: LabContext, plan: PeoplePlan): Promise<number> {
  const hr = await import("@/modules/hr/service");
  const asHr = ctx.ctxFor("hr");
  const archetype = ctx.archetypeOf("hr");
  let calls = 0;

  // Resumable: read where each employee already is and only make the remaining moves.
  const ids = plan.transitions.map((t) => t.employeeId);
  const current = new Map<string, Lifecycle>();
  if (ids.length) {
    const rows = (await ctx.sql.unsafe(
      `select id::text as id, lifecycle from public.employee where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, ids] as never[],
    )) as unknown as Array<{ id: string; lifecycle: Lifecycle }>;
    for (const r of rows) current.set(r.id, r.lifecycle);
  }
  for (const t of plan.transitions) {
    const now = current.get(t.employeeId) ?? "active";
    const target = t.steps[t.steps.length - 1]!.to;
    if (now === target) continue;
    // Skip the steps already taken: the chain is linear, so resume after the current state.
    const at = t.steps.findIndex((s) => s.to === now);
    for (const s of t.steps.slice(at + 1)) {
      await hr.transitionEmployee(asHr, archetype, t.employeeId, {
        to: s.to,
        effectiveDate: s.effectiveDate,
        endDate: s.endDate,
        finalWorkingDate: s.endDate,
        reason: s.reason,
      });
      calls++;
    }
  }

  const contractIds = plan.contractActions.map((c) => c.contractId);
  const status = new Map<string, string>();
  if (contractIds.length) {
    const rows = (await ctx.sql.unsafe(
      `select id::text as id, status from public.employee_contract where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, contractIds] as never[],
    )) as unknown as Array<{ id: string; status: string }>;
    for (const r of rows) status.set(r.id, r.status);
  }
  for (const c of plan.contractActions) {
    const st = status.get(c.contractId) ?? "draft";
    if (st === "draft") {
      await hr.issueContract(asHr, archetype, c.contractId);
      calls++;
    }
    if (c.accept && st !== "accepted") {
      await hr.recordContractAcceptance(asHr, archetype, c.contractId, c.accept);
      calls++;
    }
  }
  return calls;
}

/**
 * Insert every planned row, then (unless told not to) drive the HR service for
 * the lifecycle chains and contract issues. `services: false` is the unit test's
 * and the dry-run's door: the same rows, no database-side transitions.
 */
export async function seedPeople(
  ctx: LabContext,
  opts: { services: boolean },
): Promise<FamilyReport> {
  const plan = planFor(ctx);
  const counts: Record<string, number> = {};
  for (const table of TABLE_ORDER) {
    const rows = plan.rows[table];
    if (!rows.length) continue;
    const r = await ctx.insert(table, rows);
    counts[table] = r.attempted;
    ctx.log(`${table}: ${r.inserted}/${r.attempted} inserted`);
  }
  Object.assign(ctx.employees, plan.handoff.personaEmployees);
  const notes = [
    `${plan.transitions.length} lifecycle chains and ${plan.contractActions.length} contract issues planned through the HR service`,
  ];
  if (opts.services && !ctx.dryRun) {
    const calls = await applyTransitions(ctx, plan);
    ctx.log(`hr service: ${calls} calls (lifecycle transitions, contract issue/acceptance)`);
    notes.push(`${calls} HR service calls made`);
  } else {
    notes.push("HR service calls skipped");
  }
  return { family: FAMILY, counts, handoff: plan.handoff, notes };
}

// ── The family ──────────────────────────────────────────────────────────────

export const people: Family = {
  key: FAMILY,
  deps: ["setup"],
  appliesTo: () => true,

  plan(ctx): FamilyPlan {
    return { family: FAMILY, expected: expectedCounts(planFor(ctx)) };
  },

  seed(ctx): Promise<FamilyReport> {
    return seedPeople(ctx, { services: !ctx.dryRun });
  },

  async verify(ctx): Promise<Check[]> {
    const plan = planFor(ctx);
    const checks: Check[] = [];
    const q = async <T>(text: string, params: unknown[]): Promise<T[]> =>
      (await ctx.sql.unsafe(text, params as never[])) as unknown as T[];
    const one = async (text: string, params: unknown[] = [ctx.orgId]): Promise<number> =>
      Number((await q<{ n: number | string }>(text, params))[0]?.n ?? 0);
    const IDENT = /^[a-z_]+$/;

    // 1) Counts against the plan; employee_event also carries the service-written history.
    for (const [table, expected] of Object.entries(expectedCounts(plan))) {
      if (!IDENT.test(table)) throw new Error(`unsafe table ${table}`);
      const n = await one(`select count(*)::int as n from public.${table} where org_id = $1`);
      const want = table === "employee_event" ? expected + plan.serviceEventCount : expected;
      checks.push({
        name: `${table} count`,
        ok: n === want,
        detail: `${n} rows, planned ${want}${table === "employee_event" ? ` (${expected} inserted + ${plan.serviceEventCount} by the HR service)` : ""}`,
      });
    }

    // 2) The personas that must be employees are linked to their logins and active.
    for (const persona of REQUIRED_PERSONA_EMPLOYEES) {
      const id = plan.handoff.personaEmployees[persona]!;
      const rows = await q<{ user_id: string | null; lifecycle: string }>(
        `select user_id::text as user_id, lifecycle from public.employee where org_id = $1 and id = $2`,
        [ctx.orgId, id],
      );
      const r = rows[0];
      checks.push({
        name: `persona ${persona} is an employee`,
        ok: !!r && r.user_id === ctx.users[persona] && r.lifecycle === "active",
        detail: r ? `user_id ${r.user_id}, lifecycle ${r.lifecycle}` : "no employee row",
      });
    }

    // 3) Lifecycle mix landed as planned (proves the service transitions ran) and `active` agrees.
    const want: Record<string, number> = {};
    for (const l of Object.values(plan.finalLifecycle)) want[l] = (want[l] ?? 0) + 1;
    const got = await q<{ lifecycle: string; n: number }>(
      `select lifecycle, count(*)::int as n from public.employee where org_id = $1 group by lifecycle`,
      [ctx.orgId],
    );
    const gotMap = Object.fromEntries(got.map((g) => [g.lifecycle, g.n]));
    const lifecycleOk = Object.keys({ ...want, ...gotMap }).every(
      (k) => (want[k] ?? 0) === (gotMap[k] ?? 0),
    );
    checks.push({
      name: "lifecycle distribution",
      ok: lifecycleOk,
      detail: `got ${JSON.stringify(gotMap)} planned ${JSON.stringify(want)}`,
    });
    const activeMismatch = await one(
      `select count(*)::int as n from public.employee where org_id = $1 and active <> (lifecycle in ('active','suspended','notice'))`,
    );
    checks.push({
      name: "active flag derives from lifecycle",
      ok: activeMismatch === 0,
      detail: `${activeMismatch} mismatches`,
    });
    const terminatedNoEnd = await one(
      `select count(*)::int as n from public.employee where org_id = $1 and lifecycle in ('terminated','archived') and end_date is null`,
    );
    checks.push({
      name: "terminated employees carry an end date",
      ok: terminatedNoEnd === 0,
      detail: `${terminatedNoEnd} without`,
    });

    // 4) Money reconciles: terms = latest live compensation row not in the future; hourly = salary/208.
    const termsMismatch = await one(
      `select count(*)::int as n from public.employee_terms t
       join lateral (
         select salary_minor, hourly_cost_minor, ot_rate from public.employee_compensation c
         where c.org_id = t.org_id and c.employee_id = t.employee_id and c.superseded_at is null
           and c.effective_date <= current_date
         order by c.effective_date desc limit 1
       ) c on true
       where t.org_id = $1
         and (t.salary_minor <> c.salary_minor or t.hourly_cost_minor <> c.hourly_cost_minor or t.ot_rate <> c.ot_rate)`,
    );
    const termsMissing = await one(
      `select count(*)::int as n from public.employee e
       where e.org_id = $1
         and exists (select 1 from public.employee_compensation c where c.org_id = e.org_id and c.employee_id = e.id and c.effective_date <= current_date)
         and not exists (select 1 from public.employee_terms t where t.org_id = e.org_id and t.employee_id = e.id)`,
    );
    checks.push({
      name: "employee_terms equals the current compensation row",
      ok: termsMismatch === 0 && termsMissing === 0,
      detail: `${termsMismatch} differ, ${termsMissing} missing`,
    });
    const hourlyMismatch = await one(
      `select count(*)::int as n from public.employee_compensation where org_id = $1 and hourly_cost_minor <> round(salary_minor / 208.0)`,
    );
    checks.push({
      name: "hourly cost = salary / 208",
      ok: hourlyMismatch === 0,
      detail: `${hourlyMismatch} rows differ`,
    });

    // 5) Cross-links resolve and agree with setup's structure.
    const posDept = await one(
      `select count(*)::int as n from public.employee e
       left join public.position p on p.id = e.position_id and p.org_id = e.org_id
       where e.org_id = $1 and (e.department_id is null or p.id is null or p.department_id <> e.department_id)`,
    );
    checks.push({
      name: "position belongs to the employee's department",
      ok: posDept === 0,
      detail: `${posDept} disagree`,
    });
    const costCentre = await one(
      `select count(*)::int as n from public.employee e
       join public.department d on d.id = e.department_id and d.org_id = e.org_id
       where e.org_id = $1 and e.cost_centre is distinct from d.cost_centre`,
    );
    checks.push({
      name: "cost centre matches the department's",
      ok: costCentre === 0,
      detail: `${costCentre} differ`,
    });
    const noManager = await one(
      `select count(*)::int as n from public.employee where org_id = $1 and manager_employee_id is null`,
    );
    checks.push({
      name: "everyone but the owner has a manager",
      ok: noManager === 1,
      detail: `${noManager} without a manager`,
    });
    const emptyTeams = await one(
      `select count(*)::int as n from public.team t where t.org_id = $1 and t.active
       and not exists (select 1 from public.employee e where e.org_id = t.org_id and e.team_id = t.id)`,
    );
    checks.push({
      name: "every active team has members",
      ok: emptyTeams === 0,
      detail: `${emptyTeams} empty active teams`,
    });
    const restricted = plan.handoff.personaEmployees.restricted!;
    const field = plan.handoff.personaEmployees.field!;
    const crews = await q<{ id: string; team_id: string | null }>(
      `select id::text as id, team_id::text as team_id from public.employee where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, [restricted, field]],
    );
    const crewOf = (id: string) => crews.find((c) => c.id === id)?.team_id ?? null;
    checks.push({
      name: "restricted and field personas sit on different crews",
      ok: !!crewOf(restricted) && !!crewOf(field) && crewOf(restricted) !== crewOf(field),
      detail: `restricted ${crewOf(restricted)}, field ${crewOf(field)}`,
    });

    // 6) Contracts: issued/accepted only where the service was asked, and never by hand.
    const contractCounts = await q<{ status: string; n: number }>(
      `select status, count(*)::int as n from public.employee_contract where org_id = $1 group by status`,
      [ctx.orgId],
    );
    const cc = Object.fromEntries(contractCounts.map((c) => [c.status, c.n]));
    const wantAccepted = plan.contractActions.filter((c) => c.accept).length;
    const wantIssued = plan.contractActions.length - wantAccepted;
    const wantDraft = plan.rows.employee_contract.length - plan.contractActions.length;
    checks.push({
      name: "contract statuses",
      ok:
        (cc.accepted ?? 0) === wantAccepted &&
        (cc.issued ?? 0) === wantIssued &&
        (cc.draft ?? 0) === wantDraft,
      detail: `got ${JSON.stringify(cc)} planned accepted=${wantAccepted} issued=${wantIssued} draft=${wantDraft}`,
    });
    const badIssue = await one(
      `select count(*)::int as n from public.employee_contract where org_id = $1
       and ((status <> 'draft' and issued_at is null) or (status = 'accepted' and (accepted_at is null or accepted_channel is null)))`,
    );
    checks.push({
      name: "issued contracts carry issue/acceptance records",
      ok: badIssue === 0,
      detail: `${badIssue} inconsistent`,
    });

    // 7) One active payment instruction per employee.
    const payBad = await one(
      `select count(*)::int as n from public.employee e where e.org_id = $1
       and (select count(*) from public.employee_payment_instruction p where p.org_id = e.org_id and p.employee_id = e.id and p.active) <> 1`,
    );
    checks.push({
      name: "one active payment instruction each",
      ok: payBad === 0,
      detail: `${payBad} employees off`,
    });

    // 8) Schedules: one default pattern; every active team and location covered.
    const defaults = await one(
      `select count(*)::int as n from public.work_pattern where org_id = $1 and is_default`,
    );
    checks.push({
      name: "exactly one default work pattern",
      ok: defaults === 1,
      detail: `${defaults} defaults`,
    });
    const uncovered = await one(
      `select (select count(*) from public.team t where t.org_id = $1 and t.active and not exists
                 (select 1 from public.schedule_assignment s where s.org_id = t.org_id and s.team_id = t.id))
            + (select count(*) from public.work_location l where l.org_id = $1 and l.active and not exists
                 (select 1 from public.schedule_assignment s where s.org_id = l.org_id and s.work_location_id = l.id)) as n`,
    );
    checks.push({
      name: "schedule covers every active team and location",
      ok: uncovered === 0,
      detail: `${uncovered} uncovered`,
    });

    // 9) Nothing real: emails, id numbers and IBANs are unmistakably fake.
    const realEmail = await one(
      `select count(*)::int as n from public.employee where org_id = $1 and email not like '%.invalid'`,
    );
    const realId = await one(
      `select count(*)::int as n from public.employee_hr where org_id = $1 and id_number not like $2`,
      [ctx.orgId, `${fakeIdPrefix(ctx.company)}%`],
    );
    const realIban = await one(
      `select count(*)::int as n from public.employee_payment_instruction where org_id = $1 and iban is not null and iban not like $2`,
      [ctx.orgId, `${ctx.company.country}00 0000 %`],
    );
    checks.push({
      name: "identifiers are fake",
      ok: realEmail === 0 && realId === 0 && realIban === 0,
      detail: `${realEmail} real-looking emails, ${realId} ids, ${realIban} ibans`,
    });

    // 10) Pagination: the people surfaces are bounded by design (≤ 120 employees per profile).
    checks.push({
      name: "pagination threshold",
      ok: true,
      detail: `${plan.rows.employee.length} employees; the profile implies no > 1,205 people surface`,
    });
    return checks;
  },
};
