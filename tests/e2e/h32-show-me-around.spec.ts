import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import EN from "../../src/platform/i18n/messages/en.json";
import AR from "../../src/platform/i18n/messages/ar.json";

/**
 * The action-driven owner tour (version 2), driven by a real signed-in browser
 * with real taps.
 *
 * Version 1 of this file clicked Next through a slideshow. Version 2 of the
 * tour has no slideshow: a step ends when the person does the thing it asks
 * (the route becomes /jobs; a click lands on the + button) or, for a look
 * step, presses Next. So this walk taps the real Work tab, opens the real
 * drawer on a phone, taps Customers inside it, opens the real + menu, and
 * checks the database after every transition. It also proves the three
 * escape hatches — Skip this step, Exit, Escape — never record "completed",
 * that nothing in the organisation moves, and that a version-1 position
 * resumes at step 1.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 * Runs ONLY against the isolated test project (or CI's local stack): it creates
 * a real auth user and organisation, and refuses any environment that resolves
 * to production. The session is minted through the admin API and consumed by
 * the app's own /auth/confirm route — no password exists anywhere in this file.
 * Self-cleaning: every row it creates is removed in afterAll.
 *
 * Needs the server on baseURL running with the SAME test env and
 * FEATURE_GUIDED_ONBOARDING=1 (see playwright.local.config.ts).
 */

const TEST_PROJECT_REF = "zwnnqaryouevnzuwtyaj";
const PRODUCTION_PROJECT_REF = "anhgeeutrwftsvuzfinf";
const FIXTURE_KEY = "test.fixture";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";

function isolatedTarget(): boolean {
  const refs = [SUPABASE_URL, DIRECT_URL].join(" ");
  if (refs.includes(PRODUCTION_PROJECT_REF)) return false;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);
  return local || refs.includes(TEST_PROJECT_REF);
}

const RUN = isolatedTarget() && !!SERVICE_ROLE && !!DIRECT_URL;

type Catalogue = Record<string, string>;
type Fixture = { email: string; userId: string; orgId: string };

async function makeFixture(opts: { preCutoff: boolean; label: string }): Promise<Fixture> {
  const run = randomUUID().slice(0, 8);
  const email = `h32-${opts.label}-${run}@example.com`;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
    if (opts.preCutoff) {
      await sql`
        update public.membership set created_at = '2026-01-15T00:00:00Z'
        where org_id = ${orgId} and user_id = ${userId}`;
    }
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

async function signIn(page: Page, f: Fixture): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  });
  await page.goto(await mintSignInPath(f));
  await page.waitForURL(new RegExp(`/o/${f.orgId}`), { timeout: 30_000 });
}

function watchConsole(page: Page): ConsoleMessage[] {
  const errors: ConsoleMessage[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m);
  });
  return errors;
}

type OnboardingRow = {
  status: string;
  step_index: number;
  tour_key: string | null;
  tour_version: number;
  completed_at: Date | null;
};

