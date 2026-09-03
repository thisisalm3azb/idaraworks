/**
 * H29C — translation governance against the real database.
 *
 * The mandate's rule is that a native review may not be claimed without
 * evidence. A rule that lives only in a form is not a rule, so it is enforced
 * where nothing can go around it: the table has no write grant at all, the one
 * write path is a security-definer function that asserts an active platform
 * operator, and that function refuses a decided review with no named reviewer.
 *
 * The suite proves each of those by attacking them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withUserCtx } from "@/platform/tenancy";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const operator = randomUUID();
const civilian = randomUUID();

const call = (
  userId: string,
  locale: string,
  production: string,
  nativeReview: string,
  reviewer: string | null,
  note: string | null = null,
) =>
  withUserCtx(userId, (tx) =>
    tx.execute(sql`
      select app.locale_release_set(${locale}, ${production}, ${nativeReview}, ${reviewer},
                                    'not_started', null, ${note})`),
  );

/**
 * The reason a refusal gives, as one string.
 *
 * The query layer wraps a database error in its own "Failed query" message and
 * hangs the real PostgresError off `cause`, so asserting on `.message` alone
 * would pass for ANY failure — including a typo in the test's own SQL. Reading
 * both means the assertions below check that the database refused for the
 * reason claimed, not merely that something went wrong.
 */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} :: ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the database to refuse, but the call succeeded");
}

