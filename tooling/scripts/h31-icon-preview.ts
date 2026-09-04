/**
 * H31 — render the generated icon set to disk so a human can look at it.
 *
 * Written because the deployed icon turned out to be a plain coloured square:
 * the container had no fonts, the SVG named `Helvetica,Arial,sans-serif`, and
 * the text drew nothing. Nothing in the tests noticed, because a PNG with no
 * glyphs is still a valid PNG of the right size.
 *
 * So this exists to be looked at, and to print the one number that separates
 * "drew something" from "drew nothing": a solid square compresses to a fraction
 * of the size of one with glyphs in it.
 *
 *   npx tsx tooling/scripts/h31-icon-preview.ts [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIconSet } from "../../src/platform/tenanthost/icon";
import { solidPng } from "../../src/platform/tenanthost/png";

const OUT = process.argv[2] ?? ".h31-icons";

const CASES: Array<{ name: string; colour: string }> = [
  { name: "Najolatech Boat Works", colour: "#7c3aed" },
  { name: "شما اتيلييه", colour: "#0f766e" },
  { name: "Al Ghaith Farm", colour: "#b45309" },
  { name: "A", colour: "#111111" },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const blank512 = solidPng(512, 1, 2, 3).length;
  console.log(`a solid 512 PNG is ${blank512} bytes — glyphs should push well past that\n`);

  for (const c of CASES) {
    const { icons } = await generateIconSet({
      source: null,
      orgName: c.name,
      brandColor: c.colour,
    });
    const slug = c.name.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 20) || "org";
    for (const icon of icons) {
      const file = `${slug}-${icon.size}${icon.maskable ? "-maskable" : ""}.png`;
      writeFileSync(join(OUT, file), icon.buffer);
    }
    const big = icons.find((i) => i.size === 512 && !i.maskable)!;
    const verdict = big.buffer.length > blank512 * 1.5 ? "GLYPHS RENDERED" : "LOOKS BLANK";
    console.log(
      `${c.name.padEnd(24)} 512px = ${String(big.buffer.length).padStart(6)} bytes   ${verdict}`,
    );
  }
  console.log(`\nwritten to ${OUT}/ — open them and look.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
