import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { LOCALE_COOKIE, directionFor, normalizeLocale } from "@/platform/i18n";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IdaraWorks",
  description: "The operations management system for project-based industrial teams.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Root layout. lang/dir are locale-driven (Phase F): the `locale` cookie (set
 * from the user's profile once known) selects the language; Arabic renders RTL
 * (BUILD_BIBLE §9.11). Primitives use logical properties only, so the whole
 * tree flips direction with this one attribute.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html
      lang={locale}
      dir={directionFor(locale)}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
