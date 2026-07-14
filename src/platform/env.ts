/**
 * Canonical environment tag. The deployment contract (.env.example, Vercel prod env,
 * runbooks) uses APP_ENV ∈ { dev | preview | prod } — "prod" is the ONLY production value.
 *
 * S10 hardening fix: three provider seams (billing, e-invoice, AI narration) previously
 * gated their production "disabled" default on `APP_ENV === "production"`, a string that is
 * never set anywhere, so in production (APP_ENV=prod) the guard fell through to the FAKE
 * provider — fake ZATCA clearance, a fake billing checkout shown as enabled, fake narration.
 * Every "are we in production?" decision now routes through this single helper so the string
 * can never drift again.
 */
export function isProd(): boolean {
  return process.env.APP_ENV === "prod";
}

/** A deployed environment (prod or Vercel preview) — used where preview must behave like a real deploy. */
export function isDeployed(): boolean {
  return process.env.APP_ENV === "prod" || process.env.APP_ENV === "preview";
}
