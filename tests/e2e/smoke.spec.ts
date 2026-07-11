import { expect, test } from "@playwright/test";

test("home renders the shell", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByText("IdaraWorks")).toBeVisible();
  await expect(page.getByText("Platform status")).toBeVisible();
});

test("no horizontal overflow at mobile width", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("primary actions meet the 44px touch target (BUILD_BIBLE §9.2)", async ({ page }) => {
  await page.goto("/");
  const box = await page.getByRole("button").first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("security headers are present (S0 checklist §14)", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
