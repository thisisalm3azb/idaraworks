"use client";

/**
 * H25E — the risk matrix projection: every `risk` element placed by its own
 * validated likelihood × impact (semantic node data), the score derived, not
 * stored. Unscored risks are listed, never hidden.
 */
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

const SCALE = [1, 2, 3, 4, 5] as const;

function score(l: number, i: number): number {
  return l * i;
}

function tone(s: number): string {
  if (s >= 15) return "bg-danger-soft";
  if (s >= 8) return "bg-warning-soft";
  return "bg-success-soft";
}

export function RiskMatrixView({
  payload,
  dict,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const risks = payload.nodes.filter((n) => n.nodeType === "risk");
  const scored = risks
    .map((n) => {
      const l = Number((n.data as { likelihood?: unknown }).likelihood);
      const i = Number((n.data as { impact?: unknown }).impact);
      const ok = Number.isInteger(l) && Number.isInteger(i) && l >= 1 && l <= 5 && i >= 1 && i <= 5;
      return { node: n, l, i, ok };
    })
    .filter((r) => r.ok);
  const unscored = risks.filter((n) => !scored.some((s) => s.node.id === n.id));

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex gap-2" dir="ltr">
        <div
          className="flex shrink-0 items-center justify-center text-[10px] uppercase tracking-wide text-ink-muted"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {dict.likelihood} →
        </div>
        <div className="flex flex-col gap-1">
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: "auto repeat(5, minmax(88px, 1fr))" }}
          >
            {[...SCALE].reverse().map((l) => (
              <div key={`row-${l}`} className="contents">
                <div className="flex items-center justify-end pe-1 text-xs text-ink-muted">{l}</div>
                {SCALE.map((i) => {
                  const here = scored.filter((r) => r.l === l && r.i === i);
                  return (
                    <div
                      key={`${l}-${i}`}
                      className={`min-h-16 rounded-md border border-line p-1 ${tone(score(l, i))}`}
                      title={`${dict.likelihood} ${l} × ${dict.impact} ${i} = ${score(l, i)}`}
                    >
                      <span className="block text-[10px] text-ink-muted">{score(l, i)}</span>
                      {here.map((r) => (
                        <button
                          key={r.node.id}
                          type="button"
                          onClick={() => onSelect(r.node.id)}
                          className={`mt-0.5 block w-full truncate rounded bg-card px-1 text-start text-[11px] text-ink ${
                            selectedId === r.node.id ? "ring-2 ring-accent" : ""
                          }`}
                        >
                          {r.node.title}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
            <div />
            {SCALE.map((i) => (
              <div key={`col-${i}`} className="text-center text-xs text-ink-muted">
                {i}
              </div>
            ))}
          </div>
          <div className="text-center text-[10px] uppercase tracking-wide text-ink-muted">
            {dict.impact} →
          </div>
        </div>
      </div>
      {unscored.length > 0 ? (
        <section>
          <h3 className="text-xs font-semibold text-ink">{dict.unscored}</h3>
          <ul className="mt-1 flex flex-wrap gap-1">
            {unscored.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={`rounded-md border border-dashed border-line px-2 py-1 text-xs text-ink ${
                    selectedId === n.id ? "ring-2 ring-accent" : ""
                  }`}
                >
                  {n.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {risks.length === 0 ? (
        <p className="text-sm text-ink-muted">{dict.nothingScheduled}</p>
      ) : null}
    </div>
  );
}
