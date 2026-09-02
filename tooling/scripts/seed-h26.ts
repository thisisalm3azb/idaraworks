/**
 * Bleed-harness seeders for the H26 Document Studio tables.
 *
 * Same contract as seed-h23/h24/h25 — ONE seeder per org-scoped table via the
 * OWNER connection; chains build their own dependencies so each stands alone.
 */
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);
const hex64 = (s: string) => createHash("sha256").update(s).digest("hex");

async function documentRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.doc_document (id, org_id, reference, title, category, created_by, search_text)
          values (${id}, ${org}, ${"BLD-" + short()}, 'Bleed document', 'letter', ${u}, 'bleed document')`;
  return id;
}

async function revisionRow(o: Owner, org: string, u: string, doc?: string): Promise<string> {
  const d = doc ?? (await documentRow(o, org, u));
  const id = randomUUID();
  await o`insert into public.doc_revision (id, org_id, document_id, revision_no, created_by)
          values (${id}, ${org}, ${d}, 1, ${u})`;
  return id;
}

async function frozenRevisionRow(o: Owner, org: string, u: string, doc: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.doc_revision
            (id, org_id, document_id, revision_no, state, content_hash, frozen_at, frozen_by, created_by)
          values (${id}, ${org}, ${doc}, 1, 'frozen', ${hex64(id)}, now(), ${u}, ${u})`;
  return id;
}

async function templateRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.doc_template (id, org_id, key, name_en, name_ar, category, created_by)
          values (${id}, ${org}, ${"bleed-" + short()}, 'Bleed template', 'قالب', 'letter', ${u})`;
  return id;
}

async function workflowRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.doc_workflow (id, org_id, name, created_by)
          values (${id}, ${org}, 'Bleed workflow', ${u})`;
  return id;
}

async function runRow(o: Owner, org: string, u: string): Promise<{ run: string; doc: string }> {
  const doc = await documentRow(o, org, u);
  const rev = await frozenRevisionRow(o, org, u, doc);
  const id = randomUUID();
  await o`insert into public.doc_workflow_run (id, org_id, document_id, revision_id, definition, started_by, created_by)
          values (${id}, ${org}, ${doc}, ${rev}, '{"version":1,"steps":[]}'::jsonb, ${u}, ${u})`;
  return { run: id, doc };
}

export const H26_SEEDERS: Record<string, Seeder> = {
  doc_folder: async (o, org, u) => {
    await o`insert into public.doc_folder (org_id, name, created_by) values (${org}, 'Bleed folder', ${u})`;
  },
  doc_workflow: async (o, org, u) => {
    await workflowRow(o, org, u);
  },
  doc_template: async (o, org, u) => {
    await templateRow(o, org, u);
  },
  doc_template_version: async (o, org, u) => {
    const t = await templateRow(o, org, u);
    await o`insert into public.doc_template_version (org_id, template_id, version, body, created_by)
            values (${org}, ${t}, 1, '{"blocks":[]}'::jsonb, ${u})`;
  },
  doc_document: async (o, org, u) => {
    await documentRow(o, org, u);
  },
  doc_revision: async (o, org, u) => {
    await revisionRow(o, org, u);
  },
  doc_snapshot: async (o, org, u) => {
    const d = await documentRow(o, org, u);
    const r = await frozenRevisionRow(o, org, u, d);
    await o`insert into public.doc_snapshot
              (org_id, document_id, revision_id, snapshot, content_hash, issued_by, created_by)
            values (${org}, ${d}, ${r}, '{"version":1}'::jsonb, ${hex64(d)}, ${u}, ${u})`;
  },
  doc_event: async (o, org, u) => {
    const d = await documentRow(o, org, u);
    await o`insert into public.doc_event
              (org_id, document_id, seq, kind, actor_user_id, payload, prev_hash, event_hash, at)
            values (${org}, ${d}, 1, 'created', ${u}, '{}'::jsonb, ${"0".repeat(64)}, ${hex64(d + "1")}, now())`;
  },
  doc_comment: async (o, org, u) => {
    const d = await documentRow(o, org, u);
    await o`insert into public.doc_comment (org_id, document_id, body, author_user_id)
            values (${org}, ${d}, 'Bleed comment', ${u})`;
  },
  doc_workflow_run: async (o, org, u) => {
    await runRow(o, org, u);
  },
  doc_workflow_step_run: async (o, org, u) => {
    const { run, doc } = await runRow(o, org, u);
    await o`insert into public.doc_workflow_step_run (org_id, run_id, document_id, step_id, step_index, kind, status, created_by)
            values (${org}, ${run}, ${doc}, 's1', 0, 'review', 'skipped', ${u})`;
  },
  doc_saved_view: async (o, org, u) => {
    await o`insert into public.doc_saved_view (org_id, name, created_by, is_shared)
            values (${org}, 'Bleed view', ${u}, true)`;
  },
};
