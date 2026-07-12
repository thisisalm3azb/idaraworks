/**
 * Request/correlation id (Phase I; BUILD_BIBLE §15.3, §8.4).
 *
 * The id is GENERATED in middleware for every matched request and propagated
 * via the `x-request-id` request header; the same value is echoed on the
 * response so a user-reported failure can be correlated with server logs.
 * Inbound client-supplied values are deliberately IGNORED (a client-chosen id
 * could spoof/pollute log correlation); the id is always server-minted.
 *
 * Routes outside the middleware matcher (health/ready/static) mint their own.
 */
import { headers } from "next/headers";

export const REQUEST_ID_HEADER = "x-request-id";

// Web Crypto global — available in Node ≥19 and the edge runtime alike, so this
// module is safe to import from middleware (edge bundle: no node: imports here).
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * The current request's correlation id (server components, actions, route
 * handlers). Falls back to a fresh id when the request bypassed middleware.
 */
export async function currentRequestId(): Promise<string> {
  const h = await headers();
  return h.get(REQUEST_ID_HEADER) ?? newRequestId();
}
