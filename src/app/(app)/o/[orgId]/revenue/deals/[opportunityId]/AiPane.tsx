"use client";

/**
 * H27 — the deal assistant. Off until a provider is configured (the owner
 * action is shown, nothing is simulated). When on, it reads the deal's
 * context and returns proposals whose evidence links to real records; it
 * never sends, moves, approves, creates, signs, merges or changes consent.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button } from "@/platform/ui";
import { crmAssistAction, type AssistResult } from "./actions";

export type AiDict = {
  title: string;
  ask: string;
  mode: Record<"brief" | "actions" | "risks" | "ask", string>;
  question: string;
  unavailable: string;
  ownerAction: string;
  evidence: string;
  noEvidence: string;
  notice: string;
  failed: string;
};

export function AiPane({
  orgId,
  opportunityId,
  available,
  ownerAction,
  dict,
}: {
  orgId: string;
  opportunityId: string;
  available: boolean;
  ownerAction: string | null;
  dict: AiDict;
}) {
  const [mode, setMode] = useState<"brief" | "actions" | "risks" | "ask">("brief");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AssistResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (!available) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line p-3">
        <p className="text-sm text-ink">{dict.unavailable}</p>
        {ownerAction ? (
          <p className="text-xs text-ink-muted">
            <span className="font-medium">{dict.ownerAction}: </span>
            <span dir="ltr">{ownerAction}</span>
          </p>
        ) : null}
      </div>
    );
  }
  const run = () =>
    startTransition(async () => {
      setResult(
        await crmAssistAction(orgId, {
          kind: "opportunity",
          id: opportunityId,
          mode,
          question: mode === "ask" ? question : undefined,
        }),
      );
    });
  const href = (type: string, id: string) =>
    type === "opportunity"
      ? `/o/${orgId}/revenue/deals/${id}`
      : type === "customer"
        ? `/o/${orgId}/revenue/customers/${id}`
        : type === "lead"
          ? `/o/${orgId}/leads/${id}`
          : type === "document"
            ? `/o/${orgId}/documents/${id}`
            : type === "invoice"
              ? `/o/${orgId}/invoices/${id}`
              : type === "quote"
                ? `/o/${orgId}/quotes/${id}`
                : `/o/${orgId}/revenue/deals/${opportunityId}?tab=history`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">{dict.notice}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {dict.title}
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            className="min-h-10 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
          >
            {(Object.keys(dict.mode) as Array<keyof AiDict["mode"]>).map((m) => (
              <option key={m} value={m}>
                {dict.mode[m]}
              </option>
            ))}
          </select>
        </label>
        {mode === "ask" ? (
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-ink-muted">
            {dict.question}
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              className="min-h-10 rounded-md border border-line-strong bg-card px-3 text-sm text-ink"
            />
          </label>
        ) : null}
        <Button onClick={run} disabled={pending || (mode === "ask" && !question.trim())}>
          {dict.ask}
        </Button>
      </div>
      {result ? (
        result.ok ? (
          <div className="flex flex-col gap-2">
            {result.summary ? <p className="text-sm text-ink">{result.summary}</p> : null}
            <ul className="flex flex-col gap-2">
              {result.proposals.map((p, i) => (
                <li key={i} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={p.evidenceFound ? "brand" : "warning"}>{p.kind}</Badge>
                    <span className="text-sm font-medium text-ink">{p.title}</span>
                  </div>
                  {p.detail ? <p className="mt-1 text-sm text-ink-secondary">{p.detail}</p> : null}
                  <p className="mt-1 text-xs text-ink-muted">
                    {dict.evidence}:{" "}
                    {p.evidence.length === 0 ? (
                      <span className="text-warning">{dict.noEvidence}</span>
                    ) : (
                      p.evidence.map((e) => (
                        <Link
                          key={`${e.type}:${e.id}`}
                          href={href(e.type, e.id)}
                          className="me-2 text-brand hover:underline"
                        >
                          {e.label}
                        </Link>
                      ))
                    )}
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-muted">{result.notice}</p>
          </div>
        ) : (
          <p className="text-sm text-danger">{result.ownerAction ?? dict.failed}</p>
        )
      ) : null}
    </div>
  );
}
