/**
 * H33 Pilot Lab — the family registry.
 *
 * Order here does not matter: run.ts sorts by declared dependencies. What
 * matters is that every family is listed, because a family that is not listed
 * never runs and its absence is silent. The unit test in
 * tests/unit/pilot-lab-law.test.ts asserts the registry against the files in
 * this directory so that cannot happen quietly.
 */
import type { Family } from "../types";

export const FAMILIES: Family[] = [];
