import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getUpdate } from "@/modules/customer-updates/service";
import { updateDraftAction, revokeShareAction } from "../actions";
import { SharePanel } from "./share-panel";

const inputCls =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export default async function CustomerUpdateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; updateId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, updateId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "customer_updates.draft")) redirect(`/o/${orgId}`);
  const t = await getT();
  const u = await getUpdate(resolved.ctx, resolved.archetype, updateId);
  if (!u) notFound();
  const canSend = can(resolved.archetype, "customer_updates.send");
  const canRevoke = can(resolved.archetype, "customer_updates.revoke");

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{u.title}</h1>
        <Badge tone={u.status === "sent" ? "success" : "neutral"}>
          {t(`customer_updates.status.${u.status}`)}
        </Badge>
      </div>
      {sp.ok ? <Badge tone="success">{t("common.saved")}</Badge> : null}
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}

      {u.status === "draft" ? (
        <>
          <Card>
            <CardHeader title={t("customer_updates.form.title")} />
            <form action={updateDraftAction.bind(null, orgId)} className="flex flex-col gap-3">
              <input type="hidden" name="update_id" value={u.id} />
              <label className="flex flex-col gap-1 text-sm">
                {t("customer_updates.form.msg_title")}
                <input name="title" defaultValue={u.title} maxLength={200} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("customer_updates.form.body")}
                <textarea
                  name="body"
                  defaultValue={u.body}
                  rows={5}
                  maxLength={4000}
                  className={inputCls}
                />
              </label>
              <Button type="submit" variant="ghost">
                {t("common.save")}
              </Button>
            </form>
          </Card>
          {canSend ? (
            <Card>
              <CardHeader
                title={t("customer_updates.share.title")}
                meta={
                  <span className="text-xs text-ink-muted">{t("customer_updates.share.hint")}</span>
                }
              />
              <SharePanel
                orgId={orgId}
                updateId={u.id}
                labels={{
                  send: t("customer_updates.share.send"),
                  sending: t("common.loading"),
                  link: t("customer_updates.share.link"),
                  copy: t("customer_updates.share.copy"),
                  copied: t("customer_updates.share.copied"),
                  failed: t("common.error"),
                }}
              />
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <CardHeader
            title={t("customer_updates.sent.title")}
            meta={
              u.sentAt ? (
                <span className="text-xs text-ink-muted">{u.sentAt.slice(0, 10)}</span>
              ) : null
            }
          />
          <p className="whitespace-pre-line text-sm text-ink">{u.body}</p>
          {canRevoke && u.liveTokenId ? (
            <form action={revokeShareAction.bind(null, orgId)} className="mt-3">
              <input type="hidden" name="update_id" value={u.id} />
              <input type="hidden" name="token_id" value={u.liveTokenId} />
              <Button type="submit" variant="danger">
                {t("customer_updates.share.revoke")}
              </Button>
            </form>
          ) : (
            <p className="mt-3 text-xs text-ink-muted">
              {t("customer_updates.share.revoked_or_expired")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
