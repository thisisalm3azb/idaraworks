import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

/**
 * U6 — founder-journey e2e: signup → pre-org onboarding wizard → template
 * recommendation → proposal → tier selection → branding → review → EXPLICIT
 * CONFIRM → branded role dashboard → logout/login resumes into the org.
 *
 * HARNESS (deliberately opt-in — this suite CREATES real users/orgs):
 * - The repo's e2e webServer (`pnpm start`) needs a REACHABLE auth+DB stack
 *   with migrations applied and email confirmations OFF (signup then returns a
 *   session and redirects straight to /onboarding — see signupAction).
 * - CI's smoke stage runs with a placeholder unreachable Supabase URL, so this
 *   suite CANNOT run there; it requires the integration-stage local stack
 *   (supabase start + pnpm db:migrate) with the env exported before
 *   `pnpm build && pnpm test:e2e`.
 * - Gate 1: E2E_FOUNDER=1 must be set explicitly (skipped otherwise).
 * - Gate 2: NEXT_PUBLIC_SUPABASE_URL must point at localhost/127.0.0.1 — the
 *   suite REFUSES to run against a hosted project (never create synthetic
 *   users/orgs on the hosted DB; never touch Alpha Marine / TESTING).
 * - Runs on the desktop project only (signup is rate-limited to 5/hour/IP; the
 *   375px pass is exercised explicitly inside the service profile below).
 *
 * Screenshots: set E2E_SCREENSHOTS=1 to write evidence shots to
 * docs/ux/evidence/ (login, wizard step, tiers, owner dashboard desktop,
 * dashboard 375px, Arabic RTL dashboard). CI stays fast without the flag.
 */

const RUN = process.env.E2E_FOUNDER === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const EVIDENCE = path.join("docs", "ux", "evidence");
const PASSWORD = "Founder-Pass-123!";
const LOGO_PNG = path.join(__dirname, "fixtures", "logo-64.png");

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}

/** No raw/broken i18n anywhere on the page: the catalog fallback renders
 * missing keys as ⟦key⟧ and un-interpolated ICU leaves {var} braces. */
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
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to IdaraWorks" })).toBeVisible();
}

async function startWizard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();
}

