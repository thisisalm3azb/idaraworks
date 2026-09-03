/**
 * H27 law: every Revenue Studio page checks the release flag itself. In the
 * app router a layout and its page render concurrently, so a `notFound()`
 * thrown by the layout hides the subtree but does not stop the page from
 * rendering and streaming its data (found on production with the flag
 * unset). The layout keeps its gate as defence; the pages own the gate.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src", "app", "(app)", "o", "[orgId]", "revenue");

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (f === "page.tsx") out.push(p);
  }
  return out;
}

describe("the Revenue Studio release gate", () => {
  it("is checked by every page, before any read", () => {
    const files = pages(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(13);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const gate = src.indexOf("if (!revenueStudioEnabled()) notFound();");
      expect(gate, `${path.relative(ROOT, file)} has no flag gate`).toBeGreaterThan(0);
      const firstAwait = src.indexOf("await ", src.indexOf("export default async function"));
      expect(gate, `${path.relative(ROOT, file)} gates after a read`).toBeLessThan(firstAwait);
    }
  });

  it("is checked by the report route and the layout", () => {
    const route = readFileSync(
      path.join(
        process.cwd(),
        "src",
        "app",
        "api",
        "o",
        "[orgId]",
        "revenue",
        "report",
        "route.ts",
      ),
      "utf8",
    );
    expect(route).toContain("if (!revenueStudioEnabled())");
    const layout = readFileSync(path.join(ROOT, "layout.tsx"), "utf8");
    expect(layout).toContain("if (!revenueStudioEnabled()) notFound();");
  });
});
