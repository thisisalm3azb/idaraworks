/**
 * OAuth availability flag (S10). Lives OUTSIDE the "use server" actions module because that file may
 * only export async functions — this is a plain sync helper imported by both the action and the UI.
 * CREDENTIAL-GATED: OAuth buttons show + the sign-in action runs only when OAUTH_ENABLED=true AND the
 * provider is configured in the Supabase project (owner action). Default off.
 */
export function oauthEnabled(): boolean {
  return process.env.OAUTH_ENABLED === "true";
}
