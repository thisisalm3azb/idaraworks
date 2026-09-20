import type { InstallHelpLabels, InstallLabels, Route } from "../InstallApp";

/** Every browser route the install help can name, in one place. */
export const INSTALL_ROUTES: readonly Route[] = [
  "chrome_desktop",
  "edge_desktop",
  "chrome_android",
  "edge_android",
  "samsung_android",
  "firefox_android",
  "ios_safari",
  "chrome_ios",
  "firefox_ios",
  "edge_ios",
  "ios_other",
  "mac_safari",
  "firefox_desktop",
  "other",
];

/**
 * The install help copy, resolved on the server: a state line, the browser's
 * own three steps, and the small notes. Shared by the Company app settings
 * page, the members' Install page and the mobile banner's guide.
 */
export function installHelpLabels(t: (key: string) => string): InstallHelpLabels {
  return {
    stateInstalled: t("app.help.state_installed"),
    stateNotInstalled: t("app.help.state_not_installed"),
    promptAvailable: t("app.help.prompt_available"),
    promptDismissed: t("app.help.prompt_dismissed"),
    menuIntro: t("app.help.menu_intro"),
    afterUninstall: t("app.help.after_uninstall"),
    refreshIcon: t("app.help.refresh_icon"),
    cannotConfirm: t("app.help.cannot_confirm"),
    guideTitle: t("app.help.guide_title"),
    done: t("app.help.done"),
    routes: Object.fromEntries(
      INSTALL_ROUTES.map((r) => [
        r,
        {
          browser: t(`app.help.browser.${r}`),
          steps: [1, 2, 3].map((n) => t(`app.help.steps.${r}.${n}`)),
        },
      ]),
    ) as InstallHelpLabels["routes"],
  };
}

/** The labels every InstallApp variant needs. */
export function installLabels(t: (key: string) => string): InstallLabels {
  return {
    install: t("app.install"),
    installed: t("app.installed"),
    ios: t("app.install_ios"),
    macSafari: t("app.install_mac_safari"),
    firefox: t("app.install_firefox"),
    generic: t("app.install_generic"),
    later: t("app.install_later"),
    never: t("app.install_never"),
    help: installHelpLabels(t),
  };
}
