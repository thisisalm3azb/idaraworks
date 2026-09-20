"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { routeSatisfied } from "@/lib/route-match";
import type { Advance } from "@/modules/guidedtour/service";
import { saveTourProgressAction } from "./actions";

/**
 * The welcome card and the action-driven tour (version 2).
 *
 * ── The rules this is built around ──────────────────────────────────────────
 * 1. Never trap anybody. Nothing here is modal: the page underneath stays
 *    fully usable, Escape always exits, the close control is always
 *    reachable, and every step that asks for a tap can be skipped instead.
 * 2. Advance on evidence, never on a timer. A step that says "Tap Work" ends
 *    when the route is /jobs, or when a click lands on the highlighted
 *    control; a "look" step ends when the person presses Next. Dismissing is
 *    recorded as skipped, never as done.
 * 3. Follow the person. This is mounted in the organisation layout, so it
 *    survives navigation; the current path is read on every change and the
 *    highlighted control is found again after the next screen renders.
 * 4. Never break because the page changed. Steps point at `data-tour`
 *    attributes, not at positions or translated labels. When the control is
 *    genuinely absent the card says so and offers a way on, rather than
 *    pointing at nothing or waiting forever.
 * 5. Never block on the network. Progress is reported as it happens and every
 *    failure is swallowed; the tour runs identically offline.
 *
 * The written record lives on the server, not here. Local storage would make
 * "finished" mean "finished in this browser", which is how a tour comes back
 * from the dead on somebody's phone the evening after they dismissed it.
 */

export type TourStepView = {
  key: string;
  /** `data-tour` value to highlight, or null for a centred step. */
  target: string | null;
  title: string;
  body: string;
  advance: Advance;
  whenAbsent: "explain" | "skip";
};

export type TourLabels = {
  welcomeTitle: string;
  welcomeBody: string;
  start: string;
  notNow: string;
  next: string;
  finish: string;
  skipStep: string;
  exit: string;
  close: string;
  notFound: string;
  notFoundHint: string;
  /**
   * One resolved string per step, e.g. ["Step 1 of 6", "Step 2 of 6", …].
   *
   * An array rather than a formatting function because a function cannot cross
   * the server/client boundary — and pre-resolving keeps ICU, the locale and
   * the Latin-numeral pinning on the server, where the rest of the product's
   * translation lives.
   */
  progress: string[];
};

type Rect = { top: number; left: number; width: number; height: number };
type ReportStatus = "welcomed" | "in_progress" | "completed" | "skipped";

/**
 * Find the element a step points at.
 *
 * The same `data-tour` value is deliberately placed on both the desktop sidebar
 * item and its mobile counterpart, because a step should mean "the place you
 * find your work", not "the sidebar". Whichever of them is actually on screen
 * is the one to point at — so this takes the first with a real box, and a
 * hidden duplicate costs nothing.
 */