async function onboardingRow(f: Fixture): Promise<OnboardingRow | null> {
  const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      select status, step_index, tour_key, tour_version, completed_at from public.onboarding_state
      where org_id = ${f.orgId} and user_id = ${f.userId}
    `) as unknown as OnboardingRow[];
    return rows[0] ?? null;
  } finally {
    await sql.end();
  }
}

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

async function expectDb(f: Fixture, status: string, stepIndex?: number) {
  await expect
    .poll(
      async () => {
        const row = await onboardingRow(f);
        if (!row) return "none";
        return stepIndex === undefined ? row.status : `${row.status}/${row.step_index}`;
      },
      {
        timeout: 15_000,
        message: `database should say ${status}${stepIndex === undefined ? "" : `/${stepIndex}`}`,
      },
    )
    .toBe(stepIndex === undefined ? status : `${status}/${stepIndex}`);
}

/** The card for a step, and the law that it is inside the viewport. */
async function expectCard(page: Page, key: string, cat: Catalogue, stepNo: number) {
  const card = page.locator(`[data-tour-card="${key}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  // The title carries the organisation's own nouns ({job}, {jobs}); match the
  // catalogue string with those slots free.
  const titleRe = new RegExp(
    "^" +
      cat[`tour.owner.${key}.title`]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
        /\\\{jobs?\\\}/g,
        ".+",
      ) +
      "$",
  );
  await expect(page.locator("#iw-tour-title")).toHaveText(titleRe);
  await expect(
    page.getByText(
      cat["tour.progress"]!.replace("{current}", String(stepNo)).replace("{total}", String(TOTAL)),
      { exact: true },
    ),
  ).toBeVisible();
  const box = await card.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `step ${key}: card has a box`).not.toBeNull();
  const inside =
    box!.x >= 0 &&
    box!.y >= 0 &&
    box!.x + box!.width <= viewport.width + 1 &&
    box!.y + box!.height <= viewport.height + 1;
  expect(
    inside,
    `step ${key}: card ${JSON.stringify(box)} outside ${viewport.width}×${viewport.height}`,
  ).toBe(true);
}

/** The owner tour for a full-permission owner is six steps (More is skipped
 * silently on a laptop and answered on a phone; both count). */
const TOTAL = 6;

async function walk(page: Page, f: Fixture, cat: Catalogue, mobile: boolean) {
  const errors = watchConsole(page);
  const before = await businessCounts(f);

  await signIn(page, f);
  await expect(page.locator("[data-tour-card]")).toHaveCount(0);

  await page.getByRole("button", { name: cat["auth.account.title"]! }).click();
  await page.getByRole("menuitem", { name: cat["tour.restart"]! }).click();

  // 1 — Tap Work: ends on the route, never on Next.
  await expectCard(page, "work", cat, 1);
  await expect(page.getByRole("button", { name: cat["tour.next"]!, exact: true })).toHaveCount(0);
  await expect(page.locator('[data-tour-spotlight="nav:jobs"]')).toHaveCount(1);
  await expectDb(f, "in_progress", 0);
  if (mobile) {
    // The card sits above the bottom bar; the Work tab under it is tappable.
    const hit = await page.evaluate(() => {
      const link = document.querySelector(
        'nav.fixed.bottom-0 [data-tour="nav:jobs"] a',
      ) as HTMLElement;
      const r = link.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el ? link.contains(el) : false;
    });
    expect(hit, "the Work tab is not intercepted by the tour").toBe(true);
  }
  await page.locator('[data-tour="nav:jobs"]:visible').first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${f.orgId}/jobs$`));

  // 2 — a look step: Next.
  await expectCard(page, "new_job", cat, 2);
  await expectDb(f, "in_progress", 1);
  await page.getByRole("button", { name: cat["tour.next"]!, exact: true }).click();

  // 3 — More: a real tap on a phone, silent on a laptop.
  if (mobile) {
    await expectCard(page, "more", cat, 3);
    await page.locator('[data-tour="nav:more"]:visible').first().click();
  }

  // 4 — Customers, from the drawer on a phone, from the sidebar on a laptop.
  await expectCard(page, "customers", cat, 4);
  await expectDb(f, "in_progress", 3);
  await page.locator('[data-tour="nav:customers"]:visible').first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${f.orgId}/customers$`));

  // 5 — the + button: a real click that opens the real menu.
  await expectCard(page, "create", cat, 5);
  await page.locator('[data-tour="create"] button').first().click();
  await expect(page.getByRole("menu")).toBeVisible();

  // 6 — Done.
  await expectCard(page, "help", cat, 6);
  await expectDb(f, "in_progress", 5);
  await page.getByRole("button", { name: cat["tour.finish"]!, exact: true }).click();
  await expect(page.locator("[data-tour-card]")).toHaveCount(0);
  await expectDb(f, "completed", TOTAL);
  const done = await onboardingRow(f);
  expect(done?.completed_at, "completed_at is stamped").not.toBeNull();
  expect(Number(done?.tour_version)).toBe(2);

  // Finished means not asked again.
  await page.reload();
  await expect(page.getByRole("button", { name: cat["auth.account.title"]! })).toBeVisible();
  await expect(page.locator("[data-tour-card]")).toHaveCount(0);

  // Restart → step 1 → Skip this step is always available → Exit records skipped.
  await page.getByRole("button", { name: cat["auth.account.title"]! }).click();
  await page.getByRole("menuitem", { name: cat["tour.restart"]! }).click();
  await expectCard(page, "work", cat, 1);
  await expectDb(f, "in_progress", 0);
  expect((await onboardingRow(f))?.completed_at, "restart clears completion").toBeNull();
  await page.getByRole("button", { name: cat["tour.skip_step"]!, exact: true }).click();
  await expectCard(page, "new_job", cat, 2);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-tour-card]")).toHaveCount(0);
  await expectDb(f, "skipped");

  expect(await businessCounts(f)).toEqual(before);
  expect(errors.map((e) => e.text())).toEqual([]);
}

