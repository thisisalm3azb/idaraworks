"use client";

/**
 * H26 — the interactive builder. Blocks are the unit: insert from a
 * palette, reorder by drag or keyboard, edit in place, inspect on the side,
 * fill author fields, tune page settings. Every change lands in local
 * state with an undo stack and autosaves through the working revision's
 * row version; a stale write is refused loudly (ADR-31), never merged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/platform/ui";
import type {
  Block,
  DocBody,
  DocSettings,
  DocVariables,
  LeafBlock,
  RevisionRow,
  SectionBlock,
} from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import { saveRevisionAction } from "../studio-actions";
import { BlockEditor, type BlockEditorDict, type Vocabulary } from "./BlockEditor";

/** Field blocks in document order (sections flattened). Client-safe helper. */
function collectFields(body: DocBody) {
  const out: Array<Extract<LeafBlock, { type: "field" }>> = [];
  for (const b of body.blocks) {
    if (b.type === "field") out.push(b);
    if (b.type === "section") for (const c of b.blocks) if (c.type === "field") out.push(c);
  }
  return out;
}

export type BuilderDict = BlockEditorDict & {
  insert: string;
  inspector: string;
  nothingSelected: string;
  moveUp: string;
  moveDown: string;
  duplicate: string;
  remove: string;
  undo: string;
  redo: string;
  saveNow: string;
  saving: string;
  savedAt: string;
  unsaved: string;
  readOnly: string;
  fill: string;
  fillHint: string;
  settings: string;
  showLogo: string;
  showIssuer: string;
  showReference: string;
  footerText: string;
  pageNumbers: string;
  watermark: string;
  numberClauses: string;
  accent: string;
  dragHint: string;
  sectionBlocks: string;
  empty: string;
  shortcuts: string;
  variables: string;
  kinds: Record<string, string>;
};

type Snapshot = { body: DocBody; variables: DocVariables; settings: DocSettings };
type Lang = "en" | "ar" | "bilingual";

