import { expect, test, type Page } from "@playwright/test";

/**
 * DEFECT 4 e2e — the header popover menus (quick-create "New" + Account) built
 * on the accessible <Menu> (src/platform/ui/Menu.tsx) that replaced the native
 * <details>/<summary> menus. Exercises EVERY closure condition on the real,
 * authenticated org shell: open/toggle, outside-click, Escape (+ focus return),
 * item selection, close-after-navigation (the lingering-across-pages bug), no
 * lingering overlay intercepting the next click, reopen, arrow-key roving focus,
 * and a 375px pass.
 *
 * HARNESS (opt-in — this suite CREATES a real user/org, exactly like
 * founder-onboarding.spec.ts):
 * - Gate 1: E2E_MENU=1 must be set explicitly (skipped otherwise).
 * - Gate 2: NEXT_PUBLIC_SUPABASE_URL must point at localhost/127.0.0.1 — the
 *   suite REFUSES to run against a hosted project (never create synthetic
 *   users/orgs on the hosted DB; never touch Alpha Marine / TESTING).
 * - Needs the integration-stage local stack (supabase start + pnpm db:migrate)
 *   with email confirmations OFF, reachable via /api/health.
 * - Serial: ONE signup+onboarding creates the org (signup is rate-limited to
 *   5/hour/IP); every scenario reuses that authenticated page. Runs on the
 *   desktop project only; the 375px case resizes the same page.
 */

const RUN = process.env.E2E_MENU === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
const PASSWORD = "Founder-Pass-123!";

/** Minimal real founder journey → lands in an owned org. Mirrors the proven
 *  store profile in founder-onboarding.spec.ts; returns the org path. */
async function createOrg(page: Page): Promise<string> {
  const email = `menu-e2e-${Date.now()}@example.com`;
  const bizName = "Menu Fixtures Co";

  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Menu Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Business name").fill(bizName);
  await page.getByLabel("What field do you work in?").selectOption("retail_online");
  await page
    .getByLabel("Describe what you do, in your own words")
    .fill("Online store selling electronics and accessories with delivery");
  await page.getByRole("button", { name: "Continue" }).click();

  // Region — defaults.
  await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Scale.
  await page.getByRole("radio", { name: "1-5" }).check();
  await page.getByRole("radio", { name: "One location" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Work.
  await page.getByRole("checkbox", { name: "Selling ready products (in store or online)" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Needs.
  await page.getByRole("checkbox", { name: "Inventory & stock" }).check();
  await page.getByRole("radio", { name: "Mostly desktop" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Template → tier → skip branding → confirm.
  await expect(page.getByRole("heading", { name: "Online Store & E-commerce" })).toBeVisible();
  await page.getByRole("button", { name: "Use this setup" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose how you want to start" })).toBeVisible();
  await page.getByRole("button", { name: "Choose Medium" }).click();
  await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Create my workspace" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/);

  return new URL(page.url()).pathname;
}

test.describe.serial("header menus — accessible popover (DEFECT 4)", () => {
  let page: Page;
  let orgPath: string;
  const newTrigger = () => page.getByRole("button", { name: "New", exact: true });
  const accountTrigger = () => page.getByRole("button", { name: "Account", exact: true });

  test.beforeAll(async ({ browser }) => {
    test.skip(!RUN, "opt-in suite: set E2E_MENU=1 against a disposable local stack");
    test.skip(
      RUN && !LOCAL_STACK,
      `refusing to run: NEXT_PUBLIC_SUPABASE_URL is not a local stack (${SUPABASE_URL || "unset"}) — this suite creates a real user/org`,
    );
    test.skip(
      test.info().project.name !== "desktop",
      "runs on the desktop project only; the 375px pass resizes the same page",
    );
    page = await browser.newPage();
    const health = await page.request.get("/api/health");
    const body = (await health.json()) as { checks?: { db?: { status?: string } } };
    test.skip(body.checks?.db?.status !== "ok", "local stack DB is not reachable via /api/health");
    orgPath = await createOrg(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("opens on trigger click and toggles aria-expanded; closed = no menu in the DOM", async () => {
    await page.goto(orgPath);
    const trigger = newTrigger();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem").first()).toBeVisible();

    // Toggle shut from the trigger.
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("closes on outside click on neutral page content", async () => {
    await page.goto(orgPath);
    await newTrigger().click();
    await expect(page.getByRole("menu")).toBeVisible();

    // Click empty main content — the pointerdown closes the menu.
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(newTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  test("closes on Escape, returns focus to the trigger, and does not block the next click", async () => {
    await page.goto(orgPath);
    const trigger = newTrigger();
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused(); // focus returned to the trigger

    // Immediately click another control — it MUST receive the click (proves no
    // invisible overlay lingers after close). Opening the account menu confirms it.
    await accountTrigger().click();
    await expect(accountTrigger()).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("clicking the other trigger while open closes the first and opens the second (no overlay)", async () => {
    await page.goto(orgPath);
    await newTrigger().click();
    await expect(newTrigger()).toHaveAttribute("aria-expanded", "true");

    await accountTrigger().click();
    await expect(newTrigger()).toHaveAttribute("aria-expanded", "false");
    await expect(accountTrigger()).toHaveAttribute("aria-expanded", "true");
  });

  test("selecting a link item closes the menu AND does not linger on the destination page", async () => {
    await page.goto(orgPath);
    await newTrigger().click();
    await expect(page.getByRole("menu")).toBeVisible();

    await page.getByRole("menuitem").first().click();
    // Navigated away from the org home…
    await expect(page).not.toHaveURL(new RegExp(`${orgPath}(\\?|$)`));
    // …and the menu is GONE on the new page (the lingering-across-pages fix).
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The destination page is fully interactive — the menu reopens here.
    const trigger = newTrigger();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("reopen works after closing", async () => {
    await page.goto(orgPath);
    const trigger = newTrigger();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("arrow keys rove focus across items; Home/End jump to first/last (account menu)", async () => {
    await page.goto(orgPath);
    await accountTrigger().click();
    const items = page.getByRole("menuitem");
    const n = await items.count();
    expect(n).toBeGreaterThanOrEqual(2);

    await expect(items.first()).toBeFocused(); // first item focused on open
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowUp"); // wrap to the last
    await expect(items.nth(n - 1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.nth(n - 1)).toBeFocused();
  });

  test("375px — the menu opens and closes with no horizontal overflow", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(orgPath);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    const trigger = newTrigger(); // aria-label persists though the label text is hidden < lg
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("the logout server-action item closes the menu via the ensuing navigation", async () => {
    // Runs LAST — it ends the session. Covers the formAction (server-action)
    // item path: submit → redirect to /login → route-change closes the menu.
    await page.goto(orgPath);
    await accountTrigger().click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});
