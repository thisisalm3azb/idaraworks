/**
 * Security review 2026-09-20 (evening) — the fail-fast guard against a server
 * whose auth client was built for one Supabase project while its database
 * URL points at another (the accidental production-configured local build).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSameSupabaseProject,
  supabaseRefFromDatabaseUrl,
  supabaseRefFromUrl,
  SupabaseProjectMismatchError,
} from "@/platform/tenancy/projectGuard";

const A = "abcdefghijklmnopqrst"; // 20-char refs, like Supabase's
const B = "tsrqponmlkjihgfedcba";

describe("project reference extraction", () => {
  it("reads the ref from a hosted auth URL and ignores local ones", () => {
    expect(supabaseRefFromUrl(`https://${A}.supabase.co`)).toBe(A);
    expect(supabaseRefFromUrl("http://127.0.0.1:54321")).toBeNull();
    expect(supabaseRefFromUrl("http://localhost:54321")).toBeNull();
    expect(supabaseRefFromUrl("http://supabase_kong:8000")).toBeNull();
    expect(supabaseRefFromUrl("not a url")).toBeNull();
    expect(supabaseRefFromUrl(undefined)).toBeNull();
  });

  it("reads the ref from a direct database host and from a pooler user", () => {
    expect(
      supabaseRefFromDatabaseUrl(`postgresql://postgres:pw@db.${A}.supabase.co:5432/postgres`),
    ).toBe(A);
    expect(
      supabaseRefFromDatabaseUrl(
        `postgresql://postgres.${A}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(A);
    expect(
      supabaseRefFromDatabaseUrl("postgresql://postgres:pw@127.0.0.1:54322/postgres"),
    ).toBeNull();
    expect(
      supabaseRefFromDatabaseUrl("postgresql://postgres:pw@localhost:54322/postgres"),
    ).toBeNull();
    expect(supabaseRefFromDatabaseUrl("postgresql://postgres:pw@db:5432/postgres")).toBeNull();
    // A pooler host with an unexpected user shape is unknown, not a mismatch.
    expect(
      supabaseRefFromDatabaseUrl(
        "postgresql://postgres:pw@aws-0-x.pooler.supabase.com:6543/postgres",
      ),
    ).toBeNull();
  });
});

describe("assertSameSupabaseProject", () => {
  it("refuses a build whose auth project differs from the runtime database project", () => {
    expect(() =>
      assertSameSupabaseProject({
        NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`,
        DATABASE_URL: `postgresql://postgres.${B}:pw@aws-0-x.pooler.supabase.com:6543/postgres`,
      }),
    ).toThrow(SupabaseProjectMismatchError);
    try {
      assertSameSupabaseProject({
        NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`,
        DATABASE_URL: `postgresql://postgres:pw@db.${B}.supabase.co:5432/postgres`,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseProjectMismatchError);
      expect((err as Error).message).toContain("with-test-env.mjs pnpm build");
      // The message names refs, never a password or key.
      expect((err as Error).message).not.toContain("pw");
    }
  });

  it("passes when both sides name the same project, and when either side is local", () => {
    expect(
      assertSameSupabaseProject({
        NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`,
        DATABASE_URL: `postgresql://postgres.${A}:pw@aws-0-x.pooler.supabase.com:6543/postgres`,
      }),
    ).toEqual({ authRef: A, databaseRef: A });
    expect(
      assertSameSupabaseProject({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:54322/postgres",
      }),
    ).toEqual({ authRef: null, databaseRef: null });
    expect(
      assertSameSupabaseProject({
        NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`,
        DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:54322/postgres",
      }),
    ).toEqual({ authRef: A, databaseRef: null });
    expect(assertSameSupabaseProject({})).toEqual({ authRef: null, databaseRef: null });
  });
});

describe("the guard is wired", () => {
  it("instrumentation calls the guard at server start, before anything else", () => {
    const src = readFileSync("src/instrumentation.ts", "utf8");
    const register = src.slice(src.indexOf("export async function register"));
    expect(register).toContain("assertSameSupabaseProject()");
    expect(register.indexOf("assertSameSupabaseProject()")).toBeLessThan(
      register.indexOf("initSentryServer()"),
    );
  });
});
