"use client";

import { useState, useTransition } from "react";
import { Button } from "@/platform/ui";
import { sendAndRevealAction } from "../actions";

/**
 * Client panel: sends the draft, then reveals the share link ONCE (inline, never in the URL)
 * with a copy button. The link is not persisted — after leaving the page it can only be
 * re-obtained by an authorized re-mint (revoke + re-send is the recovery path).
 */
export function SharePanel({
  orgId,
  updateId,
  labels,
}: {
  orgId: string;
  updateId: string;
  labels: {
    send: string;
    sending: string;
    link: string;
    copy: string;
    copied: string;
    failed: string;
  };
}) {
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function send() {
    setError(null);
    start(async () => {
      const res = await sendAndRevealAction(orgId, updateId);
      if ("link" in res) setLink(res.link);
      else setError(labels.failed);
    });
  }

  if (link) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line bg-card p-3">
        <span className="text-xs text-ink-muted">{labels.link}</span>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={link}
            dir="ltr"
            className="min-h-10 flex-1 rounded border border-line bg-sunken px-2 font-mono text-xs text-ink"
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="primary" onClick={send} disabled={pending}>
        {pending ? labels.sending : labels.send}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