test.describe("the action-driven owner tour", () => {
  test.skip(!RUN, "needs the isolated test project (or a local stack) and a service-role key");
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  let existing: Fixture;
  let existingAr: Fixture;
  let newcomer: Fixture;
  let upgraded: Fixture;

  test.beforeAll(async () => {
    existing = await makeFixture({ preCutoff: true, label: "owner-en" });
    existingAr = await makeFixture({ preCutoff: true, label: "owner-ar" });
    newcomer = await makeFixture({ preCutoff: false, label: "newcomer" });
    upgraded = await makeFixture({ preCutoff: true, label: "v1" });
  });

  test.afterAll(async () => {
    for (const f of [existing, existingAr, newcomer, upgraded]) if (f) await removeFixture(f);
  });

  test("a pre-cutoff owner starts it by hand and taps through every step", async ({
    page,
  }, info) => {
    await walk(page, existing, EN as Catalogue, info.project.name.startsWith("mobile"));
  });

  test("…and in Arabic, right to left", async ({ page, context, baseURL }, info) => {
    await context.addCookies([
      { name: "locale", value: "ar", url: baseURL ?? "http://localhost:3000" },
    ]);
    await walk(page, existingAr, AR as Catalogue, info.project.name.startsWith("mobile"));
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("a newcomer is greeted without the bottom bar being covered, and Not now sticks", async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await signIn(page, newcomer);
    await expect(page.locator('[data-tour-card="welcome"]')).toBeVisible({ timeout: 15_000 });
    // No full-screen click-catching backdrop anywhere.
    await expect(page.locator(".fixed.inset-0.z-\\[100\\]")).toHaveCount(0);
    // Scoped to the card: the install card on a phone has its own "Not now".
    await page
      .locator('[data-tour-card="welcome"]')
      .getByRole("button", { name: EN["tour.not_now"] })
      .click();
    await expect(page.locator('[data-tour-card="welcome"]')).toHaveCount(0);
    await expectDb(newcomer, "skipped");
    await page.reload();
    await expect(page.getByRole("button", { name: EN["auth.account.title"] })).toBeVisible();
    await expect(page.locator("[data-tour-card]")).toHaveCount(0);
    expect(errors.map((e) => e.text())).toEqual([]);
  });

  test("a version-1 position resumes at step 1 of version 2", async ({ page }) => {
    const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
    try {
      await sql`
        insert into public.onboarding_state (org_id, user_id, status, step_index, tour_key, tour_version)
        values (${upgraded.orgId}, ${upgraded.userId}, 'in_progress', 5, 'owner', 1)`;
    } finally {
      await sql.end();
    }
    await signIn(page, upgraded);
    await expect(page.locator('[data-tour-card="work"]')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(
        EN["tour.progress"]!.replace("{current}", "1").replace("{total}", String(TOTAL)),
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expectDb(upgraded, "skipped");
    expect(Number((await onboardingRow(upgraded))?.tour_version)).toBe(2);
  });
});
