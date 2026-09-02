"use client";

import { useEffect, useRef } from "react";

/** Mounts a full document's HTML inside a shadow root (its styles stay inside; ours stay out). */
export function ShadowHtml({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = `<div>${html}</div>`;
  }, [html]);
  return (
    <div
      ref={host}
      className="overflow-auto rounded-lg border border-line bg-white p-2"
      data-testid="sign-document"
    />
  );
}
