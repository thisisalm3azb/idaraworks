/**
 * Public-homepage navigation contract, a pure function so the routing rules are
 * unit-testable without rendering the async server tree:
 *  - Start free routes to the real registration route (/signup);
 *  - Log in routes to /login;
 *  - an authenticated visitor gets "Open workspace" → their resolved landing,
 *    and no "Log in" (they are not sent back through registration);
 *  - section links target the on-page anchors in the page's reading order:
 *    the platform depth, the interactive demo, the company app, the trial.
 */
export const SIGNUP_HREF = "/signup";
export const LOGIN_HREF = "/login";

/** On-page anchors. One list, so header, footer and tests agree. */
export const ANCHORS = {
  platform: "#platform",
  demo: "#try-it",
  app: "#company-app",
  start: "#getting-started",
  plans: "#plans",
  questions: "#questions",
  trial: "#trial",
} as const;

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
  const sections: HomeCta[] = [
    { href: ANCHORS.platform, label: t("home.nav.platform") },
    { href: ANCHORS.demo, label: t("home.nav.demo") },
    { href: ANCHORS.app, label: t("home.nav.app") },
    { href: ANCHORS.trial, label: t("home.nav.trial") },
  ];
  return { authed, primary, secondary, sections };
}
