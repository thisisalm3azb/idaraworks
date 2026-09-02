import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { IMPORT_KINDS, listImportRows, previewImport } from "@/modules/imports/service";
import { stageImportAction, applyImportAction, skipImportRowsAction } from "./actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";
const KINDS = IMPORT_KINDS;
const CRM_KINDS = new Set(["contacts", "leads", "opportunities"]);

export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    batch?: string;
    applied?: string;
    error?: string;
    preview?: string;
    skipped?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "imports.manage")) redirect(`/o/${orgId}`);
  const t = await getT();

  const rows = sp.batch ? await listImportRows(resolved.ctx, resolved.archetype, sp.batch) : [];
  const valid = rows.filter((r) => r.status === "valid").length;
  const applied = rows.filter((r) => r.status === "applied").length;
  const invalid = rows.filter((r) => r.status === "invalid").length;
  const preview =
    sp.batch && sp.preview === "1"
      ? await previewImport(resolved.ctx, resolved.archetype, sp.batch)
      : null;
  const flaggedRows = new Set<number>([
    ...(preview?.unresolved.map((u) => u.rowNumber) ?? []),
    ...(preview?.duplicates.map((d) => d.rowNumber) ?? []),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-ink">{t("imports.title")}</h1>
        <p className="text-sm text-ink-muted">{t("imports.subtitle")}</p>
      </header>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      {sp.applied ? <Badge tone="success">{t("imports.applied_ok")}</Badge> : null}
      {sp.skipped ? <Badge tone="success">{t("imports.skipped_ok")}</Badge> : null}

      <Card>
        <CardHeader title={t("imports.stage_heading")} />
        <form action={stageImportAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("imports.kind")}
            <select name="kind" className={input}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`imports.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("imports.csv")}
            <textarea
              name="csv"
              required
              rows={6}
              dir="ltr"
              className={`${input} font-mono text-xs`}
              placeholder="name,phone,email&#10;..."
            />
          </label>
          <p className="text-xs text-ink-muted">{t("imports.csv_note")}</p>
          <ul className="flex flex-col gap-1 text-xs text-ink-muted">
            {KINDS.filter((k) => CRM_KINDS.has(k)).map((k) => (
              <li key={k}>
                <span className="font-medium text-ink">{t(`imports.kind.${k}`)}:</span>{" "}
                {t(`imports.columns.${k}`)}
              </li>
            ))}
          </ul>
          <Button type="submit">{t("imports.stage")}</Button>
        </form>
      </Card>

      {sp.batch ? (
        <Card>
          <CardHeader
            title={t("imports.review_heading")}
            meta={
              <span className="flex gap-2 text-xs">
                <Badge tone="brand">{t("imports.count_valid", { n: valid })}</Badge>
                <Badge tone={invalid ? "danger" : "neutral"}>
                  {t("imports.count_invalid", { n: invalid })}
                </Badge>
                <Badge tone="success">{t("imports.count_applied", { n: applied })}</Badge>
              </span>
            }
          />
          <ul className="flex flex-col gap-1">
            {rows.slice(0, 200).map((r) => (
              <li
                key={r.rowNumber}
                className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
              >
                <span className="min-w-0 truncate text-ink">
                  <span className="font-mono text-ink-muted">#{r.rowNumber}</span>{" "}
                  {String(
                    (r.mapped as { name?: string; sku?: string })?.name ??
                      (r.mapped as { sku?: string })?.sku ??
                      "—",
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {r.error ? (
                    <span className="truncate text-xs text-danger" dir="ltr">
                      {r.error}
                    </span>
                  ) : null}
                  <Badge
                    tone={
                      r.status === "applied"
                        ? "success"
                        : r.status === "invalid"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {t(`imports.row_status.${r.status}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
          {preview ? (
            <section
              className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
              aria-label={t("imports.preview_heading")}
            >
              <h3 className="text-sm font-semibold text-ink">{t("imports.preview_heading")}</h3>
              <p className="text-xs text-ink-muted">{t("imports.preview_note")}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge tone="brand">{t("imports.would_create", { n: preview.wouldCreate })}</Badge>
                <Badge tone={preview.unresolved.length ? "danger" : "neutral"}>
                  {t("imports.unresolved", { n: preview.unresolved.length })}
                </Badge>
                <Badge tone={preview.duplicates.length ? "warning" : "neutral"}>
                  {t("imports.duplicates", { n: preview.duplicates.length })}
                </Badge>
              </div>
              {flaggedRows.size > 0 ? (
                <form
                  action={skipImportRowsAction.bind(null, orgId, sp.batch!)}
                  className="flex flex-col gap-2"
                >
                  <ul className="flex flex-col gap-1">
                    {preview.unresolved.map((u) => (
                      <li key={`u-${u.rowNumber}`} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="row"
                          value={u.rowNumber}
                          defaultChecked
                          className="size-5"
                        />
                        <span className="font-mono text-ink-muted">
                          {t("imports.row", { n: u.rowNumber })}
                        </span>
                        <span className="truncate text-danger" dir="ltr">
                          {u.reason}
                        </span>
                      </li>
                    ))}
                    {preview.duplicates.map((d, i) => (
                      <li key={`d-${d.rowNumber}-${i}`} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="row"
                          value={d.rowNumber}
                          defaultChecked
                          className="size-5"
                        />
                        <span className="font-mono text-ink-muted">
                          {t("imports.row", { n: d.rowNumber })}
                        </span>
                        <span className="truncate text-ink">
                          {d.kind === "in_batch"
                            ? t("imports.dup_in_batch", {
                                field: t(`imports.match.${d.matchedOn}`),
                                row: d.rowNumber2 ?? 0,
                              })
                            : t("imports.dup_existing", {
                                name: d.name,
                                field: t(`imports.match.${d.matchedOn}`),
                              })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Button type="submit" variant="secondary">
                    {t("imports.skip_selected")}
                  </Button>
                </form>
              ) : null}
            </section>
          ) : null}
          {valid > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {!preview ? (
                <a
                  href={`/o/${orgId}/imports?batch=${sp.batch}&preview=1`}
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
                >
                  {t("imports.preview")}
                </a>
              ) : null}
              <form action={applyImportAction.bind(null, orgId, sp.batch)}>
                <Button type="submit">{t("imports.apply", { n: valid })}</Button>
              </form>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
