/**
 * H28 — the release-gate law for Idara Intelligence, on the filesystem.
 *
 * In the app router a layout and its page render concurrently, so a layout
 * gate never stops a page from rendering its data: every Idara page checks
 * the flag itself before its first await; the dock mount, the cron route and
 * every server action refuse before touching identity or data; and the heavy
 * window and workspace are imported only through next/dynamic with ssr off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src", "app", "(app)", "o", "[orgId]", "idara");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("H28 — Idara gate law", () => {
  it("every Idara page checks the flag before its first await", () => {
    const pages = walk(ROOT).filter((p) => p.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const p of pages) {
      const src = readFileSync(p, "utf8");
      const gate = src.indexOf("if (!idaraEnabled()) notFound();");
      expect(gate, `${p} lacks the page-level gate`).toBeGreaterThan(-1);
      const fn = src.indexOf("export default async function");
      const firstAwait = src.indexOf("await ", fn);
      expect(gate, `${p} gates after its first await`).toBeLessThan(firstAwait);
    }
  });

  it("the mount, the actions and the cron route refuse before identity or data", () => {
    const mount = readFileSync(join(ROOT, "IdaraDockMount.tsx"), "utf8");
    expect(mount.indexOf("if (!idaraEnabled()) return null;")).toBeGreaterThan(-1);
    expect(mount.indexOf("if (!idaraEnabled()) return null;")).toBeLessThan(
      mount.indexOf("await "),
    );
    const actions = readFileSync(join(ROOT, "actions.ts"), "utf8");
    const resolveFn = actions.indexOf("async function resolve(");
    expect(
      actions.indexOf('if (!idaraEnabled()) return { ok: false, code: "off" };', resolveFn),
    ).toBeLessThan(actions.indexOf("await resolveCtxForAction", resolveFn));
    expect(actions.indexOf('can(r.archetype, "idara.use")')).toBeGreaterThan(-1);
    const cron = readFileSync(
      join(process.cwd(), "src", "app", "api", "cron", "idara", "route.ts"),
      "utf8",
    );
    expect(
      cron.indexOf("if (!idaraEnabled()) return new Response(null, { status: 404 });"),
    ).toBeLessThan(cron.indexOf("authorised(req)"));
    expect(cron).toContain("timingSafeEqual");
    expect(cron).toContain("secret.length < 16");
  });

  it("the heavy surfaces load only through next/dynamic with ssr off, and the launcher never opens itself", () => {
    const dock = readFileSync(join(ROOT, "IdaraDock.tsx"), "utf8");
    expect(dock).toMatch(/dynamic\(\(\) => import\("\.\/IdaraWindow"\)[\s\S]*ssr: false/);
    const client = readFileSync(join(ROOT, "IdaraDockClient.tsx"), "utf8");
    expect(client).toMatch(/dynamic\(\(\) => import\("\.\/IdaraDock"\)[\s\S]*ssr: false/);
    const workspace = readFileSync(join(ROOT, "IdaraWorkspace.tsx"), "utf8");
    expect(workspace).toMatch(/dynamic\(\(\) => import\("\.\/IdaraWindow"\)[\s\S]*ssr: false/);
    // Opening happens only inside explicit handlers: a pointer/keyboard gesture, the shortcut or the idara:open event.
    expect(dock).toContain('window.addEventListener("idara:open"');
    expect(dock).not.toMatch(/useEffect\(\(\) => \{\s*setOpen\(true\)/);
    expect(dock).toContain("prefers-reduced-motion");
    expect(dock).toContain('role="toolbar"');
    expect(dock).toContain('aria-live="polite"');
  });

  it("the layout mounts the dock outside the navigation and never inside the sidebar", () => {
    const layout = readFileSync(
      join(process.cwd(), "src", "app", "(app)", "o", "[orgId]", "layout.tsx"),
      "utf8",
    );
    const mount = layout.indexOf("<IdaraDockMount");
    const main = layout.indexOf("<main");
    const sidebar = layout.indexOf("SidebarNav");
    expect(mount).toBeGreaterThan(main);
    expect(sidebar === -1 || mount > sidebar).toBe(true);
    expect(layout).not.toMatch(/nav[^\n]*IdaraDock/);
  });
});
