import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

/**
 * H32 — the live path from "Show me around" to the first tour step.
 *
 * Written because the owner clicked it in production and nothing happened. Every
 * other H32 gate was green: the unit laws, fifteen integration tests against a
 * real database, two production smokes. None of them clicked the button. This
 * one does, as the person the mandate is most careful about — somebody whose
 * membership PREDATES the eligibility cutoff, who must never be greeted
 * automatically and must always be able to ask.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 * Runs ONLY against the isolated test project (or CI's local stack): it creates
 * a real auth user and organisation, and refuses any environment that resolves
 * to production. The session is minted through the admin API and consumed by
 * the app's own /auth/confirm route — no password exists anywhere in this file.
 * Self-cleaning: every row it creates is removed in afterAll.
 *
 * Needs the dev/prod server on baseURL to be running with the SAME test env and
 * FEATURE_GUIDED_ONBOARDING=1.
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

/** Everything one fixture person needs, and how to remove them. */
type Fixture = {
  email: string;
  userId: string;
  orgId: string;
};

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
    // this file needs nothing from src/.
    // Inside one transaction with the acting user set, exactly as withUserCtx
    // would: the function writes the 'org.create' audit row from that GUC.
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

/**
 * A one-time sign-in URL, consumed by the app's own /auth/confirm route.
 *
 * This is the magic-link flow with the email step removed — nothing is typed
 * anywhere. Minted per sign-in rather than per fixture, because the token is
 * single-use: the first version of this file minted one per person and the
 * second test to use it landed on /auth/verify?reason=expired.
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

/** Sign in without a password: a fresh token, consumed by the app itself. */
async function signIn(page: Page, f: Fixture): Promise<void> {
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

test.describe("H32 — Show me around", () => {
  test.skip(!RUN, "needs the isolated test project (or a local stack) and a service-role key");
  test.describe.configure({ mode: "serial" });

  let existing: Fixture;
  let newcomer: Fixture;

  test.beforeAll(async () => {
    existing = await makeFixture({ preCutoff: true, label: "existing" });
    newcomer = await makeFixture({ preCutoff: false, label: "newcomer" });
  });

  test.afterAll(async () => {
    if (existing) await removeFixture(existing);
    if (newcomer) await removeFixture(newcomer);
  });

  test("an existing pre-cutoff member is NOT greeted automatically", async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, existing);

    // The restart item is there — the flag is on — but no panel opened itself.
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("menuitem", { name: "Show me around" })).toBeVisible();
    await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
    await expect(page.locator("#iw-tour-title")).toHaveCount(0);
    expect(errors.map((e) => e.text())).toEqual([]);
  });

  test("…and clicking Show me around shows the first step immediately", async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, existing);

    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Show me around" }).click();

    // THE assertion this file exists for. Not "eventually, after a reload" —
    // the first step, on this page, as a result of that click.
    const title = page.locator("#iw-tour-title");
    await expect(title).toBeVisible({ timeout: 15_000 });
    await expect(title).toHaveText("Your home page");
    await expect(page.getByText("Step 1 of 7")).toBeVisible();

    // The first target is on this page, so the spotlight has something to ring.
    // `:visible`, because the same anchor is emitted by the desktop sidebar AND
    // the mobile header, and only one of them is on screen at any width — the
    // tour itself picks whichever has a real box, and so must this.
    await expect(page.locator('[data-tour="brand"]:visible').first()).toBeVisible();

    // And the server agrees: the click created this person's row, in this
    // organisation, at the beginning. Read through the owner connection so the
    // assertion is about what was actually written, not what the page shows.
    const sql = postgres(DIRECT_URL, { max: 1, onnotice: () => {} });
    try {
      const rows = (await sql`
        select status, step_index, tour_key from public.onboarding_state
        where org_id = ${existing.orgId} and user_id = ${existing.userId}
      `) as unknown as Array<{ status: string; step_index: number; tour_key: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "in_progress", step_index: 0, tour_key: "owner" });
    } finally {
      await sql.end();
    }

    // It advances, and it can always be left. `exact`: on a dev server the
    // "Open Next.js Dev Tools" button also answers to "Next".
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Step 2 of 7")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(title).toHaveCount(0);

    expect(errors.map((e) => e.text())).toEqual([]);
  });

  test("a newcomer IS greeted automatically", async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, newcomer);
    await expect(page.locator("#iw-tour-welcome-title")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
    // Declined once means not asked again on the next page.
    await page.reload();
    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
    await expect(page.locator("#iw-tour-welcome-title")).toHaveCount(0);
    expect(errors.map((e) => e.text())).toEqual([]);
  });
});
