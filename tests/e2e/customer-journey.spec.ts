import { expect, test, type Page } from "@playwright/test";

/**
 * 003C — the customer-completeness critical journey, end to end:
 * New Quote → inline customer creation (validation failure keeps BOTH forms'
 * state) → quote created with the customer → edit the customer → archive
 * (disappears from new-quote selection; history intact) → reactivate.
 *
 * HARNESS — same opt-in rules as founder-onboarding.spec.ts:
 * - Gate 1: E2E_CUSTOMER=1 must be set explicitly (skipped otherwise; CI's
 *   smoke stage runs with a placeholder Supabase URL and skips this suite).
 * - Gate 2: NEXT_PUBLIC_SUPABASE_URL must be a LOCAL stack — the suite
 *   creates a real user/org and refuses to touch a hosted project (protected
 *   production organizations are never involved).
 * - Desktop project only (signup is rate-limited); the 375px pass is explicit
 *   at the end of the journey.
 */

const RUN = process.env.E2E_CUSTOMER === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
const PASSWORD = "Customer-Pass-123!";

/** Fastest wizard walk to a workspace with a TRIAL tier (quoting enabled). */
async function signupAndCreateWorkspace(page: Page, email: string, bizName: string) {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Quote Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Get started" }).click();

  await page.getByLabel("Business name").fill(bizName);
  await page.getByLabel("What field do you work in?").selectOption("manufacturing");
  await page
    .getByLabel("Describe what you do, in your own words")
    .fill("Steel fabrication workshop, gates and railings");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Where you operate" })).toBeVisible();
  await page.getByRole("radio", { name: "English" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Your team" })).toBeVisible();
  await page.getByRole("radio", { name: "6-20" }).check();
  await page
    .getByRole("group", { name: "How many of them will need to sign in?" })
    .getByRole("radio", { name: "4-10" })
    .check();
  await page.getByRole("radio", { name: "One location" }).check();
  await page.getByRole("checkbox", { name: "Workshop / production floor" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "How your work runs" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Made-to-order pieces or batches" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "What you need" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Invoices" }).check();
  await page.getByRole("radio", { name: "Not for now" }).check();
  await page.getByRole("radio", { name: "Both" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Your recommended setup" })).toBeVisible();
  await page.getByRole("button", { name: "Use this setup" }).click();
  await expect(page.getByRole("heading", { name: "What will be configured" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Any TRIAL tier (never Free) — trials carry cap.quoting; no payment exists.
  await expect(page.getByRole("heading", { name: "Choose how you want to start" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Choose (?!Free)/ })
    .first()
    .click();

  await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { name: "Review & create your workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Create my workspace" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.match(/\/o\/([0-9a-f-]{36})/)![1]!;
}

test.describe("customer completeness critical journey (003C)", () => {
  test.skip(!RUN, "opt-in suite: set E2E_CUSTOMER=1 against a disposable local stack");
  test.skip(
    RUN && !LOCAL_STACK,
    `refusing to run: NEXT_PUBLIC_SUPABASE_URL is not a local stack (${SUPABASE_URL || "unset"})`,
  );
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "journey runs on the desktop project only");
    const health = await request.get("/api/health");
    const body = (await health.json()) as { checks?: { db?: { ok?: boolean } } };
    test.skip(body.checks?.db?.ok !== true, "local stack DB is not reachable via /api/health");
  });

  test("inline create inside New Quote → edit → archive → historical integrity → reactivate", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const email = `customer-journey-${Date.now()}@example.com`;
    const orgId = await signupAndCreateWorkspace(page, email, "Coastal Fabrication");
    const CUSTOMER = "Harbor Trading LLC";

    // 1–2. New Quote with real content entered FIRST.
    await page.goto(`/o/${orgId}/quotes/new`);
    await page.locator('input[name="description"]').fill("Gate fabrication");
    await page.locator('input[name="qty"]').fill("2");
    await page.locator('input[name="unit_price"]').fill("1500");
    await page.locator('input[name="terms"]').fill("NET 30");

    // 3–4. Open Add-new-customer; submit with an EMPTY name → error stays in
    // the dialog, nothing navigates.
    await page.getByRole("button", { name: /Add new/ }).click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByRole("alert").or(dialog.locator('p[role="alert"]'))).toBeVisible();

    // 5. Parent quote fields are untouched.
    await expect(page.locator('input[name="description"]')).toHaveValue("Gate fabrication");
    await expect(page.locator('input[name="unit_price"]')).toHaveValue("1500");
    await expect(page.locator('input[name="terms"]')).toHaveValue("NET 30");

    // 6–7. Correct and create → dialog closes, the customer is selected.
    await dialog
      .getByLabel(/customer/i)
      .first()
      .fill(CUSTOMER);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("was created and selected")).toBeVisible();
    await expect(page.locator('select[name="customer_id"]')).toContainText(CUSTOMER);

    // 8–9. Submit the quote → detail shows the customer.
    await page
      .getByRole("button", { name: /Create/ })
      .last()
      .click();
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/);
    const quoteUrl = page.url();
    await expect(page.getByText(CUSTOMER).first()).toBeVisible();

    // 10. Customers → row → detail → edit.
    await page.goto(`/o/${orgId}/customers`);
    await page.getByRole("link", { name: new RegExp(CUSTOMER) }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}/);
    const detailUrl = page.url();
    await page.getByRole("link", { name: "Edit" }).click();
    await page.locator('input[name="contact_name"]').fill("Hind");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByText("Hind")).toBeVisible();

    // 11. Archive with the explaining confirmation.
    await page.getByRole("button", { name: /Archive/ }).click();
    const confirm = page.locator("dialog[open]");
    await expect(confirm.getByText(/history/i)).toBeVisible();
    await confirm.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText("Archived").first()).toBeVisible();

    // 12. Gone from new-quote selection.
    await page.goto(`/o/${orgId}/quotes/new`);
    await expect(page.locator('select[name="customer_id"]')).not.toContainText(CUSTOMER);

    // 13. The existing quote still shows its historical customer identity.
    await page.goto(quoteUrl);
    await expect(page.getByText(CUSTOMER).first()).toBeVisible();

    // 14. Reactivate → back in selection.
    await page.goto(detailUrl);
    await page.getByRole("button", { name: /Reactivate/ }).click();
    await expect(page.getByText("Active").first()).toBeVisible();
    await page.goto(`/o/${orgId}/quotes/new`);
    await expect(page.locator('select[name="customer_id"]')).toContainText(CUSTOMER);

    // 375px sanity: the customers workspace fits without horizontal overflow.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/o/${orgId}/customers`);
    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
