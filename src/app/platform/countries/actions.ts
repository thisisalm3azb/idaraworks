"use server";

/**
 * H29 — recording what review a country-pack version has had. Operator-only.
 *
 * Same shape as the language centre: verify the session, then let the database
 * decide. `app.country_pack_review_set` asserts an active platform operator and
 * writes its own audit entry.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/platform/auth/resolve";
import { isPlatformOperator, NotOperatorError } from "@/platform/ai";
import { countryPacksEnabled } from "@/platform/flags";
import { REVIEW_KINDS, REVIEW_STATES } from "@/platform/country";
import { setPackReview } from "@/platform/country/reviews";

const BASE = "/platform/countries";

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

export async function setPackReviewAction(fd: FormData): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    await setPackReview(userId, {
      packKey: z.string().min(1).max(40).parse(str(fd, "packKey")),
      kind: z.enum(REVIEW_KINDS).parse(str(fd, "kind")),
      state: z.enum(REVIEW_STATES).parse(str(fd, "state")),
      reviewer: str(fd, "reviewer"),
      note: str(fd, "note"),
    });
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    const message = String((e as Error).message ?? "");
    const code =
      e instanceof NotOperatorError
        ? "forbidden"
        : /needs a named reviewer/.test(message)
          ? "reviewer_required"
          : "failed";
    redirect(`${BASE}?error=${code}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=1`);
}
