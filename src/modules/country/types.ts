/**
 * H29 — the shapes the country module returns. Kept apart from the platform
 * pack contract so a surface can hold an establishment without holding a pack.
 */
import type { CountryPack, ReadinessState, Weekday } from "@/platform/country";

export type EstablishmentRow = {
  id: string;
  code: string;
  legalName: string;
  tradingName: string | null;
  /** The name in its own script, when the organisation entered one. */
  legalNameLocal: string | null;
  country: string;
  packKey: string | null;
  timezone: string;
  baseCurrency: string;
  workingDays: Weekday[];
  address: Record<string, string>;
  invoiceIdentity: Record<string, unknown>;
  banking: Record<string, unknown>;
  isPrimary: boolean;
  status: "active" | "inactive";
  verificationState: "unverified" | "self_declared" | "verified";
  createdAt: string;
  updatedAt: string;
};

export type RegistrationRow = {
  id: string;
  establishmentId: string;
  identifierKey: string;
  kind: string;
  authority: string;
  value: string;
  issuedOn: string | null;
  expiresOn: string | null;
  verificationState: "unverified" | "self_declared" | "verified";
};

export type AdoptionRow = {
  id: string;
  establishmentId: string;
  packKey: string;
  effectiveFrom: string;
  adoptedBy: string;
  note: string | null;
  supersededBy: string | null;
  createdAt: string;
};

/**
 * The configuration an establishment actually runs on. An organisation with no
 * establishment gets one derived from its own settings, so nothing changes for
 * anyone who has not adopted a pack.
 */
export type EffectiveConfig = {
  establishmentId: string | null;
  /** True when this came from the organisation rather than an establishment. */
  derived: boolean;
  country: string;
  timezone: string;
  currency: string;
  workingDays: Weekday[];
  packKey: string | null;
  pack: CountryPack | null;
  /** The date the pack was resolved for. */
  on: string;
};

// ── readiness ───────────────────────────────────────────────────────────────

export type ReadinessCheck = {
  key: string;
  /** Message key: the reason is rendered in the reader's own language. */
  labelKey: string;
  state: "ok" | "missing" | "blocked" | "not_applicable";
  /** What is missing, in the product's own words, as a message key. */
  detailKey?: string;
  /** Values for the message. */
  detail?: Record<string, string>;
};

export type ReadinessArea =
  "configuration" | "tax" | "payroll" | "documents" | "banking" | "privacy" | "einvoicing";

export type AreaReadiness = {
  area: ReadinessArea;
  checks: ReadinessCheck[];
  /** True only when every check in the area is ok or not applicable. */
  complete: boolean;
};

export type EstablishmentReadiness = {
  establishmentId: string;
  country: string;
  packKey: string | null;
  areas: AreaReadiness[];
  /**
   * The six states, each independently true or false. Never averaged into a
   * percentage, because legal readiness is not a number (ADR-74).
   */
  states: Record<ReadinessState, boolean>;
  /** Things that stop the establishment being used at all, in plain words. */
  blocking: ReadinessCheck[];
  /** What an outside party still has to do. */
  externalActions: string[];
};

// ── impact preview and simulation ───────────────────────────────────────────

export type ImpactLine = {
  /** What area of the product the change touches. */
  area: ReadinessArea | "identity" | "week" | "format";
  /** A message key describing the change. */
  labelKey: string;
  before: string | null;
  after: string | null;
  /** True when the change alters something a person must act on. */
  actionRequired: boolean;
};

export type ImpactPreview = {
  establishmentId: string;
  fromPackKey: string | null;
  toPackKey: string;
  effectiveFrom: string;
  changes: ImpactLine[];
  /** Records already issued, which the change cannot touch (ADR-70). */
  unchanged: Array<{ kind: string; count: number; note: string }>;
  /** Configuration still missing after the change. */
  stillMissing: ReadinessCheck[];
  /** Providers the new version needs and the organisation does not have. */
  newProviderRequirements: string[];
};
