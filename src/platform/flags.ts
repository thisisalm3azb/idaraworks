/**
 * Release gates — "is this surface finished?", NOT "has this org paid?".
 *
 * Those two questions look identical and are not. Entitlements are commercial:
 * the capability exists, works, and is sold. A release gate says the opposite —
 * the code is here, it has not been verified end to end yet, and no customer
 * should meet it by accident. Answering the second question with the first is
 * how half-built screens reach paying users with a price tag attached.
 *
 * H22 builds the stock and asset system in slices, and the standing instruction
 * for the whole phase is that inventory stays unavailable until the entire
 * system is functional and verified. So: DEFAULT OFF, everywhere, including
 * development — a flag that is on by default in dev is a flag nobody notices is
 * still off in production. One environment variable, one meaning, opt in.
 *
 * `addon.inventory_stock` stays `availability: "deferred"` in the catalogue
 * while this is off, which is what the pricing page tells the public.
 */

/**
 * The H22 stock and asset screens.
 *
 * Off unless `FEATURE_STOCK_SURFACES=1`. When off, the navigation has no entry
 * and the routes themselves answer 404 — the gate is enforced at the page, not
 * only in the menu, because a menu is not a permission.
 */
export function stockSurfacesEnabled(): boolean {
  return process.env.FEATURE_STOCK_SURFACES === "1";
}

/**
 * The H23 HR, leave, claims and payroll screens.
 *
 * Same law as the stock gate: off unless , exactly
 * that spelling; when off the navigation has no entries and the routes answer
 * 404. Pay data reaching users through a half-verified screen is worse than a
 * late feature.
 */
export function hrSurfacesEnabled(): boolean {
  return process.env.FEATURE_HR_SURFACES === "1";
}

/**
 * The H24 accounting, banking and tax screens.
 *
 * Same law again: off unless `FEATURE_FINANCE_SURFACES=1`, exactly that
 * spelling — "true", "yes", "on", padded values and absence all stay OFF.
 * When off the navigation has no entries and the routes answer 404. A ledger
 * screen reaching users before the engine is verified is how books get
 * corrupted by accident.
 */
export function financeSurfacesEnabled(): boolean {
  return process.env.FEATURE_FINANCE_SURFACES === "1";
}

/**
 * The H25 Management Studio screens.
 *
 * Same law once more: off unless `FEATURE_MANAGEMENT_STUDIO=1`, exactly that
 * spelling — "true", "yes", "on", padded values and absence all stay OFF.
 * When off the navigation has no entries and the routes answer 404. A
 * planning surface reaching users before the graph, scheduling and scenario
 * isolation are verified would put wrong dates in front of managers.
 */
export function managementStudioEnabled(): boolean {
  return process.env.FEATURE_MANAGEMENT_STUDIO === "1";
}
