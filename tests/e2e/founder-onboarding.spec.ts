import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Founder-journey e2e: signup → the four setup screens → EXPLICIT CONFIRM →
 * the workspace → logout/login resumes into the org.
 *
 * HARNESS (deliberately opt-in — this suite CREATES real users/orgs):
 * - The repo's e2e webServer (`pnpm start`) needs a REACHABLE auth+DB stack
 *   with migrations applied and email confirmations OFF (signup then returns a
 *   session and redirects straight to /onboarding — see signupAction).
 * - Gate 1: E2E_FOUNDER=1 must be set explicitly (skipped otherwise).
 * - Gate 2: NEXT_PUBLIC_SUPABASE_URL must point at localhost/127.0.0.1 — the
 *   suite REFUSES to run against a hosted project.
 * - Runs on the desktop project only (signup is rate-limited to 5/hour/IP; the
 *   375px pass is exercised explicitly inside profile 2 below).
 *
 * Screenshots: set E2E_SCREENSHOTS=1 to write evidence shots to docs/ux/evidence/.
 */

const RUN = process.env.E2E_FOUNDER === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const EVIDENCE = path.join("docs", "ux", "evidence");
const PASSWORD = "Founder-Pass-123!";

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}

/** No raw/broken i18n anywhere on the page. */
async function assertNoRawKeys(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body, "missing-message marker ⟦…⟧ reached the page").not.toContain("⟦");
  expect(body, "un-interpolated ICU variable reached the page").not.toMatch(/\{[a-z0-9_]+\}/);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
  expect(overflow, "horizontal overflow at current viewport").toBe(false);
}

/** Real UI signup; on a local stack (confirmations off) it lands on /onboarding. */
async function signup(page: Page, fullName: string, email: string): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(fullName);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Your business" })).toBeVisible();
}

async function step(page: Page, n: number): Promise<void> {
  await expect(page.getByText(`Step ${n} of 4`)).toBeVisible();
  await assertNoRawKeys(page);
}

test.describe("founder onboarding (four screens)", () => {
  test.skip(!RUN, "opt-in suite: set E2E_FOUNDER=1 against a disposable local stack");
  test.skip(
    RUN && !LOCAL_STACK,
    `refusing to run: NEXT_PUBLIC_SUPABASE_URL is not a local stack (${SUPABASE_URL || "unset"}) — this suite creates real users/orgs`,
  );
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "journey runs on the desktop project only");
    const health = await request.get("/api/health");
    const body = (await health.json()) as { checks?: { db?: { status?: string } } };
    test.skip(body.checks?.db?.status !== "ok", "local stack DB is not reachable via /api/health");
  });

  test("profile 1 — construction founder: four screens, back, resume, one workspace, Arabic switch", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const email = `founder-build-${Date.now()}@example.com`;
    const bizName = "Gulf Gate Contracting";

    await signup(page, "Mona Founder", email);
    await step(page, 1);
    await shot(page, "01-business");
    await page.getByLabel("Company name").fill(bizName);
    await page.getByLabel("Country").selectOption("AE");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "How you work" })).toBeVisible();
    await step(page, 2);
    // Back keeps the typed answers.
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.getByLabel("Company name")).toHaveValue(bizName);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Construction/ }).check();
    await shot(page, "02-setup");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "What matters now" })).toBeVisible();
    await step(page, 3);
    await page.getByRole("checkbox", { name: /Work and delivery/ }).check();
    await page.getByRole("checkbox", { name: /Money/ }).check();
    await page.getByRole("radio", { name: "6 to 20" }).check();
    await shot(page, "03-priorities");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
    await step(page, 4);
    await expect(page.getByText(bizName)).toBeVisible();
    await expect(page.getByText("30 days free. No credit card needed.")).toBeVisible();
    // Refresh/resume lands on the same screen with the answers intact.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
    await expect(page.getByText(bizName)).toBeVisible();
    await shot(page, "04-ready");

    // Double activation must not create two workspaces: the button disables
    // while pending and the confirm chain claims the draft.
    const open = page.getByRole("button", { name: "Open my workspace" });
    await open.click();
    await open.click({ force: true }).catch(() => undefined);
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/, { timeout: 90_000 });
    const orgUrl = page.url().split("?")[0]!;
    await assertNoRawKeys(page);
    await shot(page, "05-workspace");

    // The workspace switcher shows one organisation only.
    await page.goto("/account");
    const orgLinks = page.locator(`a[href^="/o/"]`);
    const hrefs = new Set(
      await orgLinks.evaluateAll((as) => as.map((a) => a.getAttribute("href")?.split("?")[0])),
    );
    expect(hrefs.size).toBeLessThanOrEqual(1);

    // Opening /onboarding again never re-runs setup for a member.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(new RegExp(orgUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Arabic switches the workspace to RTL.
    await page.goto(orgUrl);
    await page.getByRole("button", { name: /switch language|تبديل اللغة/i }).click();
    await page.getByRole("menuitem", { name: "العربية" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await assertNoHorizontalOverflow(page);
    await shot(page, "06-workspace-ar");
  });

  test("profile 2 — service founder at 375px: the four screens fit a phone and validation keeps the input", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const email = `founder-svc-${Date.now()}@example.com`;

    await signup(page, "Sara Founder", email);
    await assertNoHorizontalOverflow(page);
    // A missing name is refused with the other answers kept.
    await page.getByLabel("Country").selectOption("OM");
    await page.getByLabel("Company name").fill("");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Your business" })).toBeVisible();
    await expect(page.getByLabel("Country")).toHaveValue("OM");
    await page.getByLabel("Company name").fill("Muscat Cooling Services");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("radio", { name: /Services and maintenance/ }).check();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Continue" }).click();
    // Priorities are optional.
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
    await expect(page.getByText("Not chosen (you can pick later)")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Open my workspace" }).click();
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/, { timeout: 90_000 });
    await assertNoHorizontalOverflow(page);
    await shot(page, "07-workspace-375");
  });
});
