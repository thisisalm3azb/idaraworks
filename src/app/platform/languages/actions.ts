"use server";

/**
 * H29C — recording how a language was produced and what review it has had.
 *
 * Same shape as the H28 operator controls: verify the session, then let the
 * database decide. `app.locale_release_set` asserts an active platform_operator
 * row, refuses a decided review with no named reviewer, and writes its own audit
 * entry. Nothing here trusts a role inside an organisation.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/platform/auth/resolve";
import { isPlatformOperator, NotOperatorError } from "@/platform/ai";
import { countryPacksEnabled } from "@/platform/flags";
import { setLocaleRelease } from "@/platform/i18n/release-store";
import { SUPPORTED_LOCALES } from "@/platform/registries";

const BASE = "/platform/languages";

const REVIEW = z.enum(["not_applicable", "not_started", "in_progress", "passed", "failed"]);
const PRODUCTION = z.enum(["source", "machine_assisted", "native_authored", "professional"]);

async function operatorOrRedirect(): Promise<string> {
  if (!countryPacksEnabled()) redirect("/");
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${BASE}`);
  if (!(await isPlatformOperator(user.id))) redirect("/");
  return user.id;
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

export async function setLocaleReleaseAction(fd: FormData): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    await setLocaleRelease(userId, {
      locale: z.enum(SUPPORTED_LOCALES).parse(str(fd, "locale")),
      production: PRODUCTION.parse(str(fd, "production")),
      nativeReview: REVIEW.parse(str(fd, "native_review")),
      nativeReviewer: str(fd, "native_reviewer"),
      legalReview: REVIEW.parse(str(fd, "legal_review")),
      legalReviewer: str(fd, "legal_reviewer"),
      note: str(fd, "note"),
    });
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    // The database refuses a decided review with no reviewer; surface that as
    // its own message rather than a generic failure, because it is the one
    // mistake an operator is most likely to make here.
    const message = String((e as Error).message ?? "");
    const code =
      e instanceof NotOperatorError
        ? "forbidden"
        : /needs a named reviewer|locale_release_.*_evidence/.test(message)
          ? "reviewer_required"
          : "failed";
    redirect(`${BASE}?error=${code}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=1`);
}
