"use client";

/**
 * H28 — the Idara launcher (ADR-58). A tiny client island mounted in the
 * authenticated shell:
 *  - a `toolbar` with the launcher button, a position menu (six logical
 *    positions, arrow keys) and a reset control; pointer drag snaps to the
 *    same six positions, so dragging is never the only way to move it;
 *  - position remembered per person per device (localStorage), mapped by
 *    logical inset so it mirrors correctly under RTL;
 *  - keeps clear of the header band and the phone bottom navigation band,
 *    and steps aside when keyboard focus lands beneath it;
 *  - quiet status (idle, thinking, waiting for approval, done, failed), a
 *    restrained unread badge, reduced motion honoured;
 *  - opens only on an explicit gesture (click, shortcut, palette command or
 *    an "Ask Idara" button that dispatches the `idara:open` event); never by
 *    itself. The working window is loaded on demand.
 */
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentId } from "@/platform/agents/registry";
import type { RecordRef } from "@/modules/idara/service";
import { contextFromPath } from "./links";

export type DockDict = {
  launcher: string;
  open: string;
  close: string;
  minimise: string;
  workspace: string;
  position: string;
  positions: Record<DockPosition, string>;
  reset: string;
  quickAsk: string;
  placeholder: string;
  send: string;
  thinking: string;
  waiting: string;
  done: string;
  failed: string;
  idle: string;
  unavailable: string;
  evidenceOnly: string;
  includePage: string;
  contextTitle: string;
  remove: string;
  addRecord: string;
  searchPlaceholder: string;
  nothingFound: string;
  agent: string;
  answeredBy: string;
  contributors: string;
  steps: string;
  evidence: string;
  facts: string;
  calculations: string;
  assumptions: string;
  gaps: string;
  actions: string;
  confirm: string;
  execute: string;
  cancelAction: string;
  stop: string;
  newConversation: string;
  conversations: string;
  notGenerated: string;
  ownerAction: string;
  credits: string;
  riskClass: Record<1 | 2 | 3 | 4 | 5, string>;
  status: Record<string, string>;
  shortcutHint: string;
  sizeSmall: string;
  sizeMedium: string;
  sizeLarge: string;
  moveHint: string;
};

export type DockPosition =
  "top-start" | "top-end" | "middle-start" | "middle-end" | "bottom-start" | "bottom-end";
export const DOCK_POSITIONS: DockPosition[] = [
  "top-start",
  "top-end",
  "middle-start",
  "middle-end",
  "bottom-start",
  "bottom-end",
];
export const DEFAULT_POSITION: DockPosition = "bottom-end";

export type DockStatus = "idle" | "thinking" | "waiting" | "done" | "failed";

export type AgentOption = { id: AgentId; name: string; description: string };

export type OpenRequest = { contextRefs?: RecordRef[]; intent?: string; agentId?: AgentId };

const IdaraWindow = dynamic(() => import("./IdaraWindow").then((m) => m.IdaraWindow), {
  ssr: false,
  loading: () => null,
});

function storageKey(userId: string): string {
  return `idara.dock.${userId}`;
}

function readStored(userId: string): { position: DockPosition; minimised: boolean } {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { position: DEFAULT_POSITION, minimised: false };
    const p = JSON.parse(raw) as { position?: string; minimised?: boolean };
    const position = DOCK_POSITIONS.includes(p.position as DockPosition)
      ? (p.position as DockPosition)
      : DEFAULT_POSITION;
    return { position, minimised: Boolean(p.minimised) };
  } catch {
    return { position: DEFAULT_POSITION, minimised: false };
  }
}

function writeStored(userId: string, v: { position: DockPosition; minimised: boolean }): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(v));
  } catch {
    /* storage may be unavailable; the position simply does not persist */
  }
}

/** Logical inset classes per position; `start`/`end` mirror under RTL automatically. */
const POSITION_CLASS: Record<DockPosition, string> = {
  "top-start": "top-20 start-3",
  "top-end": "top-20 end-3",
  "middle-start": "top-1/2 -translate-y-1/2 start-3",
  "middle-end": "top-1/2 -translate-y-1/2 end-3",
  "bottom-start": "bottom-24 md:bottom-6 start-3",
  "bottom-end": "bottom-24 md:bottom-6 end-3",
};

