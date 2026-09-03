/**
 * H29 — the adapter registry. Closed, like every other registry here: a new
 * authority lands in this file, not in a database row an ordinary user can add.
 */
import { zatcaAdapter } from "./adapters/zatca";
import { uaePeppolAdapter } from "./adapters/uae-peppol";
import type { EInvoiceAdapter } from "./adapters/types";

export const EINVOICE_ADAPTERS: readonly EInvoiceAdapter[] = [
  zatcaAdapter,
  uaePeppolAdapter,
] as const;

export function adapterFor(key: string): EInvoiceAdapter | null {
  return EINVOICE_ADAPTERS.find((a) => a.key === key) ?? null;
}

export function adaptersForCountry(country: string): EInvoiceAdapter[] {
  return EINVOICE_ADAPTERS.filter((a) => a.countries.includes(country));
}

/**
 * Whether a credential NAME resolves to a value in this deployment.
 *
 * The name is stored and shown; the value is read here and nowhere else, and is
 * never returned, logged or put in an audit summary. An empty variable counts
 * as absent, which is what makes a half-configured deployment fail closed
 * instead of trying.
 */
export function credentialPresent(
  credentialRef: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!credentialRef) return false;
  const value = env[credentialRef];
  return typeof value === "string" && value.trim().length > 0;
}
