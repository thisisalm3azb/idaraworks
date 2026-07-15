/**
 * Dependency audit via npm's BULK advisory endpoint (CI "Dependency audit (high+)" step).
 *
 * npm retired the legacy audit endpoints (410 Gone) that `pnpm audit` (≤10.x) calls, so the
 * old `pnpm audit --prod --audit-level high` step cannot run at all. This script implements
 * the officially recommended replacement (https://api-docs.npmjs.com/#tag/Audit): it collects
 * the EXACT installed prod-dependency versions from `pnpm list` and POSTs them to
 * https://registry.npmjs.org/-/npm/v1/security/advisories/bulk — the endpoint returns the
 * advisories applicable to the submitted versions (the same contract yarn's `npm audit` uses;
 * no client-side semver range math). Fails (exit 1) when any advisory at/above the threshold
 * severity is returned. Failure mode is conservative: over-reporting is visible, never silent.
 *
 * Usage: node tooling/scripts/audit-bulk.mjs [--level high|critical|moderate|low] [--dev]
 */
import { execSync } from "node:child_process";

const LEVELS = ["low", "moderate", "high", "critical"];
const args = process.argv.slice(2);
const levelArg = args.includes("--level") ? args[args.indexOf("--level") + 1] : "high";
const includeDev = args.includes("--dev");
if (!LEVELS.includes(levelArg)) {
  console.error(`unknown --level ${levelArg} (expected one of ${LEVELS.join(", ")})`);
  process.exit(2);
}
const threshold = LEVELS.indexOf(levelArg);

// 1. Collect exact installed versions (prod tree by default, mirroring `pnpm audit --prod`).
const listCmd = `pnpm list ${includeDev ? "" : "--prod "}--depth Infinity --json`;
const tree = JSON.parse(execSync(listCmd, { maxBuffer: 128 * 1024 * 1024 }).toString());
const versions = new Map(); // name -> Set(version)
function walk(deps) {
  if (!deps) return;
  for (const [name, info] of Object.entries(deps)) {
    if (info?.version) {
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(info.version);
    }
    walk(info?.dependencies);
  }
}
for (const project of Array.isArray(tree) ? tree : [tree]) {
  walk(project.dependencies);
  if (includeDev) walk(project.devDependencies);
}
if (versions.size === 0) {
  console.error("no dependencies collected — refusing to pass an empty audit");
  process.exit(2);
}

// 2. Bulk advisory query with the exact versions.
const body = {};
for (const [name, vs] of versions) body[name] = [...vs];
const res = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`bulk advisory endpoint returned ${res.status} ${res.statusText}`);
  process.exit(2); // infrastructure failure must FAIL the gate, never silently pass
}
const advisories = await res.json();

// 3. Report + gate.
let failing = 0;
let below = 0;
for (const [name, list] of Object.entries(advisories)) {
  for (const adv of list) {
    const sev = LEVELS.indexOf(String(adv.severity).toLowerCase());
    const line = `${name} ${[...versions.get(name)].join(",")} — [${adv.severity}] ${adv.title} (${adv.url})`;
    if (sev >= threshold) {
      failing++;
      console.error(`FAIL ${line}`);
    } else {
      below++;
      console.log(`info ${line}`);
    }
  }
}
console.log(
  `audit-bulk: ${versions.size} packages checked, ${failing} advisories at/above '${levelArg}', ` +
    `${below} below threshold`,
);
process.exit(failing > 0 ? 1 : 0);
