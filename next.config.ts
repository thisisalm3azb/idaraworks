import type { NextConfig } from "next";

/**
 * Security headers per BUILD_BIBLE §6.8 / S0 checklist §14.
 * CSP note: script-src currently allows 'unsafe-inline' for the Next.js runtime;
 * nonce-based CSP is tracked as accepted debt (BUILD_BIBLE §16) — issue SEC-1.
 * Supabase storage/API hosts are appended via env when Phase B/E wire them.
 */
const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
  : "";

// Phase I: the Sentry BROWSER SDK posts events to the DSN's ingest origin —
// allow it in connect-src only when client-side Sentry is configured (OA-4).
const sentryIngest = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? new URL(process.env.NEXT_PUBLIC_SENTRY_DSN).origin
  : "";

const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // 'unsafe-eval' is dev-only (Next dev tooling); never shipped (review finding #13).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${supabaseHost}`.trim(),
  "font-src 'self'",
  `connect-src 'self' ${supabaseHost} ${sentryIngest}`.replace(/\s+/g, " ").trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), geolocation=(), microphone=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // pino + transport must not be bundled by Next (review finding #8a);
  // sharp's native binding must stay external for the serverless runtime (Phase E).
  serverExternalPackages: ["pino", "pino-pretty", "sharp"],
  // Deploy fix: Turbopack + pnpm misses sharp's linux-x64 native libs in a
  // function trace (libvips-cpp.so → ERR_DLOPEN_FAILED on Vercel;
  // vercel/vercel#14001, next.js discussion #83230). Force-include the platform
  // packages for EVERY route whose server code loads sharp (lazily or not).
  // Pairs with vercel.json's hoisted-linker install: the @img dirs must be REAL
  // top-level directories, because Vercel rejects function bundles containing
  // pnpm's symlinked store paths ("invalid deployment package"). Globs that
  // match nothing (e.g. linux dirs on a Windows dev machine) are inert.
  //
  // Sharp-caller → route map (grep processLogo/uploadLogo/processImage):
  //   /api/inngest ............... image-derivatives worker (processImage)
  //   /o/[orgId]/settings/branding uploadLogoAction → uploadLogo → processLogo
  //   /onboarding ................ BOTH the wizard logo stash
  //                                (uploadFlowLogoAction → stashDraftLogo →
  //                                processLogo) AND the confirm-time upload
  //                                (confirmFlowAction → runConfirmChain →
  //                                applyDraftBranding → uploadLogo → processLogo)
  // (watermarkImage also imports sharp but is not yet wired to any route.)
  outputFileTracingIncludes: {
    "/api/inngest": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
    // U2 branding: the logo upload server action re-encodes through sharp
    // (lazily imported) — the settings/branding route needs the same libs.
    "/o/[orgId]/settings/branding": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
    // U4 onboarding (DEFECT 2): the (auth)/onboarding route group resolves to
    // the public path "/onboarding". Its server actions run sharp in TWO places
    // — the branding-step logo stash and the final confirm-time upload — so this
    // function needs the native libs too, or the stash catch returns a generic
    // failure (the deployed-onboarding logo-upload bug).
    "/onboarding": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
  },
  // U2 branding: the logo upload server action carries up to a 2 MB image
  // (size/MIME/magic-byte/dimension validated server-side); the Next default
  // action body cap is 1 MB.
  experimental: {
    serverActions: { bodySizeLimit: "3mb" },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