async function fillBusiness(
  page: Page,
  name: string,
  industryValue: string,
  description: string,
): Promise<void> {
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("What field do you work in?").selectOption(industryValue);
  await page.getByLabel("Describe what you do, in your own words").fill(description);
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("founder onboarding journey (U6)", () => {
  test.skip(!RUN, "opt-in suite: set E2E_FOUNDER=1 against a disposable local stack");
  test.skip(
    RUN && !LOCAL_STACK,
    `refusing to run: NEXT_PUBLIC_SUPABASE_URL is not a local stack (${SUPABASE_URL || "unset"}) — this suite creates real users/orgs`,
  );
  // Signup is rate-limited (5/hour/IP): run the journey once, on desktop only.
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "journey runs on the desktop project only; the 375px pass is explicit in profile 3",
    );
    const health = await request.get("/api/health");
    const body = (await health.json()) as { checks?: { db?: { status?: string } } };
    test.skip(body.checks?.db?.status !== "ok", "local stack DB is not reachable via /api/health");
  });

  test("profile 1 — manufacturing founder: full journey, Free tier, logo upload, AR switch, resume", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const email = `founder-mfg-${Date.now()}@example.com`;
    const bizName = "Gulf Gate Fabrication";

    await page.goto("/login");
    await shot(page, "01-login");

    await signup(page, "Mona Founder", email);
    await startWizard(page);

    // Progress + remaining render on questionnaire screens (business = step 1 of 10 = 10%).
    await expect(page.getByText("Step 1 of 10")).toBeVisible();
    await expect(page.getByText("10%")).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "10");

    // Description mirrors the unit-tested classifier mapping (onboarding-flow-mapping).
    await fillBusiness(
      page,
      bizName,
      "manufacturing",
      "Steel fabrication and welding workshop, gates and railings",
    );

    // Region — switch the wizard to Arabic via the preferred-language answer.
    await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
    await page.getByRole("radio", { name: "العربية" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // The flow locale flips immediately: RTL + Arabic heading on the scale step.
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("heading", { name: "فريقك" })).toBeVisible();
    await assertNoRawKeys(page);

    // Back to region (deep link), switch back to English, continue.
    await page.goto("/onboarding?step=region");
    await page.getByRole("radio", { name: "English" }).check();
    await page.getByRole("button", { name: "متابعة" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { name: "Your team" })).toBeVisible();
    await shot(page, "02-wizard-scale");

    // Back button returns to the previous screen with answers preserved.
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Scale — a 6–20 team IS asked the sign-ins question (no SKIP-1 here).
    await page.getByRole("radio", { name: "6-20" }).check();
    const signIns = page.getByRole("group", {
      name: "How many of them will need to sign in?",
    });
    await expect(signIns).toBeVisible();
    await signIns.getByRole("radio", { name: "4-10" }).check();
    await page.getByRole("radio", { name: "One location" }).check();
    await page.getByRole("checkbox", { name: "Workshop / production floor" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Work.
    await expect(page.getByRole("heading", { name: "How your work runs" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Made-to-order pieces or batches" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Needs — a customer-facing capability makes the sharing question appear (SKIP-4 inverse).
    await expect(page.getByRole("heading", { name: "What you need" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Invoices" }).check();
    await expect(
      page.getByText("Will you share progress updates with your customers?"),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Not for now" }).check();
    await page.getByRole("radio", { name: "Both" }).check();

    // Autosave/resume: reload mid-wizard keeps the step; a plain /onboarding
    // visit resumes at the saved step (needs — the first incomplete screen).
    await page.reload();
    await expect(page.getByRole("heading", { name: "What you need" })).toBeVisible();
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "What you need" })).toBeVisible();
    // Re-answer after reload (unsaved checks are not persisted until submit).
    await page.getByRole("checkbox", { name: "Invoices" }).check();
    await page.getByRole("radio", { name: "Not for now" }).check();
    await page.getByRole("radio", { name: "Both" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Template recommendation: expected template + alternatives + manual override and back.
    await expect(page.getByRole("heading", { name: "Your recommended setup" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Manufacturing & Workshop" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Other good fits" })).toBeVisible();
    // Override to a known different template (expand the full list if needed).
    const allSetups = page.getByText("See every available setup");
    if (await allSetups.isVisible()) await allSetups.click();
    await page
      .locator("li")
      .filter({ hasText: "Generic Operations" })
      .filter({ has: page.getByRole("button", { name: "Choose this instead" }) })
      .first()
      .getByRole("button", { name: "Choose this instead" })
      .click();
    await expect(page.getByRole("heading", { name: "What will be configured" })).toBeVisible();
    await expect(page.getByText("Generic Operations").first()).toBeVisible();
    // Back to the template step — the manual pick is marked, then revert to the recommendation.
    await page.goto("/onboarding?step=template");
    const allSetupsAgain = page.getByText("See every available setup");
    if (await allSetupsAgain.isVisible()) await allSetupsAgain.click();
    await expect(page.getByText("Selected").first()).toBeVisible();
    await page.getByRole("button", { name: "Use this setup" }).click();
    await expect(page.getByRole("heading", { name: "What will be configured" })).toBeVisible();
    await expect(page.getByText("Manufacturing & Workshop").first()).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Tier selection: nothing pre-selected — no Continue until a choice is made; no payment fields.
    await expect(page.getByRole("heading", { name: "Choose how you want to start" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue" })).toHaveCount(0);
    await expect(page.locator('input[autocomplete^="cc-"], input[name*="card" i]')).toHaveCount(0);
    await expect(
      page.getByText("No payment is collected now", { exact: false }).first(),
    ).toBeVisible();
    await shot(page, "03-tiers");
    // Free selects INSIDE its comparison card (the duplicate below-grid card was removed).
    await page.getByRole("button", { name: "Choose Free" }).click();

    // Free selection advances to branding; going back shows the recorded choice + Continue.
    await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.getByText("Current").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue" })).toBeVisible();
    await page.getByRole("link", { name: "Continue" }).click();

    // Branding: upload a valid PNG into the draft; preview + remove appear.
    await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(LOGO_PNG);
    await expect(page.getByRole("button", { name: "Remove image" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();

    // Review: summary shows the choices; edit-link round-trip (branding → review).
    await expect(
      page.getByRole("heading", { name: "Review & create your workspace" }),
    ).toBeVisible();
    await expect(page.getByText(bizName).first()).toBeVisible();
    await expect(page.getByText("Manufacturing & Workshop").first()).toBeVisible();
    await expect(page.getByText("Free").first()).toBeVisible();
    await page.getByRole("link", { name: "Edit" }).last().click();
    await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Review & create your workspace" }),
    ).toBeVisible();
    await assertNoRawKeys(page);

    // EXPLICIT CONFIRM → the org dashboard with the welcome banner.
    await page.getByRole("button", { name: "Create my workspace" }).click();
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/);
    const orgUrl = new URL(page.url());
    const orgPath = orgUrl.pathname;
    await expect(page.getByText("Welcome to your workspace")).toBeVisible();
    await expect(page.getByText(bizName).first()).toBeVisible();
    // Template-specific terminology + the owner subscription strip.
    await expect(page.getByRole("link", { name: "Work Orders" }).first()).toBeVisible();
    await expect(page.getByText("Usage & seats")).toBeVisible();
    await assertNoRawKeys(page);
    await assertNoHorizontalOverflow(page);
    await shot(page, "04-dashboard-owner-desktop");

    // Arabic RTL dashboard (top-bar language switch), then back to English.
    await page.getByRole("button", { name: "Switch language" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "اليوم" })).toBeVisible();
    await assertNoRawKeys(page);
    await shot(page, "05-dashboard-rtl-arabic");
    await page.getByRole("button", { name: "تغيير اللغة" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    // Logout → login resumes INTO the org, not the wizard. (Account menu is now
    // an accessible <Menu> button popover, not a native <details>/<summary>.)
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(new RegExp(orgPath.replace(/[/]/g, "\\/")));
    await expect(page.getByText(bizName).first()).toBeVisible();
  });

  test("profile 2 — online store founder: SKIP-1 fires, Medium tier, branding skipped", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const email = `founder-store-${Date.now()}@example.com`;
    const bizName = "Souq Direct Electronics";

    await signup(page, "Omar Founder", email);
    await startWizard(page);
    // Description mirrors the unit-tested classifier mapping (onboarding-flow-mapping).
    await fillBusiness(
      page,
      bizName,
      "retail_online",
      "Online store selling electronics and accessories with delivery",
    );

    // Region: accept the country defaults, keep English.
    await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Scale: the smallest team band fires SKIP-1 — sign-ins and departments are not asked.
    await expect(page.getByRole("heading", { name: "Your team" })).toBeVisible();
    await page.getByRole("radio", { name: "1-5" }).check();
    await expect(page.getByText("How many of them will need to sign in?")).toBeHidden();
    await expect(page.getByText("Which areas exist in your business?")).toBeHidden();
    await page.getByRole("radio", { name: "One location" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Work.
    await page
      .getByRole("checkbox", { name: "Selling ready products (in store or online)" })
      .check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Needs: no customer-facing capability → the sharing question stays hidden (SKIP-4).
    await page.getByRole("checkbox", { name: "Inventory & stock" }).check();
    await expect(
      page.getByText("Will you share progress updates with your customers?"),
    ).toBeHidden();
    await page.getByRole("radio", { name: "Mostly desktop" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Template: the online-store profile recommends the e-commerce setup.
    await expect(page.getByRole("heading", { name: "Online Store & E-commerce" })).toBeVisible();
    await page.getByRole("button", { name: "Use this setup" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    // Tier: Medium.
    await expect(page.getByRole("heading", { name: "Choose how you want to start" })).toBeVisible();
    await page.getByRole("button", { name: "Choose Medium" }).click();

    // Branding: skipped entirely.
    await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();

    // Review reflects Medium + skipped branding; confirm.
    await expect(
      page.getByRole("heading", { name: "Review & create your workspace" }),
    ).toBeVisible();
    await expect(page.getByText("Medium").first()).toBeVisible();
    await expect(page.getByText("Skipped — add it any time", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Create my workspace" }).click();
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/);
    await expect(page.getByText("Welcome to your workspace")).toBeVisible();
    await expect(page.getByText(bizName).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Orders" }).first()).toBeVisible();
    await assertNoRawKeys(page);
  });

  test("profile 3 — service founder at 375px: custom tier (2 add-ons), invalid logo rejected, no overflow", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const email = `founder-svc-${Date.now()}@example.com`;
    const bizName = "Rapid Cool Maintenance";

    await signup(page, "Sara Founder", email);
    await startWizard(page);
    await assertNoHorizontalOverflow(page);

    await fillBusiness(
      page,
      bizName,
      "field_services",
      "AC maintenance and repair callouts, technician visits",
    );
    await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click(); // region defaults

    await expect(page.getByRole("heading", { name: "Your team" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("radio", { name: "6-20" }).check();
    await page
      .getByRole("group", { name: "How many of them will need to sign in?" })
      .getByRole("radio", { name: "4-10" })
      .check();
    await page.getByRole("radio", { name: "2-3" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("checkbox", { name: "Service visits and repairs" }).check();
    await page
      .getByRole("checkbox", { name: "Recurring contracts (weekly or monthly visits)" })
      .check();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("checkbox", { name: "Assigning work to people" }).check();
    await page.getByRole("radio", { name: "Mostly phones" }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Template: service profile recommends the service-business setup.
    await expect(page.getByRole("heading", { name: "Service Business" })).toBeVisible();
    await page.getByRole("button", { name: "Use this setup" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    // Tier: custom with two add-ons (one checkbox module + one stackable pack).
    await expect(page.getByRole("heading", { name: "Choose how you want to start" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("checkbox", { name: "Quotes & invoices" }).check();
    await page.getByRole("button", { name: "Increase Additional 10 members" }).click();
    await page.getByRole("button", { name: "Use this custom selection" }).click();

    // Branding: an invalid file type is rejected with the honest inline error.
    await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "not-an-image.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("definitely not a png"),
    });
    await expect(page.getByRole("alert")).toContainText("Use a PNG, JPG or WebP image.");
    await page.getByRole("button", { name: "Skip for now" }).click();

    // Review: custom selection with 2 add-ons; confirm.
    await expect(
      page.getByRole("heading", { name: "Review & create your workspace" }),
    ).toBeVisible();
    await expect(page.getByText("Custom").first()).toBeVisible();
    await expect(page.getByText("Add-ons selected")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Create my workspace" }).click();
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\?welcome=1/);
    await expect(page.getByText("Welcome to your workspace")).toBeVisible();
    // 375px dashboard: template noun in the KPI cards; no overflow.
    await expect(page.getByText("Active Service Jobs").first()).toBeVisible();
    await assertNoRawKeys(page);
    await assertNoHorizontalOverflow(page);
    await shot(page, "06-dashboard-375");
  });
});
