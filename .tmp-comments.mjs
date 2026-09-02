import fs from "node:fs";
const dir = "src/app/(app)/o/[orgId]/studio/[planId]";
function patch(p, pairs) {
  let s = fs.readFileSync(p, "utf8");
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${p}: anchor not found:\n${a}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
  console.log("patched", p);
}

// actions: comments on elements through the platform door
{
  const p = `${dir}/../actions.ts`;
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes(`import { createComment, listComments } from "@/platform/comments";`)) {
    s = s.replace(
      `import { resolveCtxForAction } from "@/platform/auth/resolve";`,
      `import { resolveCtxForAction } from "@/platform/auth/resolve";\nimport { createComment, listComments, type Comment } from "@/platform/comments";`,
    );
  }
  s += `
// ── H25C — comments on elements (platform comments, studio_node is attachable) ─

export async function listNodeCommentsAction(
  orgId: string,
  nodeId: string,
): Promise<ActionResult<Comment[]>> {
  return run(orgId, (r) => listComments(r.ctx, "studio_node", nodeId));
}

export async function addNodeCommentAction(
  orgId: string,
  input: { nodeId: string; body: string },
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => ({
    id: await createComment(r.ctx, { entityType: "studio_node", entityId: input.nodeId, body: input.body }),
  }));
}
`;
  fs.writeFileSync(p, s);
  console.log("actions: comments");
}

// workspace types
patch(`${dir}/StudioWorkspace.tsx`, [
  [
    `import type { ActionResult, SimulationDto } from "../actions";`,
    `import type { ActionResult, SimulationDto } from "../actions";
import type { Comment } from "@/platform/comments";`,
  ],
  [
    `  updateEdge: (input: {`,
    `  listNodeComments: (nodeId: string) => Promise<ActionResult<Comment[]>>;
  addNodeComment: (input: { nodeId: string; body: string }) => Promise<ActionResult<{ id: string }>>;
  updateEdge: (input: {`,
  ],
  [
    `  edgeLabel: string;
  lag: string;`,
    `  comments: string;
  addComment: string;
  edgeLabel: string;
  lag: string;`,
  ],
]);

// inspector: comments section (loaded on demand per selected element)
patch(`${dir}/Inspector.tsx`, [
  [
    `import { useState, useTransition } from "react";`,
    `import { useEffect, useState, useTransition } from "react";
import type { Comment } from "@/platform/comments";`,
  ],
  [
    `  const [linkJob, setLinkJob] = useState("");`,
    `  const [linkJob, setLinkJob] = useState("");
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const nodeId = node?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    setComments(null);
    if (!nodeId) return;
    void actions.listNodeComments(nodeId).then((res) => {
      if (!cancelled && res.ok) setComments(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, actions]);`,
  ],
  [
    `      {canEdit && !isLinked && payload.jobs.length > 0 &&`,
    `      <section className="rounded-md border border-line p-2">
        <p className="text-xs font-semibold text-ink">
          {dict.comments}
          {comments ? \` (\${comments.length})\` : ""}
        </p>
        <ul className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {(comments ?? []).map((c) => (
            <li key={c.id} className="rounded-md bg-sunken px-2 py-1 text-xs">
              <span className="block text-[10px] text-ink-muted">
                {c.authorName} · <span dir="ltr">{c.createdAt.slice(0, 16).replace("T", " ")}</span>
              </span>
              <span className="block whitespace-pre-wrap text-ink">{c.body}</span>
            </li>
          ))}
        </ul>
        <form
          className="mt-1 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const body = commentBody.trim();
            if (!body) return;
            start(async () => {
              const res = await actions.addNodeComment({ nodeId: current.id, body });
              if (res.ok) {
                setCommentBody("");
                const list = await actions.listNodeComments(current.id);
                if (list.ok) setComments(list.data);
              } else settle(res);
            });
          }}
        >
          <input
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder={dict.addComment}
            maxLength={4000}
            className="min-h-9 w-full rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
          />
          <button
            type="submit"
            disabled={pending || !commentBody.trim()}
            className="min-h-9 rounded-md border border-line px-2 text-xs text-ink disabled:opacity-50"
          >
            {dict.addComment}
          </button>
        </form>
      </section>

      {canEdit && !isLinked && payload.jobs.length > 0 &&`,
  ],
]);

// page dict + bindings
patch(`${dir}/page.tsx`, [
  [
    `  updateEdgeAction,
} from "../actions";`,
    `  updateEdgeAction,
  listNodeCommentsAction,
  addNodeCommentAction,
} from "../actions";`,
  ],
  [
    `    edgeLabel: t("studio.edge_label"),`,
    `    comments: t("studio.comments"),
    addComment: t("studio.add_comment"),
    edgeLabel: t("studio.edge_label"),`,
  ],
  [
    `        updateEdge: updateEdgeAction.bind(null, orgId),`,
    `        updateEdge: updateEdgeAction.bind(null, orgId),
        listNodeComments: listNodeCommentsAction.bind(null, orgId),
        addNodeComment: addNodeCommentAction.bind(null, orgId),`,
  ],
]);

const EN = { "studio.comments": "Comments", "studio.add_comment": "Add a comment" };
const AR = { "studio.comments": "التعليقات", "studio.add_comment": "أضف تعليقًا" };
for (const [file, add] of [
  ["src/platform/i18n/messages/en.json", EN],
  ["src/platform/i18n/messages/ar.json", AR],
]) {
  const obj = JSON.parse(fs.readFileSync(file, "utf8"));
  let n = 0;
  for (const [k, v] of Object.entries(add)) {
    if (k in obj) continue;
    obj[k] = v;
    n++;
  }
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(file, "+", n);
}
