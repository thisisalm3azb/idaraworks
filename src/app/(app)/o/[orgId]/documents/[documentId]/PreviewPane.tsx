"use client";

/**
 * H26 — the live preview. The document renders through the same route the
 * PDF uses; its HTML is fetched and mounted inside a shadow root so the
 * document's own stylesheet cannot leak into the app (and the app's cannot
 * leak in). No iframe: the site forbids framing (frame-ancestors 'none').
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/platform/ui";

export function PreviewPane({
  src,
  dict,
}: {
  src: string;
  dict: { refresh: string; loading: string; failed: string; openTab: string };
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [tick, setTick] = useState(0);

  // State changes happen only inside promise callbacks (never synchronously
  // in the effect body): the pane starts in "loading" and a refresh flips it
  // back from the click handler.
  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: "same-origin", cache: "no-store" })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((html) => {
        if (cancelled) return;
        const el = host.current;
        if (!el) return;
        const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
        // A full document: the parser keeps <style> and body content, drops
        // the html/head/body wrappers. Scripts never execute via innerHTML.
        root.innerHTML = `<div class="ds-preview-root">${html}</div>`;
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [src, tick]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setState("loading");
            setTick((t) => t + 1);
          }}
        >
          {dict.refresh}
        </Button>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-sunken"
        >
          {dict.openTab}
        </a>
        <span className="text-xs text-ink-muted" role="status">
          {state === "loading" ? dict.loading : state === "failed" ? dict.failed : ""}
        </span>
      </div>
      <div
        ref={host}
        className="min-h-[60vh] overflow-auto rounded-lg border border-line bg-white p-2 shadow-card"
        data-testid="document-preview"
      />
    </div>
  );
}
