"use client";

import type { Block, Condition, LocaleText } from "@/modules/docstudio/service";

/** The closed vocabularies, handed in by the server page (client bundles import only types from the door). */
export type Vocabulary = {
  blockTypes: readonly Block["type"][];
  fieldKinds: readonly string[];
  bindingPaths: readonly string[];
  conditionOps: readonly string[];
  signatureParts: readonly string[];
};

export type BlockEditorDict = {
  textEn: string;
  textAr: string;
  titleEn: string;
  titleAr: string;
  level: string;
  listStyle: string;
  bullet: string;
  numbered: string;
  items: string;
  addItem: string;
  columns: string;
  rows: string;
  addRow: string;
  addColumn: string;
  removeRow: string;
  source: string;
  manual: string;
  currency: string;
  description: string;
  qty: string;
  unit: string;
  unitPrice: string;
  vat: string;
  showVat: string;
  showTotals: string;
  fieldKey: string;
  fieldKind: string;
  label: string;
  required: string;
  options: string;
  computed: string;
  filledBy: string;
  author: string;
  party: string;
  bindingPath: string;
  format: string;
  parts: string;
  tone: string;
  info: string;
  warning: string;
  widthPct: string;
  align: string;
  condition: string;
  conditionNone: string;
  conditionKey: string;
  conditionOp: string;
  conditionValue: string;
  kinds: Record<string, string>;
};

type Lang = "en" | "ar" | "bilingual";
const input =
  "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink disabled:bg-sunken";
const area =
  "mt-1 w-full rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink disabled:bg-sunken";

function LocaleTextInput({
  value,
  onChange,
  language,
  readOnly,
  dict,
  multiline,
  labelEn,
  labelAr,
}: {
  value: LocaleText | undefined;
  onChange: (v: LocaleText) => void;
  language: Lang;
  readOnly: boolean;
  dict: BlockEditorDict;
  multiline?: boolean;
  labelEn?: string;
  labelAr?: string;
}) {
  const langs = language === "bilingual" ? (["ar", "en"] as const) : ([language] as const);
  return (
    <>
      {langs.map((l) => (
        <label key={l} className="text-xs text-ink-muted">
          {l === "en" ? (labelEn ?? dict.textEn) : (labelAr ?? dict.textAr)}
          {multiline ? (
            <textarea
              value={value?.[l] ?? ""}
              disabled={readOnly}
              rows={4}
              dir={l === "ar" ? "rtl" : "ltr"}
              lang={l}
              onChange={(e) => onChange({ ...(value ?? {}), [l]: e.target.value })}
              className={area}
            />
          ) : (
            <input
              value={value?.[l] ?? ""}
              disabled={readOnly}
              dir={l === "ar" ? "rtl" : "ltr"}
              lang={l}
              onChange={(e) => onChange({ ...(value ?? {}), [l]: e.target.value })}
              className={input}
            />
          )}
        </label>
      ))}
    </>
  );
}