beforeAll(async () => {
  for (const [id, name] of [
    [operator, "H29C Operator"],
    [civilian, "H29C Civilian"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h29c-${name.split(" ")[1]!.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${id}, ${name}, 'en')
      on conflict (id) do nothing`;
  }
  await owner`
    insert into public.platform_operator (user_id, note) values (${operator}, ${`h29c ${run}`})
    on conflict (user_id) do update set revoked_at = null`;
}, 300_000);

afterAll(async () => {
  // Restore the shipped record so a later run reads the migration's own truth.
  await owner`
    update public.locale_release
       set production = 'machine_assisted', native_review = 'not_started',
           native_reviewer = null, native_reviewed_at = null,
           legal_review = 'not_started', legal_reviewer = null, legal_reviewed_at = null
     where locale = 'es'`;
  await owner`delete from public.platform_operator where user_id = ${operator}`;
  for (const id of [operator, civilian]) {
    await owner`delete from public.user_profile where id = ${id}`;
    await owner`delete from auth.users where id = ${id}`;
  }
  await owner.end();
  await closeAppDb();
});

describe("the shipped record is honest about what has been reviewed", () => {
  it("every shipped locale has a row, and neither translation claims a review", async () => {
    const rows = await owner`
      select locale, production, native_review, native_reviewer
        from public.locale_release order by locale`;
    expect(rows.map((r) => r.locale).sort()).toEqual(["ar", "en", "es"]);
    const byLocale = Object.fromEntries(rows.map((r) => [r.locale, r]));
    expect(byLocale.en!.production).toBe("source");
    expect(byLocale.en!.native_review).toBe("not_applicable");
    // Both translations were produced with machine assistance inside build
    // phases. Neither carries a native review, and neither pretends to.
    for (const locale of ["ar", "es"]) {
      expect(byLocale[locale]!.production).toBe("machine_assisted");
      expect(byLocale[locale]!.native_review).toBe("not_started");
      expect(byLocale[locale]!.native_reviewer).toBeNull();
    }
  });
});

describe("only a platform operator can record a review", () => {
  it("a signed-in non-operator is refused", async () => {
    expect(
      await refusal(() => call(civilian, "es", "machine_assisted", "in_progress", null)),
    ).toMatch(/platform operator only/i);
  });

  it("the refusal writes nothing", async () => {
    const [row] = await owner`select native_review from public.locale_release where locale = 'es'`;
    expect(row!.native_review).toBe("not_started");
  });

  it("an operator can record progress", async () => {
    await call(operator, "es", "machine_assisted", "in_progress", null, `h29c ${run}`);
    const [row] = await owner`
      select native_review, native_reviewer, native_reviewed_at, note
        from public.locale_release where locale = 'es'`;
    expect(row!.native_review).toBe("in_progress");
    // An undecided review has no date: the date is evidence of a decision.
    expect(row!.native_reviewed_at).toBeNull();
    expect(row!.note).toBe(`h29c ${run}`);
  });
});

describe("a decided review cannot be claimed without evidence", () => {
  it("passed with no reviewer is refused", async () => {
    expect(await refusal(() => call(operator, "es", "machine_assisted", "passed", null))).toMatch(
      /named reviewer/i,
    );
  });

  it("passed with a blank reviewer is refused too", async () => {
    expect(await refusal(() => call(operator, "es", "machine_assisted", "passed", "   "))).toMatch(
      /named reviewer/i,
    );
  });

  it("failed with no reviewer is refused — the rule is about evidence, not approval", async () => {
    expect(await refusal(() => call(operator, "es", "machine_assisted", "failed", null))).toMatch(
      /named reviewer/i,
    );
  });

  it("passed with a named reviewer records the name AND the date together", async () => {
    await call(operator, "es", "native_authored", "passed", "A. Reviewer");
    const [row] = await owner`
      select production, native_review, native_reviewer, native_reviewed_at
        from public.locale_release where locale = 'es'`;
    expect(row!.production).toBe("native_authored");
    expect(row!.native_review).toBe("passed");
    expect(row!.native_reviewer).toBe("A. Reviewer");
    expect(row!.native_reviewed_at).not.toBeNull();
  });

  it("the table itself refuses a decided review without a reviewer, even to the owner", async () => {
    // The function is the intended path, but a direct write must fail too —
    // otherwise the rule is only a convention of one code path.
    expect(
      await refusal(
        () => owner`update public.locale_release set native_reviewer = null where locale = 'es'`,
      ),
    ).toMatch(/locale_release_native_evidence/);
  });
});

describe("the write path is the only write path", () => {
  it("app_user holds no insert, update or delete grant on the table", async () => {
    const rows = await owner`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'locale_release' and grantee = 'app_user'`;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["SELECT"]);
  });

  it("row-level security is on, with a read policy", async () => {
    const [table] = await owner`
      select relrowsecurity from pg_class where oid = 'public.locale_release'::regclass`;
    expect(table!.relrowsecurity).toBe(true);
    const policies = await owner`
      select cmd from pg_policies where schemaname = 'public' and tablename = 'locale_release'`;
    expect(policies.map((p) => p.cmd).sort()).toEqual(["SELECT"]);
  });

  it("any signed-in user can READ the record — people are told a language is unreviewed", async () => {
    const rows = (await withUserCtx(civilian, (tx) =>
      tx.execute(sql`select locale, native_review from public.locale_release order by locale`),
    )) as unknown as Array<{ locale: string; native_review: string }>;
    expect(rows.map((r) => r.locale)).toEqual(["ar", "en", "es"]);
  });
});

describe("every change leaves evidence", () => {
  it("each recorded change lands in the platform audit with the operator's identity", async () => {
    // Scoped to THIS run's operator: the audit is append-only and a previous
    // run of this suite leaves its own rows behind, so an unscoped read would
    // assert about somebody else's evidence.
    const rows = await owner`
      select actor_user_id, action, scope, scope_key, summary
        from public.platform_audit
       where action = 'locale_release.set' and scope_key = 'es' and actor_user_id = ${operator}
       order by created_at desc`;
    // Two successful writes happened above; the refusals wrote nothing.
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.scope).toBe("locale_release");
    expect(String(rows[0]!.summary)).toMatch(/native review passed/);
    expect(String(rows[1]!.summary)).toMatch(/native review in_progress/);
  });
});
