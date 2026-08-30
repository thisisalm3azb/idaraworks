/**
 * Which failures a person can actually do something about.
 *
 * Every action in this folder used to collapse to `error=failed`, so eight
 * authored messages never reached anyone and a foreman who tried to close a
 * dependency loop was told "Something went wrong - try again". These are
 * deterministic refusals: retrying fails identically forever, so the message has
 * to say what the rule is.
 *
 * Anything not listed here stays the generic failure, which is the right answer
 * for a genuine fault. The slug travels in the URL, so it is short and stable;
 * the map is the single place the two sides agree.
 *
 * This is a plain module rather than part of actions.ts because a "use server"
 * file may only export async functions.
 */
export const WORK_ERROR_KEYS: Record<string, string> = {
  transition: "work.error.transition",
  reason: "work.error.reason",
  immutable: "work.error.immutable",
  cycle: "tasks.error.cycle",
  scope: "tasks.error.scope",
  blocked: "tasks.error.blocked",
  children: "tasks.error.children",
  depth: "tasks.error.depth",
};

const BY_CLASS: Record<string, string> = {
  WorkTransitionError: "transition",
  WorkReasonRequiredError: "reason",
  WorkImmutableError: "immutable",
  DependencyCycleError: "cycle",
  DependencyScopeError: "scope",
  TaskBlockedError: "blocked",
  TaskChildrenOpenError: "children",
  TaskDepthError: "depth",
  TaskTransitionError: "transition",
  TaskReasonRequiredError: "reason",
};

/** The slug for a thrown error, or "failed" for anything unrecognised. */
export function workErrorSlug(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  return (name && BY_CLASS[name]) || "failed";
}
