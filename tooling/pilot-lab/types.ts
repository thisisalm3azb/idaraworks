/**
 * H33 Pilot Lab — the contracts every generator family implements.
 *
 * A family is one coherent slice of a company's life (customers, stock ledger,
 * payroll, Document Studio, …). It declares what it depends on, can say how
 * many rows it WOULD write (dry-run), writes them (seed), and can check them
 * afterwards (verify). The orchestrator owns ordering, checkpoints, the
 * capacity stop and progress; a family owns nothing but its own rows.
 */
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rng } from "../simulation/rng";
import type { SimClock } from "../simulation/dates";
import type { Sql, InsertResult } from "./db";

export type CompanyKey = "gulfbuild" | "tradeline" | "saudimfg" | "consult" | "facilico";

export type PersonaKey =
  | "owner"
  | "admin"
  | "manager"
  | "finance"
  | "hr"
  | "warehouse"
  | "field"
  | "restricted"
  | "auditor";

export type Persona = {
  key: PersonaKey;
  /** One of the seven role keys every organisation carries. */
  roleKey: "owner" | "admin" | "manager" | "foreman" | "procurement" | "accounts" | "viewer";
  archetype: RoleArchetype;
  fullName: string;
  fullNameAr: string;
  locale: "en" | "ar";
  /** Human description for the launcher and the acceptance checklist. */
  describes: string;
};

/** Knobs a family reads to scale itself; every company sets all of them. */
export type VolumeProfile = {
  customers: number;
  suppliers: number;
  items: number;
  employees: number;
  projects: number;
  jobs: number;
  tasksPerJob: [number, number];
  leads: number;
  opportunities: number;
  activitiesPerOpportunity: [number, number];
  quotes: number;
  invoices: number;
  purchaseOrders: number;
  stockMovementsTarget: number;
  journalEntries: number;
  documents: number;
  studioPlans: number;
  assets: number;
  /** Which optional families apply to this company at all. */
  enables: {
    stock: boolean;
    lots: boolean;
    serials: boolean;
    bom: boolean;
    payroll: boolean;
    assets: boolean;
    docstudio: boolean;
    studio: boolean;
    revenue: boolean;
    establishment: boolean;
  };
};

export type Company = {
  key: CompanyKey;
  nameEn: string;
  nameAr: string;
  legalNameEn: string;
  country: "AE" | "SA";
  currency: "AED" | "SAR";
  timezone: string;
  languages: Array<"en" | "ar">;
  templateKey: string;
  sixDayWeek: boolean;
  /** First day of operating history and the simulation "today". */
  history: { from: string; asOf: string };
  brandColor: string;
  personas: Persona[];
  profile: VolumeProfile;
};

/** What a family reports for the manifest and the checkpoint. */
export type FamilyReport = {
  family: string;
  counts: Record<string, number>;
  /** Anything a later family needs (ids of warehouses, accounts, …). Small. */
  handoff?: Record<string, unknown>;
  notes?: string[];
};

/** Expected rows per table, for the dry-run and the completeness check. */
export type FamilyPlan = { family: string; expected: Record<string, number> };

export type Check = { name: string; ok: boolean; detail?: string };

export type LabContext = {
  sql: Sql;
  admin: SupabaseClient;
  company: Company;
  orgId: string;
  /** Persona → auth user id. Every persona exists before any family runs. */
  users: Record<PersonaKey, string>;
  /** Persona → employee id, for the personas that are also employees. */
  employees: Partial<Record<PersonaKey, string>>;
  /** A tenant context for calling real domain services as a persona. */
  ctxFor(persona: PersonaKey): Ctx;
  archetypeOf(persona: PersonaKey): RoleArchetype;
  rng: Rng;
  clock: SimClock;
  /** Deterministic id for this company: id("customer", 17). */
  id(family: string, ...ordinal: Array<string | number>): string;
  /** Batched, idempotent insert. Rows must carry org_id. */
  insert(
    table: string,
    rows: Array<Record<string, unknown>>,
    conflict?: "nothing" | string,
  ): Promise<InsertResult>;
  /** Handoffs from families this one depends on. */
  handoff<T = Record<string, unknown>>(family: string): T;
  log(message: string): void;
  dryRun: boolean;
};

export type Family = {
  key: string;
  /** Families that must have completed first (their handoffs are then available). */
  deps: string[];
  /** Whether this family applies to a company at all. */
  appliesTo(company: Company): boolean;
  plan(ctx: LabContext): FamilyPlan;
  seed(ctx: LabContext): Promise<FamilyReport>;
  verify?(ctx: LabContext): Promise<Check[]>;
};