const newId = () => `b_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

function blank(type: Block["type"], lang: Lang): Block {
  const text = lang === "ar" ? { ar: "" } : lang === "bilingual" ? { en: "", ar: "" } : { en: "" };
  const t = { ...text, ...(lang === "ar" ? { ar: " " } : { en: " " }) };
  const id = newId();
  switch (type) {
    case "heading":
      return { id, type, level: 2, text: t };
    case "paragraph":
      return { id, type, text: t };
    case "clause":
      return { id, type, text: t };
    case "note":
      return { id, type, tone: "info", text: t };
    case "list":
      return { id, type, style: "bullet", items: [t] };
    case "table":
      return { id, type, columns: [t, { ...t }], rows: [[{ ...t }, { ...t }]] };
    case "line_items":
      return {
        id,
        type,
        source: "manual",
        currency: "AED",
        items: [],
        showVat: true,
        showTotals: true,
      };
    case "field":
      return {
        id,
        type,
        key: `field_${id.slice(2, 8)}`,
        kind: "text",
        label: t,
        required: false,
        filledBy: "author",
      };
    case "binding":
      return { id, type, path: "counterparty.name", format: "text" };
    case "signature":
      return { id, type, party: "counterparty", label: t, parts: ["signature", "name", "date"] };
    case "image":
      return { id, type, source: "logo", widthPct: 40, align: "start" };
    case "page_break":
      return { id, type };
    case "section":
      return { id, type, blocks: [] };
  }
}

function findPath(
  body: DocBody,
  id: string,
): { index: number; parent: string | null; childIndex?: number } | null {
  for (const [i, b] of body.blocks.entries()) {
    if (b.id === id) return { index: i, parent: null };
    if (b.type === "section") {
      const j = b.blocks.findIndex((c) => c.id === id);
      if (j >= 0) return { index: i, parent: b.id, childIndex: j };
    }
  }
  return null;
}

export function Builder({
  orgId,
  documentId,
  language,
  revision,
  readOnly,
  settle,
  dict,
  blockTypes,
  bindings,
  vocab,
  save: saveProp,
}: {
  orgId: string;
  documentId: string;
  language: Lang;
  revision: RevisionRow;
  readOnly: boolean;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
  dict: BuilderDict;
  blockTypes: Record<string, string>;
  bindings: Record<string, string>;
  vocab: Vocabulary;
  /** Where a save goes (defaults to the document revision action). Templates pass their own. */
  save?: (
    snapshot: { body: DocBody; variables: DocVariables; settings: DocSettings },
    expectedRowVersion: number,
  ) => Promise<ActionResult<{ rowVersion: number; savedAt: string }>>;
}) {
  const [snap, setSnap] = useState<Snapshot>({
    body: revision.body,
    variables: revision.variables,
    settings: revision.settings,
  });
  const [rowVersion, setRowVersion] = useState(revision.rowVersion);
  const [selected, setSelected] = useState<string | null>(null);
  const [aside, setAside] = useState<"inspector" | "fill" | "settings">("inspector");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const dragId = useRef<string | null>(null);
  const latest = useRef(snap);
  // The undo/redo stacks live in refs (handlers only); their sizes are state
  // so the toolbar can render them. A new working revision remounts the
  // builder (the workspace keys it by revision id), so no adoption effect.
  const [stacks, setStacks] = useState({ past: 0, future: 0 });
  useEffect(() => {
    latest.current = snap;
  }, [snap]);

  const commit = useCallback((next: Snapshot) => {
    past.current = [...past.current.slice(-60), latest.current];
    future.current = [];
    setStacks({ past: past.current.length, future: 0 });
    latest.current = next;
    setSnap(next);
    setDirty(true);
  }, []);

  const setBody = useCallback((body: DocBody) => commit({ ...latest.current, body }), [commit]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(latest.current);
    setStacks({ past: past.current.length, future: future.current.length });
    latest.current = prev;
    setSnap(prev);
    setDirty(true);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(latest.current);
    setStacks({ past: past.current.length, future: future.current.length });
    latest.current = next;
    setSnap(next);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (readOnly || conflict || saving) return;
    const current = latest.current;
    setSaving(true);
    const res = saveProp
      ? await saveProp(current, rowVersion)
      : await saveRevisionAction(orgId, {
          documentId,
          revisionId: revision.id,
          expectedRowVersion: rowVersion,
          body: current.body,
          variables: current.variables,
          settings: current.settings,
        });
    setSaving(false);
    if (res.ok) {
      setRowVersion(res.data.rowVersion);
      setSavedAt(res.data.savedAt);
      if (latest.current === current) setDirty(false);
    } else {
      if (res.code === "conflict") setConflict(true);
      settle(res);
    }
  }, [orgId, documentId, revision.id, rowVersion, readOnly, conflict, saving, settle, saveProp]);

  useEffect(() => {
    if (!dirty || readOnly || conflict) return;
    const id = setTimeout(() => void save(), 1500);
    return () => clearTimeout(id);
  }, [dirty, snap, save, readOnly, conflict]);

  // ── block operations ───────────────────────────────────────────────────────
  const update = useCallback(
    (id: string, patch: Partial<Block>) => {
      const body = latest.current.body;
      const blocks = body.blocks.map((b) => {
        if (b.id === id) return { ...b, ...patch } as Block;
        if (b.type === "section")
          return {
            ...b,
            blocks: b.blocks.map((c) => (c.id === id ? ({ ...c, ...patch } as LeafBlock) : c)),
          };
        return b;
      });
      setBody({ blocks });
    },
    [setBody],
  );

  const insert = useCallback(
    (type: Block["type"], into: string | null = null) => {
      const body = latest.current.body;
      const block = blank(type, language);
      if (into) {
        const blocks = body.blocks.map((b) =>
          b.id === into && b.type === "section" && block.type !== "section"
            ? { ...b, blocks: [...b.blocks, block as LeafBlock] }
            : b,
        );
        setBody({ blocks });
      } else {
        const pos = selected ? findPath(body, selected) : null;
        const at =
          pos && pos.parent === null ? pos.index + 1 : pos ? pos.index + 1 : body.blocks.length;
        const blocks = [...body.blocks];
        blocks.splice(at, 0, block);
        setBody({ blocks });
      }
      setSelected(block.id);
      setAside("inspector");
    },
    [language, selected, setBody],
  );

  const remove = useCallback(
    (id: string) => {
      const body = latest.current.body;
      setBody({
        blocks: body.blocks
          .filter((b) => b.id !== id)
          .map((b) =>
            b.type === "section" ? { ...b, blocks: b.blocks.filter((c) => c.id !== id) } : b,
          ),
      });
      if (selected === id) setSelected(null);
    },
    [selected, setBody],
  );

  const duplicate = useCallback(
    (id: string) => {
      const body = latest.current.body;
      const clone = (b: Block): Block => {
        const copy = JSON.parse(JSON.stringify(b)) as Block;
        copy.id = newId();
        if (copy.type === "field") copy.key = `${copy.key}_copy`.slice(0, 40);
        if (copy.type === "section") copy.blocks = copy.blocks.map((c) => clone(c) as LeafBlock);
        return copy;
      };
      const blocks: Block[] = [];
      for (const b of body.blocks) {
        blocks.push(b);
        if (b.id === id) blocks.push(clone(b));
        else if (b.type === "section" && b.blocks.some((c) => c.id === id)) {
          const idx = blocks.length - 1;
          const kids: LeafBlock[] = [];
          for (const c of b.blocks) {
            kids.push(c);
            if (c.id === id) kids.push(clone(c) as LeafBlock);
          }
          blocks[idx] = { ...b, blocks: kids };
        }
      }
      setBody({ blocks });
    },
    [setBody],
  );

  const move = useCallback(
    (id: string, delta: number) => {
      const body = latest.current.body;
      const pos = findPath(body, id);
      if (!pos) return;
      if (pos.parent === null) {
        const to = pos.index + delta;
        if (to < 0 || to >= body.blocks.length) return;
        const blocks = [...body.blocks];
        const [b] = blocks.splice(pos.index, 1);
        blocks.splice(to, 0, b!);
        setBody({ blocks });
      } else {
        const blocks = body.blocks.map((b) => {
          if (b.id !== pos.parent || b.type !== "section") return b;
          const kids = [...b.blocks];
          const to = pos.childIndex! + delta;
          if (to < 0 || to >= kids.length) return b;
          const [c] = kids.splice(pos.childIndex!, 1);
          kids.splice(to, 0, c!);
          return { ...b, blocks: kids };
        });
        setBody({ blocks });
      }
    },
    [setBody],
  );

  const dropBefore = useCallback(
    (targetId: string) => {
      const from = dragId.current;
      dragId.current = null;
      if (!from || from === targetId) return;
      const body = latest.current.body;
      const src = findPath(body, from);
      const dst = findPath(body, targetId);
      if (!src || !dst || src.parent !== null || dst.parent !== null) return; // top level only
      const blocks = [...body.blocks];
      const [b] = blocks.splice(src.index, 1);
      const at = blocks.findIndex((x) => x.id === targetId);
      blocks.splice(at, 0, b!);
      setBody({ blocks });
    },
    [setBody],
  );

  // ── keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (typing) return;
        e.preventDefault();
        undo();
        return;
      }
      if (
        (mod && e.key.toLowerCase() === "y") ||
        (mod && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        if (typing) return;
        e.preventDefault();
        redo();
        return;
      }
      if (typing || !selected || readOnly) return;
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        move(selected, -1);
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        move(selected, 1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(selected);
      } else if (e.key === "Escape") {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, readOnly, save, undo, redo, move, remove]);

  const selectedBlock = useMemo(() => {
    if (!selected) return null;
    for (const b of snap.body.blocks) {
      if (b.id === selected) return b;
      if (b.type === "section") {
        const c = b.blocks.find((x) => x.id === selected);
        if (c) return c;
      }
    }
    return null;
  }, [snap.body, selected]);

  const authorFields = useMemo(
    () => collectFields(snap.body).filter((f) => f.filledBy === "author" && !f.computed),
    [snap.body],
  );

  const setVariable = (key: string, value: string | number | boolean | null) =>
    commit({ ...latest.current, variables: { ...latest.current.variables, [key]: value } });
  const setSettings = (patch: Partial<DocSettings>) =>
    commit({ ...latest.current, settings: { ...latest.current.settings, ...patch } });

  const pick = (t: { en?: string; ar?: string } | undefined) =>
    (language === "ar" ? (t?.ar ?? t?.en) : (t?.en ?? t?.ar)) ?? "";
  const summary = (b: Block): string => {
    switch (b.type) {
      case "heading":
      case "paragraph":
      case "note":
        return pick(b.text);
      case "clause":
        return `${pick(b.title) ? pick(b.title) + ": " : ""}${pick(b.text)}`;
      case "list":
        return b.items.map(pick).join(" · ");
      case "table":
        return b.columns.map(pick).join(" | ");
      case "line_items":
        return `${b.source} · ${b.items.length} · ${b.currency}`;
      case "field":
        return `${b.key} · ${dict.kinds[b.kind] ?? b.kind}${b.required ? " *" : ""}`;
      case "binding":
        return bindings[b.path] ?? b.path;
      case "signature":
        return `${b.party} · ${pick(b.label)}`;
      case "image":
        return b.source === "logo" ? "logo" : b.source;
      case "page_break":
        return "";
      case "section":
        return `${pick(b.title)} (${b.blocks.length})`;
    }
  };

  const row = (b: Block, nested: boolean) => (
    <li
      key={b.id}
      draggable={!readOnly && !nested}
      onDragStart={() => {
        dragId.current = b.id;
      }}
      onDragOver={(e) => {
        if (!nested) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (!nested) dropBefore(b.id);
      }}
      className={`rounded-md border ${
        selected === b.id
          ? "border-accent-line bg-accent-soft"
          : "border-line bg-card hover:bg-sunken"
      } ${nested ? "ms-6" : ""}`}
    >
      <button
        type="button"
        onClick={() => {
          setSelected(b.id);
          setAside("inspector");
        }}
        className="flex w-full items-start gap-2 px-3 py-2 text-start"
        aria-pressed={selected === b.id}
      >
        <span className="mt-0.5 shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
          {blockTypes[b.type] ?? b.type}
        </span>
        <span className="min-h-6 flex-1 truncate text-sm text-ink" dir="auto">
          {summary(b) || <span className="text-ink-muted">…</span>}
        </span>
        {b.condition ? <span className="text-[10px] text-ink-muted">{dict.condition}</span> : null}
      </button>
      {b.type === "section" ? (
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {b.blocks.map((c) => row(c, true))}
          {!readOnly ? (
            <li className="ms-6 flex flex-wrap gap-1">
              {vocab.blockTypes
                .filter((t) => t !== "section")
                .map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => insert(t, b.id)}
                    className="min-h-8 rounded border border-line bg-card px-2 text-[11px] text-ink-secondary hover:bg-accent-soft"
                  >
                    + {blockTypes[t] ?? t}
                  </button>
                ))}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );

  const stateText = conflict
    ? dict.unsaved
    : saving
      ? dict.saving
      : dirty
        ? dict.unsaved
        : savedAt
          ? `${dict.savedAt} ${new Date(savedAt).toLocaleTimeString()}`
          : "";

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-2">
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-card p-2 shadow-card">
            <span className="me-1 text-xs text-ink-muted">{dict.insert}</span>
            {vocab.blockTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => insert(t)}
                className="min-h-9 rounded-full border border-line bg-card px-3 text-xs text-ink-secondary hover:bg-accent-soft"
              >
                + {blockTypes[t] ?? t}
              </button>
            ))}
            <span className="ms-auto flex items-center gap-1">
              <Button
                variant="ghost"

                onClick={undo}
                disabled={stacks.past === 0}
                aria-label={dict.undo}
              >
                ↶
              </Button>
              <Button
                variant="ghost"
                onClick={redo}
                disabled={stacks.future === 0}
                aria-label={dict.redo}
              >
                ↷
              </Button>
              <Button
                variant="secondary"

                onClick={() => void save()}
                disabled={saving || conflict || !dirty}
              >
                {dict.saveNow}
              </Button>
              <span
                className={`text-xs ${conflict ? "text-danger" : "text-ink-muted"}`}
                role="status"
              >
                {stateText}
              </span>
            </span>
          </div>
        ) : (
          <p className="rounded-md bg-sunken px-3 py-2 text-xs text-ink-secondary">
            {dict.readOnly}
          </p>
        )}
        {snap.body.blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong bg-card p-6 text-center text-sm text-ink-muted">
            {dict.empty}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label={dict.dragHint}>
            {snap.body.blocks.map((b) => row(b, false))}
          </ul>
        )}
        {!readOnly ? <p className="text-[11px] text-ink-muted">{dict.shortcuts}</p> : null}
      </div>

      <aside className="flex flex-col gap-2">
        <div role="tablist" className="flex gap-1">
          {(["inspector", "fill", "settings"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={aside === k}
              onClick={() => setAside(k)}
              className={`min-h-9 rounded-md px-3 text-xs ${
                aside === k ? "bg-accent-soft text-ink" : "bg-sunken text-ink-secondary"
              }`}
            >
              {k === "inspector" ? dict.inspector : k === "fill" ? dict.fill : dict.settings}
              {k === "fill" && authorFields.length ? ` (${authorFields.length})` : ""}
            </button>
          ))}
        </div>
        <div className="rounded-lg border border-line bg-card p-3 shadow-card">
          {aside === "inspector" ? (
            selectedBlock ? (
              <div className="flex flex-col gap-2">
                {!readOnly ? (
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" onClick={() => move(selectedBlock.id, -1)}>
                      {dict.moveUp}
                    </Button>
                    <Button variant="ghost" onClick={() => move(selectedBlock.id, 1)}>
                      {dict.moveDown}
                    </Button>
                    <Button variant="ghost" onClick={() => duplicate(selectedBlock.id)}>
                      {dict.duplicate}
                    </Button>
                    <Button variant="danger" onClick={() => remove(selectedBlock.id)}>
                      {dict.remove}
                    </Button>
                  </div>
                ) : null}
                <BlockEditor
                  block={selectedBlock}
                  language={language}
                  readOnly={readOnly}
                  dict={dict}
                  bindings={bindings}
                  vocab={vocab}
                  fieldKeys={collectFields(snap.body).map((f) => f.key)}
                  onChange={(patch) => update(selectedBlock.id, patch)}
                />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">{dict.nothingSelected}</p>
            )
          ) : null}
          {aside === "fill" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-muted">{dict.fillHint}</p>
              {authorFields.length === 0 ? <p className="text-sm text-ink-muted">–</p> : null}
              {authorFields.map((f) => {
                const v = snap.variables[f.key];
                const label = `${pick(f.label)}${f.required ? " *" : ""}`;
                const cls =
                  "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
                if (f.kind === "checkbox")
                  return (
                    <label key={f.key} className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={Boolean(v)}
                        disabled={readOnly}
                        onChange={(e) => setVariable(f.key, e.target.checked)}
                      />
                      {label}
                    </label>
                  );
                if (f.kind === "choice")
                  return (
                    <label key={f.key} className="text-xs text-ink-muted">
                      {label}
                      <select
                        value={typeof v === "number" ? String(v) : ""}
                        disabled={readOnly}
                        onChange={(e) =>
                          setVariable(f.key, e.target.value === "" ? null : Number(e.target.value))
                        }
                        className={cls}
                      >
                        <option value="">–</option>
                        {(f.options ?? []).map((o, i) => (
                          <option key={i} value={i}>
                            {pick(o)}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                if (f.kind === "textarea")
                  return (
                    <label key={f.key} className="text-xs text-ink-muted">
                      {label}
                      <textarea
                        value={typeof v === "string" ? v : ""}
                        disabled={readOnly}
                        rows={3}
                        onChange={(e) => setVariable(f.key, e.target.value)}
                        className={`${cls} py-2`}
                      />
                    </label>
                  );
                const type =
                  f.kind === "number" || f.kind === "money"
                    ? "number"
                    : f.kind === "date"
                      ? "date"
                      : f.kind === "email"
                        ? "email"
                        : f.kind === "phone"
                          ? "tel"
                          : "text";
                return (
                  <label key={f.key} className="text-xs text-ink-muted">
                    {label}
                    {f.kind === "money" ? ` (${f.currency ?? "AED"})` : ""}
                    <input
                      type={type}
                      step={f.kind === "money" ? "0.01" : undefined}
                      value={
                        v === null || v === undefined
                          ? ""
                          : f.kind === "money" && typeof v === "number"
                            ? String(v / 100)
                            : String(v)
                      }
                      disabled={readOnly}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") setVariable(f.key, null);
                        else if (f.kind === "money")
                          setVariable(f.key, Math.round(Number(raw) * 100));
                        else if (f.kind === "number") setVariable(f.key, Number(raw));
                        else setVariable(f.key, raw);
                      }}
                      className={cls}
                    />
                  </label>
                );
              })}
            </div>
          ) : null}
          {aside === "settings" ? (
            <div className="flex flex-col gap-2 text-sm text-ink">
              {(
                [
                  ["showLogo", dict.showLogo],
                  ["showIssuer", dict.showIssuer],
                  ["showReference", dict.showReference],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={snap.settings.header[k]}
                    disabled={readOnly}
                    onChange={(e) =>
                      setSettings({ header: { ...snap.settings.header, [k]: e.target.checked } })
                    }
                  />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={snap.settings.footer.showPageNumbers}
                  disabled={readOnly}
                  onChange={(e) =>
                    setSettings({
                      footer: { ...snap.settings.footer, showPageNumbers: e.target.checked },
                    })
                  }
                />
                {dict.pageNumbers}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={snap.settings.numberClauses}
                  disabled={readOnly}
                  onChange={(e) => setSettings({ numberClauses: e.target.checked })}
                />
                {dict.numberClauses}
              </label>
              <label className="text-xs text-ink-muted">
                {dict.watermark}
                <select
                  value={snap.settings.watermark}
                  disabled={readOnly}
                  onChange={(e) =>
                    setSettings({ watermark: e.target.value as DocSettings["watermark"] })
                  }
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  {["none", "draft", "sample", "confidential"].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                {dict.footerText}
                <input
                  value={pick(snap.settings.footer.text)}
                  disabled={readOnly}
                  onChange={(e) =>
                    setSettings({
                      footer: {
                        ...snap.settings.footer,
                        text: {
                          ...(snap.settings.footer.text ?? {}),
                          [language === "ar" ? "ar" : "en"]: e.target.value,
                        },
                      },
                    })
                  }
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
              <label className="text-xs text-ink-muted">
                {dict.accent}
                <input
                  type="color"
                  value={snap.settings.accentColor ?? "#1a1a1a"}
                  disabled={readOnly}
                  onChange={(e) => setSettings({ accentColor: e.target.value })}
                  className="mt-1 h-11 w-20 rounded-md border border-line-strong bg-card"
                />
              </label>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

export type { SectionBlock };
