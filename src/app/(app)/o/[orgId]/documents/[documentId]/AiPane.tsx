"use client";

/**
 * H26I — the document assistant: summary, questions answered with the clause
 * relied on, and obligation proposals a person may add. When no provider is
 * configured the pane says so and shows the owner action; nothing is faked.
 */
import { useState } from "react";
import { Badge, Button } from "@/platform/ui";
import type { AiAnswer, AiProposal, AiSummary } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import {
  aiAskAction,
  aiProposeAction,
  aiSummariseAction,
  createObligationAction,
} from "../studio-actions";

export type AiDict = {
  title: string;
  intro: string;
  unavailableTitle: string;
  unavailableBody: string;
  ownerAction: string;
  summarise: string;
  summary: string;
  keyTerms: string;
  ask: string;
  questionPlaceholder: string;
  answer: string;
  cited: string;
  noEvidence: string;
  propose: string;
  proposals: string;
  proposalsHint: string;
  addObligation: string;
  added: string;
  notLegalAdvice: string;
  clause: string;
  working: string;
  failed: string;
};

export function AiPane({
  orgId,
  documentId,
  available,
  ownerAction,
  canAddObligations,
  dict,
}: {
  orgId: string;
  documentId: string;
  available: boolean;
  ownerAction: string | null;
  canAddObligations: boolean;
  dict: AiDict;
}) {
  const [busy, setBusy] = useState<"summary" | "ask" | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [proposals, setProposals] = useState<AiProposal[] | null>(null);
  const [added, setAdded] = useState<Record<number, string>>({});

  const guard = async <T,>(key: "summary" | "ask" | "propose", p: Promise<ActionResult<T>>) => {
    setBusy(key);
    setError(null);
    const res = await p;
    setBusy(null);
    if (!res.ok) setError(`${dict.failed}: ${res.error}`);
    return res;
  };

  if (!available)
    return (
      <section
        className="rounded-lg border border-line bg-card p-4 shadow-card"
        data-ai="unavailable"
      >
        <h3 className="text-sm font-semibold text-ink">{dict.unavailableTitle}</h3>
        <p className="mt-1 text-sm text-ink-secondary">{dict.unavailableBody}</p>
        {ownerAction ? (
          <p className="mt-2 rounded bg-sunken px-3 py-2 text-xs text-ink-secondary">
            <strong>{dict.ownerAction}:</strong> {ownerAction}
          </p>
        ) : null}
      </section>
    );

  return (
    <div className="flex flex-col gap-3" data-ai="available">
      <p className="text-sm text-ink-secondary">{dict.intro}</p>
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{dict.summary}</h3>
          <Button
            disabled={busy !== null}
            onClick={async () => {
              const r = await guard("summary", aiSummariseAction(orgId, { documentId }));
              if (r.ok) setSummary(r.data);
            }}
          >
            {busy === "summary" ? dict.working : dict.summarise}
          </Button>
        </div>
        {summary ? (
          <div className="mt-2 text-sm text-ink">
            <p>{summary.summary}</p>
            {summary.keyTerms.length ? (
              <>
                <h4 className="mt-2 text-xs font-semibold text-ink-muted">{dict.keyTerms}</h4>
                <ul className="list-disc ps-5">
                  {summary.keyTerms.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">{dict.notLegalAdvice}</p>
          </div>
        ) : null}
      </section>
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <h3 className="text-sm font-semibold text-ink">{dict.ask}</h3>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={dict.questionPlaceholder}
            className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || question.trim().length < 2) return;
              const r = await guard(
                "ask",
                aiAskAction(orgId, { documentId, question: question.trim() }),
              );
              if (r.ok) setAnswer(r.data);
            }}
          />
          <Button
            disabled={busy !== null || question.trim().length < 2}
            onClick={async () => {
              const r = await guard(
                "ask",
                aiAskAction(orgId, { documentId, question: question.trim() }),
              );
              if (r.ok) setAnswer(r.data);
            }}
          >
            {busy === "ask" ? dict.working : dict.answer}
          </Button>
        </div>
        {answer ? (
          <div className="mt-3 text-sm text-ink">
            <p>{answer.evidenceFound ? answer.answer : dict.noEvidence}</p>
            {answer.citations.length ? (
              <div className="mt-2">
                <h4 className="text-xs font-semibold text-ink-muted">{dict.cited}</h4>
                <ul className="mt-1 flex flex-col gap-1">
                  {answer.citations.map((c) => (
                    <li
                      key={c.blockId}
                      className="rounded bg-sunken px-2 py-1 text-xs text-ink-secondary"
                    >
                      <Badge tone="neutral">{c.ref}</Badge>{" "}
                      <span className="ms-1">{c.excerpt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">{dict.notLegalAdvice}</p>
          </div>
        ) : null}
      </section>
      <section className="rounded-lg border border-line bg-card p-3 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{dict.proposals}</h3>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={async () => {
              const r = await guard("propose", aiProposeAction(orgId, { documentId }));
              if (r.ok) {
                setProposals(r.data);
                setAdded({});
              }
            }}
          >
            {busy === "propose" ? dict.working : dict.propose}
          </Button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">{dict.proposalsHint}</p>
        {proposals ? (
          <ul className="mt-2 flex flex-col gap-2">
            {proposals.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm"
              >
                <Badge tone="neutral">{p.kind}</Badge>
                <span className="font-medium text-ink">{p.title}</span>
                {p.dueOn ? <span className="text-xs text-ink-muted">{p.dueOn}</span> : null}
                {p.clauseRef ? (
                  <span className="text-xs text-ink-muted">
                    {dict.clause}: {p.clauseRef}
                  </span>
                ) : null}
                {p.rationale ? (
                  <span className="basis-full text-xs text-ink-secondary">{p.rationale}</span>
                ) : null}
                {canAddObligations ? (
                  added[i] ? (
                    <Badge tone="success">{dict.added}</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={async () => {
                        const r = await createObligationAction(orgId, {
                          documentId,
                          kind: p.kind,
                          title: p.title,
                          dueOn: p.dueOn ?? new Date().toISOString().slice(0, 10),
                          clauseRef: p.clauseId,
                          description: p.rationale,
                          source: "ai",
                        });
                        if (r.ok) setAdded((a) => ({ ...a, [i]: r.data.id }));
                        else setError(`${dict.failed}: ${r.error}`);
                      }}
                    >
                      {dict.addObligation}
                    </Button>
                  )
                ) : null}
              </li>
            ))}
            {proposals.length === 0 ? (
              <li className="text-sm text-ink-muted">{dict.noEvidence}</li>
            ) : null}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
