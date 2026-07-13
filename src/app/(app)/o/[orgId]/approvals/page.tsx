import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listInbox } from "@/modules/approvals/service";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { decideApprovalAction } from "./actions";

export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "approvals.decide")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const inbox = await listInbox(resolved.ctx, resolved.archetype);
  const decide = decideApprovalAction.bind(null, orgId);
  const currency = resolved.baseCurrency as CurrencyCode;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("approvals.title")}</h1>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("approvals.decided_notice")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("common.error")}
        </p>
      ) : null}
      {inbox.length === 0 ? (
        <EmptyState title={t("approvals.inbox_empty")} />
      ) : (
        <ul className="flex flex-col gap-3">
          {inbox.map((a) => (
            <li key={a.id}>
              <Card>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-ink">{a.title}</span>
                    <span className="text-xs text-ink-muted">
                      {a.jobRef ? `${a.jobRef} · ` : ""}
                      {t("approvals.assigned_to")}: {a.assignedRole} ·{" "}
                      {formatDate(a.createdAt.slice(0, 10), { locale })}
                    </span>
                  </div>
                  {a.amountMinor ? (
                    <Badge tone="info" dir="ltr">
                      {formatMoney(Number(a.amountMinor), currency, { locale: "en" })}
                    </Badge>
                  ) : null}
                </div>
                <form action={decide} className="mt-3 flex flex-col gap-2">
                  <input type="hidden" name="approval_id" value={a.id} />
                  <input
                    name="note"
                    maxLength={2000}
                    placeholder={t("approvals.reject_reason")}
                    className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" name="decision" value="approved" className="flex-1">
                      {t("approvals.approve")}
                    </Button>
                    <Button
                      type="submit"
                      name="decision"
                      value="rejected"
                      variant="danger"
                      className="flex-1"
                    >
                      {t("approvals.reject")}
                    </Button>
                  </div>
                </form>
                <Link
                  href={`/o/${orgId}/${a.subjectType === "purchase_order" ? "purchase-orders" : "material-requests"}/${a.subjectId}`}
                  className="mt-2 inline-block text-sm text-ink-secondary underline"
                >
                  {a.subjectType.replace("_", " ")} →
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
