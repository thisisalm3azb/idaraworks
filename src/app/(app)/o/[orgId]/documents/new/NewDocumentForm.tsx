"use client";

import { useState } from "react";
import { Button } from "@/platform/ui";

type Option = { id: string; label: string };
export type NewDocDict = {
  title: string;
  category: string;
  language: string;
  template: string;
  blank: string;
  counterparty: string;
  counterpartyNone: string;
  otherLabel: string;
  record: string;
  recordNone: string;
  expires: string;
  tags: string;
  folder: string;
  noFolder: string;
  create: string;
  kinds: Record<"customer" | "supplier" | "employee" | "other", string>;
  recordKinds: Record<"quote" | "invoice" | "job", string>;
};

const input =
  "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

export function NewDocumentForm({
  action,
  initialTemplate,
  templates,
  folders,
  categories,
  languages,
  counterparties,
  records,
  dict,
}: {
  action: (formData: FormData) => Promise<void>;
  initialTemplate: string;
  templates: Array<{ value: string; label: string; category: string; language: string }>;
  folders: Array<{ id: string; name: string }>;
  categories: Array<{ value: string; label: string }>;
  languages: Array<{ value: string; label: string }>;
  counterparties: Record<"customer" | "supplier" | "employee", Option[]>;
  records: Record<"quote" | "invoice" | "job", Option[]>;
  dict: NewDocDict;
}) {
  const [source, setSource] = useState(initialTemplate);
  const picked = templates.find((t) => t.value === source);
  const [category, setCategory] = useState(picked?.category ?? "other");
  const [language, setLanguage] = useState(picked?.language ?? "en");
  const [cpKind, setCpKind] = useState<"" | "customer" | "supplier" | "employee" | "other">("");
  const [recordType, setRecordType] = useState<"" | "quote" | "invoice" | "job">("");

  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-xs text-ink-muted sm:col-span-2">
        {dict.template}
        <select
          name="source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            const t = templates.find((x) => x.value === e.target.value);
            if (t) {
              setCategory(t.category);
              setLanguage(t.language);
            }
          }}
          className={input}
        >
          <option value="blank">{dict.blank}</option>
          {templates.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted sm:col-span-2">
        {dict.title}
        <input name="title" required maxLength={240} className={input} autoFocus />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.category}
        <select
          name="category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={input}
        >
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted">
        {dict.language}
        <select
          name="language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className={input}
        >
          {languages.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted">
        {dict.counterparty}
        <select
          name="counterpartyKind"
          value={cpKind}
          onChange={(e) => setCpKind(e.target.value as typeof cpKind)}
          className={input}
        >
          <option value="">{dict.counterpartyNone}</option>
          {(["customer", "supplier", "employee", "other"] as const).map((k) => (
            <option key={k} value={k}>
              {dict.kinds[k]}
            </option>
          ))}
        </select>
      </label>
      {cpKind === "other" ? (
        <label className="text-xs text-ink-muted">
          {dict.otherLabel}
          <input name="counterpartyLabel" maxLength={200} className={input} />
        </label>
      ) : cpKind ? (
        <label className="text-xs text-ink-muted">
          {dict.kinds[cpKind]}
          <select name="counterpartyId" required className={input}>
            {counterparties[cpKind].map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div />
      )}
      <label className="text-xs text-ink-muted">
        {dict.record}
        <select
          name="recordType"
          value={recordType}
          onChange={(e) => setRecordType(e.target.value as typeof recordType)}
          className={input}
        >
          <option value="">{dict.recordNone}</option>
          {(["quote", "invoice", "job"] as const)
            .filter((k) => records[k].length > 0)
            .map((k) => (
              <option key={k} value={k}>
                {dict.recordKinds[k]}
              </option>
            ))}
        </select>
      </label>
      {recordType ? (
        <label className="text-xs text-ink-muted">
          {dict.recordKinds[recordType]}
          <select name="recordId" required className={input}>
            {records[recordType].map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div />
      )}
      <label className="text-xs text-ink-muted">
        {dict.expires}
        <input name="expiresAt" type="date" className={input} />
      </label>
      <label className="text-xs text-ink-muted">
        {dict.folder}
        <select name="folderId" className={input} defaultValue="">
          <option value="">{dict.noFolder}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted sm:col-span-2">
        {dict.tags}
        <input name="tags" maxLength={400} className={input} />
      </label>
      <div className="sm:col-span-2">
        <Button type="submit">{dict.create}</Button>
      </div>
    </form>
  );
}
