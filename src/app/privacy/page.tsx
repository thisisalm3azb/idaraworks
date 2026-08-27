import type { Metadata } from "next";
import { getServerLocale } from "@/platform/i18n/server";
import { legalDoc } from "../_legal/content";
import { LegalPage } from "../_legal/LegalPage";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  const doc = legalDoc("privacy", locale === "ar" ? "ar" : "en");
  return { title: `${doc.title} — IdaraWorks`, description: doc.intro, robots: { index: true } };
}

export default function PrivacyRoute() {
  return <LegalPage kind="privacy" />;
}
