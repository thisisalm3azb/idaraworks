"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field } from "@/platform/ui";
import { createMrAction, type MrCreatePayload } from "./actions";

type Line = { itemName: string; qty: number; unit: string; estUnitCostMinor?: number };
type Job = { id: string; reference: string };
export type MrDict = {
  title: string;
  job: string;
  urgency: string;
  urgency_low: string;
  urgency_normal: string;
  urgency_high: string;
  urgency_urgent: string;
  required_date: string;
  item: string;
  est_cost: string;
  add_line: string;
  notes: string;
  create: string;
  err_lines: string;
  err_failed: string;
};

export function MrForm({
  orgId,
  jobs,
  showCost,
  dict,
  dir,
}: {
  orgId: string;
  jobs: Job[];
  showCost: boolean;
  dict: MrDict;
  dir: "ltr" | "rtl";
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState("");
  const [urgency, setUrgency] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [requiredDate, setRequiredDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ itemName: "", qty: 1, unit: "pcs" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setLine(i: number, patch: Partial<Line>) {
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    const clean = lines.filter((l) => l.itemName.trim() && l.qty > 0);
    if (clean.length === 0) {
      setError(dict.err_lines);
      return;
    }
    setBusy(true);
    setError("");
    const payload: MrCreatePayload = {
      jobId: jobId || undefined,
      urgency,
      requiredDate: requiredDate || undefined,
      notes: notes.trim() || undefined,
      lines: clean.map((l) => ({
        itemName: l.itemName.trim(),
        qty: l.qty,
        unit: l.unit.trim() || "pcs",
        estUnitCostMinor: showCost ? l.estUnitCostMinor : undefined,
      })),
    };
    const res = await createMrAction(orgId, payload);
    if (res.ok) {
      router.push(`/o/${orgId}/material-requests/${res.id}`);
      return;
    }
    setBusy(false);
    setError(dict.err_failed);
  }

  return (
    <div className="flex flex-col gap-4" dir={dir}>
      <h1 className="text-lg font-semibold text-ink">{dict.title}</h1>
      {jobs.length > 0 ? (
        <Card>
          <label className="mb-1.5 block text-sm font-medium text-ink">{dict.job}</label>
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
        </Card>
      ) : null}

      <Card>
        <label className="mb-1.5 block text-sm font-medium text-ink">{dict.urgency}</label>
        <div className="flex flex-wrap gap-2">
          {(["low", "normal", "high", "urgent"] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUrgency(u)}
              className={`min-h-11 rounded-full border px-3 text-sm ${
                urgency === u
                  ? "border-brand bg-brand text-ink-inverse"
                  : "border-line-strong bg-card text-ink"
              }`}
            >
              {dict[`urgency_${u}`]}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <Field
            label={dict.required_date}
            type="date"
            value={requiredDate}
            onChange={(e) => setRequiredDate(e.target.value)}
          />
        </div>
      </Card>

      <Card>
        <label className="mb-2 block text-sm font-medium text-ink">{dict.item}</label>
        {lines.map((l, i) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
            <input
              value={l.itemName}
              onChange={(e) => setLine(i, { itemName: e.target.value })}
              placeholder={dict.item}
              className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            />
            <input
              type="number"
              inputMode="decimal"
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
            {showCost ? (
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={l.estUnitCostMinor ?? ""}
                onChange={(e) =>
                  setLine(i, { estUnitCostMinor: Number(e.target.value) || undefined })
                }
                placeholder={dict.est_cost}
                className="min-h-11 w-24 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
              />
            ) : null}
          </div>
        ))}
        <Button
          variant="secondary"
          type="button"
          onClick={() => setLines((p) => [...p, { itemName: "", qty: 1, unit: "pcs" }])}
        >
          {dict.add_line}
        </Button>
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
