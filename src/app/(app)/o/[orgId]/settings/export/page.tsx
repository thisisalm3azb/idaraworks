import { redirect } from "next/navigation";
import { Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { EXPORT_ENTITY_KEYS } from "@/platform/export/service";

export default async function ExportPage({ params }: { params: Promise<{ orgId: string }> }) {
  const t = await getT();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "data.export")) redirect(`/o/${orgId}`);
  const terms = await loadOrgTerminology(resolved.ctx, await getServerLocale());
  const jobsTerm = term("job", terms, "plural");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("export.title")} />
        <p className="mb-3 text-sm text-ink-muted">{t("export.help")}</p>
        <ul className="flex flex-col gap-2">
          {EXPORT_ENTITY_KEYS.map((entity) => (
            <li
              key={entity}
              className="flex items-center justify-between gap-3 rounded-md border border-line p-3"
            >
              <span className="text-sm text-ink">
                {t(`export.entity.${entity}`, { jobs: jobsTerm })}
              </span>
              {/* A plain download link — the route sets Content-Disposition: attachment. */}
              <a href={`/api/o/${orgId}/export?entity=${entity}`} download>
                <Button variant="secondary">{t("export.download")}</Button>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
