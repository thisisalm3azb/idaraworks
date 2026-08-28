import type { MetadataRoute } from "next";

const CANONICAL = "https://www.idaraworks.com";

/** Sitemap (005A): the public surface only — the homepage and the two
 * public auth-funnel pages. Tenant/app routes are intentionally excluded. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: CANONICAL, changeFrequency: "monthly", priority: 1 },
    { url: `${CANONICAL}/login`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${CANONICAL}/signup`, changeFrequency: "yearly", priority: 0.5 },
    { url: `${CANONICAL}/terms`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${CANONICAL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
