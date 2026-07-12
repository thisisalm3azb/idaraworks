import { expect, test } from "@playwright/test";

// `/` now redirects to /login when unauthenticated (Phase C). The login page is
// the stable unauthenticated smoke surface.
test("unauthenticated root redirects to the login screen", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("no horizontal overflow at mobile width", async ({ page }) => {
  await page.goto("/login");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("primary actions meet the 44px touch target (BUILD_BIBLE §9.2)", async ({ page }) => {
  await page.goto("/login");
  const box = await page.getByRole("button").first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("security headers are present (S0 checklist §14)", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("login → signup navigation works", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

test("health endpoint responds with per-dependency checks (Phase I)", async ({ request }) => {
  const res = await request.get("/api/health");
  // 200 when db+storage are reachable, 503 otherwise — both are valid JSON
  // here; the e2e env has no DB/storage, so accept either and assert the shape.
  const body = await res.json();
  expect(body).toHaveProperty("ok");
  expect(body).toHaveProperty("request_id");
  expect(body.checks).toHaveProperty("db");
  expect(body.checks).toHaveProperty("storage");
  expect(body.checks).toHaveProperty("queue");
  // Inngest state is always EXPLICIT — configured or unconfigured, never absent.
  expect(["configured", "unconfigured"]).toContain(body.checks.inngest.status);
  expect(res.headers()["x-request-id"]).toBeTruthy();
});

test("readiness endpoint is dependency-free (Phase I)", async ({ request }) => {
  const res = await request.get("/api/ready");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ready).toBe(true);
  expect(body).toHaveProperty("request_id");
});

test("responses echo a server-minted x-request-id (Phase I)", async ({ request }) => {
  const res = await request.get("/login", { headers: { "x-request-id": "client-spoofed" } });
  const rid = res.headers()["x-request-id"];
  expect(rid).toBeTruthy();
  // Inbound ids are never trusted — the echoed id is server-minted.
  expect(rid).not.toBe("client-spoofed");
});

test("Arabic locale renders RTL with translated copy and no horizontal scroll (Phase F)", async ({
  context,
  page,
}) => {
  // The `locale` cookie drives lang/dir + the message catalog end-to-end.
  await context.addCookies([{ name: "locale", value: "ar", url: "http://localhost:3000" }]);
  await page.goto("/login");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(html).toHaveAttribute("lang", "ar");
  // The login title renders from the ar catalog, not English.
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();

  // RTL must not introduce horizontal overflow at mobile width.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
