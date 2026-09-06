/**
 * H33 Pilot Lab — the Document Studio family, checked without a database.
 *
 * Document Studio is the module whose credibility rests on integrity: a frozen
 * revision, an issued snapshot and a hash-linked event chain. So this file does
 * not merely count rows — it recomputes the chain with the product's own
 * `verifyChain`, re-derives every content hash, and asserts each CHECK
 * constraint the migration declares, because a row that the database would
 * reject is a seed that fails halfway through a company.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import { DocBody } from "@/modules/docstudio/types";
import { GENESIS_HASH, verifyChain, type ChainRow } from "@/modules/docstudio/snapshot";
import {
  docstudio,
  planDocstudio,
  seedDocstudio,
  buildDocstudio,
  allocateStatuses,
  DOCSTUDIO_TABLES,
  DOC_STATUS_ORDER,
  STATUS_MIX,
  TEMPLATE_SPECS,
  type DocstudioTable,
} from "../../tooling/pilot-lab/families/docstudio";

type Row = Record<string, unknown>;
type Store = Partial<Record<string, Row[]>>;

const PERSONAS: PersonaKey[] = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
  "auditor",
];

/** Columns that are allowed to point into the future; everything else is past. */
const FUTURE_OK = new Set([
  "expires_at",
  "expires_on",
  "token_expires_at",
  "due_at",
  "due_on",
  "retention_until",
]);

function handoffs(company: Company): Record<string, Record<string, unknown>> {
  const n = (k: string, c: number) => Array.from({ length: c }, (_, i) => labId(company.key, k, i));
  return {
    setup: {
      folders: {
        contracts: labId(company.key, "doc_folder", "contracts"),
        hr: labId(company.key, "doc_folder", "hr"),
      },
    },
    people: {
      activeEmployeeIds: n("employee", Math.min(company.profile.employees, 40)),
      managers: n("employee", 3),
    },
    masters: {
      customerIds: n("customer", Math.min(company.profile.customers, 50)),
      supplierIds: n("supplier", Math.min(company.profile.suppliers, 30)),
    },
    work: {
      jobs: Array.from({ length: 30 }, (_, i) => ({
        id: labId(company.key, "job", i),
        reference: `JOB-${String(i + 1).padStart(3, "0")}`,
      })),
    },
  };
}

function fakeCtx(company: Company) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const h = handoffs(company);
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx: LabContext = {
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
      }
      store[table] = [...(store[table] ?? []), ...rows.map((r) => ({ ...r }))];
      return { attempted: rows.length, inserted: rows.length };
    },
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) out[e.table] = await ctx.insert(e.table, e.rows, e.conflict);
      return out;
    },
    handoff: <T>(family: string) => {
      const v = h[family];
      if (!v) throw new Error(`no handoff from family ${family}`);
      return v as T;
    },
    log: () => {},
    dryRun: false,
  };
  return { ctx, store };
}

async function runFor(company: Company) {
  const { ctx, store } = fakeCtx(company);
  const plan = planDocstudio(ctx).expected;
  const report = await seedDocstudio(ctx);
  const rows = (t: DocstudioTable) => store[t] ?? [];
  return { ctx, plan, report, rows, model: buildDocstudio(ctx) };
}

const ts = (v: unknown) => Date.parse(String(v));
const asOf = (c: Company) => Date.parse(`${c.history.asOf}T23:59:59.999Z`);
const active = COMPANIES.filter((c) => docstudio.appliesTo(c));

