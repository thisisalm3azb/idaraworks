/**
 * H31 — the installed identity of a company app.
 *
 * Three manifest members decide whether two companies are two apps on a
 * device, or one app fighting itself: `id` is what the browser keys the
 * installation on, `start_url` is what a shortcut opens, and `scope` is the
 * set of pages the installed window owns. They are pure functions of the
 * organisation id so that a rename, a new logo or a new origin never changes
 * them — and so the law that keeps companies apart can be tested without a
 * database.
 */

export type AppIdentity = { id: string; start_url: string; scope: string };

/** The identity members of the manifest for one company on one origin. */
export function appIdentity(origin: string, orgId: string): AppIdentity {
  const base = `${origin}/o/${orgId}`;
  return {
    id: `/o/${orgId}`,
    start_url: `${base}?source=pwa`,
    /*
     * No trailing slash. The spec's "within scope" test is a string prefix on
     * the path: `/o/<id>/` is not a prefix of `/o/<id>`, so with the slash the
     * start_url fell outside its own scope and browsers used the default scope
     * `/o/` instead — one scope shared by every company on the origin.
     */
    scope: base,
  };
}

/**
 * The Web App Manifest "within scope" rule: same origin, and the scope's path
 * is a prefix of the target's path. Query and fragment do not take part.
 */
export function withinScope(target: string, scope: string): boolean {
  const t = new URL(target);
  const s = new URL(scope);
  return t.origin === s.origin && t.pathname.startsWith(s.pathname);
}
