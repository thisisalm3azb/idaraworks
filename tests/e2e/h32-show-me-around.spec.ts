import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import EN from "../../src/platform/i18n/messages/en.json";
import AR from "../../src/platform/i18n/messages/ar.json";

/**
 * H32 — the complete owner tour, driven by a real signed-in browser.
 *
 * Written twice. The first version proved that "Show me around" produced the
 * first card, because the owner had clicked it in production and nothing
 * happened. The owner then reported the tour stopping at step 2 of 7 — and
 * that version had clicked Next exactly once. Proving the first card is not
 * proving the tour. This version walks every step, presses Back, finishes,
 * checks the database after every action, restarts, and proves nothing else in
 * the organisation moved.
 *
 * ── The assertion that catches the second defect ────────────────────────────
 * After every transition the card must be INSIDE the viewport. Step 3 points at
 * a sidebar item that can sit below the fold of a scrollable nav; a card
 * positioned relative to an off-screen target is a card nobody can see, and
 * every other assertion (title, progress, database) passes while it is
 * invisible. That is exactly how the owner experienced it.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 * Runs ONLY against the isolated test project (or CI's local stack): it creates
 * a real auth user and organisation, and refuses any environment that resolves
 * to production. The session is minted through the admin API and consumed by
 * the app's own /auth/confirm route — no password exists anywhere in this file.
 * Self-cleaning: every row it creates is removed in afterAll.
 *
 * Needs the dev server on baseURL running with the SAME test env and
 * FEATURE_GUIDED_ONBOARDING=1 (see playwright.local.config.ts).
 */

const TEST_PROJECT_REF = "zwnnqaryouevnzuwtyaj";
const PRODUCTION_PROJECT_REF = "anhgeeutrwftsvuzfinf";
const FIXTURE_KEY = "test.fixture";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";

/** True only for the disposable test project or a local stack. */
function isolatedTarget(): boolean {
  const refs = [SUPABASE_URL, DIRECT_URL].join(" ");
  if (refs.includes(PRODUCTION_PROJECT_REF)) return false;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
  return local || refs.includes(TEST_PROJECT_REF);
}

const RUN = isolatedTarget() && !!SERVICE_ROLE && !!DIRECT_URL;

/**
 * The owner tour, in order, from the same source the product reads. Titles are
 * looked up in the catalogue rather than typed here, so a copy change cannot
 * make this file lie in either direction.
 */
const OWNER_STEPS = ["home", "create", "customers", "jobs", "invoices", "team", "help"] as const;
type Catalogue = Record<string, string>;
const title = (cat: Catalogue, step: string) => cat[`tour.owner.${step}.title`]!;
const progress = (cat: Catalogue, n: number) =>
  cat["tour.progress"]!.replace("{current}", String(n)).replace(
    "{total}",
    String(OWNER_STEPS.length),
  );

type Fixture = { email: string; userId: string; orgId: string };

async function makeFixture(opts: { preCutoff: boolean; label: string }): Promise<Fixture> {
  const run = randomUUID().slice(0, 8);
  const email = `h32-${opts.label}-${run}@example.com`;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // A confirmed user, created through the admin API. The auth.users trigger
  // creates the user_profile row the org creation needs.
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: `H32 ${opts.label}` },
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  const userId = created.data.user.id;

  const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
  let orgId = "";
  try {
    // The same door the product uses to create a workspace, called directly so
    // this file needs nothing from src/. Inside one transaction with the acting
    // user set, exactly as withUserCtx would: the function writes the
    // 'org.create' audit row from that GUC.
    orgId = await sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      const [row] = (await tx`
        select app.create_org_with_owner(
          ${userId}::uuid, ${`H32 ${opts.label} ${run}`}, 'AE', 'AED',
          'Asia/Dubai', array['en'], false
        ) as org_id
      `) as unknown as Array<{ org_id: string }>;
      return row!.org_id;
    });

    // The membership date is the whole eligibility rule. Somebody who joined
    // long before the cutoff must never be greeted automatically.
    if (opts.preCutoff) {
      await sql`
        update public.membership set created_at = '2026-01-15T00:00:00Z'
        where org_id = ${orgId} and user_id = ${userId}`;
    }

    // Marked by EVIDENCE, so a residue sweep can identify it without guessing.
    await sql`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${FIXTURE_KEY}, ${sql.json({
        is_test_fixture: true,
        suite: "h32-show-me-around",
        run,
        created_at: new Date().toISOString(),
      })})
      on conflict (org_id, key) do update set value = excluded.value`;
  } finally {
    await sql.end();
  }

  return { email, userId, orgId };
}