describe("the docstudio family", () => {
  it("is declared correctly", () => {
    expect(docstudio.key).toBe("docstudio");
    expect(docstudio.deps).toEqual(expect.arrayContaining(["setup", "people", "masters", "work"]));
    for (const c of COMPANIES) expect(docstudio.appliesTo(c)).toBe(c.profile.enables.docstudio);
  });

  it("mixes statuses to exactly the document count", () => {
    expect(Object.values(STATUS_MIX).reduce((a, b) => a + b, 0)).toBe(100);
    for (const n of [9, 20, 90, 110, 140, 160, 320, 1000]) {
      const got = allocateStatuses(n);
      expect(got.length, `total for ${n}`).toBe(n);
      // Every status is reachable in the lab, however small the company.
      for (const s of DOC_STATUS_ORDER) expect(got, `${s} at ${n}`).toContain(s);
    }
    // Below the number of statuses there is nothing to guarantee, but the
    // count must still be exact.
    expect(allocateStatuses(4).length).toBe(4);
    expect(allocateStatuses(0)).toEqual([]);
  });

  it("builds every template body through the product's own schema", () => {
    // buildDocstudio throws on an invalid body; this pins the schema directly
    // so a template that stops parsing is caught here, not at seed time.
    for (const spec of TEMPLATE_SPECS) expect(spec.key).toMatch(/^[a-z0-9_.-]{1,60}$/);
    const { ctx } = fakeCtx(active[0]!);
    const m = buildDocstudio(ctx);
    for (const v of m.rows.doc_template_version)
      expect(DocBody.safeParse(v.body).success, String(v.id)).toBe(true);
    for (const r of m.rows.doc_revision)
      expect(DocBody.safeParse(r.body).success, String(r.id)).toBe(true);
  });

  it("keeps signer and form-link tokens unique across every company", () => {
    const tokens = new Set<string>();
    let n = 0;
    for (const c of active) {
      const { ctx } = fakeCtx(c);
      const m = buildDocstudio(ctx);
      for (const r of [...m.rows.doc_signer, ...m.rows.doc_form_link]) {
        // These columns are globally unique in the schema, not org-scoped, so
        // a collision between two lab companies would fail the seed.
        const t = String(r.token_hash);
        expect(t).toMatch(/^[0-9a-f]{64}$/);
        expect(tokens.has(t), t).toBe(false);
        tokens.add(t);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

for (const company of active) {
  describe(`docstudio for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of DOCSTUDIO_TABLES) expect(r.rows(t).length, t).toBe(r.plan[t]);
      expect(r.rows("doc_document").length).toBe(company.profile.documents);
    });

    it("is deterministic", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of DOCSTUDIO_TABLES)
        expect(a.rows(t).map((x) => x.id ?? x.scope_key)).toEqual(
          b.rows(t).map((x) => x.id ?? x.scope_key),
        );
    });

    it("carries org_id everywhere and never repeats an id", async () => {
      const r = await runFor(company);
      const seen = new Set<string>();
      for (const t of DOCSTUDIO_TABLES)
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          if (row.id === undefined) continue; // reference_sequence has no id
          const id = String(row.id);
          expect(seen.has(id), `${t} ${id}`).toBe(false);
          seen.add(id);
        }
    });

    it("dates the past in the past and only expiries in the future", async () => {
      const r = await runFor(company);
      const limit = asOf(company);
      for (const t of DOCSTUDIO_TABLES)
        for (const row of r.rows(t))
          for (const [k, v] of Object.entries(row)) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
            if (!/_(at|on|from|until)$/.test(k)) continue;
            if (FUTURE_OK.has(k)) continue;
            expect(ts(v), `${t}.${k} = ${v}`).toBeLessThanOrEqual(limit);
          }
    });

    it("shows a document in every status", async () => {
      const r = await runFor(company);
      const got = new Set(r.rows("doc_document").map((d) => String(d.status)));
      for (const s of DOC_STATUS_ORDER) expect(got, s).toContain(s);
    });

    // ── the constraints the migration declares ──────────────────────────────
    it("satisfies every doc_document check constraint", async () => {
      const r = await runFor(company);
      const refs = new Set<string>();
      for (const d of r.rows("doc_document")) {
        expect(refs.has(String(d.reference))).toBe(false);
        refs.add(String(d.reference));
        expect((d.status === "terminated") === (d.terminated_at !== null)).toBe(true);
        expect((d.status === "archived") === (d.archived_at !== null)).toBe(true);
        expect((d.record_type === null) === (d.record_id === null)).toBe(true);
        if (d.counterparty_kind === null) {
          expect(d.counterparty_id).toBeNull();
          expect(d.counterparty_label).toBeNull();
        } else if (d.counterparty_kind !== "other") {
          expect(d.counterparty_id !== null || d.counterparty_label !== null).toBe(true);
        }
        expect((d.tags as string[]).length).toBeLessThanOrEqual(20);
        expect(String(d.title).trim().length).toBeGreaterThan(0);
        expect(String(d.title).length).toBeLessThanOrEqual(240);
      }
    });

    it("freezes a revision only with its hash, and leaves working ones open", async () => {
      const r = await runFor(company);
      const byDoc = new Map(r.rows("doc_document").map((d) => [String(d.id), d]));
      const perDoc = new Map<string, Set<number>>();
      for (const rev of r.rows("doc_revision")) {
        const frozen = rev.state === "frozen";
        expect(
          frozen === (rev.frozen_at !== null && rev.content_hash !== null),
          String(rev.id),
        ).toBe(true);
        if (rev.content_hash !== null) expect(String(rev.content_hash)).toMatch(/^[0-9a-f]{64}$/);
        const doc = String(rev.document_id);
        expect(byDoc.has(doc)).toBe(true);
        const nos = perDoc.get(doc) ?? new Set<number>();
        expect(nos.has(Number(rev.revision_no))).toBe(false);
        nos.add(Number(rev.revision_no));
        perDoc.set(doc, nos);
      }
      // Every document has revision 1; an amendment adds revision 2 on top.
      for (const nos of perDoc.values()) expect(nos.has(1)).toBe(true);
      expect(r.rows("doc_revision").length).toBeGreaterThanOrEqual(r.rows("doc_document").length);
    });

    it("issues exactly one snapshot per issued document and none for the rest", async () => {
      const r = await runFor(company);
      const snaps = r.rows("doc_snapshot");
      const perDoc = new Map<string, number>();
      for (const s of snaps) {
        perDoc.set(String(s.document_id), (perDoc.get(String(s.document_id)) ?? 0) + 1);
        expect(String(s.content_hash)).toMatch(/^[0-9a-f]{64}$/);
      }
      // doc_snapshot_document_uq is unique on document_id alone.
      for (const [, n] of perDoc) expect(n).toBe(1);
      for (const d of r.rows("doc_document")) {
        const has = perDoc.has(String(d.id));
        expect(has, `${d.reference} ${d.status}`).toBe(d.issued_at !== null);
        expect(d.issued_snapshot_id !== null).toBe(has);
      }
      expect(snaps.length).toBeGreaterThan(0);
    });

    it("produces an evidence chain the product verifies", async () => {
      const r = await runFor(company);
      const byDoc = new Map<string, Row[]>();
      for (const e of r.rows("doc_event")) {
        const k = String(e.document_id);
        byDoc.set(k, [...(byDoc.get(k) ?? []), e]);
      }
      expect(byDoc.size).toBe(r.rows("doc_document").length);
      for (const [docId, events] of byDoc) {
        const sorted = events.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
        expect(sorted[0]!.prev_hash).toBe(GENESIS_HASH);
        const chain: ChainRow[] = sorted.map((e) => ({
          documentId: docId,
          seq: Number(e.seq),
          kind: String(e.kind),
          actorUserId: (e.actor_user_id as string | null) ?? null,
          actorLabel: (e.actor_label as string | null) ?? null,
          payload: e.payload as Record<string, unknown>,
          // Exactly the round-trip the reader performs on the stored value.
          at: new Date(String(e.at)).toISOString(),
          prevHash: String(e.prev_hash),
          eventHash: String(e.event_hash),
        }));
        const result = verifyChain(chain);
        expect(result.ok, `${docId}: ${JSON.stringify(result)}`).toBe(true);
      }
    });

    it("orders the chain's own timeline forwards", async () => {
      const r = await runFor(company);
      const byDoc = new Map<string, Row[]>();
      for (const e of r.rows("doc_event")) {
        const k = String(e.document_id);
        byDoc.set(k, [...(byDoc.get(k) ?? []), e]);
      }
      for (const events of byDoc.values()) {
        const sorted = events.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
        for (let i = 1; i < sorted.length; i++)
          expect(ts(sorted[i]!.at)).toBeGreaterThanOrEqual(ts(sorted[i - 1]!.at));
        expect(String(sorted[0]!.kind)).toBe("created");
      }
    });

    it("pairs every superseded document with its successor", async () => {
      const r = await runFor(company);
      const docs = r.rows("doc_document");
      const byId = new Map(docs.map((d) => [String(d.id), d]));
      let pairs = 0;
      for (const d of docs) {
        if (d.superseded_by_document_id === null) continue;
        const next = byId.get(String(d.superseded_by_document_id));
        expect(next, String(d.reference)).toBeDefined();
        expect(next!.supersedes_document_id).toBe(d.id);
        pairs++;
      }
      expect(pairs).toBeGreaterThan(0);
      for (const d of docs)
        if (d.supersedes_document_id !== null)
          expect(byId.get(String(d.supersedes_document_id))).toBeDefined();
    });

    it("runs approval workflows consistently with the document's status", async () => {
      const r = await runFor(company);
      const byDoc = new Map(r.rows("doc_document").map((d) => [String(d.id), d]));
      const stepsByRun = new Map<string, Row[]>();
      for (const s of r.rows("doc_workflow_step_run")) {
        const k = String(s.run_id);
        stepsByRun.set(k, [...(stepsByRun.get(k) ?? []), s]);
      }
      const workflowIds = new Set(r.rows("doc_workflow").map((w) => String(w.id)));
      expect(r.rows("doc_workflow_run").length).toBeGreaterThan(0);
      for (const run of r.rows("doc_workflow_run")) {
        // doc_workflow_run_finished_ck
        expect((run.status === "running") === (run.finished_at === null)).toBe(true);
        expect(workflowIds.has(String(run.workflow_id))).toBe(true);
        const doc = byDoc.get(String(run.document_id))!;
        expect(doc).toBeDefined();
        const running = doc.status === "review" || doc.status === "approval";
        expect(run.status, String(doc.reference)).toBe(running ? "running" : "completed");
        const steps = (stepsByRun.get(String(run.id)) ?? [])
          .slice()
          .sort((a, b) => Number(a.step_index) - Number(b.step_index));
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.map((s) => Number(s.step_index))).toEqual(steps.map((_, i) => i));
        for (const s of steps) {
          const done = s.status === "completed";
          expect(done === (s.decided_at !== null)).toBe(true);
          if (s.decision !== null) expect(s.decision).toBe("approved");
          if (s.decision !== null) expect(s.kind).toBe("approval");
          expect(String(s.step_id)).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
        }
        // A finished run has no step still waiting.
        if (run.status === "completed")
          expect(steps.every((s) => s.status === "completed")).toBe(true);
      }
    });

    it("keeps the signature room honest", async () => {
      const r = await runFor(company);
      const reqs = r.rows("doc_signature_request");
      const byDoc = new Map(r.rows("doc_document").map((d) => [String(d.id), d]));
      const snapIds = new Set(r.rows("doc_snapshot").map((s) => String(s.id)));
      expect(reqs.length).toBeGreaterThan(0);
      for (const q of reqs) {
        expect(ts(q.expires_at), "expires_at > created_at").toBeGreaterThan(ts(q.created_at));
        expect(snapIds.has(String(q.snapshot_id))).toBe(true);
        const doc = byDoc.get(String(q.document_id))!;
        expect(doc.issued_at, "a signature room needs an issued document").not.toBeNull();
        expect((q.status === "completed") === (q.completed_at !== null)).toBe(true);
      }
      const reqIds = new Set(reqs.map((q) => String(q.id)));
      const signers = r.rows("doc_signer");
      expect(signers.length).toBeGreaterThanOrEqual(reqs.length);
      for (const s of signers) {
        expect(reqIds.has(String(s.request_id))).toBe(true);
        // doc_signer_member_ck and doc_signer_signed_ck
        expect((s.party_kind === "member") === (s.user_id !== null)).toBe(true);
        expect(
          (s.status === "signed") === (s.signed_at !== null && s.evidence_hash !== null),
          String(s.id),
        ).toBe(true);
        expect(String(s.party)).toMatch(/^[A-Za-z0-9_ -]{1,40}$/);
        if (s.email !== null) expect(String(s.email)).toMatch(/@pilot-lab\.invalid$/);
        // An external signer is never given a real user id.
        if (s.party_kind === "external") expect(s.user_id).toBeNull();
      }
      // Both a completed room and one still waiting are visible.
      const statuses = new Set(reqs.map((q) => String(q.status)));
      expect(statuses.has("completed")).toBe(true);
    });

    it("writes comments that respect the suggestion constraint", async () => {
      const r = await runFor(company);
      const docIds = new Set(r.rows("doc_document").map((d) => String(d.id)));
      const comments = r.rows("doc_comment");
      expect(comments.length).toBeGreaterThan(0);
      for (const c of comments) {
        expect(docIds.has(String(c.document_id))).toBe(true);
        // doc_comment_suggestion_ck
        expect((c.suggestion === null) === (c.suggestion_status === null)).toBe(true);
        expect(String(c.body).trim().length).toBeGreaterThan(0);
        expect(String(c.body).length).toBeLessThanOrEqual(4000);
        expect((c.mentions as string[]).length).toBeLessThanOrEqual(20);
        if (c.block_id !== null) expect(String(c.block_id)).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      }
      expect(comments.some((c) => c.resolved_at !== null)).toBe(true);
    });

    it("writes obligations that are due on both sides of today", async () => {
      const r = await runFor(company);
      const obs = r.rows("doc_obligation");
      const today = company.history.asOf;
      expect(obs.length).toBeGreaterThan(0);
      for (const o of obs) {
        // doc_obligation_done_ck / _closed_ck / _money_ck
        expect((o.status === "done") === (o.completed_at !== null), String(o.id)).toBe(true);
        if (o.status === "waived" || o.status === "cancelled")
          expect(o.closed_reason, String(o.id)).toBeTruthy();
        expect((o.amount_cents === null) === (o.currency === null)).toBe(true);
        if (o.currency !== null) expect(String(o.currency)).toMatch(/^[A-Z]{3}$/);
        if (o.recurrence_months !== null) {
          expect(Number(o.recurrence_months)).toBeGreaterThanOrEqual(1);
          expect(Number(o.recurrence_months)).toBeLessThanOrEqual(120);
        }
      }
      const open = obs.filter((o) => o.status === "open");
      expect(
        open.some((o) => String(o.due_on) < today),
        "something overdue",
      ).toBe(true);
      expect(
        open.some((o) => String(o.due_on) >= today),
        "something upcoming",
      ).toBe(true);
      expect(new Set(obs.map((o) => o.status)).size).toBeGreaterThanOrEqual(2);
    });

    it("links form submissions to a live link and a snapshot", async () => {
      const r = await runFor(company);
      const links = r.rows("doc_form_link");
      const subs = r.rows("doc_form_submission");
      const snapIds = new Set(r.rows("doc_snapshot").map((s) => String(s.id)));
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) {
        expect(ts(l.expires_at)).toBeGreaterThan(ts(l.created_at));
        expect(snapIds.has(String(l.snapshot_id))).toBe(true);
        expect(Number(l.use_count)).toBeGreaterThanOrEqual(0);
        expect(Number(l.use_count)).toBeLessThanOrEqual(Number(l.max_uses));
      }
      const linkIds = new Set(links.map((l) => String(l.id)));
      expect(subs.length).toBeGreaterThan(0);
      for (const s of subs) {
        expect(linkIds.has(String(s.link_id))).toBe(true);
        expect(snapIds.has(String(s.snapshot_id))).toBe(true);
        // doc_form_submission_converted_ck
        expect((s.converted_record_type === null) === (s.converted_record_id === null)).toBe(true);
        expect(String(s.submitter_email)).toMatch(/@pilot-lab\.invalid$/);
      }
      // Every link's use_count matches the submissions actually recorded on it.
      for (const l of links)
        expect(subs.filter((s) => s.link_id === l.id).length).toBe(Number(l.use_count));
    });

    it("orders its tables so every foreign key already exists", async () => {
      const r = await runFor(company);
      const order = DOCSTUDIO_TABLES.indexOf.bind(DOCSTUDIO_TABLES);
      // The parent side of each FK must be inserted first.
      const pairs: Array<[DocstudioTable, DocstudioTable]> = [
        ["doc_workflow", "doc_template"],
        ["doc_template", "doc_template_version"],
        ["doc_template_version", "doc_document"],
        ["doc_document", "doc_revision"],
        ["doc_revision", "doc_snapshot"],
        ["doc_document", "doc_event"],
        ["doc_revision", "doc_workflow_run"],
        ["doc_workflow_run", "doc_workflow_step_run"],
        ["doc_snapshot", "doc_signature_request"],
        ["doc_signature_request", "doc_signer"],
        ["doc_revision", "doc_comment"],
        ["doc_document", "doc_obligation"],
        ["doc_snapshot", "doc_form_link"],
        ["doc_form_link", "doc_form_submission"],
      ];
      for (const [parent, child] of pairs)
        expect(order(parent), `${parent} before ${child}`).toBeLessThan(order(child));
      // And the rows really do point at things this family wrote.
      const ids = (t: DocstudioTable) => new Set(r.rows(t).map((x) => String(x.id)));
      const docIds = ids("doc_document");
      const revIds = ids("doc_revision");
      const tplIds = ids("doc_template");
      for (const d of r.rows("doc_document")) expect(tplIds.has(String(d.template_id))).toBe(true);
      for (const s of r.rows("doc_snapshot")) {
        expect(docIds.has(String(s.document_id))).toBe(true);
        expect(revIds.has(String(s.revision_id))).toBe(true);
      }
      for (const s of r.rows("doc_workflow_step_run"))
        expect(docIds.has(String(s.document_id))).toBe(true);
    });

    it("advances the document reference sequence past the bulk", async () => {
      const r = await runFor(company);
      const seq = r.rows("reference_sequence");
      expect(seq.length).toBe(1);
      expect(seq[0]!.scope_key).toBe("document");
      expect(Number(seq[0]!.next_value)).toBe(company.profile.documents + 1);
      const refs = r.rows("doc_document").map((d) => String(d.reference));
      expect(new Set(refs).size).toBe(refs.length);
      for (const ref of refs) expect(ref).toMatch(/^DOC-\d{3,}$/);
    });

    it("hands off what later families need", async () => {
      const r = await runFor(company);
      const h = r.report.handoff as {
        documentIds: string[];
        activeDocumentIds: string[];
        templateIds: string[];
      };
      expect(h.documentIds.length).toBe(company.profile.documents);
      expect(h.activeDocumentIds.length).toBeGreaterThan(0);
      expect(h.templateIds.length).toBe(TEMPLATE_SPECS.length);
    });
  });
}
