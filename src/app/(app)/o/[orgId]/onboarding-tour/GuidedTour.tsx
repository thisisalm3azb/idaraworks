"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { saveTourProgressAction } from "./actions";

/**
 * H32 — the welcome panel and the short tour.
 *
 * ── The rules this is built around ──────────────────────────────────────────
 * 1. Never trap anybody. Escape always closes, the close button is always
 *    reachable, and nothing here is a modal the product cannot be used behind.
 *    A person who wants to get on with their work must always win.
 * 2. Never break because the page changed. Steps point at `data-tour`
 *    attributes, not at positions in the DOM or at translated labels. When a
 *    target is genuinely absent — a menu that only exists on desktop, a button
 *    a blueprint removed — the step still appears, centred, rather than being
 *    silently dropped. Losing the sentence is worse than losing the arrow.
 * 3. Never block on the network. Progress is reported as it happens and every
 *    failure is swallowed; the tour runs identically offline.
 *
 * The written record lives on the server, not here. Local storage would make
 * "finished" mean "finished in this browser", which is how a tour comes back
 * from the dead on somebody's phone the evening after they dismissed it.
 */

export type TourStepView = {
  key: string;
  /** `data-tour` value to anchor to, or null for a centred step. */
  target: string | null;
  title: string;
  body: string;
};