async function removeFixture(f: Fixture): Promise<void> {
  const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
  try {
    const tables = (await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
    `) as unknown as Array<{ table_name: string }>;
    const SAFE = /^[a-z_][a-z0-9_]*$/;
    const script = [
      ...tables
        .map((t) => t.table_name)
        .filter((t) => SAFE.test(t))
        .map((t) => `delete from public."${t}" where org_id = '${f.orgId}';`),
      `delete from public.org where id = '${f.orgId}';`,
    ].join("\n");
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx.unsafe(script);
      await tx.unsafe("set local session_replication_role = default");
    });
    await sql`delete from public.user_profile where id = ${f.userId}`;
    await sql`delete from auth.users where id = ${f.userId}`;
  } finally {
    await sql.end();
  }
}

/**
 * A one-time sign-in URL, consumed by the app's own /auth/confirm route.
 *
 * This is the magic-link flow with the email step removed — nothing is typed
 * anywhere. Minted per sign-in rather than per fixture, because the token is
 * single-use.
 */
async function mintSignInPath(f: Fixture): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: f.email });
  if (link.error || !link.data.properties?.hashed_token) {
    throw link.error ?? new Error("no token");
  }
  return (
    `/auth/confirm?token_hash=${encodeURIComponent(link.data.properties.hashed_token)}` +
    `&type=magiclink&next=${encodeURIComponent(`/o/${f.orgId}`)}`
  );
}

/** Sign in without a password: a fresh token, consumed by the app itself. */
async function signIn(page: Page, f: Fixture): Promise<void> {
  // The Next.js DEV overlay badge floats over the bottom corner and, on a
  // 375px screen in RTL, sits exactly on the sheet's primary button —
  // Playwright reported "<nextjs-portal> intercepts pointer events". It does
  // not exist in a production build; hiding it here keeps the walk about the
  // product, not the dev tooling.
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  });
  await page.goto(await mintSignInPath(f));
  await page.waitForURL(new RegExp(`/o/${f.orgId}`), { timeout: 30_000 });
}

/** Collect anything the page complains about, so a hidden failure surfaces. */
function watchConsole(page: Page): ConsoleMessage[] {
  const errors: ConsoleMessage[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m);
  });
  return errors;
}

// ── Database views, read through the owner connection ───────────────────────

type OnboardingRow = {
  status: string;
  step_index: number;
  tour_key: string | null;
  completed_at: Date | null;
};

async function onboardingRow(f: Fixture): Promise<OnboardingRow | null> {
  const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      select status, step_index, tour_key, completed_at from public.onboarding_state
      where org_id = ${f.orgId} and user_id = ${f.userId}
    `) as unknown as OnboardingRow[];
    return rows[0] ?? null;
  } finally {
    await sql.end();
  }
}

/** The business numbers for one organisation. The tour must never move them. */
async function businessCounts(f: Fixture): Promise<Record<string, number>> {
  const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
  try {
    const [r] = (await sql`
      select
        (select count(*) from public.customer where org_id = ${f.orgId})::int as customers,
        (select count(*) from public.job where org_id = ${f.orgId})::int as jobs,
        (select count(*) from public.invoice where org_id = ${f.orgId})::int as invoices,
        (select count(*) from public.quote where org_id = ${f.orgId})::int as quotes,
        (select count(*) from public.audit_log where org_id = ${f.orgId})::int as audit_rows,
        (select count(*) from public.membership where org_id = ${f.orgId})::int as memberships
    `) as unknown as Array<Record<string, number>>;
    return r!;
  } finally {
    await sql.end();
  }
}

/** Wait for a fire-and-forget progress write to land, then return the row. */
async function expectDbStep(f: Fixture, stepIndex: number, status = "in_progress") {
  await expect
    .poll(
      async () => {
        const row = await onboardingRow(f);
        return row ? `${row.status}/${row.step_index}` : "none";
      },
      { timeout: 15_000, message: `database should say ${status}/${stepIndex}` },
    )
    .toBe(`${status}/${stepIndex}`);
}

// ── The card itself ─────────────────────────────────────────────────────────

/**
 * The card must be where a person can see it. Title and progress can be
 * perfectly correct on a card positioned below the bottom of the screen.
 */
async function expectCardVisible(page: Page, cat: Catalogue, stepNo: number) {
  const card = page.getByRole("dialog");
  // The first card follows a restart: two dev-server round-trips. Generous.
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("#iw-tour-title")).toHaveText(title(cat, OWNER_STEPS[stepNo - 1]!));
  await expect(page.getByText(progress(cat, stepNo), { exact: true })).toBeVisible();

  const box = await card.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `step ${stepNo}: card has a box`).not.toBeNull();
  const inside =
    box!.x >= 0 &&
    box!.y >= 0 &&
    box!.x + box!.width <= viewport.width + 1 &&
    box!.y + box!.height <= viewport.height + 1;
  expect(
    inside,
    `step ${stepNo}: card at (${Math.round(box!.x)},${Math.round(box!.y)}) ` +
      `${Math.round(box!.width)}×${Math.round(box!.height)} is outside the ${viewport.width}×${viewport.height} viewport`,
  ).toBe(true);
}

