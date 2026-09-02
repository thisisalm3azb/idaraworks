/**
 * H26I — the provider-neutral assistant seam for documents. Everything goes
 * through the ONE agent provider (platform/agents): no SDK here, and when no
 * provider is configured (the production default) every call fails closed
 * with the exact owner action. The assistant only READS: it summarises,
 * answers questions citing the clause it relied on (citations are validated
 * against the document; unknown ones are dropped, and no valid citation means
 * "evidence was not found"), and proposes obligations that a person may then
 * add. It never issues, approves, signs, alters or terminates a document,
 * and its output is never presented as legal advice.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentProviderDisabledError,
  AgentProviderTimeoutError,
  agentsEnabled,
  buildProviderRequest,
  callProvider,
  getAgentProvider,
  untrustedBlock,
  type AgentProvider,
} from "@/platform/agents";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { getDocument } from "./documents";
import { OBLIGATION_KINDS } from "./obligations";
import { DocError, flattenBlocks, type DocBody, type LocaleText } from "./types";

export const AI_OWNER_ACTION =
  "Configure a model provider behind getAgentProvider() (src/platform/agents/provider.ts) and enable the feat.ai_agents feature for the organisation. Until then the assistant stays off; nothing is simulated.";
export const AI_NOTICE =
  "Not legal advice. Answers cite the clause they relied on; verify before acting.";

export type AiAvailability = {
  available: boolean;
  provider: string;
  ownerAction: string | null;
};

export type Clause = { id: string; ref: string; text: string };

function pick(t: LocaleText | undefined, lang: "en" | "ar"): string {
  return ((lang === "ar" ? (t?.ar ?? t?.en) : (t?.en ?? t?.ar)) ?? "").trim();
}

/** Pure: the citable units of a body, in order, with a human reference. */
export function documentClauses(body: DocBody, lang: "en" | "ar" = "en"): Clause[] {
  const out: Clause[] = [];
  let clause = 0;
  for (const b of flattenBlocks(body)) {
    let text = "";
    let ref: string = b.type;
    switch (b.type) {
      case "heading":
      case "paragraph":
      case "note":
        text = pick(b.text, lang);
        break;
      case "clause":
        clause += 1;
        ref = `clause ${clause}`;
        text = [pick(b.title, lang), pick(b.text, lang)].filter(Boolean).join(": ");
        break;
      case "list":
        text = b.items.map((i) => pick(i, lang)).join("; ");
        break;
      case "section":
        text = pick(b.title, lang);
        ref = "section";
        break;
      case "field":
        text = `${pick(b.label, lang)} (${b.key})`;
        ref = "field";
        break;
      case "table":
        text = b.rows.map((r) => r.map((c) => pick(c, lang)).join(" | ")).join("\n");
        ref = "table";
        break;
      default:
        continue;
    }
    if (text) out.push({ id: b.id, ref, text: text.slice(0, 4000) });
  }
  return out;
}

const Citation = z.object({ blockId: z.string().min(1), excerpt: z.string().max(600).optional() });
const AnswerOutput = z.object({
  answer: z.string().min(1).max(4000),
  citations: z.array(Citation).max(20).default([]),
});
const SummaryOutput = z.object({
  summary: z.string().min(1).max(4000),
  keyTerms: z.array(z.string().min(1).max(300)).max(20).default([]),
});
const ProposalOutput = z.object({
  proposals: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        kind: z.enum(OBLIGATION_KINDS).default("obligation"),
        dueOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        clauseId: z.string().optional(),
        rationale: z.string().max(1000).optional(),
      }),
    )
    .max(30)
    .default([]),
});

export type AiAnswer = {
  answer: string;
  citations: Array<{ blockId: string; ref: string; excerpt: string }>;
  evidenceFound: boolean;
  notice: string;
};
export type AiSummary = { summary: string; keyTerms: string[]; notice: string };
export type AiProposal = {
  title: string;
  kind: (typeof OBLIGATION_KINDS)[number];
  dueOn: string | null;
  clauseId: string | null;
  clauseRef: string | null;
  rationale: string | null;
};

function outputObject(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { answer: raw, summary: raw };
    }
  }
  return raw;
}

