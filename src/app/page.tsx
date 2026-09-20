import type { Metadata } from "next";
import { getSessionUser } from "@/platform/auth/resolve";
import { getServerLocale } from "@/platform/i18n/server";
import { languageListFor } from "@/platform/i18n/offered";
import { t } from "@/platform/i18n";
import { resolveLanding } from "./(auth)/actions";
import { HomePage } from "./_home/HomePage";

const CANONICAL = "https://www.idaraworks.com";

/**
 * Root `/` — the public IdaraWorks homepage. Rendered for everyone: signed-out
 * visitors get Start free / Log in; an authenticated visitor gets an "Open
 * workspace" action (resolveLanding → their workspace or onboarding), never
 * forced back through registration.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  const title = t("home.meta.title", undefined, locale);
  const description = t("home.meta.description", { languages: languageListFor(locale) }, locale);
  // The social preview is rendered by app/opengraph-image.tsx from the same
  // headline; Next wires its URL and dimensions into the tags automatically.
  return {
    title,
    description,
    alternates: { canonical: CANONICAL },
    openGraph: {
      type: "website",
      siteName: "IdaraWorks",
      title,
      description,
      url: CANONICAL,
      locale: locale === "ar" ? "ar_AE" : locale === "es" ? "es_ES" : "en_US",
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

export default async function Home() {
  const user = await getSessionUser();
  const workspaceHref = user ? await resolveLanding() : null;
  return <HomePage workspaceHref={workspaceHref} />;
}
