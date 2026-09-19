import { redirect } from "next/navigation";
import { getSessionUser, listMyOrgs } from "@/platform/auth/resolve";
import { getDraft } from "@/modules/onboarding/service";

/**
 * Existing members never see the founder wizard (D7).
 *
 * The page below already redirects a member to their workspace, but the page
 * renders behind `loading.tsx`, so the redirect only reached the browser after
 * the wizard's skeleton had been streamed: a member opening /onboarding saw a
 * flash of an empty wizard before landing where they belonged. A layout has
 * no loading boundary above it, so deciding here turns that into a plain
 * redirect before anything of the wizard is sent. Signed-out visitors and a
 * founder mid-way through the wizard (a draft that already confirmed its
 * organisation) fall through to the page, which keeps its own rules.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (user) {
    const orgs = await listMyOrgs(user.id);
    if (orgs[0]) {
      const draft = await getDraft(user.id);
      const confirming = draft?.status === "active" && Boolean(draft.data.confirm.org_id);
      if (!confirming) redirect(`/o/${orgs[0].orgId}`);
    }
  }
  return children;
}
