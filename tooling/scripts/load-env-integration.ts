/**
 * Environment for the INTEGRATION suite.
 *
 * Deliberately does NOT load `.env.local`. That file holds the production
 * project's credentials, and loading it is what pointed every local integration
 * run at the live database. The suite creates and deletes organizations, so its
 * credentials must be supplied on purpose:
 *
 *   - CI exports DIRECT_URL / DATABASE_URL from its own `supabase start` stack.
 *     dotenv never overwrites a variable that is already set, so CI is untouched.
 *   - Locally, put a throwaway project's credentials in `.env.test.local`
 *     (gitignored), or run `supabase start` and use `.env.test`.
 *
 * `.env` is still read last for non-secret defaults shared with the app.
 */
import { config } from "dotenv";

config({ path: [".env.test.local", ".env.test", ".env"], quiet: true });
