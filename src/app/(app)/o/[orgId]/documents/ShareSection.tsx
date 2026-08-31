import { getT, getServerLocale } from "@/platform/i18n/server";
import { Button, Card, CardHeader } from "@/platform/ui";
import { formatDate } from "@/platform/format";
import type { DocumentKind, DocumentShareRow } from "@/modules/documents/service";
import { ShareControls } from "./ShareControls";
import { revokeDocumentShareAction } from "./actions";

/**
 * The share panel for one document: mint a link, and see or revoke the links
 * that already exist.
 *
 * Only rendered where the viewer holds documents.share. A read-only viewer sees
 * no share controls at all rather than disabled ones, because a control that
 * cannot be used is noise on a phone screen.
 */
export async function ShareSection({
  orgId,
  kind,
  id,
  shares,
}: {
  orgId: string;
  kind: DocumentKind;
  id: string;
  shares: DocumentShareRow[];
}) {
  const t = await getT();
  const locale = await getServerLocale();

  return (
    <Card>
      <CardHeader title={t("documents.share")} />
      <ShareControls
        orgId={orgId}
        kind={kind}
        id={id}
        labels={{
          days: t("documents.share_days"),
          create: t("documents.share_create"),
          creating: t("documents.share_creating"),
          link: t("documents.share_link"),
          once: t("documents.share_once"),
          copy: t("documents.share_copy"),
          copied: t("documents.share_copied"),
          failed: t("documents.share_failed"),
          forbidden: t("documents.share_forbidden"),
        }}
      />
      {shares.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">{t("documents.share_none")}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {shares.map((s) => {
            const revoked = s.revokedAt !== null;
            const expired = !revoked && s.expired;
            return (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">
                    {revoked
                      ? t("documents.share_revoked")
                      : expired
                        ? t("documents.share_expired")
                        : t("documents.share_expires", {
                            date: formatDate(s.expiresAt.slice(0, 10), { locale }),
                          })}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {t("documents.share_views", { count: s.viewCount })}
                  </span>
                </span>
                {!revoked && !expired ? (
                  <form action={revokeDocumentShareAction.bind(null, orgId)}>
                    <input type="hidden" name="kind" value={kind} />
                    <input type="hidden" name="subject_id" value={id} />
                    <input type="hidden" name="share_id" value={s.id} />
                    <Button type="submit" variant="danger">
                      {t("documents.share_revoke")}
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