function ConditionEditor({
  value,
  onChange,
  readOnly,
  dict,
  fieldKeys,
  vocab,
}: {
  value: Condition | undefined;
  onChange: (c: Condition | undefined) => void;
  readOnly: boolean;
  dict: BlockEditorDict;
  fieldKeys: string[];
  vocab: Vocabulary;
}) {
  const leaf = value && "key" in value ? value : null;
  const keys = [
    ...fieldKeys,
    "document.amount",
    "document.category",
    "document.language",
    "document.counterparty_kind",
    "counterparty.country",
  ];
  return (
    <fieldset className="rounded-md border border-line p-2">
      <legend className="px-1 text-xs text-ink-muted">{dict.condition}</legend>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={leaf !== null}
          disabled={readOnly}
          onChange={(e) =>
            onChange(
              e.target.checked ? { key: keys[0] ?? "document.amount", op: "not_empty" } : undefined,
            )
          }
        />
        {leaf ? dict.condition : dict.conditionNone}
      </label>
      {leaf ? (
        <div className="mt-1 grid grid-cols-1 gap-1">
          <label className="text-xs text-ink-muted">
            {dict.conditionKey}
            <input
              list="ds-condition-keys"
              value={leaf.key}
              disabled={readOnly}
              onChange={(e) => onChange({ ...leaf, key: e.target.value })}
              className={input}
            />
            <datalist id="ds-condition-keys">
              {keys.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.conditionOp}
            <select
              value={leaf.op}
              disabled={readOnly}
              onChange={(e) =>
                onChange({
                  ...leaf,
                  op: e.target.value as Condition extends { op: infer O } ? O : never,
                })
              }
              className={input}
            >
              {vocab.conditionOps.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          {!["empty", "not_empty", "truthy"].includes(leaf.op) ? (
            <label className="text-xs text-ink-muted">
              {dict.conditionValue}
              <input
                value={Array.isArray(leaf.value) ? leaf.value.join(",") : String(leaf.value ?? "")}
                disabled={readOnly}
                onChange={(e) => {
                  const raw = e.target.value;
                  const v =
                    leaf.op === "in"
                      ? raw
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean)
                      : raw !== "" && !Number.isNaN(Number(raw))
                        ? Number(raw)
                        : raw;
                  onChange({ ...leaf, value: v });
                }}
                className={input}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

export function BlockEditor({
  block,
  language,
  readOnly,
  dict,
  bindings,
  fieldKeys,
  vocab,
  onChange,
}: {
  block: Block;
  language: Lang;
  readOnly: boolean;
  dict: BlockEditorDict;
  bindings: Record<string, string>;
  fieldKeys: string[];
  vocab: Vocabulary;
  onChange: (patch: Partial<Block>) => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange(patch as Partial<Block>);
  const body = (() => {
    switch (block.type) {
      case "heading":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.level}
              <select
                value={block.level}
                disabled={readOnly}
                onChange={(e) => set({ level: Number(e.target.value) })}
                className={input}
              >
                {[1, 2, 3].map((l) => (
                  <option key={l} value={l}>
                    H{l}
                  </option>
                ))}
              </select>
            </label>
            <LocaleTextInput
              value={block.text}
              onChange={(text) => set({ text })}
              language={language}
              readOnly={readOnly}
              dict={dict}
            />
          </>
        );
      case "paragraph":
        return (
          <LocaleTextInput
            value={block.text}
            onChange={(text) => set({ text })}
            language={language}
            readOnly={readOnly}
            dict={dict}
            multiline
          />
        );
      case "note":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.tone}
              <select
                value={block.tone}
                disabled={readOnly}
                onChange={(e) => set({ tone: e.target.value })}
                className={input}
              >
                <option value="info">{dict.info}</option>
                <option value="warning">{dict.warning}</option>
              </select>
            </label>
            <LocaleTextInput
              value={block.text}
              onChange={(text) => set({ text })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              multiline
            />
          </>
        );
      case "clause":
        return (
          <>
            <LocaleTextInput
              value={block.title}
              onChange={(title) => set({ title })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              labelEn={dict.titleEn}
              labelAr={dict.titleAr}
            />
            <LocaleTextInput
              value={block.text}
              onChange={(text) => set({ text })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              multiline
            />
          </>
        );
      case "list":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.listStyle}
              <select
                value={block.style}
                disabled={readOnly}
                onChange={(e) => set({ style: e.target.value })}
                className={input}
              >
                <option value="bullet">{dict.bullet}</option>
                <option value="number">{dict.numbered}</option>
              </select>
            </label>
            <span className="text-xs text-ink-muted">{dict.items}</span>
            {block.items.map((it, i) => (
              <div key={i} className="flex items-end gap-1">
                <div className="flex-1">
                  <LocaleTextInput
                    value={it}
                    onChange={(v) => set({ items: block.items.map((x, j) => (j === i ? v : x)) })}
                    language={language}
                    readOnly={readOnly}
                    dict={dict}
                  />
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    aria-label={dict.removeRow}
                    onClick={() => set({ items: block.items.filter((_, j) => j !== i) })}
                    className="min-h-11 px-2 text-ink-muted hover:text-danger"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            {!readOnly ? (
              <button
                type="button"
                onClick={() =>
                  set({ items: [...block.items, language === "ar" ? { ar: " " } : { en: " " }] })
                }
                className="min-h-9 self-start rounded-md border border-line px-2 text-xs text-ink-secondary hover:bg-sunken"
              >
                + {dict.addItem}
              </button>
            ) : null}
          </>
        );
      case "table":
        return (
          <>
            <span className="text-xs text-ink-muted">{dict.columns}</span>
            {block.columns.map((c, i) => (
              <LocaleTextInput
                key={i}
                value={c}
                onChange={(v) => set({ columns: block.columns.map((x, j) => (j === i ? v : x)) })}
                language={language}
                readOnly={readOnly}
                dict={dict}
              />
            ))}
            {!readOnly ? (
              <button
                type="button"
                onClick={() =>
                  set({
                    columns: [...block.columns, { en: " " }],
                    rows: block.rows.map((r) => [...r, { en: " " }]),
                  })
                }
                className="min-h-9 self-start rounded-md border border-line px-2 text-xs text-ink-secondary hover:bg-sunken"
              >
                + {dict.addColumn}
              </button>
            ) : null}
            <span className="text-xs text-ink-muted">{dict.rows}</span>
            {block.rows.map((r, ri) => (
              <div key={ri} className="flex flex-col gap-1 rounded-md border border-line p-2">
                {r.map((c, ci) => (
                  <LocaleTextInput
                    key={ci}
                    value={c}
                    onChange={(v) =>
                      set({
                        rows: block.rows.map((row, i) =>
                          i === ri ? row.map((x, j) => (j === ci ? v : x)) : row,
                        ),
                      })
                    }
                    language={language}
                    readOnly={readOnly}
                    dict={dict}
                  />
                ))}
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => set({ rows: block.rows.filter((_, i) => i !== ri) })}
                    className="min-h-9 self-start text-xs text-danger"
                  >
                    {dict.removeRow}
                  </button>
                ) : null}
              </div>
            ))}
            {!readOnly ? (
              <button
                type="button"
                onClick={() =>
                  set({ rows: [...block.rows, block.columns.map(() => ({ en: " " }))] })
                }
                className="min-h-9 self-start rounded-md border border-line px-2 text-xs text-ink-secondary hover:bg-sunken"
              >
                + {dict.addRow}
              </button>
            ) : null}
          </>
        );
      case "line_items":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.source}
              <select
                value={block.source}
                disabled={readOnly}
                onChange={(e) => set({ source: e.target.value })}
                className={input}
              >
                <option value="manual">{dict.manual}</option>
                <option value="quote">quote</option>
                <option value="invoice">invoice</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {dict.currency}
              <input
                value={block.currency}
                disabled={readOnly}
                maxLength={3}
                onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
                className={input}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={block.showVat}
                disabled={readOnly}
                onChange={(e) => set({ showVat: e.target.checked })}
              />
              {dict.showVat}
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={block.showTotals}
                disabled={readOnly}
                onChange={(e) => set({ showTotals: e.target.checked })}
              />
              {dict.showTotals}
            </label>
            {block.source === "manual"
              ? block.items.map((it, i) => (
                  <div key={i} className="flex flex-col gap-1 rounded-md border border-line p-2">
                    <LocaleTextInput
                      value={it.description}
                      onChange={(v) =>
                        set({
                          items: block.items.map((x, j) =>
                            j === i ? { ...x, description: v } : x,
                          ),
                        })
                      }
                      language={language}
                      readOnly={readOnly}
                      dict={dict}
                      labelEn={dict.description}
                      labelAr={dict.description}
                    />
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                      <label className="text-xs text-ink-muted">
                        {dict.qty}
                        <input
                          type="number"
                          value={it.qty}
                          disabled={readOnly}
                          onChange={(e) =>
                            set({
                              items: block.items.map((x, j) =>
                                j === i ? { ...x, qty: Number(e.target.value) } : x,
                              ),
                            })
                          }
                          className={input}
                        />
                      </label>
                      <label className="text-xs text-ink-muted">
                        {dict.unit}
                        <input
                          value={it.unit ?? ""}
                          disabled={readOnly}
                          onChange={(e) =>
                            set({
                              items: block.items.map((x, j) =>
                                j === i ? { ...x, unit: e.target.value } : x,
                              ),
                            })
                          }
                          className={input}
                        />
                      </label>
                      <label className="text-xs text-ink-muted">
                        {dict.unitPrice}
                        <input
                          type="number"
                          step="0.01"
                          value={it.unitPriceMinor / 100}
                          disabled={readOnly}
                          onChange={(e) =>
                            set({
                              items: block.items.map((x, j) =>
                                j === i
                                  ? {
                                      ...x,
                                      unitPriceMinor: Math.round(Number(e.target.value) * 100),
                                    }
                                  : x,
                              ),
                            })
                          }
                          className={input}
                        />
                      </label>
                      <label className="text-xs text-ink-muted">
                        {dict.vat} %
                        <input
                          type="number"
                          value={it.vatRate}
                          disabled={readOnly}
                          onChange={(e) =>
                            set({
                              items: block.items.map((x, j) =>
                                j === i ? { ...x, vatRate: Number(e.target.value) } : x,
                              ),
                            })
                          }
                          className={input}
                        />
                      </label>
                    </div>
                    {!readOnly ? (
                      <button
                        type="button"
                        onClick={() => set({ items: block.items.filter((_, j) => j !== i) })}
                        className="min-h-9 self-start text-xs text-danger"
                      >
                        {dict.removeRow}
                      </button>
                    ) : null}
                  </div>
                ))
              : null}
            {block.source === "manual" && !readOnly ? (
              <button
                type="button"
                onClick={() =>
                  set({
                    items: [
                      ...block.items,
                      { description: { en: " " }, qty: 1, unit: "", unitPriceMinor: 0, vatRate: 5 },
                    ],
                  })
                }
                className="min-h-9 self-start rounded-md border border-line px-2 text-xs text-ink-secondary hover:bg-sunken"
              >
                + {dict.addRow}
              </button>
            ) : null}
          </>
        );
      case "field":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.fieldKey}
              <input
                value={block.key}
                disabled={readOnly}
                onChange={(e) =>
                  set({
                    key: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_]/g, "_")
                      .slice(0, 40),
                  })
                }
                className={`${input} font-mono`}
              />
            </label>
            <label className="text-xs text-ink-muted">
              {dict.fieldKind}
              <select
                value={block.kind}
                disabled={readOnly}
                onChange={(e) => set({ kind: e.target.value })}
                className={input}
              >
                {vocab.fieldKinds.map((k) => (
                  <option key={k} value={k}>
                    {dict.kinds[k] ?? k}
                  </option>
                ))}
              </select>
            </label>
            <LocaleTextInput
              value={block.label}
              onChange={(label) => set({ label })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              labelEn={`${dict.label} (EN)`}
              labelAr={`${dict.label} (AR)`}
            />
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={block.required}
                disabled={readOnly}
                onChange={(e) => set({ required: e.target.checked })}
              />
              {dict.required}
            </label>
            {block.kind === "choice" ? (
              <label className="text-xs text-ink-muted">
                {dict.options}
                <textarea
                  value={(block.options ?? [])
                    .map((o) => (language === "ar" ? (o.ar ?? o.en) : (o.en ?? o.ar)) ?? "")
                    .join("\n")}
                  disabled={readOnly}
                  rows={3}
                  onChange={(e) =>
                    set({
                      options: e.target.value
                        .split("\n")
                        .filter((x) => x.trim() !== "")
                        .map((x) =>
                          language === "ar"
                            ? { ar: x }
                            : language === "bilingual"
                              ? { en: x, ar: x }
                              : { en: x },
                        ),
                    })
                  }
                  className={area}
                />
              </label>
            ) : null}
            {block.kind === "money" ? (
              <label className="text-xs text-ink-muted">
                {dict.currency}
                <input
                  value={block.currency ?? "AED"}
                  disabled={readOnly}
                  maxLength={3}
                  onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
                  className={input}
                />
              </label>
            ) : null}
            {block.kind === "number" || block.kind === "money" ? (
              <label className="text-xs text-ink-muted">
                {dict.computed}
                <input
                  value={block.computed ?? ""}
                  disabled={readOnly}
                  placeholder="qty * price"
                  onChange={(e) => set({ computed: e.target.value || undefined })}
                  className={`${input} font-mono`}
                />
              </label>
            ) : null}
            <label className="text-xs text-ink-muted">
              {dict.filledBy}
              <select
                value={block.filledBy}
                disabled={readOnly}
                onChange={(e) => set({ filledBy: e.target.value })}
                className={input}
              >
                <option value="author">{dict.author}</option>
                <option value="party">{dict.party}</option>
              </select>
            </label>
            {block.filledBy === "party" ? (
              <label className="text-xs text-ink-muted">
                {dict.party}
                <input
                  value={block.party ?? ""}
                  disabled={readOnly}
                  onChange={(e) => set({ party: e.target.value })}
                  className={input}
                />
              </label>
            ) : null}
          </>
        );
      case "binding":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.bindingPath}
              <select
                value={block.path}
                disabled={readOnly}
                onChange={(e) => set({ path: e.target.value })}
                className={input}
              >
                {vocab.bindingPaths.map((p) => (
                  <option key={p} value={p}>
                    {bindings[p] ?? p}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {dict.format}
              <select
                value={block.format}
                disabled={readOnly}
                onChange={(e) => set({ format: e.target.value })}
                className={input}
              >
                {["text", "money", "date"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <LocaleTextInput
              value={block.label}
              onChange={(label) => set({ label })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              labelEn={`${dict.label} (EN)`}
              labelAr={`${dict.label} (AR)`}
            />
          </>
        );
      case "signature":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.party}
              <input
                value={block.party}
                disabled={readOnly}
                onChange={(e) => set({ party: e.target.value })}
                className={input}
              />
            </label>
            <LocaleTextInput
              value={block.label}
              onChange={(label) => set({ label })}
              language={language}
              readOnly={readOnly}
              dict={dict}
              labelEn={`${dict.label} (EN)`}
              labelAr={`${dict.label} (AR)`}
            />
            <span className="text-xs text-ink-muted">{dict.parts}</span>
            {vocab.signatureParts.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={(block.parts as readonly string[]).includes(p)}
                  disabled={readOnly}
                  onChange={(e) =>
                    set({
                      parts: e.target.checked
                        ? [...block.parts, p as (typeof block.parts)[number]]
                        : block.parts.filter((x) => x !== p),
                    })
                  }
                />
                {p}
              </label>
            ))}
          </>
        );
      case "image":
        return (
          <>
            <label className="text-xs text-ink-muted">
              {dict.widthPct}
              <input
                type="number"
                min={10}
                max={100}
                value={block.widthPct}
                disabled={readOnly}
                onChange={(e) => set({ widthPct: Number(e.target.value) })}
                className={input}
              />
            </label>
            <label className="text-xs text-ink-muted">
              {dict.align}
              <select
                value={block.align}
                disabled={readOnly}
                onChange={(e) => set({ align: e.target.value })}
                className={input}
              >
                {["start", "center", "end"].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </>
        );
      case "section":
        return (
          <LocaleTextInput
            value={block.title}
            onChange={(title) => set({ title })}
            language={language}
            readOnly={readOnly}
            dict={dict}
            labelEn={dict.titleEn}
            labelAr={dict.titleAr}
          />
        );
      case "page_break":
        return null;
    }
  })();

  return (
    <div className="flex flex-col gap-2">
      {body}
      <ConditionEditor
        value={block.condition}
        onChange={(condition) => set({ condition })}
        readOnly={readOnly}
        dict={dict}
        fieldKeys={fieldKeys}
        vocab={vocab}
      />
    </div>
  );
}
