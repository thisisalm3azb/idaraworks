import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { isPlatformOperator } from "@/platform/ai";
import { getSessionUser } from "@/platform/auth/resolve";
import { countryPacksEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import { localeStatuses } from "@/platform/i18n/release-store";
import { type LocaleReadiness } from "@/platform/i18n/release";
import { setLocaleReleaseAction } from "./actions";

/**
 * H29C — the language release centre. Operator-only.
 *
 * It answers one question honestly: is this language ready to offer to the
 * public? Two things decide that and they are shown separately, never averaged
 * into a single percentage. Completeness is measured from the catalogue files
 * on every render. Review is a recorded human fact with a named reviewer and a
 * date, and its absence reads as "not started" rather than as approval.
 *
 * Turning a language ON is deliberately not a control here. It is an
 * environment flag the owner sets on the deployment, so a language cannot start
 * being offered because someone clicked a button in a browser.
 */
export default async function PlatformLanguagesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  // Page-level gate: in the App Router a layout gate does not stop this page's
  // own render, so the check belongs before the first await that fetches data.
  if (!countryPacksEnabled()) notFound();
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/platform/languages");
  if (!(await isPlatformOperator(user.id))) notFound();
  const t = await getT();
  const statuses = await localeStatuses(user.id);

  const READINESS_TONE: Record<LocaleReadiness, "neutral" | "success" | "warning" | "danger"> = {
    source_language: "neutral",
    catalogue_incomplete: "warning",
    awaiting_native_review: "warning",
    native_review_in_progress: "warning",
    native_review_failed: "danger",
    reviewed: "success",
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t("platform.locales.title")}</h1>
        <p className="text-sm text-ink-muted">{t("platform.locales.subtitle")}</p>
      </header>

      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("platform.locales.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
          {t(
            sp.error === "reviewer_required"
              ? "platform.locales.error.reviewer_required"
              : sp.error === "forbidden"
                ? "platform.locales.error.forbidden"
                : "platform.locales.error.failed",
          )}
        </p>
      ) : null}

      <p className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-secondary">
        {t("platform.locales.law")}
      </p>

      {statuses.map(({ completeness, release, readiness, offered }) => {
        const c = completeness;
        return (
          <Card key={c.locale}>
            <CardHeader
              title={`${LOCALE_NATIVE_NAME[c.locale]} (${c.locale})`}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={READINESS_TONE[readiness]}>
                    {t(`platform.locales.readiness.${readiness}`)}
                  </Badge>
                  <Badge tone={offered ? "success" : "neutral"}>
                    {t(offered ? "platform.locales.offered" : "platform.locales.not_offered")}
                  </Badge>
                </div>
              }
            />

            {/* Measured now, from the catalogue files. Four separate numbers,
                because "94% done" hides which 6% and why. */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-ink-muted">{t("platform.locales.total")}</dt>
                <dd className="font-medium tabular-nums text-ink">{c.total}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t("platform.locales.translated")}</dt>
                <dd className="font-medium tabular-nums text-ink">{c.translated}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t("platform.locales.recorded_identical")}</dt>
                <dd className="font-medium tabular-nums text-ink">{c.recordedIdentical}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t("platform.locales.untranslated")}</dt>
                <dd
                  className={`font-medium tabular-nums ${
                    c.untranslated + c.missing > 0 ? "text-danger" : "text-ink"
                  }`}
                >
                  {c.untranslated + c.missing}
                </dd>
              </div>
            </dl>

            {release?.note ? (
              <p className="mt-3 text-sm text-ink-secondary">{release.note}</p>
            ) : null}

            {release?.nativeReview === "passed" && release.nativeReviewer ? (
              <p className="mt-1 text-sm text-ink-secondary">
                {t("platform.locales.reviewed_by", {
                  reviewer: release.nativeReviewer,
                  date: release.nativeReviewedAt?.slice(0, 10) ?? "",
                })}
              </p>
            ) : null}

            <form
              action={setLocaleReleaseAction}
              className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
            >
              <input type="hidden" name="locale" value={c.locale} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">{t("platform.locales.production")}</span>
                  <select
                    name="production"
                    defaultValue={release?.production ?? "machine_assisted"}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  >
                    {(
                      ["source", "machine_assisted", "native_authored", "professional"] as const
                    ).map((option) => (
                      <option key={option} value={option}>
                        {t(`platform.locales.production.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">
                    {t("platform.locales.native_review")}
                  </span>
                  <select
                    name="native_review"
                    defaultValue={release?.nativeReview ?? "not_started"}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  >
                    {(
                      ["not_applicable", "not_started", "in_progress", "passed", "failed"] as const
                    ).map((option) => (
                      <option key={option} value={option}>
                        {t(`platform.locales.review.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">
                    {t("platform.locales.native_reviewer")}
                  </span>
                  <input
                    name="native_reviewer"
                    defaultValue={release?.nativeReviewer ?? ""}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">{t("platform.locales.legal_review")}</span>
                  <select
                    name="legal_review"
                    defaultValue={release?.legalReview ?? "not_applicable"}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  >
                    {(
                      ["not_applicable", "not_started", "in_progress", "passed", "failed"] as const
                    ).map((option) => (
                      <option key={option} value={option}>
                        {t(`platform.locales.review.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">
                    {t("platform.locales.legal_reviewer")}
                  </span>
                  <input
                    name="legal_reviewer"
                    defaultValue={release?.legalReviewer ?? ""}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  <span className="font-medium text-ink">{t("platform.locales.note")}</span>
                  <input
                    name="note"
                    defaultValue={release?.note ?? ""}
                    maxLength={1000}
                    className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
                  />
                </label>
              </div>
              <p className="text-xs text-ink-muted">{t("platform.locales.reviewer_help")}</p>
              <div>
                <Button type="submit" variant="secondary">
                  {t("platform.locales.record")}
                </Button>
              </div>
            </form>
          </Card>
        );
      })}
    </div>
  );
}