function snapFromPoint(x: number, y: number, dir: "ltr" | "rtl"): DockPosition {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const physicalEnd = x > w / 2;
  const logicalEnd = dir === "rtl" ? !physicalEnd : physicalEnd;
  const band = y < h / 3 ? "top" : y > (2 * h) / 3 ? "bottom" : "middle";
  return `${band}-${logicalEnd ? "end" : "start"}` as DockPosition;
}

export function IdaraDock({
  orgId,
  userId,
  locale,
  dir,
  dict,
  agents,
  modelAvailable,
  reason,
  ownerAction,
  canConfirm,
}: {
  orgId: string;
  userId: string;
  locale: "en" | "ar";
  dir: "ltr" | "rtl";
  dict: DockDict;
  agents: AgentOption[];
  modelAvailable: boolean;
  reason: string;
  ownerAction: string | null;
  canConfirm: boolean;
}) {
  const pathname = usePathname();
  const [position, setPosition] = useState<DockPosition>(() => readStored(userId).position);
  const [open, setOpen] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [status, setStatus] = useState<DockStatus>("idle");
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [yielding, setYielding] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false,
    [],
  );

  const persist = useCallback(
    (next: DockPosition) => {
      setPosition(next);
      writeStored(userId, { position: next, minimised: false });
    },
    [userId],
  );

  // Explicit open requests: shortcut, palette command, "Ask Idara" buttons.
  const doOpen = useCallback((req: OpenRequest | null = null) => {
    setOpenRequest(req);
    setOpen(true);
    setMinimised(false);
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    const onEvent = (e: Event) => doOpen((e as CustomEvent<OpenRequest>).detail ?? null);
    window.addEventListener("idara:open", onEvent);
    return () => window.removeEventListener("idara:open", onEvent);
  }, [doOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "." && !typing) {
        e.preventDefault();
        if (open && !minimised) {
          setOpen(false);
          launcherRef.current?.focus();
        } else doOpen(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doOpen, open, minimised]);

  // Never cover the focused element: step aside while focus sits beneath the launcher (WCAG 2.4.11).
  useEffect(() => {
    const onFocus = () => {
      const el = document.activeElement as HTMLElement | null;
      const box = launcherRef.current?.getBoundingClientRect();
      if (!el || !box || el === launcherRef.current) return setYielding(false);
      const r = el.getBoundingClientRect();
      const overlaps =
        r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      setYielding(overlaps);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  // Pointer drag with snap; click without movement opens.
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > 8 || Math.abs(e.clientY - s.y) > 8) {
      s.moved = true;
      setDragging(true);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    dragStart.current = null;
    setDragging(false);
    if (s?.moved) persist(snapFromPoint(e.clientX, e.clientY, dir));
    else if (open && !minimised) {
      setOpen(false);
    } else doOpen(null);
  };

  // Position menu keyboard: arrows move through the six positions.
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = DOCK_POSITIONS.indexOf(position);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(DOCK_POSITIONS[(i + 1) % DOCK_POSITIONS.length]!);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      persist(DOCK_POSITIONS[(i - 1 + DOCK_POSITIONS.length) % DOCK_POSITIONS.length]!);
    } else if (e.key === "Escape") {
      setMenuOpen(false);
      launcherRef.current?.focus();
    }
  };

  const pageContext = useMemo(() => contextFromPath(pathname ?? ""), [pathname]);
  const statusLabel =
    status === "thinking"
      ? dict.thinking
      : status === "waiting"
        ? dict.waiting
        : status === "done"
          ? dict.done
          : status === "failed"
            ? dict.failed
            : dict.idle;
  const ring =
    status === "thinking"
      ? "ring-2 ring-info"
      : status === "waiting"
        ? "ring-2 ring-warning"
        : status === "done"
          ? "ring-2 ring-success"
          : status === "failed"
            ? "ring-2 ring-danger"
            : "ring-1 ring-line-strong";

  return (
    <>
      <div
        role="toolbar"
        aria-label={dict.launcher}
        aria-orientation="vertical"
        data-idara-dock
        data-position={position}
        className={`fixed z-40 flex flex-col items-end gap-1 ${POSITION_CLASS[position]} ${yielding ? "opacity-40 pointer-events-none" : ""} ${reduceMotion || dragging ? "" : "transition-[opacity] duration-200"}`}
      >
        {menuOpen ? (
          <div
            ref={menuRef}
            role="menu"
            aria-label={dict.position}
            tabIndex={-1}
            onKeyDown={onMenuKey}
            className="mb-1 w-56 rounded-lg border border-line bg-card p-1 text-sm shadow-pop"
          >
            {DOCK_POSITIONS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={p === position}
                onClick={() => {
                  persist(p);
                  setMenuOpen(false);
                  launcherRef.current?.focus();
                }}
                className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-sunken ${p === position ? "font-semibold text-ink" : "text-ink-secondary"}`}
              >
                <span aria-hidden="true" className="inline-block size-2 rounded-full bg-current" />
                {dict.positions[p]}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                persist(DEFAULT_POSITION);
                setMenuOpen(false);
                launcherRef.current?.focus();
              }}
              className="mt-1 flex min-h-9 w-full items-center rounded-md border-t border-line px-2 text-start text-ink-muted hover:bg-sunken"
            >
              {dict.reset}
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={dict.position}
            title={dict.moveHint}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex size-7 items-center justify-center rounded-full border border-line bg-card text-ink-muted hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="currentColor">
              <circle cx="6" cy="6" r="1.6" />
              <circle cx="14" cy="6" r="1.6" />
              <circle cx="6" cy="14" r="1.6" />
              <circle cx="14" cy="14" r="1.6" />
            </svg>
          </button>
          <button
            ref={launcherRef}
            type="button"
            aria-label={`${dict.launcher}: ${statusLabel}`}
            aria-expanded={open && !minimised}
            aria-controls="idara-window"
            aria-keyshortcuts="Control+."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (open && !minimised) setOpen(false);
                else doOpen(null);
              }
            }}
            className={`relative flex min-h-12 min-w-12 touch-none select-none items-center justify-center rounded-full bg-brand text-ink-inverse shadow-pop ${ring} ${dragging ? "cursor-grabbing scale-105" : "cursor-pointer"} ${reduceMotion ? "" : "transition-transform"}`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
              <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13zM5 14l.7 2 2 .7-2 .7L5 19.5l-.7-2.1-2-.7 2-.7.7-2z" />
            </svg>
            {unread > 0 ? (
              <span
                className="absolute -top-1 -end-1 min-w-5 rounded-full bg-danger px-1 text-center text-[11px] font-semibold leading-5 text-ink-inverse"
                aria-hidden="true"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
            {status === "thinking" && !reduceMotion ? (
              <span
                className="absolute inset-0 animate-ping rounded-full bg-info/30"
                aria-hidden="true"
              />
            ) : null}
          </button>
        </div>
        {open && minimised ? (
          <button
            type="button"
            onClick={() => setMinimised(false)}
            className="mt-1 flex min-h-9 items-center gap-2 rounded-full border border-line bg-card px-3 text-xs text-ink shadow"
            aria-label={`${dict.open}: ${statusLabel}`}
          >
            <span
              className={`inline-block size-2 rounded-full ${status === "thinking" ? "bg-info" : status === "waiting" ? "bg-warning" : status === "failed" ? "bg-danger" : "bg-success"}`}
              aria-hidden="true"
            />
            {statusLabel}
          </button>
        ) : null}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {open ? statusLabel : ""}
      </div>
      {open && !minimised ? (
        <IdaraWindow
          orgId={orgId}
          userId={userId}
          locale={locale}
          dir={dir}
          dict={dict}
          agents={agents}
          modelAvailable={modelAvailable}
          reason={reason}
          ownerAction={ownerAction}
          canConfirm={canConfirm}
          pageContext={pageContext}
          openRequest={openRequest}
          position={position}
          onStatus={setStatus}
          onUnread={setUnread}
          onMinimise={() => {
            setMinimised(true);
            launcherRef.current?.focus();
          }}
          onClose={() => {
            setOpen(false);
            launcherRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
