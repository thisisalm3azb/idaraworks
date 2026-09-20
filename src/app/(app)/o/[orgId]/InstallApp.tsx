"use client";

import { useEffect, useState } from "react";

/**
 * H31 — the install affordance, and the service-worker registration.
 *
 * ── The two rules that shape this ────────────────────────────────────────────
 * 1. Never nag. The browser gives us one `beforeinstallprompt` event and it is
 *    tempting to fire it immediately, on every page. That is the pattern people
 *    have learned to dismiss without reading. The floating affordance is a quiet
 *    button, and "don't remind me" is honoured permanently on that device.
 * 2. Never pretend. Firefox cannot install a web app from a manifest, and iOS
 *    has no programmatic prompt at all. Telling a Firefox user to "click
 *    install" when no install exists, or showing Windows instructions on an
 *    iPhone, is worse than saying nothing.
 *
 * ── The settings page is different (owner, 2026-09-20) ──────────────────────
 * "Sometimes it opens installation, sometimes it shows a brief instruction and
 * disappears. On mobile Chrome I cannot find how to install." The browser's own
 * prompt is a courtesy that comes and goes: Chrome withholds it for a while
 * after an uninstall, Safari never has it, and a dismissed prompt cannot be
 * shown again. So the Company app page always keeps a HELP entry: whether this
 * device has the app installed, the direct Install button when the browser
 * offers one, and the menu route for the browser and system actually in use,
 * which works whether or not the automatic prompt exists.
 *
 * Platform detection here decides only which SENTENCES to show. It never
 * decides what the user may do — the browser does that.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "chromium" | "ios" | "mac-safari" | "firefox" | "other";
type Route =
  | "chrome_desktop"
  | "edge_desktop"
  | "chrome_android"
  | "samsung_android"
  | "firefox_android"
  | "ios_safari"
  | "mac_safari"
  | "firefox_desktop"
  | "other";

/** Which sentence this device needs. Read once; never sent anywhere. */
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) &&
      typeof navigator.maxTouchPoints === "number" &&
      navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (/Firefox\//.test(ua)) return "firefox";
  // Chromium sets this; Safari does not. Cheaper and more honest than parsing
  // a user-agent string that every browser lies in.
  if (/Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return "mac-safari";
  return "other";
}

/** The exact menu route for the browser and system in use. */
function detectRoute(): Route {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const platform = detectPlatform();
  const android = /Android/.test(ua);
  if (platform === "ios") return "ios_safari";
  if (platform === "mac-safari") return "mac_safari";
  if (platform === "firefox") return android ? "firefox_android" : "firefox_desktop";
  if (platform === "chromium") {
    if (/SamsungBrowser\//.test(ua)) return "samsung_android";
    if (android) return "chrome_android";
    if (/Edg\//.test(ua)) return "edge_desktop";
    return "chrome_desktop";
  }
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
  /** Present on the settings page: the persistent help entry. */
  help?: InstallHelpLabels;
};

export function InstallApp({
  orgId,
  labels,
  /** Rendered inline in a settings page rather than as a floating affordance. */
  variant = "chrome",
}: {
  orgId: string;
  labels: InstallLabels;
  variant?: "chrome" | "settings";
}) {
  /*
   * Device facts are read LAZILY on first render rather than set from an
   * effect. `useState(fn)` runs the initialiser once, on the client, after
   * hydration — so the server still renders the neutral default and no
   * cascading re-render is triggered by writing state inside an effect.
   */
  const [platform] = useState<Platform>(() => detectPlatform());
  const [route] = useState<Route>(() => detectRoute());
  const [standalone, setStandalone] = useState<boolean>(() => isStandalone());
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      // Per device and per organisation: a user who declined for one company
      // has said nothing about another.
      return window.localStorage.getItem(`idaraworks.install.dismissed.${orgId}`) === "1";
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
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

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

  const remember = () => {
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // Nothing to do: the preference simply will not persist.
    }
    setDismissed(true);
    setOpen(false);
  };

  // ── The settings page: a persistent help entry ────────────────────────────
  if (variant === "settings" && labels.help) {
    const help = labels.help;
    const r = help.routes[route];
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
              className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse hover:bg-brand-strong"
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
            <p className="text-sm font-medium text-ink">
              {help.menuIntro} <span className="text-ink-secondary">({r.browser})</span>
            </p>
            <ol className="mt-1 flex list-decimal flex-col gap-0.5 ps-5 text-sm text-ink">
              {r.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            {route === "chrome_android" ||
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

  // ── The floating affordance (layout): quiet, dismissable ──────────────────
  if (standalone) {
    return variant === "settings" ? (
      <p className="text-sm text-ink-secondary">{labels.installed}</p>
    ) : null;
  }
  if (variant === "chrome" && dismissed) return null;

  const guidance =
    platform === "ios"
      ? labels.ios
      : platform === "mac-safari"
        ? labels.macSafari
        : platform === "firefox"
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
      {(open || variant === "settings") && !canPromptDirectly ? (
        <p className="max-w-prose text-sm text-ink-secondary" role="status">
          {guidance}
        </p>
      ) : null}
    </div>
  );
}
