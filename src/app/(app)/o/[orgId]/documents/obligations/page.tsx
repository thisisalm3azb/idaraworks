import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { listMembers } from "@/platform/auth/identity";
import { getDocSettings, listDocuments, listObligations } from "@/modules/docstudio/service";
import { ObligationsBoard } from "./ObligationsBoard";
import { obligationsDict } from "./obligationsDict";

/** H26H — every obligation, renewal, payment and risk across the document estate. */
export default async function ObligationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const [items, docs, members, settings] = await Promise.all([
    listObligations(resolved.ctx, resolved.archetype, { limit: 500 }),
    listDocuments(resolved.ctx, resolved.archetype, { limit: 500 }),
    listMembers(resolved.ctx, resolved.archetype).catch(() => []),
    getDocSettings(resolved.ctx, resolved.archetype),
  ]);
  const dict = obligationsDict(t);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {t("docstudio.back")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink">{dict.title}</h1>
        <p className="text-sm text-ink-muted">{dict.subtitle}</p>
      </div>
      <ObligationsBoard
        orgId={orgId}
        locale={locale}
        userId={resolved.ctx.userId}
        items={items}
        documents={docs.rows
          .filter((d) => d.issuedSnapshotId !== null && d.effectiveStatus !== "archived")
          .map((d) => ({ id: d.id, reference: d.reference, title: d.title }))}
        members={members.map((m) => ({ id: m.userId, name: m.fullName }))}
        canManage={can(resolved.archetype, "documents.obligations.manage")}
        soonDays={Math.max(0, ...settings.reminderDays)}
        initialView={sp.view}
        dict={dict}
      />
    </div>
  );
}
