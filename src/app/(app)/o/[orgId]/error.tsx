"use client";

/**
 * Org-scope error boundary (U5 §3): a retry surface inside the org shell.
 * Same observability law as the root boundary (BUILD_BIBLE §8.4): capture to
 * Sentry, show nothing internal. t() is client-usable; the locale comes from
 * the <html lang> the root layout already resolved.
 */
import { useEffect } from "react";
import { ErrorState } from "@/platform/ui/dashboard";
import { t } from "@/platform/i18n";
import { captureBoundaryError } from "@/platform/observability/sentry.client";

export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureBoundaryError(error);
  }, [error]);
  const locale =
    typeof document !== "undefined" && document.documentElement.lang === "ar" ? "ar" : "en";
  return (
    <ErrorState
      title={t("dashboard.error_title", undefined, locale)}
      description={t("common.error", undefined, locale)}
      retryLabel={t("dashboard.error_retry", undefined, locale)}
      onRetry={reset}
    />
  );
}
