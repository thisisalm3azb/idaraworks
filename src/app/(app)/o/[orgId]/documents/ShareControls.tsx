"use client";

import { useState, useTransition } from "react";
import { Button } from "@/platform/ui";
import { createDocumentShareAction } from "./actions";
import type { DocumentKind } from "@/modules/documents/service";

/**
 * Mint a share link and show it once.
 *
 * The token exists in plaintext only in this response: the database keeps its
 * SHA-256, so nothing can hand the link back later. That is deliberate, and the
 * copy also says so, because a user who assumes they can return for it later
 * will lose it silently.
 */
export function ShareControls({
  orgId,
  kind,
  id,
  labels,
}: {
  orgId: string;
  kind: DocumentKind;
  id: string;
  labels: {
    days: string;
    create: string;
    creating: string;
    link: string;
    once: string;
    copy: string;
    copied: string;
    failed: string;
    forbidden: string;
  };
}) {
  const [pending, start] = useTransition();
  const [days, setDays] = useState(7);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function create() {
    setError(null);
    setCopied(false);
    start(async () => {
      const res = await createDocumentShareAction(orgId, kind, id, days);
      if (res.ok) setLink(res.link);
      else setError(res.error === "forbidden" ? labels.forbidden : labels.failed);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {labels.days}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="min-h-11 rounded-md border border-line bg-card px-2 text-sm text-ink"
          >
            <option value={7}>7</option>
            <option value={14}>14</option>
            <option value={30}>30</option>
            <option value={90}>90</option>
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={create} disabled={pending}>
          {pending ? labels.creating : labels.create}
        </Button>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {link ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken p-3">
          <span className="text-xs text-ink-muted">{labels.link}</span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              dir="ltr"
              onFocus={(e) => e.currentTarget.select()}
              className="min-h-10 flex-1 rounded border border-line bg-card px-2 font-mono text-xs text-ink"
            />
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? labels.copied : labels.copy}
            </Button>
          </div>
          <p className="text-xs text-ink-muted">{labels.once}</p>
        </div>
      ) : null}
    </div>
  );
}
