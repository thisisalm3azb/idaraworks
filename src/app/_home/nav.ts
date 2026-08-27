/**
 * Public-homepage navigation contract (005A) — a pure function so the routing
 * rules are unit-testable without rendering the async server tree:
 *  - Get Started routes to the real registration route (/signup);
 *  - Log in routes to /login;
 *  - an authenticated visitor gets "Open workspace" → their resolved landing,
 *    and no "Log in" (they are not sent back through registration);
 *  - section links target the on-page anchors.
 */
export const SIGNUP_HREF = "/signup";
export const LOGIN_HREF = "/login";

export type HomeCta = { href: string; label: string };

export function homeNav(
  t: (k: string) => string,
  workspaceHref: string | null,
): {
  authed: boolean;
  primary: HomeCta;
  secondary: HomeCta | null;
  sections: HomeCta[];
} {
  const authed = workspaceHref !== null;
  const primary: HomeCta = authed
    ? { href: workspaceHref, label: t("home.nav.open_workspace") }
    : { href: SIGNUP_HREF, label: t("home.nav.get_started") };
  const secondary: HomeCta | null = authed
    ? null
    : { href: LOGIN_HREF, label: t("home.nav.login") };
  // Section links in the PAGE'S reading order (H2): flow → capabilities →
  // international → pricing, so the nav teaches the page's own structure.
  const sections: HomeCta[] = [
    { href: "#how", label: t("home.nav.how") },
    { href: "#product", label: t("home.nav.product") },
    { href: "#international", label: t("home.nav.international") },
    { href: "#pricing", label: t("home.nav.pricing") },
  ];
  return { authed, primary, secondary, sections };
}
