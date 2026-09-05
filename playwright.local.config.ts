import base from "./playwright.config";

/**
 * Local-only variant: same projects and baseURL, but NO managed webServer.
 *
 * The base config starts `pnpm start` (a production build) on port 3000. For
 * the H32 signed-in walk the server must be `next dev` with the ISOLATED TEST
 * project's env exported and FEATURE_GUIDED_ONBOARDING=1, started by hand —
 * a production build would have inlined whatever NEXT_PUBLIC_SUPABASE_URL was
 * present at build time, and that must never be production for this walk.
 *
 * Untracked on purpose; CI keeps using playwright.config.ts.
 */
const { webServer: _ignored, ...rest } = base;
void _ignored;

export default rest;
