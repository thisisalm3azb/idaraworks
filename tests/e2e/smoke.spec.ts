import { expect, test } from "@playwright/test";
import EN from "../../src/platform/i18n/messages/en.json";

// `/` is the public marketing homepage for signed-out visitors (005A) — it no
// longer redirects to /login. Get Started routes to registration; Log in to
// /login. Runs at both desktop and mobile-375, so it doubles as a homepage
// responsive check.
test("unauthenticated root renders the public homepage", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  // The headline is read from the copy catalogue rather than repeated here: a
  // hardcoded copy went stale in H13 when the hero was rewritten, and this
  // smoke has been failing on main ever since.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(EN["home.hero.title"]);
  await expect(page.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute(
    "href",
    "/signup",
  );
  await expect(page.getByRole("link", { name: "Log in" }).first()).toHaveAttribute(
    "href",
    "/login",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
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

test("login → signup navigation reaches the registration gateway", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup/);
  // 005B: /signup is the new split-screen registration gateway.
  await expect(page.getByRole("heading", { name: /Create your IdaraWorks account/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
    "href",
    "/terms",
  );
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
