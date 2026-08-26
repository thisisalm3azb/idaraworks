"use client";

/**
 * RelationshipField — the reusable "pick a related record or create it here"
 * interaction (003C). A labelled select over ACTIVE records plus, when the
 * caller grants it, an "Add new" action that opens the platform Dialog with a
 * small create form — the parent form never navigates, so its state survives
 * untouched; the child form keeps its own state across validation failures.
 *
 * Platform owns the INTERACTION only. The caller (app layer) supplies:
 *  - the option list (server-fetched, already permission/redaction-safe);
 *  - a typed SERVER ACTION that runs the module's audited create command and
 *    returns {ok,id,label} | {ok:false,error,field?,correlationId?};
 *  - a declarative minimal field list and every translated string.
 * Domain validation stays in the module service behind the action — nothing
 * here touches a database or bakes in entity rules. Designed for reuse:
 * customer→quote/invoice, supplier→PO, item→MR/PO, team→employee.
 */
import { useMemo, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";

export type RelationshipOption = { id: string; label: string };

export type RelationshipCreateResult =
  | { ok: true; id: string; label: string }
  | { ok: false; error: string; field?: string; correlationId?: string };

export type RelationshipCreateField = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  dir?: "ltr" | "rtl";
  maxLength?: number;
  placeholder?: string;
};

export type RelationshipFieldLabels = {
  addNew: string;
  dialogTitle: string;
  dialogDescription?: string;
  create: string;
  cancel: string;
  close: string;
  /** Success announcement; "{name}" is replaced with the new record's label. */
  created: string;
  /** Near-match hint; "{name}" is replaced with the matching existing label. */
  similar: string;
  useExisting: string;
  reference: string;
  /** error code → translated message; "failed" is the required fallback. */
  errors: Record<string, string>;
};

export function RelationshipField({
  label,
  name,
  options,
  defaultValue,
  placeholder,
  canCreate,
  createAction,
  createFields,
  labels,
}: {
  label: string;
  /** Form field name the selected id is posted under. */
  name: string;
  options: RelationshipOption[];
  defaultValue?: string;
  placeholder: string;
  /** Server-computed permission — without it the add affordance never renders. */
  canCreate: boolean;
  createAction?: (formData: FormData) => Promise<RelationshipCreateResult>;
  createFields: RelationshipCreateField[];
  labels: RelationshipFieldLabels;
}) {
  const [extra, setExtra] = useState<RelationshipOption[]>([]);
  const [selected, setSelected] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ code: string; field?: string; ref?: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, startTransition] = useTransition();

  const all = useMemo(() => {
    const seen = new Set(options.map((o) => o.id));
    return [...options, ...extra.filter((o) => !seen.has(o.id))];
  }, [options, extra]);

  // Near-match hint on the FIRST create field (by convention the name field):
  // duplicates are often legal, so this offers — never blocks.
  const primary = createFields[0]?.name;
  const typedName = (primary ? (values[primary] ?? "") : "").trim().toLowerCase();
  const similar = useMemo(
    () =>
      typedName.length >= 2
        ? (all.find((o) => o.label.trim().toLowerCase() === typedName) ?? null)
        : null,
    [all, typedName],
  );

  const errMsg = (code: string) => labels.errors[code] ?? labels.errors.failed ?? code;

  function submitChild() {
    if (!createAction || pending) return;
    setError(null);
    const fd = new FormData();
    for (const f of createFields) fd.set(f.name, values[f.name] ?? "");
    startTransition(async () => {
      const res = await createAction(fd);
      if (!res.ok) {
        setError({ code: res.error, field: res.field, ref: res.correlationId });
        return; // child values retained; parent untouched
      }
      setExtra((xs) => [...xs, { id: res.id, label: res.label }]);
      setSelected(res.id);
      setAnnounce(labels.created.replace("{name}", res.label));
      setValues({});
      setOpen(false);
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${name}-select`} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <select
          id={`${name}-select`}
          name={name}
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setAnnounce("");
          }}
          className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-card px-3 py-2 text-base text-ink focus:border-brand"
        >
          <option value="">{placeholder}</option>
          {all.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {canCreate && createAction ? (
          <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
            {labels.addNew}
          </Button>
        ) : null}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cn("text-xs text-success", !announce && "sr-only")}
      >
        {announce}
      </p>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={labels.dialogTitle}
        description={labels.dialogDescription}
        closeLabel={labels.close}
      >
        <div className="flex flex-col gap-3">
          {error && !error.field ? (
            <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
              {errMsg(error.code)}
              {error.ref ? (
                <span className="mt-1 block text-xs text-danger/80">
                  {labels.reference}{" "}
                  <span dir="ltr" className="font-mono">
                    {error.ref}
                  </span>
                </span>
              ) : null}
            </p>
          ) : null}
          {similar ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft p-2.5 text-sm text-warning">
              <span>{labels.similar.replace("{name}", similar.label)}</span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSelected(similar.id);
                  setAnnounce("");
                  setOpen(false);
                }}
              >
                {labels.useExisting}
              </Button>
            </div>
          ) : null}
          {createFields.map((f) => (
            <Field
              key={f.name}
              label={f.label}
              type={f.type}
              required={f.required}
              dir={f.dir}
              maxLength={f.maxLength}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              error={error?.field === f.name ? errMsg(error.code) : undefined}
            />
          ))}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {labels.cancel}
            </Button>
            <Button type="button" onClick={submitChild} disabled={pending}>
              {labels.create}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