function findTarget(name: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`);
  let boxed: HTMLElement | null = null;
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (intersectsViewport(r)) return node;
    boxed ??= node;
  }
  return boxed;
}

/** True when any part of the box is inside the visible viewport. */
function intersectsViewport(r: DOMRect | Rect): boolean {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return r.top < vh && r.top + r.height > 0 && r.left < vw && r.left + r.width > 0;
}

/**
 * A store that never changes, used only to ask "am I on the client".
 *
 * Hoisted to module scope deliberately: `useSyncExternalStore` re-subscribes
 * whenever the subscribe function's identity changes, so an inline arrow would
 * tear down and re-establish a subscription on every single render.
 */
const NEVER_CHANGES = () => () => {};
const ON_CLIENT = () => true;
const ON_SERVER = () => false;

const PAD = 6;
const PANEL_W = 320;
const GAP = 12;
/** How long a control may take to appear after a step or route change before
 * the card admits it cannot find it. Covers a screen that is still rendering. */
const MISSING_AFTER_MS = 2500;
/** A control that is a platform difference (the mobile More tab on a laptop)
 * is skipped after this, without a message. */
const SKIP_AFTER_MS = 600;
/** Above the mobile bottom bar (3.5rem) and the device's safe area. */
const ABOVE_BAR = "calc(3.5rem + env(safe-area-inset-bottom) + 12px)";

export function GuidedTour({
  orgId,
  steps,
  labels,
  /** "welcome" opens the greeting first; "tour" starts straight into a step. */
  mode,
  startAt,
}: {
  orgId: string;
  steps: TourStepView[];
  labels: TourLabels;
  mode: "welcome" | "tour";
  startAt: number;
}) {
  const orgBase = `/o/${orgId}`;
  const pathname = usePathname();
  const [phase, setPhase] = useState<"welcome" | "tour" | "done">(mode);
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(startAt, Math.max(0, steps.length - 1))),
  );
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before we took it, so it can be handed back on close.
  const returnFocus = useRef<HTMLElement | null>(null);
  // Which step index has already been advanced from. A route change and a
  // click can both report the same step done; only the first one counts.
  const advancedFrom = useRef(-1);
  // Which step has had its control scrolled into view. Once per step: a
  // control that appears late (inside a drawer that opened on the previous
  // tap) is brought on screen the moment it exists, and never fought over
  // afterwards while the person scrolls.
  const scrolledFor = useRef(-1);
  /*
   * A new step, or a new screen under the same step, forgets any "cannot find
   * it" verdict from before. Derived at render time (React's sanctioned
   * alternative to an effect), so the verdict clears in the same render that
   * shows the new situation. The clock itself starts inside the measurement
   * loop below, which restarts for the same reasons.
   */
  const situation = `${phase}:${index}:${pathname}`;
  const [seenSituation, setSeenSituation] = useState(situation);
  if (seenSituation !== situation) {
    setSeenSituation(situation);
    if (missing) setMissing(false);
  }

  const mounted = useSyncExternalStore(NEVER_CHANGES, ON_CLIENT, ON_SERVER);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => returnFocus.current?.focus?.();
  }, []);

  /**
   * Progress writes: fire-and-forget, but never more than one in flight.
   *
   * Server actions from one browser run in order, one at a time, so a burst of
   * writes would leave the database trailing the screen. While a write is in
   * flight only the LATEST state is remembered, and it is sent when the
   * current one returns. Nothing meaningful is lost: the server keeps the
   * highest step it has seen, and a terminal state is always the last thing
   * requested.
   */
  const inFlight = useRef(false);
  const pending = useRef<{ status: ReportStatus; step: number } | null>(null);
  const report = useCallback(
    (status: ReportStatus, step: number) => {
      pending.current = { status, step };
      if (inFlight.current) return;
      const flush = (): void => {
        const next = pending.current;
        pending.current = null;
        if (!next) {
          inFlight.current = false;
          return;
        }
        inFlight.current = true;
        void saveTourProgressAction(orgId, next.status, next.step)
          .catch(() => {})
          .finally(flush);
      };
      flush();
    },
    [orgId],
  );

  const step = steps[index];
  const [panelHeight, setPanelHeight] = useState(180);

  const close = useCallback(
    (how: "completed" | "skipped") => {
      report(how, how === "completed" ? steps.length : index);
      setPhase("done");
    },
    [report, steps.length, index],
  );

  /** Leave step `from` for the one after it. Idempotent per step. */
  const advanceFrom = useCallback(
    (from: number) => {
      if (advancedFrom.current === from) return;
      advancedFrom.current = from;
      const next = from + 1;
      if (next >= steps.length) {
        close("completed");
        return;
      }
      setIndex(next);
      report("in_progress", next);
    },
    [steps.length, close, report],
  );

  const begin = useCallback(() => {
    advancedFrom.current = -1;
    report("in_progress", 0);
    setIndex(0);
    setPhase("tour");
  }, [report]);

  /** Click steps end when a click or keyboard activation lands on the control. */
  useEffect(() => {
    if (phase !== "tour" || !step?.target || step.advance.kind !== "click") return;
    const selector = `[data-tour="${CSS.escape(step.target)}"]`;
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest(selector)) return;
      advanceFrom(index);
    };
    // Capture phase: a menu that stops propagation must not hide the tap.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [phase, step, index, advanceFrom]);

  /**
   * Bring the control on screen when the step changes.
   *
   * Once, not every frame: a scrollable sidebar's lower items sit below the
   * fold on an ordinary laptop, and a card positioned relative to an
   * off-screen control is a card nobody can see. `nearest` scrolls the least
   * that makes it visible; `auto` (instant) so the measurement that follows is
   * not chasing an animation, which also respects reduced motion.
   */
  useEffect(() => {
    if (phase !== "tour" || !step?.target) return;
    const el = findTarget(step.target);
    if (el && !intersectsViewport(el.getBoundingClientRect())) {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    }
  }, [phase, step, pathname]);

  /**
   * Measure the control, and keep measuring while the page moves.
   *
   * Continuous because a sticky header, a collapsing sidebar, an opening
   * drawer and an on-screen keyboard all move things under us, and because a
   * control that is not there yet (the next screen is still rendering) has to
   * be picked up the moment it appears. React is only told when something
   * actually changed, so a still page costs nothing to render.
   */
  useEffect(() => {
    if (phase !== "tour" || !step) return;
    let frame = 0;
    // When this step began on this screen: the clock the "cannot find it"
    // message and the silent skip both run on. The effect restarts on a new
    // step or a new route, so the clock restarts with it.
    const startedAt = Date.now();
    const measure = () => {
      // Route steps end when the route says so, however the person got there
      // (including being there already when the step began).
      if (step.advance.kind === "route" && routeSatisfied(pathname, orgBase, step.advance.path)) {
        advanceFrom(index);
        return;
      }
      const el = step.target ? findTarget(step.target) : null;
      if (el && scrolledFor.current !== index) {
        scrolledFor.current = index;
        if (!intersectsViewport(el.getBoundingClientRect())) {
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
        }
      }
      const box = el?.getBoundingClientRect() ?? null;
      const next: Rect | null =
        box && intersectsViewport(box)
          ? { top: box.top, left: box.left, width: box.width, height: box.height }
          : null;
      const h = panelRef.current?.offsetHeight ?? 0;
      if (h > 0) setPanelHeight((prev) => (prev === h ? prev : h));
      setRect((prev) => {
        if (prev === null && next === null) return prev;
        if (
          prev !== null &&
          next !== null &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev;
        }
        return next;
      });
      if (step.target && !el) {
        const waited = Date.now() - startedAt;
        if (step.whenAbsent === "skip") {
          if (waited > SKIP_AFTER_MS) advanceFrom(index);
        } else if (waited > MISSING_AFTER_MS) {
          setMissing((prev) => prev || true);
        }
      } else {
        setMissing((prev) => (prev ? false : prev));
      }
    };
    const loop = () => {
      measure();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, step, index, pathname, advanceFrom, orgBase]);

  /** Escape always exits. Rule 1, and the only keyboard law here. */
  useEffect(() => {
    if (phase === "done") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close("skipped");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, close]);

  // Move focus to the card when the step changes so a screen reader announces
  // it and its controls are immediately reachable by keyboard. Not a trap:
  // Tab leaves it, and the page behind is fully live.
  useEffect(() => {
    if (phase !== "done") panelRef.current?.focus();
  }, [phase, index]);

  if (!mounted || phase === "done" || steps.length === 0) return null;

  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  // Below 640px the card is a sheet pinned to one end of the screen. A floating
  // card beside a menu item on a 375px phone covers the very thing it points at.
  const narrow = vw < 640;

  // ── The greeting ──────────────────────────────────────────────────────────
  if (phase === "welcome") {
    return createPortal(
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="iw-tour-welcome-title"
        tabIndex={-1}
        data-tour-card="welcome"
        className="fixed z-[100] w-auto rounded-xl border border-line bg-card p-5 shadow-pop outline-none sm:w-full sm:max-w-sm"
        style={
          narrow
            ? { left: 12, right: 12, bottom: ABOVE_BAR }
            : { left: Math.max(12, vw / 2 - 192), top: Math.max(12, vh / 2 - 120) }
        }
      >
        <h2 id="iw-tour-welcome-title" className="text-lg font-semibold text-ink">
          {labels.welcomeTitle}
        </h2>
        <p className="mt-2 text-sm text-ink-secondary">{labels.welcomeBody}</p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={begin}
            className="h-11 flex-1 rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse"
          >
            {labels.start}
          </button>
          <button
            type="button"
            onClick={() => close("skipped")}
            className="h-11 flex-1 rounded-md border border-line px-4 text-sm font-medium text-ink hover:bg-sunken"
          >
            {labels.notNow}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  // ── A step ────────────────────────────────────────────────────────────────
  if (!step) return null;

  let panelStyle: React.CSSProperties;
  if (!rect || narrow) {
    /*
     * On a phone the card is a full-width sheet, and WHICH end it sticks to is
     * not cosmetic. Most mobile steps point at the bottom bar, so a sheet at
     * the bottom would sit on the thing it describes. It goes to whichever end
     * the control is not at; at the bottom it sits above the bar, so the tabs
     * stay usable.
     */
    const targetLow = rect !== null && rect.top + rect.height / 2 > vh / 2;
    panelStyle = narrow
      ? targetLow
        ? { left: 12, right: 12, top: 12 }
        : { left: 12, right: 12, bottom: ABOVE_BAR }
      : {
          left: Math.max(12, vw / 2 - PANEL_W / 2),
          top: Math.max(12, vh / 2 - panelHeight / 2),
          width: PANEL_W,
        };
  } else {
    /*
     * Below the control if it fits, above it if not — and then CLAMPED, on
     * both axes, to the viewport, using the card's measured height rather than
     * a guess, so a longer sentence in another language cannot push its
     * buttons off the bottom either.
     */
    const maxTop = Math.max(12, vh - panelHeight - 12);
    const maxLeft = Math.max(12, vw - PANEL_W - 12);
    const below = rect.top + rect.height + GAP;
    const fitsBelow = below + panelHeight + 12 <= vh;
    const top = fitsBelow ? below : rect.top - GAP - panelHeight;
    panelStyle = {
      top: Math.min(Math.max(12, top), maxTop),
      left: Math.min(Math.max(12, rect.left), maxLeft),
      width: PANEL_W,
    };
  }

  const isLast = index === steps.length - 1;
  const manual = step.advance.kind === "next";
  const showMissing = missing && step.target !== null && step.whenAbsent !== "skip";

  return createPortal(
    <>
      {/*
        The dim, and the hole in it. One element with an enormous spread shadow
        is cheaper and sharper than an SVG mask, and `pointer-events-none`
        means the page underneath stays fully usable — the tour explains the
        product, it does not hold it hostage. The person is asked to tap the
        control in the hole, so the hole must never be covered.
      */}
      {rect ? (
        <div
          aria-hidden
          data-tour-spotlight={step.target ?? ""}
          className="pointer-events-none fixed z-[99] rounded-lg ring-2 ring-accent motion-safe:transition-all"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.35)",
          }}
        />
      ) : null}

      <div
        ref={panelRef}
        role="dialog"
        // Not a modal: the application behind stays reachable, and announcing
        // it as one would tell a screen-reader user the opposite.
        aria-modal="false"
        aria-labelledby="iw-tour-title"
        aria-describedby="iw-tour-body"
        tabIndex={-1}
        data-tour-card={step.key}
        data-tour-step={index + 1}
        className="fixed z-[100] rounded-xl border border-line bg-card p-4 shadow-pop outline-none motion-safe:transition-all"
        style={panelStyle}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="iw-tour-title" className="text-sm font-semibold text-ink">
            {step.title}
          </h2>
          <button
            type="button"
            onClick={() => close("skipped")}
            aria-label={labels.exit}
            title={labels.exit}
            className="-me-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <p id="iw-tour-body" className="mt-1.5 text-sm text-ink-secondary">
          {step.body}
        </p>
        {showMissing ? (
          <p role="status" className="mt-2 rounded-md bg-sunken px-2.5 py-2 text-xs text-ink">
            <span className="font-medium">{labels.notFound}</span> {labels.notFoundHint}
          </p>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs tabular-nums text-ink-secondary">
            {labels.progress[index] ?? ""}
          </span>
          <div className="flex-1" />
          {manual ? (
            <button
              type="button"
              onClick={() => advanceFrom(index)}
              className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse"
            >
              {isLast ? labels.finish : labels.next}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => advanceFrom(index)}
              className="h-10 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-sunken"
            >
              {labels.skipStep}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
