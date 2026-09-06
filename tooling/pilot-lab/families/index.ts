/**
 * H33 Pilot Lab — the family registry.
 *
 * Order here does not matter: run.ts sorts by declared dependencies. What
 * matters is that every family is listed, because a family that is not listed
 * never runs and its absence is silent — the seed simply writes fewer rows and
 * nothing complains. The unit test in tests/unit/pilot-lab-law.test.ts asserts
 * the registry against the files in this directory so that cannot happen
 * quietly.
 *
 * All fifteen went in at once, after every one was type-clean and had its own
 * focused unit tests, so the lab could never be seeded from a half-built set.
 */
import type { Family } from "../types";

import { setup } from "./setup";
import { people } from "./people";
import { masters } from "./masters";
import { work } from "./work";
import { sales } from "./sales";
import { supply } from "./supply";
import { stock } from "./stock";
import { crm } from "./crm";
import { hr } from "./hr";
import { assets } from "./assets";
import { studio } from "./studio";
import { docstudio } from "./docstudio";
import { finance } from "./finance";
import { country } from "./country";
import { misc } from "./misc";

export const FAMILIES: Family[] = [
  setup,
  people,
  masters,
  work,
  sales,
  supply,
  stock,
  crm,
  hr,
  assets,
  studio,
  docstudio,
  finance,
  country,
  misc,
];
