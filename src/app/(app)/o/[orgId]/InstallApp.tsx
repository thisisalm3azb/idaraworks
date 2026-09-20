"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@/platform/ui";

/**
 * H31 — the install affordance, and the service-worker registration.
 *
 * ── The two rules that shape this ────────────────────────────────────────────
 * 1. Never nag. The browser gives us one `beforeinstallprompt` event and it is
 *    tempting to fire it immediately, on every page. The mobile banner is one
 *    compact card, "Not now" hides it for two weeks on that device, and the
 *    permanent entry lives in the account menu and on the Install page.
 * 2. Never pretend. Firefox cannot install a web app from a manifest, iOS has
 *    no programmatic prompt at all, and a website cannot tell whether the
 *    person finished the browser's own dialog. So the copy separates "opened
 *    the instructions" from "installed", and "no prompt" is never read as
 *    "already installed".
 *
 * ── Platform facts the routes are written from (2026-09-20) ─────────────────
 * iOS and iPadOS 16.4+: Safari, Chrome, Firefox and Edge can all add a web app
 * to the Home Screen from their own Share menu, and the icon opens as a web
 * app whichever browser added it (WebKit release notes). Chrome on Android:
 * menu → "Install and create shortcut" → Install (Chrome Help; older versions
 * say "Add to Home screen" or "Install app"); Chrome also fires
 * `beforeinstallprompt`, which is the direct Install button here.
 *
 * Platform detection decides only which SENTENCES to show. It never decides
 * what the user may do — the browser does that.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type Route =
  | "chrome_desktop"
  | "edge_desktop"
  | "chrome_android"
  | "edge_android"
  | "samsung_android"
  | "firefox_android"
  | "ios_safari"
  | "chrome_ios"
  | "firefox_ios"
  | "edge_ios"
  | "ios_other"
  | "mac_safari"
  | "firefox_desktop"
  | "other";

/** The exact menu route for the browser and system in use. Read once; never sent anywhere. */
export function detectRoute(ua: string, maxTouchPoints = 0): Route {
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (isIOS) {
    if (/CriOS\//.test(ua)) return "chrome_ios";
    if (/FxiOS\//.test(ua)) return "firefox_ios";
    if (/EdgiOS\//.test(ua)) return "edge_ios";
    // In-app browsers (Instagram, Facebook, LINE, WeChat…) have no Add to Home
    // Screen of their own; the shortest route is to open the page in Safari.
    if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|GSA\//.test(ua)) return "ios_other";
    if (/Safari\//.test(ua)) return "ios_safari";
    return "ios_other";
  }
  const android = /Android/.test(ua);
  if (/Firefox\//.test(ua)) return android ? "firefox_android" : "firefox_desktop";
  if (android) {
    if (/SamsungBrowser\//.test(ua)) return "samsung_android";
    if (/EdgA\//.test(ua)) return "edge_android";
    if (/Chrome\//.test(ua)) return "chrome_android";
    return "other";
  }
  if (/Edg\//.test(ua)) return "edge_desktop";
  if (/Chrome\/|Chromium\//.test(ua) && !/OPR\//.test(ua)) return "chrome_desktop";
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return "mac_safari";
  return "other";
}

/** True when the page is already running as an installed app. */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // Safari's own flag, which predates the standard media query.
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

export type InstallHelpLabels = {
  stateInstalled: string;
  stateNotInstalled: string;
  promptAvailable: string;
  promptDismissed: string;
  menuIntro: string;
  afterUninstall: string;
  refreshIcon: string;
  cannotConfirm: string;
  guideTitle: string;
  done: string;
  routes: Record<Route, { browser: string; steps: string[] }>;
};

export type InstallLabels = {
  install: string;
  installed: string;
  ios: string;
  macSafari: string;
  firefox: string;
  generic: string;
  later: string;
  never: string;
  /** Present on the settings and install pages, and on the banner. */
  help?: InstallHelpLabels;
};

export type InstallBannerLabels = {
  title: string; // "Install {org} on this phone" already resolved
  body: string;
  how: string;
  later: string;
  close: string;
};

/** Which glyph each step of a route shows. Kept in code: it is UI shape, not copy. */
const ROUTE_GLYPHS: Record<Route, [Glyph, Glyph, Glyph]> = {
  ios_safari: ["share", "addhome", "check"],
  chrome_ios: ["share", "addhome", "check"],
  edge_ios: ["dots", "share", "addhome"],
  firefox_ios: ["dots", "share", "addhome"],
  ios_other: ["compass", "share", "addhome"],
  chrome_android: ["dots", "install", "check"],
  edge_android: ["dots", "install", "check"],
  samsung_android: ["menu", "addhome", "check"],
  firefox_android: ["dots", "addhome", "check"],
  chrome_desktop: ["install", "dots", "check"],
  edge_desktop: ["dots", "install", "check"],
  mac_safari: ["compass", "install", "check"],
  firefox_desktop: ["info", "compass", "info"],
  other: ["menu", "install", "compass"],
};

type Glyph = "share" | "addhome" | "check" | "dots" | "menu" | "install" | "compass" | "info";

/** Small, current-colour glyphs for the visual guide. */
function StepGlyph({ name }: { name: Glyph }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "share":
      return (
        <svg {...common}>
          <path d="M12 3v12" />
          <path d="m8 7 4-4 4 4" />
          <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
        </svg>
      );
    case "addhome":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 3 3 5-6" />
        </svg>
      );
    case "dots":
      return (
        <svg {...common}>
          <circle cx="12" cy="5" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case "install":
      return (
        <svg {...common}>
          <path d="M12 4v10" />
          <path d="m8 10 4 4 4-4" />
          <path d="M4 18h16" />
        </svg>
      );
    case "compass":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m15 9-2 5-4 2 2-5z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      );
  }
}

/** The three-step visual guide for one route: an icon and a short phrase each. */
export function InstallGuide({
  route,
  help,
  compact = false,
}: {
  route: Route;
  help: InstallHelpLabels;
  compact?: boolean;
}) {
  const r = help.routes[route];
  const glyphs = ROUTE_GLYPHS[route];
  return (
    <div data-install-guide data-install-route={route}>
      <p className="text-sm font-medium text-ink">
        {help.menuIntro} <span className="text-ink-secondary">({r.browser})</span>
      </p>
      <ol className={`mt-3 flex flex-col ${compact ? "gap-2" : "gap-3"}`}>
        {r.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-card text-ink"
            >
              <StepGlyph name={glyphs[i] ?? "info"} />
            </span>
            <span className="min-w-0 pt-1.5 text-sm leading-snug text-ink">
              <span className="me-1.5 text-xs font-semibold text-ink-muted">{i + 1}.</span>
              {step}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-muted">{help.cannotConfirm}</p>
    </div>
  );
}

const SNOOZE_DAYS = 14;

export function InstallApp({
  orgId,
  labels,
  variant = "chrome",
  banner,
  leading,
}: {
  orgId: string;
  labels: InstallLabels;
  /** chrome = quiet header button; settings = persistent help entry; banner = the mobile card. */
  variant?: "chrome" | "settings" | "banner";
  /** Banner copy (variant "banner" only). */
  banner?: InstallBannerLabels;
  /** The company mark shown at the start of the banner (server-rendered). */
  leading?: ReactNode;
}) {
  /*
   * Device facts are read LAZILY on first render rather than set from an
   * effect. `useState(fn)` runs the initialiser once, on the client, after
   * hydration — so the server still renders the neutral default and no
   * cascading re-render is triggered by writing state inside an effect.
   */
  const [route] = useState<Route>(() =>
    typeof navigator === "undefined"
      ? "other"
      : detectRoute(navigator.userAgent, navigator.maxTouchPoints ?? 0),
  );
  const [standalone, setStandalone] = useState<boolean>(() => isStandalone());
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem(`idaraworks.install.dismissed.${orgId}`) === "1") return true;
      // The banner's "Not now" rests for a fortnight on this device.
      const snoozed = Number(window.localStorage.getItem(`idaraworks.install.snooze.${orgId}`));
      return Number.isFinite(snoozed) && snoozed > Date.now();
    } catch {
      // Private browsing can throw on any storage access. A missing preference
      // must not break the button.
      return false;
    }
  });
  const [open, setOpen] = useState(false);

  const dismissKey = `idaraworks.install.dismissed.${orgId}`;

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Suppressing the browser's own banner is the point: it appears at a
      // moment the browser chooses, and we would rather choose it.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setStandalone(true);
      try {
        window.localStorage.setItem(dismissKey, "1");
      } catch {
        // nothing to do
      }
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [dismissKey]);

  /*
   * Registering the worker from the install affordance rather than a global
   * effect keeps it inside the flag: this component only renders when the
   * server decided the feature is on for this organisation.
   */
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // A worker that will not register costs an offline screen, nothing more.
    });
  }, []);

  const canPromptDirectly = deferred !== null;

  const doInstall = async () => {
    if (!deferred) {
      setOpen(true);
      return;
    }
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    if (choice.outcome === "accepted") setStandalone(true);
    else setPromptDismissed(true);
  };

  const snooze = () => {
    try {
      window.localStorage.setItem(
        `idaraworks.install.snooze.${orgId}`,
        String(Date.now() + SNOOZE_DAYS * 86_400_000),
      );
    } catch {
      // the preference simply will not persist
    }
    setDismissed(true);
  };

  const remember = () => {
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // Nothing to do: the preference simply will not persist.
    }
    setDismissed(true);
    setOpen(false);
  };

  // ── The mobile banner: one compact card near the top of the workspace ─────
  if (variant === "banner" && labels.help && banner) {
    if (standalone || dismissed) return null;
    const help = labels.help;
    return (
      <div
        data-install-banner
        role="region"
        aria-label={banner.title}
        className="mb-4 flex flex-col gap-2 rounded-md border border-line bg-card px-3 py-2.5 shadow-card"
      >
        {/* Identity row: the company's own mark and name, and the way out. */}
        <div className="flex items-center gap-2">
          {leading ? <div className="min-w-0 flex-1">{leading}</div> : null}
          {!leading ? (
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{banner.title}</p>
          ) : null}
          <button
            type="button"
            onClick={snooze}
            aria-label={banner.later}
            className="grid size-11 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
          >
            <span aria-hidden className="text-lg leading-none">
              ×
            </span>
          </button>
        </div>
        {/* One line of why, and one action. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-40">
            {leading ? <p className="text-sm font-medium text-ink">{banner.title}</p> : null}
            <p className="text-xs text-ink-secondary">
              {promptDismissed ? help.promptDismissed : banner.body}
            </p>
          </div>
          {canPromptDirectly ? (
            <button
              type="button"
              onClick={doInstall}
              className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse"
            >
              {labels.install}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
            >
              {banner.how}
            </button>
          )}
        </div>
        <Dialog
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          title={help.guideTitle}
          closeLabel={banner.close}
        >
          <InstallGuide route={route} help={help} />
          <button
            type="button"
            onClick={() => setGuideOpen(false)}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse"
          >
            {help.done}
          </button>
        </Dialog>
      </div>
    );
  }

  // ── The settings / install page: a persistent help entry ───────────────────
  if (variant === "settings" && labels.help) {
    const help = labels.help;
    return (
      <div className="flex flex-col gap-3" data-install-help data-install-route={route}>
        <p className="text-sm font-medium text-ink" role="status">
          {standalone ? help.stateInstalled : help.stateNotInstalled}
        </p>
        {!standalone && canPromptDirectly ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-secondary">{help.promptAvailable}</p>
            <button
              type="button"
              onClick={doInstall}
              className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-ink-inverse"
            >
              {labels.install}
            </button>
          </div>
        ) : null}
        {promptDismissed ? (
          <p className="text-sm text-ink-secondary" role="status">
            {help.promptDismissed}
          </p>
        ) : null}
        {!standalone ? (
          <div className="rounded-md border border-line bg-sunken p-3">
            <InstallGuide route={route} help={help} />
            {route === "chrome_android" ||
            route === "edge_android" ||
            route === "chrome_desktop" ||
            route === "edge_desktop" ? (
              <p className="mt-2 text-xs text-ink-muted">{help.afterUninstall}</p>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">{help.refreshIcon}</p>
      </div>
    );
  }

  // ── The quiet header button (sm+): unchanged behaviour ─────────────────────
  if (standalone) {
    return variant === "settings" ? (
      <p className="text-sm text-ink-secondary">{labels.installed}</p>
    ) : null;
  }
  if (variant === "chrome" && dismissed) return null;

  const guidance =
    route === "ios_safari" ||
    route === "chrome_ios" ||
    route === "edge_ios" ||
    route === "firefox_ios" ||
    route === "ios_other"
      ? labels.ios
      : route === "mac_safari"
        ? labels.macSafari
        : route === "firefox_desktop" || route === "firefox_android"
          ? labels.firefox
          : labels.generic;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={doInstall}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-sm font-medium text-ink hover:bg-sunken"
        >
          {labels.install}
        </button>
        {variant === "chrome" ? (
          <button
            type="button"
            onClick={remember}
            className="min-h-11 rounded-md px-2 text-sm text-ink-muted hover:text-ink"
          >
            {labels.never}
          </button>
        ) : null}
      </div>
      {/* Guidance appears only when there is no real prompt to offer, so a
          Chromium user is never told to hunt through a menu they do not need. */}
      {open && !canPromptDirectly ? (
        <p className="max-w-prose text-sm text-ink-secondary" role="status">
          {guidance}
        </p>
      ) : null}
    </div>
  );
}
