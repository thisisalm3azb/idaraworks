import Link from "next/link";
import { guidedOnboardingEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { loadOnboardingCached } from "./load";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { dismissChecklistAction } from "./actions";
import type { TourTerms } from "./GuidedTourMount";

/**
 * H32 — the getting-started checklist.
 *
 * Three questions about work this company has or has not done yet, each one a
 * count of records that already exist. Nothing here creates anything: a
 * checklist that seeds an example customer to tick its own box leaves fake
 * entries in a real ledger, and "you can delete them later" does not make that
 * a reasonable thing to do to somebody's books.
 *
 * It retires itself. Once every visible item is done, or the person dismisses
 * it, it never comes back — a permanent nag is what turns a helpful list into
 * furniture people stop seeing.
 */
export async function GettingStarted({
  orgId,
  ctx,
  archetype,
  terms,
}: {
  orgId: string;
  ctx: Ctx;
  archetype: RoleArchetype;
  terms: TourTerms;
}) {
  if (!guidedOnboardingEnabled()) return null;

  // Same reasoning as the tour mount: the catch guards the query, not the
  // render, because the render has not happened yet when this returns.
  let data: Awaited<ReturnType<typeof loadOnboardingCached>>;
  let t: Awaited<ReturnType<typeof getT>>;
  try {
    data = await loadOnboardingCached(ctx, archetype);
    t = await getT();
  } catch {
    // Never the reason a page fails to render.
    return null;
  }
  const { checklist, checklistComplete, state } = data;
  if (state.checklistDismissed || checklistComplete || checklist.length === 0) return null;

  const done = checklist.filter((i) => i.done).length;

  return (
    <section
      aria-labelledby="iw-getting-started"
      className="rounded-lg border border-line bg-card p-4 shadow-pop"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="iw-getting-started" className="text-base font-semibold text-ink">
          {t("checklist.title")}
        </h2>
        <form action={dismissChecklistAction.bind(null, orgId)}>
          <button
            type="submit"
            className="-me-1 -mt-1 flex h-8 items-center rounded-md px-2 text-xs text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            {t("checklist.dismiss")}
          </button>
        </form>
      </div>
      <p className="mt-0.5 text-xs tabular-nums text-ink-secondary">
        {t("checklist.progress", { done, total: checklist.length })}
      </p>

      <ul className="mt-3 flex flex-col gap-1.5">
        {checklist.map((item) => {
          const label = t(`checklist.item.${item.key}`, terms);
          const mark = (
            <span
              aria-hidden
              className={
                item.done
                  ? "flex size-5 shrink-0 items-center justify-center rounded-full border border-success bg-success-soft text-[10px] text-success"
                  : "flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-[10px] text-ink-secondary"
              }
            >
              {item.done ? "✓" : ""}
            </span>
          );
          // The state is announced in words as well as in colour: a tick that
          // is only green tells a screen reader nothing.
          const text = (
            <span className={item.done ? "text-ink-secondary line-through" : "text-ink"}>
              {label}
              <span className="sr-only">
                {" — "}
                {t(item.done ? "checklist.state.done" : "checklist.state.todo")}
              </span>
            </span>
          );
          return (
            <li key={item.key}>
              {/* An item with no link is one this person may see but not do —
                  still worth showing, since knowing the step exists and is
                  already handled is the useful part. */}
              {item.href && !item.done ? (
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center gap-2.5 rounded-md px-1 text-sm hover:bg-sunken"
                >
                  {mark}
                  {text}
                </Link>
              ) : (
                <div className="flex min-h-11 items-center gap-2.5 px-1 text-sm">
                  {mark}
                  {text}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
