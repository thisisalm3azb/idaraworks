import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listImportRows } from "@/modules/imports/service";
import { stageImportAction, applyImportAction } from "./actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";
const KINDS = ["customers", "employees", "items"] as const;

export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ batch?: string; applied?: string; error?: string }>;
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-ink">{t("imports.title")}</h1>
        <p className="text-sm text-ink-muted">{t("imports.subtitle")}</p>
      </header>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      {sp.applied ? <Badge tone="success">{t("imports.applied_ok")}</Badge> : null}

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
          {valid > 0 ? (
            <form action={applyImportAction.bind(null, orgId, sp.batch)} className="mt-3">
              <Button type="submit">{t("imports.apply", { n: valid })}</Button>
            </form>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