/** Every anchored step's target exists in the DOM — visible or not. */
async function expectTargetsExist(page: Page) {
  const targets = [
    "brand",
    "create",
    "nav:customers",
    "nav:jobs",
    "nav:invoices",
    "nav:members",
    "account",
  ];
  for (const t of targets) {
    await expect(
      page.locator(`[data-tour="${t}"]`).first(),
      `target ${t} should be in the DOM`,
    ).toBeAttached();
  }
}

async function walkTheWholeTour(page: Page, f: Fixture, cat: Catalogue) {
  const errors = watchConsole(page);
  const before = await businessCounts(f);

  await signIn(page, f);
  // Pre-cutoff: nothing opened by itself.
  await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectTargetsExist(page);

  // Start it by hand.
  await page.getByRole("button", { name: cat["auth.account.title"]! }).click();
  await page.getByRole("menuitem", { name: cat["tour.restart"]! }).click();

  const next = page.getByRole("button", { name: cat["tour.next"]!, exact: true });
  const back = page.getByRole("button", { name: cat["tour.back"]!, exact: true });
  const done = page.getByRole("button", { name: cat["tour.finish"]!, exact: true });

  // Step 1.
  await expectCardVisible(page, cat, 1);
  await expectDbStep(f, 0);

  // Forward through every step, checking the screen AND the database each time.
  for (let stepNo = 2; stepNo <= OWNER_STEPS.length; stepNo++) {
    await next.click();
    await expectCardVisible(page, cat, stepNo);
    await expectDbStep(f, stepNo - 1);

    // Back once, from step 3 — and the database must NOT move backwards, because
    // a stale tab one step behind must never undo real progress.
    if (stepNo === 3) {
      await back.click();
      await expectCardVisible(page, cat, 2);
      await expectDbStep(f, 2);
      await next.click();
      await expectCardVisible(page, cat, 3);
    }
  }

  // The last step offers Done, not Next.
  await expect(next).toHaveCount(0);
  await done.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectDbStep(f, OWNER_STEPS.length, "completed");
  expect((await onboardingRow(f))?.completed_at, "completed_at is stamped").not.toBeNull();

  // Finished means not asked again.
  await page.reload();
  await expect(page.getByRole("button", { name: cat["auth.account.title"]! })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Restart from the menu: step 1, from the beginning, in the database too.
  await page.getByRole("button", { name: cat["auth.account.title"]! }).click();
  await page.getByRole("menuitem", { name: cat["tour.restart"]! }).click();
  await expectCardVisible(page, cat, 1);
  await expectDbStep(f, 0);
  expect((await onboardingRow(f))?.completed_at, "restart clears completion").toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectDbStep(f, 0, "skipped");

  // Nothing in the business moved.
  expect(await businessCounts(f)).toEqual(before);
  expect(errors.map((e) => e.text())).toEqual([]);
}

test.describe("H32 — the whole owner tour", () => {
  test.skip(!RUN, "needs the isolated test project (or a local stack) and a service-role key");
  // Serial, and generous: a single restart is two server round-trips, each of
  // which the dev server serves in 6–11 seconds while it compiles, and the walk
  // does that twice plus eight progress writes. The base 30-second budget is
  // for a smoke, not a walk.
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  let existing: Fixture;
  let existingAr: Fixture;
  let newcomer: Fixture;

  test.beforeAll(async () => {
    existing = await makeFixture({ preCutoff: true, label: "owner-en" });
    existingAr = await makeFixture({ preCutoff: true, label: "owner-ar" });
    newcomer = await makeFixture({ preCutoff: false, label: "newcomer" });
  });

  test.afterAll(async () => {
    for (const f of [existing, existingAr, newcomer]) if (f) await removeFixture(f);
  });

  test("a pre-cutoff owner starts it by hand and walks all seven steps (English)", async ({
    page,
  }) => {
    await walkTheWholeTour(page, existing, EN as Catalogue);
  });

  test("…and in Arabic, right to left", async ({ page, context, baseURL }) => {
    // The same cookie the language menu sets; set directly so the walk is about
    // the tour, not about the language switcher.
    await context.addCookies([
      { name: "locale", value: "ar", url: baseURL ?? "http://localhost:3000" },
    ]);
    await walkTheWholeTour(page, existingAr, AR as Catalogue);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("a newcomer IS greeted automatically, and Not now sticks", async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, newcomer);
    await expect(page.locator("#iw-tour-welcome-title")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: EN["tour.not_now"] }).click();
    await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: EN["auth.account.title"] })).toBeVisible();
    await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
    expect(errors.map((e) => e.text())).toEqual([]);
  });
});