/** Pure: keep only citations that point at a real clause of this document. */
export function validateCitations(clauses: Clause[], raw: unknown): AiAnswer {
  const parsed = AnswerOutput.safeParse(outputObject(raw));
  if (!parsed.success)
    throw new DocError("the assistant returned an unusable answer", "validation");
  const byId = new Map(clauses.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const citations: AiAnswer["citations"] = [];
  for (const c of parsed.data.citations) {
    const clause = byId.get(c.blockId);
    if (!clause || seen.has(c.blockId)) continue;
    seen.add(c.blockId);
    citations.push({
      blockId: c.blockId,
      ref: clause.ref,
      excerpt: (c.excerpt && clause.text.includes(c.excerpt.trim())
        ? c.excerpt
        : clause.text
      ).slice(0, 300),
    });
  }
  const evidenceFound = citations.length > 0;
  return {
    answer: evidenceFound ? parsed.data.answer : "Evidence was not found in this document.",
    citations,
    evidenceFound,
    notice: AI_NOTICE,
  };
}

/** Pure: proposals whose clause references exist; nothing is persisted here. */
export function parseProposals(clauses: Clause[], raw: unknown): AiProposal[] {
  const parsed = ProposalOutput.safeParse(outputObject(raw));
  if (!parsed.success)
    throw new DocError("the assistant returned unusable proposals", "validation");
  const byId = new Map(clauses.map((c) => [c.id, c]));
  return parsed.data.proposals.map((p) => {
    const clause = p.clauseId ? byId.get(p.clauseId) : undefined;
    return {
      title: p.title,
      kind: p.kind,
      dueOn: p.dueOn ?? null,
      clauseId: clause?.id ?? null,
      clauseRef: clause?.ref ?? null,
      rationale: p.rationale ?? null,
    };
  });
}

export function parseSummary(raw: unknown): AiSummary {
  const parsed = SummaryOutput.safeParse(outputObject(raw));
  if (!parsed.success)
    throw new DocError("the assistant returned an unusable summary", "validation");
  return { ...parsed.data, notice: AI_NOTICE };
}

export type AiDeps = { provider?: AgentProvider; enabled?: boolean };

export async function aiAvailability(ctx: Ctx, deps: AiDeps = {}): Promise<AiAvailability> {
  const provider = deps.provider ?? getAgentProvider();
  const enabled = deps.enabled ?? (await agentsEnabled(ctx));
  const available = provider.name !== "disabled" && enabled;
  return { available, provider: provider.name, ownerAction: available ? null : AI_OWNER_ACTION };
}

async function bodyFor(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<{ title: string; reference: string; body: DocBody; language: "en" | "ar" }> {
  const detail = await getDocument(ctx, archetype, documentId);
  const body = detail.snapshot?.snapshot.body ?? detail.working?.body;
  if (!body) throw new DocError("the document has no content to read", "state");
  return {
    title: detail.document.title,
    reference: detail.document.reference,
    body,
    language: detail.document.language === "ar" ? "ar" : "en",
  };
}

async function run<T>(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
  what: "summarise" | "ask" | "propose",
  input: string,
  deps: AiDeps,
  parse: (clauses: Clause[], raw: unknown) => T,
): Promise<T> {
  assertCan(archetype, "documents.view");
  const avail = await aiAvailability(ctx, deps);
  if (!avail.available) throw new DocError(avail.ownerAction ?? AI_OWNER_ACTION, "unavailable");
  const provider = deps.provider ?? getAgentProvider();
  const doc = await bodyFor(ctx, archetype, documentId);
  const clauses = documentClauses(doc.body, doc.language);
  const text = clauses.map((c) => `[${c.id}] (${c.ref}) ${c.text}`).join("\n");
  const req = buildProviderRequest({
    agentId: "operations",
    correlationId: randomUUID(),
    locale: doc.language,
    input: `${INSTRUCTIONS[what]}\n\n${input}`,
    blocks: [
      untrustedBlock(
        "read.document_text",
        [{ type: "document", id: documentId }],
        `Document ${doc.reference}: ${doc.title}\n${text}`,
      ),
    ],
  });
  return command(
    ctx,
    {
      audit: {
        action: `documents.ai.${what}`,
        entityType: "document",
        entityId: documentId,
        summary: `Assistant ${what} (read-only, ${provider.name})`,
      },
    },
    async () => {
      try {
        const res = await callProvider(provider, req);
        return parse(clauses, res.output);
      } catch (err) {
        if (err instanceof AgentProviderDisabledError)
          throw new DocError(AI_OWNER_ACTION, "unavailable");
        if (err instanceof AgentProviderTimeoutError)
          throw new DocError("the assistant did not answer in time", "unavailable");
        throw err;
      }
    },
  );
}

const INSTRUCTIONS = {
  summarise:
    'Summarise the document for a manager in plain language. Return JSON: {"summary": string, "keyTerms": string[]}. Do not give legal advice.',
  ask: 'Answer the question using ONLY the document. Return JSON: {"answer": string, "citations": [{"blockId": string, "excerpt": string}]}. Cite the block ids you relied on; if the document does not contain the answer, return an empty citations array. Do not give legal advice.',
  propose:
    'List the obligations, payments, notices, reviews, renewals and risks the document creates. Return JSON: {"proposals": [{"title": string, "kind": "obligation"|"payment"|"renewal"|"notice"|"review"|"risk", "dueOn": "YYYY-MM-DD"|null, "clauseId": string, "rationale": string}]}. Proposals only; a person decides.',
} as const;

export async function summariseDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
  deps: AiDeps = {},
): Promise<AiSummary> {
  return run(ctx, archetype, documentId, "summarise", "", deps, (_c, raw) => parseSummary(raw));
}

const AskInput = z.object({
  documentId: z.string().uuid(),
  question: z.string().trim().min(2).max(2000),
});

export async function askDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  deps: AiDeps = {},
): Promise<AiAnswer> {
  const input = AskInput.parse(raw);
  return run(ctx, archetype, input.documentId, "ask", input.question, deps, validateCitations);
}

export async function proposeObligations(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
  deps: AiDeps = {},
): Promise<AiProposal[]> {
  return run(ctx, archetype, documentId, "propose", "", deps, parseProposals);
}
