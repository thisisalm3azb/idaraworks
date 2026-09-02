"use client";

import { Badge } from "@/platform/ui";
import { formatDate, formatDateTime } from "@/platform/format";
import type { DocumentDetail } from "@/modules/docstudio/service";

export type ActivityDict = {
  title: string;
  chainOk: string;
  chainBroken: string;
  snapshotHash: string;
  retention: string;
  legalHold: string;
  kinds: Record<string, string>;
};

/** The hash-chained evidence timeline, verified on every read. */
export function ActivityPane({
  detail,
  dict,
  locale,
}: {
  detail: DocumentDetail;
  dict: ActivityDict;
  locale: string;
}) {
  const l = locale as "en" | "ar";
  const d = detail.document;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {detail.chain.ok ? (
          <Badge tone="success">{dict.chainOk}</Badge>
        ) : (
          <Badge tone="danger">
            {dict.chainBroken} #{detail.chain.atSeq}: {detail.chain.reason}
          </Badge>
        )}
        {detail.snapshot ? (
          <span className="font-mono text-xs text-ink-secondary">
            {dict.snapshotHash}: <bdi dir="ltr">{detail.snapshot.contentHash}</bdi>
          </span>
        ) : null}
        {d.retentionUntil ? (
          <span className="text-xs text-ink-muted">
            {dict.retention}: {formatDate(d.retentionUntil, { locale: l })}
          </span>
        ) : null}
        {d.legalHold ? <Badge tone="warning">{dict.legalHold}</Badge> : null}
      </div>
      <ol className="flex flex-col gap-1 rounded-lg border border-line bg-card p-3 shadow-card">
        {[...detail.events].reverse().map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line py-2 text-sm last:border-b-0"
          >
            <span className="w-8 shrink-0 font-mono text-xs text-ink-muted">
              <bdi dir="ltr">#{e.seq}</bdi>
            </span>
            <span className="font-medium text-ink">{dict.kinds[e.kind] ?? e.kind}</span>
            <span className="text-xs text-ink-secondary">
              {formatDateTime(e.at, { locale: l })}
            </span>
            {e.actorLabel ? (
              <span className="text-xs text-ink-secondary">{e.actorLabel}</span>
            ) : null}
            {Object.keys(e.payload).length > 0 ? (
              <span
                className="basis-full truncate font-mono text-[10px] text-ink-muted"
                title={JSON.stringify(e.payload)}
              >
                <bdi dir="ltr">{JSON.stringify(e.payload).slice(0, 160)}</bdi>
              </span>
            ) : null}
            <span
              className="basis-full truncate font-mono text-[10px] text-ink-muted"
              title={e.eventHash}
            >
              <bdi dir="ltr">{e.eventHash.slice(0, 24)}</bdi>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
