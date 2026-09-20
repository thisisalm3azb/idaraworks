/**
 * Does a pathname satisfy a route under an organisation?
 *
 * Exact, or a deeper page under it: "/jobs" is satisfied by "/jobs" and by
 * "/jobs/123", never by "/jobsheets". A trailing slash and a query string do
 * not matter. Pure and dependency-free, so the guided tour's client island and
 * its server-side definitions share one meaning of "you got there".
 */
export function routeSatisfied(pathname: string, orgBase: string, path: string): boolean {
  const clean = (pathname.split("?")[0] ?? "").replace(/\/+$/, "");
  const want = `${orgBase}${path}`.replace(/\/+$/, "");
  return clean === want || clean.startsWith(`${want}/`);
}
