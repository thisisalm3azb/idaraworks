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

const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // 'unsafe-eval' is dev-only (Next dev tooling); never shipped (review finding #13).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${supabaseHost}`.trim(),
  "font-src 'self'",
  `connect-src 'self' ${supabaseHost}`.trim(),
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
  // Deploy fix: Turbopack + pnpm misses sharp's linux-x64 native libs in the
  // /api/inngest function trace (libvips-cpp.so → ERR_DLOPEN_FAILED on Vercel;
  // vercel/vercel#14001, next.js discussion #83230). Force-include the platform
  // packages for the one route that loads sharp (image-derivatives worker).
  // Globs that match nothing (e.g. linux dirs on a Windows dev machine) are inert.
  outputFileTracingIncludes: {
    "/api/inngest": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
      "./node_modules/.pnpm/@img+sharp-linux-x64@*/**/*",
      "./node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/**/*",
    ],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