export type TourLabels = {
  welcomeTitle: string;
  welcomeBody: string;
  start: string;
  notNow: string;
  next: string;
  back: string;
  finish: string;
  skip: string;
  close: string;
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

/**
 * Find the element a step points at.
 *
 * The same `data-tour` value is deliberately placed on both the desktop sidebar
 * item and its mobile counterpart, because a step should mean "the place you
 * find your jobs", not "the sidebar". Whichever of them is actually on screen
 * is the one to point at — so this takes the first with a real box, and a
 * hidden duplicate costs nothing.
 */
function findTarget(name: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`);
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return node;
  }
  return null;
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

export function GuidedTour({
  orgId,
  steps,
  labels,
  /** "welcome" opens the greeting first; "tour" starts straight into step 1. */
  mode,
  startAt,
}: {
  orgId: string;
  steps: TourStepView[];
  labels: TourLabels;
  mode: "welcome" | "tour";
  startAt: number;
}) {
  const [phase, setPhase] = useState<"welcome" | "tour" | "done">(mode);
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(startAt, Math.max(0, steps.length - 1))),
  );
  const [rect, setRect] = useState<Rect | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before we took it, so it can be handed back on close. A
  // person who was typing must not lose their place because a tour appeared.
  const returnFocus = useRef<HTMLElement | null>(null);

  /**
   * Are we on the client yet?
   *
   * A portal needs a real `document`, and this component is server-rendered
   * like everything else in the shell. `useSyncExternalStore` is the isomorphic
   * way to ask: the server snapshot is false, the client snapshot is true, and
   * React reconciles the difference itself. Setting a flag from an effect would
   * do the same job by triggering a second render — which is exactly what the
   * cascading-render rule exists to prevent.
   */
  const mounted = useSyncExternalStore(NEVER_CHANGES, ON_CLIENT, ON_SERVER);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    // Hand focus back where it came from. Somebody who was mid-sentence when
    // the tour opened should find their cursor again when it closes.
    return () => returnFocus.current?.focus?.();
  }, []);

  const report = useCallback(
    (status: "welcomed" | "in_progress" | "completed" | "skipped", step: number) => {
      // Fire and forget, by design: the tour must not wait on a round trip and
      // must not surface a failure. `void` documents that the promise is
      // intentionally unobserved.
      void saveTourProgressAction(orgId, status, step).catch(() => {});
    },
    [orgId],
  );

  const step = steps[index];

  /** Measure the current target, and keep measuring while the page moves. */
  useEffect(() => {
    if (phase !== "tour" || !step) return;
    let frame = 0;
    /*
     * Measure, but only tell React when something moved.
     *
     * Without this comparison the loop calls setRect with a fresh object sixty
     * times a second, and since every one is a new reference React re-renders
     * the whole overlay every frame for a highlight that is usually perfectly
     * still. On a phone that is battery and jank in exchange for nothing.
     */
    const measure = () => {
      const el = step.target ? findTarget(step.target) : null;
      const next: Rect | null = el
        ? (({ top, left, width, height }) => ({ top, left, width, height }))(
            el.getBoundingClientRect(),
          )
        : null;
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
          return prev; // identical reference: React bails out of the render
        }
        return next;
      });
    };
    // Deliberately NOT measured synchronously here: a sticky header, a
    // collapsing sidebar and an on-screen keyboard all move things under us, so
    // the position has to be re-read continuously anyway. Letting the first read
    // happen on the first frame keeps this effect free of a synchronous setState
    // and costs about sixteen milliseconds nobody can see.
    const loop = () => {
      measure();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, step]);

  const close = useCallback(
    (how: "completed" | "skipped") => {
      report(how, how === "completed" ? steps.length : index);
      setPhase("done");
    },
    [report, steps.length, index],
  );

  /** Escape always closes. Rule 1, and the only keyboard law here. */
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

  // Move focus to the panel when the step changes so a screen reader announces
  // it and the buttons are immediately reachable by keyboard.
  useEffect(() => {
    if (phase !== "done") panelRef.current?.focus();
  }, [phase, index]);

  if (!mounted || phase === "done" || steps.length === 0) return null;

  // ── The greeting ──────────────────────────────────────────────────────────
  if (phase === "welcome") {
    return createPortal(
      <div className="fixed inset-0 z-[100] flex items-end justify-center bg-ink/40 p-4 sm:items-center">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby="iw-tour-welcome-title"
          tabIndex={-1}
          className="w-full max-w-sm rounded-xl border border-line bg-card p-5 shadow-pop outline-none"
        >
          <h2 id="iw-tour-welcome-title" className="text-lg font-semibold text-ink">
            {labels.welcomeTitle}
          </h2>
          <p className="mt-2 text-sm text-ink-secondary">{labels.welcomeBody}</p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
            <button
              type="button"
              onClick={() => {
                report("in_progress", 0);
                setIndex(0);
                setPhase("tour");
              }}
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
        </div>
      </div>,
      document.body,
    );
  }

  // ── A step ────────────────────────────────────────────────────────────────
  if (!step) return null;

  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  // Below 640px the panel is a sheet at the bottom of the screen. Trying to fit
  // a floating card beside a menu item on a 375px phone produces something that
  // covers the very thing it is pointing at.
  const narrow = vw < 640;

  let panelStyle: React.CSSProperties;
  if (!rect || narrow) {
    panelStyle = narrow
      ? { left: 12, right: 12, bottom: 12 }
      : {
          left: Math.max(12, vw / 2 - PANEL_W / 2),
          top: Math.max(12, vh / 2 - 90),
          width: PANEL_W,
        };
  } else {
    const below = rect.top + rect.height + GAP;
    const fitsBelow = below + 180 < vh;
    // Clamped to the viewport on both axes, which is what keeps a step anchored
    // to something near the right edge from rendering off screen — the usual
    // way this breaks in RTL, where the sidebar is on the other side.
    const left = Math.min(Math.max(12, rect.left), Math.max(12, vw - PANEL_W - 12));
    panelStyle = fitsBelow
      ? { top: below, left, width: PANEL_W }
      : { top: Math.max(12, rect.top - GAP - 180), left, width: PANEL_W };
  }

  const isLast = index === steps.length - 1;

  return createPortal(
    <>
      {/*
        The dim, and the hole in it. One element with an enormous spread shadow
        is cheaper and sharper than an SVG mask, and `pointer-events-none` means
        the page underneath stays fully usable — the tour explains the product,
        it does not hold it hostage.
      */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[99] rounded-lg ring-2 ring-accent motion-safe:transition-all"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)",
          }}
        />
      ) : (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[99] bg-ink/40" />
      )}

      <div
        ref={panelRef}
        role="dialog"
        // Not a modal: the application behind stays reachable, and announcing it
        // as one would tell a screen-reader user the opposite.
        aria-modal="false"
        aria-labelledby="iw-tour-title"
        tabIndex={-1}
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
            aria-label={labels.close}
            className="-me-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <p className="mt-1.5 text-sm text-ink-secondary">{step.body}</p>

        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs tabular-nums text-ink-secondary">
            {labels.progress[index] ?? ""}
          </span>
          <div className="flex-1" />
          {index > 0 ? (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="h-9 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-sunken"
            >
              {labels.back}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => close("skipped")}
              className="h-9 rounded-md px-3 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
            >
              {labels.skip}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isLast) {
                close("completed");
                return;
              }
              const next = index + 1;
              setIndex(next);
              report("in_progress", next);
            }}
            className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-ink-inverse"
          >
            {isLast ? labels.finish : labels.next}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
