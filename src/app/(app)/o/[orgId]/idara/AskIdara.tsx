"use client";

/**
 * H28 — contextual entry points (ADR-58): a small "Ask Idara" menu placed on
 * record pages. Every intent opens the SAME dock with the record in the
 * capsule; nothing here is a second chat system. Rendered only when the
 * server decided the dock is on (the mount decides; this button is inert
 * without it because the event has no listener).
 */
import { useEffect, useRef, useState } from "react";
import type { AgentId } from "@/platform/agents/registry";
import type { RecordRef } from "@/modules/idara/service";

export type AskIdaraDict = {
  button: string;
  about: string;
  explain: string;
  summarise: string;
  compare: string;
  risks: string;
  draft: string;
  next: string;
  automation: string;
};

type Intent = { key: keyof AskIdaraDict; text: string; agentId?: AgentId };

export function AskIdara({
  record,
  dict,
  agentId,
  compact = false,
}: {
  record: RecordRef;
  dict: AskIdaraDict;
  agentId?: AgentId;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The dock announces itself through a data attribute; without it the entry point stays hidden.
    const t = setTimeout(() => setEnabled(Boolean(document.querySelector("[data-idara-dock]"))), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!enabled) return null;
  const label = record.label ?? record.type;
  const intents: Intent[] = [
    { key: "about", text: `${dict.about} ${label}`.trim() },
    { key: "explain", text: `${dict.explain}` },
    { key: "summarise", text: `${dict.summarise} ${label}`.trim() },
    { key: "compare", text: `${dict.compare} ${label}`.trim(), agentId: "planning_analytics" },
    { key: "risks", text: `${dict.risks} ${label}`.trim() },
    { key: "draft", text: `${dict.draft} ${label}`.trim() },
    { key: "next", text: `${dict.next} ${label}`.trim() },
    { key: "automation", text: `${dict.automation} ${label}`.trim() },
  ];
  const fire = (intent: Intent) => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent("idara:open", {
        detail: { contextRefs: [record], intent: intent.text, agentId: intent.agentId ?? agentId },
      }),
    );
  };
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-card px-2.5 text-sm text-ink hover:bg-sunken ${compact ? "min-w-9 justify-center px-0" : ""}`}
        aria-label={dict.button}
        title={dict.button}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4 text-brand"
          fill="currentColor"
        >
          <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
        </svg>
        {compact ? null : <span>{dict.button}</span>}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={dict.button}
          className="absolute z-40 mt-1 w-64 rounded-lg border border-line bg-card p-1 text-sm shadow-pop end-0"
        >
          {intents.map((i) => (
            <button
              key={i.key}
              type="button"
              role="menuitem"
              onClick={() => fire(i)}
              className="block min-h-9 w-full rounded-md px-2 text-start text-ink hover:bg-sunken"
            >
              {dict[i.key]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
