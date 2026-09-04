import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { isPlatformOperator } from "@/platform/ai";
import { getSessionUser } from "@/platform/auth/resolve";
import { countryPacksEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { REVIEW_KINDS, REVIEW_STATES, getPack } from "@/platform/country";
import { packReviews } from "@/platform/country/reviews";
import { setPackReviewAction } from "./actions";

/**
 * H29 — the country-pack review centre. Operator-only.
 *
 * A pack version's review state is what the readiness centre reads to decide
 * whether an establishment is `legally_reviewed`, and no amount of configuration
 * can imply one. Recording a review is therefore an owner action, and this is
 * its door: without one the only way to record it would be to write SQL against
 * production.
 *
 * The states shown are facts about REVIEW, never about correctness. A version
 * whose internal review passed is still a version no professional has read.
 */
export default async function PlatformCountriesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  // Page-level gate: the layout and the page render together, so a layout check
  // would not stop this page's own data fetch.
  if (!countryPacksEnabled()) notFound();
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/platform/countries");
  if (!(await isPlatformOperator(user.id))) notFound();
  const t = await getT();
  const packs = await packReviews(user.id);

  const TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
    not_started: "neutral",
    in_progress: "warning",
    passed: "success",
    failed: "danger",
  };
  const input = "min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t("platform.countries.title")}</h1>
        <p className="text-sm text-ink-muted">{t("platform.countries.subtitle")}</p>
      </header>

      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("platform.countries.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-ink" role="alert">
          {t(
            sp.error === "reviewer_required"
              ? "platform.countries.error.reviewer_required"
              : sp.error === "forbidden"
                ? "platform.countries.error.forbidden"
                : "platform.countries.error.failed",
          )}
        </p>
      ) : null}

      <p className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-secondary">
        {t("platform.countries.law")}
      </p>

      {packs.map((pack) => {
        const definition = getPack(pack.packKey);
        return (
          <Card key={pack.packKey}>
            <CardHeader
              title={pack.packKey}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{pack.country}</Badge>
                  <Badge tone={pack.status === "approved" ? "success" : "neutral"}>
                    {t(`country.pack_status.${pack.status}`)}
                  </Badge>
                </div>
              }
            />
            {definition ? (
              <p className="text-sm text-ink-secondary">{definition.jurisdiction}</p>
            ) : null}

            {definition && definition.knownLimitations.length > 0 ? (
              <div className="mt-3 rounded-md border border-line bg-sunken px-3 py-2 text-sm">
                <p className="font-medium text-ink">{t("country.known_limits")}</p>
                <ul className="mt-1 list-disc ps-5 text-ink-secondary">
                  {definition.knownLimitations.map((limit) => (
                    <li key={limit}>{t(limit)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {REVIEW_KINDS.map((kind) => {
              const review = pack.reviews.find((r) => r.kind === kind)!;
              return (
                <form
                  key={kind}
                  action={setPackReviewAction}
                  className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
                >
                  <input type="hidden" name="packKey" value={pack.packKey} />
                  <input type="hidden" name="kind" value={kind} />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {t(`platform.countries.kind.${kind}`)}
                    </span>
                    <Badge tone={TONE[review.state] ?? "neutral"}>
                      {t(`platform.countries.state.${review.state}`)}
                    </Badge>
                    {review.reviewer && review.decidedAt ? (
                      <span className="text-sm text-ink-muted">
                        {t("platform.countries.decided_by", {
                          reviewer: review.reviewer,
                          date: review.decidedAt.slice(0, 10),
                        })}
                      </span>
                    ) : null}
                  </div>
                  {review.note ? <p className="text-sm text-ink-secondary">{review.note}</p> : null}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-ink">
                        {t("platform.countries.state_label")}
                      </span>
                      <select name="state" defaultValue={review.state} className={input}>
                        {REVIEW_STATES.map((state) => (
                          <option key={state} value={state}>
                            {t(`platform.countries.state.${state}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-ink">
                        {t("platform.countries.reviewer")}
                      </span>
                      <input
                        name="reviewer"
                        defaultValue={review.reviewer ?? ""}
                        maxLength={200}
                        className={input}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-ink">{t("platform.countries.note")}</span>
                      <input
                        name="note"
                        defaultValue={review.note ?? ""}
                        maxLength={1000}
                        className={input}
                      />
                    </label>
                  </div>
                  <div>
                    <Button type="submit" variant="secondary">
                      {t("platform.countries.record")}
                    </Button>
                  </div>
                </form>
              );
            })}
          </Card>
        );
      })}
    </div>
  );
}
