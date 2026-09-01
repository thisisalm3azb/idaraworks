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
