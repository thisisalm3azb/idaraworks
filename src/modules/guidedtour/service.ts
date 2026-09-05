/**
 * H32 — the guided onboarding module's only public door.
 *
 * Two responsibilities, and a firm line between them:
 *
 *   • progress — one row per person per organisation, read and written here.
 *   • the checklist — derived by COUNTING what the organisation already has.
 *
 * That second point is the one worth stating plainly: this module never creates
 * a customer, a job, an invoice or anything else. A getting-started checklist
 * that seeds example data leaves somebody with fake records in a real ledger,
 * and no amount of "you can delete them later" makes that acceptable. Every
 * item here is a question about data that already exists, asked read-only.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { can, type Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import {
  MAX_STEPS,
  TOUR_VERSION,
  shouldAutoStart,
  stepsFor,
  tourKeyForRole,
  type TourKey,
  type TourStep,
} from "./tours";

export {
  MAX_STEPS,
  TOUR_VERSION,
  TOUR_KEYS,
  AUTO_START_FROM,
  allTours,
  shouldAutoStart,
  stepsFor,
  tourKeyForRole,
  type TourKey,
  type TourStep,
} from "./tours";

/** The closed set of things a person's progress can be. Mirrors the CHECK. */
export const ONBOARDING_STATUSES = [
  "new",
  "welcomed",
  "in_progress",
  "completed",
  "skipped",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export type OnboardingState = {
  status: OnboardingStatus;
  stepIndex: number;
  tourKey: string | null;
  tourVersion: number;
  checklistDismissed: boolean;
};

const BLANK: OnboardingState = {
  status: "new",
  stepIndex: 0,
  tourKey: null,
  tourVersion: TOUR_VERSION,
  checklistDismissed: false,
};

type Row = {
  status: string;
  step_index: number;
  tour_key: string | null;
  tour_version: number;
  checklist_dismissed_at: Date | null;
};

function toState(row: Row | undefined): OnboardingState {
  if (!row) return BLANK;
  const status = (ONBOARDING_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as OnboardingStatus)
    : "new";
  return {
    status,
    stepIndex: Number(row.step_index ?? 0),
    tourKey: row.tour_key,
    tourVersion: Number(row.tour_version ?? TOUR_VERSION),
    checklistDismissed: row.checklist_dismissed_at !== null,
  };
}

// ── The checklist ───────────────────────────────────────────────────────────

/**
 * Every item, in the order a company would naturally do them.
 *
 * Three, not four. The home page already carries an owner-only setup card
 * (workspace, company details, logo, invite the team) that shows while a
 * workspace is empty; this list answers the different question — has this
 * company done its first real work yet. Asking "invite somebody" twice on one
 * screen is how two useful cards become one ignored one, so that item is left
 * to the card that already owns it.
 */
export const CHECKLIST_KEYS = ["customer", "job", "invoice"] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

export type ChecklistItem = {
  key: ChecklistKey;
  done: boolean;
  /** Where to go and do it, or null when this person may only look. */
  href: string | null;
};

/**
 * What each item means, in one place.
 *
 * `view` decides whether the item is shown at all — an item pointing somewhere
 * a person would be refused is a dead end. `act` decides whether it becomes a
 * link: somebody who can see invoices but not raise one still deserves to know
 * the step exists and is done.
 */
const CHECKLIST: Record<
  ChecklistKey,
  { view: Action; act: Action; path: (orgId: string) => string }
> = {
  customer: {
    view: "customers.view",
    act: "customers.manage",
    path: (o) => `/o/${o}/customers/new`,
  },
  job: { view: "jobs.view", act: "jobs.create", path: (o) => `/o/${o}/jobs/new` },
  invoice: {
    view: "invoices.view",
    act: "invoices.manage",
    path: (o) => `/o/${o}/invoices/new`,
  },
};

export type Onboarding = {
  state: OnboardingState;
  /** The steps THIS person should see, already permission-filtered. */
  steps: TourStep[];
  tourKey: TourKey;
  /** Greet them without being asked? See `shouldAutoStart` for the rule. */
  autoStart: boolean;
  checklist: ChecklistItem[];
  /** True once every visible item is done — the checklist then retires itself. */
  checklistComplete: boolean;
};

/**
 * Everything the shell needs, in one round trip.
 *
 * One query rather than five, because this runs on every page load for every
 * person in the pilot and a welcome mat has no business adding four round trips
 * to the request that renders somebody's work.
 *
 * `exists` rather than `count`: the question is "is there at least one", and
 * Postgres can stop at the first row. It also sidesteps the 1,000-row read cap
 * entirely — there is no row set to page through.
 */
export async function loadOnboarding(ctx: Ctx, archetype: RoleArchetype): Promise<Onboarding> {
  const allowed = (a: Action) => can(archetype, a);
  const { tourKey, steps } = stepsFor(archetype, allowed);

  const rows = await withCtx(ctx, async (tx) => {
    return (await tx.execute(sql`
      select
        os.status,
        os.step_index,
        os.tour_key,
        os.tour_version,
        os.checklist_dismissed_at,
        m.created_at as member_since,
        exists (select 1 from public.customer c where c.org_id = ${ctx.orgId}) as has_customer,
        exists (select 1 from public.job j where j.org_id = ${ctx.orgId}) as has_job,
        exists (select 1 from public.invoice i where i.org_id = ${ctx.orgId}) as has_invoice
      from public.membership m
      left join public.onboarding_state os
        on os.org_id = m.org_id and os.user_id = m.user_id
      where m.org_id = ${ctx.orgId} and m.user_id = ${ctx.userId}
      limit 1
    `)) as unknown as Array<
      Partial<Row> & {
        member_since: string | Date | null;
        has_customer: boolean;
        has_job: boolean;
        has_invoice: boolean;
      }
    >;
  });

  const row = rows[0];
  // No membership row is not an error here — the layout guard already refused
  // anybody who does not belong. Treat it as "nothing to show" and move on:
  // onboarding must never be the thing that breaks a page.
  const state = toState(row?.status ? (row as Row) : undefined);

  const memberSince = row?.member_since ? new Date(row.member_since) : null;
  const autoStart =
    steps.length > 0 &&
    shouldAutoStart({
      memberSince,
      status: state.status,
      tourKey,
      storedTourKey: state.tourKey,
    });

  const done: Record<ChecklistKey, boolean> = {
    customer: row?.has_customer === true,
    job: row?.has_job === true,
    invoice: row?.has_invoice === true,
  };
  const checklist: ChecklistItem[] = CHECKLIST_KEYS.filter((k) => allowed(CHECKLIST[k].view)).map(
    (k) => ({
      key: k,
      done: done[k],
      href: allowed(CHECKLIST[k].act) ? CHECKLIST[k].path(ctx.orgId) : null,
    }),
  );

  return {
    state,
    steps,
    tourKey,
    autoStart,
    checklist,
    checklistComplete: checklist.length > 0 && checklist.every((i) => i.done),
  };
}

/**
 * Record where somebody has got to.
 *
 * ── Why this is not wrapped in `command()` ──────────────────────────────────
 * The audit log is the organisation's record of who changed the business and
 * when. "Advanced to step 3 of the welcome tour" is not that, and a few hundred
 * of them per new employee would bury the entries somebody actually needs to
 * find during a dispute. This writes one row that only its owner can read, and
 * `updated_at` already answers when.
 *
 * The upsert never touches org_id or user_id on conflict — and could not, since
 * neither is in the UPDATE grant. Combined with the RLS policy, a person can
 * only ever write their own row in their own organisation.
 */
export async function saveProgress(
  ctx: Ctx,
  input: {
    status: OnboardingStatus;
    stepIndex: number;
    tourKey: TourKey;
    /**
     * An explicit request to start again, which is allowed to move the position
     * backwards. Everything else may only move forwards.
     *
     * A flag rather than something inferred from the status, and the integration
     * test is why: restarting writes `in_progress`, which is not terminal, so
     * the monotonic guard clamped the reset away and Restart silently resumed at
     * the last step instead of the first. Intent and resulting status are
     * different things, and only the caller knows which this is.
     */
    reset?: boolean;
  },
): Promise<void> {
  const step = Math.max(0, Math.min(MAX_STEPS, Math.trunc(input.stepIndex)));
  const rewindAllowed =
    input.status === "completed" || input.status === "skipped" || input.reset === true;

  await withCtx(ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.onboarding_state
        (org_id, user_id, status, step_index, tour_key, tour_version, completed_at, dismissed_at)
      values (
        ${ctx.orgId}, ${ctx.userId}, ${input.status}, ${step}, ${input.tourKey}, ${TOUR_VERSION},
        ${input.status === "completed" ? sql`now()` : sql`null`},
        ${input.status === "skipped" ? sql`now()` : sql`null`}
      )
      on conflict (org_id, user_id) do update set
        status = excluded.status,
        -- Never move backwards while the tour is running: a second tab that is
        -- one step behind must not undo real progress. Finishing, skipping and
        -- an explicit restart are the exceptions, because each of those is
        -- somebody deciding where they are rather than reporting it late.
        step_index = ${
          rewindAllowed
            ? sql`excluded.step_index`
            : sql`greatest(public.onboarding_state.step_index, excluded.step_index)`
        },
        tour_key = excluded.tour_key,
        tour_version = excluded.tour_version,
        completed_at = excluded.completed_at,
        dismissed_at = excluded.dismissed_at,
        updated_at = now()
    `);
  });
}

/** Put the tour back to the beginning, from the Help menu. */
export async function restartTour(ctx: Ctx, archetype: RoleArchetype): Promise<void> {
  await saveProgress(ctx, {
    status: "in_progress",
    stepIndex: 0,
    tourKey: tourKeyForRole(archetype),
    // Deliberate: this is the one write that is allowed to move backwards.
    reset: true,
  });
}

/** Hide the checklist for this person. Independent of the tour. */
export async function dismissChecklist(ctx: Ctx): Promise<void> {
  await withCtx(ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.onboarding_state (org_id, user_id, checklist_dismissed_at)
      values (${ctx.orgId}, ${ctx.userId}, now())
      on conflict (org_id, user_id) do update set
        checklist_dismissed_at = now(),
        updated_at = now()
    `);
  });
}
