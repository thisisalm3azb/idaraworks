/**
 * Owner Home view model (microstep 002B — blueprint docs/ux/OWNER_HOME_EXPERIENCE_BLUEPRINT.md).
 *
 * Pure serializable types shared by the deterministic composer
 * (src/modules/today/owner-home.ts — modules may import platform, never the
 * reverse) and the presentational components. Everything is expressed as i18n
 * KEYS + variables; the page translates. The composer can only echo counts it
 * was given — there is no field in this model that could carry a health score,
 * percentage, or invented status (truthfulness law, tested).
 */
import type { IconName } from "../icons";

export type OwnerHomeState = "empty" | "active" | "attention";

/** A small factual signal chip on the Business Brief (≤4 rendered). */
export type BriefChip = {
  key: string;
  labelKey: string;
  /** Count/money vars for the label. Money arrives PRE-FORMATTED by the page. */
  vars?: Record<string, string | number>;
  tone: "neutral" | "success" | "warning" | "danger";
  href?: string;
};

/** One prioritized next-best action (max 3 composed). */
export type HomeAction = {
  key: string;
  titleKey: string;
  /** Truthful grounded reason; omitted when no grounded reason exists. */
  reasonKey?: string;
  vars?: Record<string, string | number>;
  href: string;
  icon: IconName;
  urgency: "decide" | "overdue" | "review" | "money" | "setup" | "create";
};

/** One contextual attention row (zone renders only when list is non-empty). */
export type AttentionRow = {
  key: string;
  /** exception rule rows translate via dashboard.rule.<ruleKey>; others via labelKey. */
  ruleKey?: string;
  labelKey?: string;
  vars?: Record<string, string | number>;
  severity: "info" | "warning" | "critical";
  href: string;
};

/** One grounded setup step — `done` only when existing data proves it. */
export type SetupStep = {
  key: string;
  labelKey: string;
  done: boolean;
  href?: string;
  /** What completing it unlocks (shown on the next incomplete step). */
  unlocksKey?: string;
};

export type OwnerHomeView = {
  state: OwnerHomeState;
  brief: {
    /** The one factual sentence (state-appropriate; never a health claim). */
    sentenceKey: string;
    sentenceVars?: Record<string, string | number>;
    chips: BriefChip[];
  };
  actions: HomeAction[];
  attention: AttentionRow[];
  /** Rendered only in the empty state; no aggregate count, no percentage. */
  setup: SetupStep[] | null;
  /** Which lower-detail sections have meaningful content to show. */
  sections: {
    stages: boolean;
    reportTrend: boolean;
    collections: boolean;
    payments: boolean;
    purchasing: boolean;
    activity: boolean;
    deadlines: boolean;
  };
  /** Compact capabilities row (replaces the subscription strip + money LockedCards). */
  map: { capsOn: number; showManage: boolean } | null;
};
