"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { createPoAction, type PoCreatePayload } from "./actions";

type Line = { itemId: string; itemName: string; qty: number; unit: string; unitCostMinor: number };
type Supplier = { id: string; name: string };
/** A catalogue item an order line can name instead of describing in free text. */
export type PickableItem = { id: string; sku: string; name: string; unit: string };
type Job = { id: string; reference: string };
export type PoDict = {
  title: string;
  supplier: string;
  job: string;
  add_line: string;
  item: string;
  item_free_text: string;
  item_pick: string;
  unit_cost: string;
  vat: string;
  notes: string;
  create: string;
  err_supplier: string;
  err_lines: string;
  err_failed: string;
};

export function PoForm({
  orgId,
  suppliers,
  jobs,
  items,
  dict,
  dir,
}: {
  orgId: string;
  suppliers: Supplier[];
  jobs: Job[];
  /**
   * The catalogue. Empty for an organization that keeps none, in which case the
   * form behaves exactly as it always did — free text only.
   */
  items: PickableItem[];
  dict: PoDict;
  dir: "ltr" | "rtl";
}) {
  const router = useRouter();
  const [supplierId, setSupplierId] = useState("");
  const [jobId, setJobId] = useState("");
  const [vat, setVat] = useState(0);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { itemId: "", itemName: "", qty: 1, unit: "pcs", unitCostMinor: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setLine(i: number, patch: Partial<Line>) {
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (!supplierId) {
      setError(dict.err_supplier);
      return;
    }
    const clean = lines.filter((l) => l.itemName.trim() && l.qty > 0);
    if (clean.length === 0) {
      setError(dict.err_lines);
      return;
    }
    setBusy(true);
    setError("");
    const payload: PoCreatePayload = {
      supplierId,
      jobId: jobId || undefined,
      vatMinor: vat || 0,
      notes: notes.trim() || undefined,
      lines: clean.map((l) => ({
        // The id is what makes a receipt against this line able to become
        // stock. Without it the line is a description of something bought, and
        // the warehouse never hears about it.
        itemId: l.itemId || undefined,
        itemName: l.itemName.trim(),
        qty: l.qty,
        unit: l.unit.trim() || "pcs",
        unitCostMinor: l.unitCostMinor || 0,
      })),
    };
    const res = await createPoAction(orgId, payload);
    if (res.ok) {
      router.push(`/o/${orgId}/purchase-orders/${res.id}`);
      return;
    }
    setBusy(false);
    setError(dict.err_failed);
  }

  return (
    <div className="flex flex-col gap-4" dir={dir}>
      <h1 className="text-lg font-semibold text-ink">{dict.title}</h1>
      <Card>
        <label className="mb-1.5 block text-sm font-medium text-ink">{dict.supplier}</label>
        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
        >
          <option value="">—</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {jobs.length > 0 ? (
          <>
            <label className="mb-1.5 mt-3 block text-sm font-medium text-ink">{dict.job}</label>
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              <option value="">—</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.reference}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </Card>

      <Card>
        <label className="mb-2 block text-sm font-medium text-ink">{dict.add_line}</label>
        {lines.map((l, i) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
            {/*
             * Pick from the catalogue, or describe it.
             *
             * Both are real: a business orders catalogue stock AND one-off
             * things that will never be an item. Only the first can become
             * stock, so choosing an item fills the name and unit from the
             * catalogue and the free-text box steps aside.
             */}
            {items.length > 0 ? (
              <select
                value={l.itemId}
                aria-label={dict.item_pick}
                onChange={(e) => {
                  const picked = items.find((it) => it.id === e.target.value);
                  setLine(
                    i,
                    picked
                      ? { itemId: picked.id, itemName: picked.name, unit: picked.unit }
                      : { itemId: "", itemName: "" },
                  );
                }}
                className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                <option value="">{dict.item_free_text}</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} — {it.name}
                  </option>
                ))}
              </select>
            ) : null}
            {l.itemId === "" ? (
              <input
                value={l.itemName}
                onChange={(e) => setLine(i, { itemName: e.target.value })}
                placeholder={dict.item}
                aria-label={dict.item}
                className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            ) : null}
            <input
              type="number"
              min={0}
              value={l.qty}
              onChange={(e) => setLine(i, { qty: Number(e.target.value) })}
              className="min-h-11 w-16 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
            <input
              value={l.unit}
              onChange={(e) => setLine(i, { unit: e.target.value })}
              className="min-h-11 w-16 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
            <input
              type="number"
              min={0}
              value={l.unitCostMinor}
              onChange={(e) => setLine(i, { unitCostMinor: Number(e.target.value) || 0 })}
              placeholder={dict.unit_cost}
              className="min-h-11 w-24 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
          </div>
        ))}
        <Button
          variant="secondary"
          type="button"
          onClick={() =>
            setLines((p) => [
              ...p,
              { itemId: "", itemName: "", qty: 1, unit: "pcs", unitCostMinor: 0 },
            ])
          }
        >
          {dict.add_line}
        </Button>
        <div className="mt-3 flex items-center gap-2">
          <label className="text-sm text-ink">{dict.vat}</label>
          <input
            type="number"
            min={0}
            value={vat}
            onChange={(e) => setVat(Number(e.target.value) || 0)}
            className="min-h-11 w-28 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
          />
        </div>
      </Card>

      <Card>
        <label className="mb-1.5 block text-sm font-medium text-ink">{dict.notes}</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-line-strong bg-card p-3 text-base text-ink"
        />
      </Card>

      {error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}
      <Button size="lg" onClick={submit} disabled={busy}>
        {dict.create}
      </Button>
    </div>
  );
}
