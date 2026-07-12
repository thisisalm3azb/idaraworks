/**
 * RTL-first guard (Bible §9.2/§9.11; doc 07 pseudo-locale render test).
 * The design system must use LOGICAL properties only, so the whole tree flips
 * with the <html dir> attribute and no primitive hard-codes a side. We render
 * the primitives (with long-Arabic + pseudo content) and assert the emitted
 * markup carries no physical-direction utility classes, then snapshot them.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Card, CardHeader, EmptyState, Badge } from "@/platform/ui";

// Physical-direction Tailwind utilities that would BREAK under RTL.
const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l|rounded-r|float-(left|right)|origin-(left|right))\b/;

const LONG_AR = "مرحلة التجميع النهائي للهيكل قبل التسليم — مراجعة الجودة والطلاء";
const PSEUDO = "[[Ṽẽṛÿ_ĺõñĝ_ṗšëüðõ_ĺáþëĺ_ţö_çáţçh_ţṛüñçáţíõñ]]";

const samples: Array<[string, string]> = [
  ["button", renderToStaticMarkup(h(Button, {}, LONG_AR))],
  ["card", renderToStaticMarkup(h(Card, {}, h(CardHeader, { title: LONG_AR, meta: PSEUDO })))],
  ["emptyState", renderToStaticMarkup(h(EmptyState, { title: LONG_AR, description: PSEUDO }))],
  ["badge", renderToStaticMarkup(h(Badge, { tone: "success" }, LONG_AR))],
];

describe("primitives are RTL-safe (logical properties only)", () => {
  for (const [name, html] of samples) {
    it(`${name} renders and uses no physical-direction classes`, () => {
      expect(html).toContain(name === "badge" ? "التجميع" : "التسليم"); // Arabic renders
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), `${name} leaked a physical class: ${classes}`).toBe(false);
    });
  }

  it("shell/primitive markup is stable (long-Arabic + pseudo snapshot)", () => {
    expect(samples.map(([name, html]) => `${name}:\n${html}`).join("\n\n")).toMatchSnapshot();
  });
});
