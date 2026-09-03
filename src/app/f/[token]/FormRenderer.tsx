"use client";

/**
 * The public form: the snapshot's party-filled fields, kind-aware inputs,
 * conditional sections evaluated as the person types, and one submit.
 */
import { useMemo, useState } from "react";
import { evaluateConditions, type Condition } from "@/platform/rules/conditions";
import type { Locale } from "@/platform/registries";

type LocaleText = { en?: string; ar?: string };
export type FormField = {
  id: string;
  key: string;
  kind: string;
  label: LocaleText;
  help?: LocaleText;
  required: boolean;
  options?: LocaleText[];
  currency?: string;
  min?: number;
  max?: number;
  condition?: Condition;
  /** The enclosing conditional section, when any. */
  sectionCondition?: Condition;
  sectionTitle?: LocaleText;
};

const pickText = (lang: Locale, t?: LocaleText) =>
  (lang === "ar" ? (t?.ar ?? t?.en) : (t?.en ?? t?.ar)) ?? "";

export type FormDict = {
  submit: string;
  name: string;
  email: string;
  required: string;
  problems: Record<string, string>;
};

export function FormRenderer({
  action,
  fields,
  lang,
  dict,
  problems,
  initial,
}: {
  action: (formData: FormData) => Promise<void>;
  fields: FormField[];
  lang: Locale;
  dict: FormDict;
  problems: Record<string, string>;
  initial: Record<string, string>;
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean | null>>(() => {
    const v: Record<string, string | number | boolean | null> = {};
    for (const [k, val] of Object.entries(initial)) v[k] = val;
    return v;
  });
  const pick = (t?: LocaleText) => pickText(lang, t);
  const rows = useMemo(() => {
    const cv = { bindings: {}, variables: values };
    const out: Array<{ f: FormField; section?: string; showHeading: boolean }> = [];
    let last: string | undefined;
    for (const f of fields) {
      const shown =
        (!f.sectionCondition || evaluateConditions(f.sectionCondition, cv)) &&
        (!f.condition || evaluateConditions(f.condition, cv));
      if (!shown) continue;
      const section = f.sectionTitle ? pickText(lang, f.sectionTitle) : undefined;
      const showHeading = Boolean(section && section !== last);
      last = section;
      out.push({ f, section, showHeading });
    }
    return out;
  }, [fields, values, lang]);
  const set = (key: string, v: string | number | boolean | null) =>
    setValues((s) => ({ ...s, [key]: v }));
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-white px-3 text-base text-ink";

  return (
    <form action={action} className="flex flex-col gap-3" dir={lang === "ar" ? "rtl" : "ltr"}>
      <label className="text-xs text-ink-muted">
        {dict.name}
        <input name="__name" maxLength={200} className={input} />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.email}
        <input name="__email" type="email" maxLength={320} className={input} />
      </label>
      {rows.map(({ f, section, showHeading }) => {
        const label = `${pick(f.label)}${f.required ? " *" : ""}`;
        const err = problems[f.key] ? (dict.problems[problems[f.key]!] ?? problems[f.key]) : null;
        const v = values[f.key];
        return (
          <div key={f.id} className="flex flex-col gap-1">
            {showHeading ? (
              <h3 className="mt-2 text-sm font-semibold text-ink">{section}</h3>
            ) : null}
            {f.kind === "checkbox" ? (
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name={f.key}
                  checked={Boolean(v)}
                  onChange={(e) => set(f.key, e.target.checked)}
                  className="mt-1"
                />
                <span>{label}</span>
              </label>
            ) : f.kind === "choice" ? (
              <label className="text-xs text-ink-muted">
                {label}
                <select
                  name={f.key}
                  value={v === null || v === undefined ? "" : String(v)}
                  onChange={(e) =>
                    set(f.key, e.target.value === "" ? null : Number(e.target.value))
                  }
                  className={input}
                >
                  <option value="">–</option>
                  {(f.options ?? []).map((o, i) => (
                    <option key={i} value={i}>
                      {pick(o)}
                    </option>
                  ))}
                </select>
              </label>
            ) : f.kind === "textarea" ? (
              <label className="text-xs text-ink-muted">
                {label}
                <textarea
                  name={f.key}
                  rows={4}
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={`${input} py-2`}
                />
              </label>
            ) : (
              <label className="text-xs text-ink-muted">
                {label}
                {f.kind === "money" ? ` (${f.currency ?? "AED"})` : ""}
                <input
                  name={f.key}
                  type={
                    f.kind === "number" || f.kind === "money"
                      ? "number"
                      : f.kind === "date"
                        ? "date"
                        : f.kind === "email"
                          ? "email"
                          : f.kind === "phone"
                            ? "tel"
                            : "text"
                  }
                  step={f.kind === "money" ? "0.01" : undefined}
                  min={f.min}
                  max={f.max}
                  value={v === null || v === undefined ? "" : String(v)}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={input}
                />
              </label>
            )}
            {f.help && pick(f.help) ? (
              <p className="text-xs text-ink-muted">{pick(f.help)}</p>
            ) : null}
            {err ? <p className="text-xs text-danger">{err}</p> : null}
          </div>
        );
      })}
      <button
        type="submit"
        className="min-h-12 rounded-md bg-brand px-6 text-base font-medium text-ink-inverse"
      >
        {dict.submit}
      </button>
    </form>
  );
}
