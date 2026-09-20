/**
 * Structured data for the public homepage. Verified facts only: the
 * organisation and site names, the canonical URL, the interface languages this
 * deployment offers, and that the product is a web application with a free
 * plan at zero cost (the one price the typed pricing source states). No
 * ratings, review counts, awards or customer figures.
 */
export function JsonLd({
  canonical,
  languages,
  freePriceUsd,
  nonce,
}: {
  canonical: string;
  languages: readonly string[];
  freePriceUsd: number;
  /** The per-request nonce minted by middleware, so the staged nonce policy sees this script as ours. */
  nonce?: string;
}) {
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "IdaraWorks",
      url: canonical,
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "IdaraWorks",
      url: canonical,
      inLanguage: languages,
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "IdaraWorks",
      url: canonical,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web browser",
      offers: {
        "@type": "Offer",
        price: String(freePriceUsd),
        priceCurrency: "USD",
      },
    },
  ];
  // A JSON-LD script must carry raw JSON: React's text escaping would turn the
  // quotes into entities. The payload is static, server-authored, contains no
  // user input, and `<` is escaped so no value can close the element early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    // eslint-disable-next-line react/no-danger -- static JSON-LD, see above
    <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: json }} />
  );
}
