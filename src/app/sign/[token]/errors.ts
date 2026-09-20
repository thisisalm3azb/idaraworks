import { ZodError } from "zod";
import { logger } from "@/platform/logger";
import { DocError } from "@/modules/docstudio/service";

/**
 * The closed set of failure codes the public signing page renders (security
 * review 2026-09-20, F-26). The page is reachable by anyone holding a link,
 * so the `?error=` value it shows must never be free text: a raw message from
 * the database or the runtime would disclose internals, and any string a
 * third party put in the URL would render as if the site had said it.
 */
export const SIGN_ERROR_CODES = ["invalid", "closed", "conflict", "forbidden", "failed"] as const;
export type SignErrorCode = (typeof SIGN_ERROR_CODES)[number];

export function isSignErrorCode(v: string | undefined): v is SignErrorCode {
  return v !== undefined && (SIGN_ERROR_CODES as readonly string[]).includes(v);
}

export function signErrorCode(err: unknown): SignErrorCode {
  if (err instanceof ZodError) return "invalid";
  if (err instanceof DocError) {
    switch (err.code) {
      case "validation":
        return "invalid";
      case "conflict":
        return "conflict";
      case "forbidden":
        return "forbidden";
      default:
        return "closed";
    }
  }
  logger.error(
    { err: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err) },
    "public signing action failed",
  );
  return "failed";
}
