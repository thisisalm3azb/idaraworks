/**
 * Pure logo-upload + accent-colour validation (U2 org branding) — no sharp, no
 * DB, unit-testable as a matrix. The service composes these with the image
 * pipeline (which is the second wall: undecodable bytes fail the re-encode).
 *
 * SVG is rejected OUTRIGHT (not on the whitelist and never sniffed): SVG is a
 * script-capable document format, not a bitmap — the platform does not accept
 * it anywhere (VC-4 re-encode law).
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const LOGO_MIN_EDGE_PX = 32;
export const LOGO_MAX_SOURCE_EDGE_PX = 2000;

export const LOGO_ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoMime = (typeof LOGO_ALLOWED_MIMES)[number];

export const ACCENT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export type LogoValidationError =
  | "too_large" // > LOGO_MAX_BYTES
  | "bad_type" // declared MIME not on the whitelist (SVG et al.)
  | "bad_signature" // magic bytes missing or contradict the declared MIME
  | "too_small_dims" // < LOGO_MIN_EDGE_PX on either edge
  | "too_large_dims"; // > LOGO_MAX_SOURCE_EDGE_PX on either edge

/** File-signature sniff, shared with the upload pipeline (platform/files/image). */
export function sniffImageMime(bytes: Uint8Array): LogoMime | null {
  return platformSniff(bytes) as LogoMime | null;
}

export type LogoBytesVerdict =
  { ok: true; mime: LogoMime } | { ok: false; error: LogoValidationError };

/** Size + declared-MIME whitelist + magic-byte agreement (dimensions are
 * checked after decode via checkLogoDimensions). */
export function validateLogoBytes(bytes: Uint8Array, declaredMime: string): LogoBytesVerdict {
  if (!(LOGO_ALLOWED_MIMES as readonly string[]).includes(declaredMime)) {
    return { ok: false, error: "bad_type" };
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    return { ok: false, error: "too_large" };
  }
  const sniffed = sniffImageMime(bytes);
  if (sniffed === null || sniffed !== declaredMime) {
    return { ok: false, error: "bad_signature" };
  }
  return { ok: true, mime: sniffed };
}

/** Decoded-dimension bounds: ≥32×32 (legible) and ≤2000×2000 (sane source). */
export function checkLogoDimensions(
  width: number | undefined,
  height: number | undefined,
): LogoValidationError | null {
  if (!width || !height || width < LOGO_MIN_EDGE_PX || height < LOGO_MIN_EDGE_PX) {
    return "too_small_dims";
  }
  if (width > LOGO_MAX_SOURCE_EDGE_PX || height > LOGO_MAX_SOURCE_EDGE_PX) {
    return "too_large_dims";
  }
  return null;
}
import { sniffImageMime as platformSniff } from "@/platform/files/image";
