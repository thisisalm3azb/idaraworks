import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getOnboardingSession } from "@/modules/onboarding/service";
import { applyOnboardingAction, undoOnboardingAction } from "../actions";

export default async function OnboardingPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; sessionId: string }>;
  searchParams: Promise<{ applied?: string; undone?: string; error?: string }>;
}) {
  const { orgId, sessionId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "onboarding.run")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const ar = locale === "ar";
  const session = await getOnboardingSession(resolved.ctx, resolved.archetype, sessionId);
  if (!session || !session.proposal) redirect(`/o/${orgId}/onboarding`);
  const p = session.proposal;
  const canManage = can(resolved.archetype, "config.manage");

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("onboarding.preview.title")}</h1>
        <Badge
          tone={
            session.status === "applied"
              ? "success"
              : session.status === "dismissed"
                ? "neutral"
                : "brand"
          }
        >
          {t(`onboarding.status.${session.status}`)}
        </Badge>
      </header>

      {sp.applied ? <Badge tone="success">{t("onboarding.preview.applied_ok")}</Badge> : null}
      {sp.undone ? <Badge tone="neutral">{t("onboarding.preview.undone_ok")}</Badge> : null}
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}

      <Card>
        <CardHeader title={t("onboarding.preview.summary")} />
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
          {ar ? p.intake_summary_ar : p.intake_summary_en}
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          {t("onboarding.preview.template")}: <span className="font-mono">{p.template_key}</span>
        </p>
      </Card>

      <Card>
        <CardHeader title={t("onboarding.preview.will_apply")} />
        <ul className="flex flex-col gap-2 text-sm">
          {p.install_template ? (
            <li className="flex items-start gap-2">
              <Badge tone="brand">{t("onboarding.preview.template_install")}</Badge>
              <span className="text-ink-muted">
                {t("onboarding.preview.template_install_note")}
              </span>
            </li>
          ) : null}
          {p.artifacts.map((a) => (
            <li key={a.key} className="flex items-start gap-2">
              <Badge tone="neutral">{a.key}</Badge>
              <span className="text-ink-muted">{ar ? a.rationale_ar : a.rationale_en}</span>
            </li>
          ))}
          {p.approval_defaults.map((d) => (
            <li key={d.subject_type} className="flex items-start gap-2">
              <Badge tone="neutral">{t(`onboarding.subject.${d.subject_type}`)}</Badge>
              <span className="font-mono text-ink" dir="ltr">
                {t("onboarding.preview.auto_below")} {d.auto_approve_below_minor}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {p.requires_upgrade.length > 0 ? (
        <Card>
          <CardHeader title={t("onboarding.preview.requires_upgrade")} />
          <ul className="flex flex-wrap gap-2">
            {p.requires_upgrade.map((f) => (
              <li key={f}>
                <Badge tone="warning">{f}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">{t("onboarding.preview.upgrade_note")}</p>
        </Card>
      ) : null}

      {session.status === "proposed" && canManage ? (
        <form action={applyOnboardingAction.bind(null, orgId, sessionId)}>
          <Button type="submit">{t("onboarding.preview.apply")}</Button>
        </form>
      ) : null}
      {session.status === "applied" && canManage ? (
        <div className="flex items-center gap-3">
          <Link href={`/o/${orgId}`} className="text-sm text-brand hover:underline">
            {t("onboarding.preview.go_today")}
          </Link>
          <form action={undoOnboardingAction.bind(null, orgId, sessionId)}>
            <Button type="submit" variant="ghost">
              {t("onboarding.preview.undo")}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
