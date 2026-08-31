import type { MetadataRoute } from "next";

const CANONICAL = "https://www.idaraworks.com";

/**
 * Robots policy (005A): the public homepage and the marketing-funnel auth
 * pages may be indexed; every authenticated/tenant and private path stays out
 * of the index (defence-in-depth alongside per-page noindex on /s/[token]).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/o/",
          "/account",
          "/onboarding",
          "/mfa",
          "/invite/",
          "/reset-password",
          "/d/",
          "/s/",
          "/api/",
          "/auth/",
        ],
      },
    ],
    sitemap: `${CANONICAL}/sitemap.xml`,
    host: CANONICAL,
  };
}
