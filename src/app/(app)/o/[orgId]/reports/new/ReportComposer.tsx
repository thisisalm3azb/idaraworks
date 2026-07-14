"use client";

/**
 * The foreman's daily-report composer (doc 01 D-1.5; BUILD_BIBLE P1 phone-first).
 * One thumb, choice chips, minimal typing. OFFLINE-TOLERANT: the whole draft +
 * a stable idempotency key persist in localStorage, so a reload or a lost signal
 * never loses work, and a retry is exactly-once server-side (the key). This is
 * not a service-worker background-sync outbox (a later enhancement) — it is the
 * data-loss-proof, safe-retry core the P1 rule demands.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field } from "@/platform/ui";
import { submitReportAction, type ReportSubmitPayload } from "../actions";

type Crew = { id: string; name: string };
type Item = { id: string; sku: string; name: string; unit: string };
type Stage = { stageKey: string; label: string };
type LabourRow = { employeeId: string; name: string; normalHours: number; otHours: number };
type MaterialRow = { itemId?: string; itemName: string; qty: number; unit: string };
type WorkRow = { stageKey?: string; description: string; progressNote?: string };

export type ComposerDict = {
  new_title: string;
  date: string;
  summary: string;
  work: string;
  work_description: string;
  labour: string;
  normal_hours: string;
  ot_hours: string;
  materials: string;
  materials_search: string;
  materials_free: string;
  blockers: string;
  add: string;
  remove: string;
  submit: string;
  submitting: string;
  retry: string;
  saved_offline: string;
  draft_restored: string;
  err_duplicate: string;
  err_identity: string;
  err_invalid: string;
  err_failed: string;
};

export type ReportInitial = {
  reportDate: string;
  summary: string;
  blockers: string;
  work: WorkRow[];
  labour: LabourRow[];
  materials: MaterialRow[];
};

// The idempotency key is DETERMINISTIC per (job, date) — NOT a random per-draft
// value (review finding C). That makes the first submit and every re-edit of a
// RETURNED report present the SAME key, so saveReport resolves the existing report
// and updates it in place instead of colliding on the (job, date) unique. It also
// makes offline retries exactly-once without needing to persist a key.
function keyFor(jobId: string, reportDate: string): string {
  return `dr:${jobId}:${reportDate}`;
}

export function ReportComposer({
  orgId,
  jobId,
  jobLabel,
  today,
  crew,
  items,
  stages,
  dict,
  dir,
  initial,
}: {
  orgId: string;
  jobId: string;
  jobLabel: string;
  today: string;
  crew: Crew[];
  items: Item[];
  stages: Stage[];
  dict: ComposerDict;
  dir: "ltr" | "rtl";
  initial?: ReportInitial;
}) {
  const router = useRouter();
  const draftKey = `iw:report-draft:${orgId}:${jobId}`;

  const [reportDate, setReportDate] = useState(initial?.reportDate ?? today);
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [blockers, setBlockers] = useState(initial?.blockers ?? "");
  const [labour, setLabour] = useState<LabourRow[]>(initial?.labour ?? []);
  const [materials, setMaterials] = useState<MaterialRow[]>(initial?.materials ?? []);
  const [work, setWork] = useState<WorkRow[]>(initial?.work ?? []);
  const [itemQuery, setItemQuery] = useState("");
  const [freeMaterial, setFreeMaterial] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "offline" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [restored, setRestored] = useState(false);

  // Restore an offline draft on mount — UNLESS the page seeded `initial` from a
  // server report (a returned-report re-edit, which is authoritative). This MUST
  // be an effect, not a useState initializer: localStorage doesn't exist during
  // SSR, so reading it at init would break hydration. A one-time mount restore is
  // the documented-acceptable effect (external-store read).
  useEffect(() => {
    if (initial) return; // server content wins over a stale local draft
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        setReportDate(d.reportDate ?? today);
        setSummary(d.summary ?? "");
        setBlockers(d.blockers ?? "");
        setLabour(Array.isArray(d.labour) ? d.labour : []);
        setMaterials(Array.isArray(d.materials) ? d.materials : []);
        setWork(Array.isArray(d.work) ? d.work : []);
        if (d.summary || d.labour?.length || d.materials?.length) setRestored(true);
      }
    } catch {
      /* corrupt draft — ignore, start fresh */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the draft on every change (the key is derived, so it isn't stored).
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ reportDate, summary, blockers, labour, materials, work }),
      );
    } catch {
      /* storage full / disabled — the in-memory form still works */
    }
  }, [draftKey, reportDate, summary, blockers, labour, materials, work]);

  const filteredItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    if (!q) return items.slice(0, 8);
    return items
      .filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q))
      .slice(0, 8);
  }, [items, itemQuery]);

  const inLabour = (id: string) => labour.some((l) => l.employeeId === id);
  function toggleCrew(c: Crew) {
    setLabour((prev) =>
      inLabour(c.id)
        ? prev.filter((l) => l.employeeId !== c.id)
        : [...prev, { employeeId: c.id, name: c.name, normalHours: 8, otHours: 0 }],
    );
  }
  function setHours(id: string, field: "normalHours" | "otHours", v: number) {
    setLabour((prev) =>
      prev.map((l) => (l.employeeId === id ? { ...l, [field]: Math.max(0, Math.min(24, v)) } : l)),
    );
  }
  function addItemMaterial(it: Item) {
    if (materials.some((m) => m.itemId === it.id)) return;
    setMaterials((prev) => [...prev, { itemId: it.id, itemName: it.name, qty: 1, unit: it.unit }]);
    setItemQuery("");
  }
  function addFreeMaterial() {
    const name = freeMaterial.trim();
    if (!name) return;
    setMaterials((prev) => [...prev, { itemName: name, qty: 1, unit: "pcs" }]);
    setFreeMaterial("");
  }
  function setMaterialQty(idx: number, qty: number) {
    setMaterials((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, qty: Math.max(0.001, qty) } : m)),
    );
  }
  function removeMaterial(idx: number) {
    setMaterials((prev) => prev.filter((_, i) => i !== idx));
  }
  function toggleStage(s: Stage) {
    setWork((prev) => {
      const found = prev.find((w) => w.stageKey === s.stageKey);
      if (found) return prev.filter((w) => w.stageKey !== s.stageKey);
      return [...prev, { stageKey: s.stageKey, description: s.label }];
    });
  }
  function setWorkNote(stageKey: string, description: string) {
    setWork((prev) => prev.map((w) => (w.stageKey === stageKey ? { ...w, description } : w)));
  }

  const canSubmit = summary.trim().length > 0 && status !== "submitting";

  async function onSubmit() {
    if (!canSubmit) return;
    setStatus("submitting");
    setErrorMsg("");
    const payload: ReportSubmitPayload = {
      jobId,
      reportDate,
      summary: summary.trim(),
      blockers: blockers.trim() || undefined,
      idempotencyKey: keyFor(jobId, reportDate),
      workLines: work
        .filter((w) => w.description.trim())
        .map((w) => ({ stageKey: w.stageKey, description: w.description.trim() })),
      materialLines: materials.map((m) => ({
        itemId: m.itemId,
        itemName: m.itemName,
        qty: m.qty,
        unit: m.unit,
      })),
      labourLines: labour.map((l) => ({
        employeeId: l.employeeId,
        normalHours: l.normalHours,
        otHours: l.otHours,
      })),
    };
    try {
      const res = await submitReportAction(orgId, payload);
      if (res.ok) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
        router.push(`/o/${orgId}/reports/${res.id}`);
        return;
      }
      setStatus("error");
      setErrorMsg(
        res.error === "duplicate"
          ? dict.err_duplicate
          : res.error === "identity"
            ? dict.err_identity
            : res.error === "invalid"
              ? dict.err_invalid
              : dict.err_failed,
      );
    } catch {
      // Network/offline: the draft (with its key) is already persisted → retry
      // is safe and exactly-once.
      setStatus("offline");
    }
  }

  return (
    <div className="flex flex-col gap-4" dir={dir}>
      <Card>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-ink-secondary">{dict.new_title}</span>
          <span className="text-base font-semibold text-ink">{jobLabel}</span>
        </div>
      </Card>

      {restored ? (
        <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-secondary">
          {dict.draft_restored}
        </p>
      ) : null}

      <Field
        label={dict.date}
        type="date"
        value={reportDate}
        onChange={(e) => setReportDate(e.target.value)}
      />

      <Card>
        <label className="mb-1.5 block text-sm font-medium text-ink">{dict.summary}</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-line-strong bg-card p-3 text-base text-ink"
          placeholder={dict.summary}
        />
      </Card>

      {/* Progress: tap a stage chip, edit the note */}
      {stages.length > 0 ? (
        <Card>
          <label className="mb-2 block text-sm font-medium text-ink">{dict.work}</label>
          <div className="flex flex-wrap gap-2">
            {stages.map((s) => {
              const on = work.some((w) => w.stageKey === s.stageKey);
              return (
                <button
                  key={s.stageKey}
                  type="button"
                  onClick={() => toggleStage(s)}
                  className={`min-h-11 rounded-full border px-3 text-sm ${
                    on
                      ? "border-brand bg-brand text-ink-inverse"
                      : "border-line-strong bg-card text-ink"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          {work.map((w) => (
            <input
              key={w.stageKey}
              value={w.description}
              onChange={(e) => setWorkNote(w.stageKey!, e.target.value)}
              className="mt-2 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              placeholder={dict.work_description}
            />
          ))}
        </Card>
      ) : null}

      {/* Labour: crew chips → hours steppers */}
      <Card>
        <label className="mb-2 block text-sm font-medium text-ink">{dict.labour}</label>
        <div className="flex flex-wrap gap-2">
          {crew.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggleCrew(c)}
              className={`min-h-11 rounded-full border px-3 text-sm ${
                inLabour(c.id)
                  ? "border-brand bg-brand text-ink-inverse"
                  : "border-line-strong bg-card text-ink"
              }`}
            >
              {c.name}
            </button>
          ))}
          {crew.length === 0 ? <span className="text-sm text-ink-muted">—</span> : null}
        </div>
        {labour.map((l) => (
          <div key={l.employeeId} className="mt-2 flex items-center gap-2">
            <span className="flex-1 text-sm text-ink">{l.name}</span>
            <label className="text-xs text-ink-muted">{dict.normal_hours}</label>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={24}
              value={l.normalHours}
              onChange={(e) => setHours(l.employeeId, "normalHours", Number(e.target.value))}
              className="min-h-11 w-16 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
            <label className="text-xs text-ink-muted">{dict.ot_hours}</label>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={24}
              value={l.otHours}
              onChange={(e) => setHours(l.employeeId, "otHours", Number(e.target.value))}
              className="min-h-11 w-16 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
          </div>
        ))}
      </Card>

      {/* Materials: search catalog or free-text; qty stepper */}
      <Card>
        <label className="mb-2 block text-sm font-medium text-ink">{dict.materials}</label>
        <input
          value={itemQuery}
          onChange={(e) => setItemQuery(e.target.value)}
          className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
          placeholder={dict.materials_search}
        />
        {itemQuery.trim() ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {filteredItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => addItemMaterial(it)}
                className="min-h-11 rounded-full border border-line-strong bg-card px-3 text-sm text-ink"
              >
                + {it.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex gap-2">
          <input
            value={freeMaterial}
            onChange={(e) => setFreeMaterial(e.target.value)}
            className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            placeholder={dict.materials_free}
          />
          <Button variant="secondary" type="button" onClick={addFreeMaterial}>
            {dict.add}
          </Button>
        </div>
        {materials.map((m, idx) => (
          <div key={`${m.itemId ?? "free"}-${idx}`} className="mt-2 flex items-center gap-2">
            <span className="flex-1 text-sm text-ink">{m.itemName}</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.001"
              value={m.qty}
              onChange={(e) => setMaterialQty(idx, Number(e.target.value))}
              className="min-h-11 w-20 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
            />
            <span className="w-10 text-sm text-ink-muted">{m.unit}</span>
            <button
              type="button"
              onClick={() => removeMaterial(idx)}
              className="min-h-11 px-2 text-danger"
              aria-label={dict.remove}
            >
              ✕
            </button>
          </div>
        ))}
      </Card>

      <Card>
        <label className="mb-1.5 block text-sm font-medium text-ink">{dict.blockers}</label>
        <textarea
          value={blockers}
          onChange={(e) => setBlockers(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-line-strong bg-card p-3 text-base text-ink"
          placeholder={dict.blockers}
        />
      </Card>

      {status === "offline" ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">
          {dict.saved_offline}
        </p>
      ) : null}
      {status === "error" ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{errorMsg}</p>
      ) : null}

      <Button size="lg" onClick={onSubmit} disabled={!canSubmit}>
        {status === "submitting"
          ? dict.submitting
          : status === "offline"
            ? dict.retry
            : dict.submit}
      </Button>
    </div>
  );
}
