/**
 * Production smoke checks (Phase I; runbooks/deployment-and-rollback.md step 4).
 *
 *   pnpm smoke:prod                          # against the production alias
 *   pnpm smoke:prod -- https://<deploy-url>  # against a specific deployment
 *   EXPECTED_COMMIT=<sha> pnpm smoke:prod    # also assert the deployed commit
 *
 * Read-only: no writes, no auth, no test data. Asserts the deployed surface:
 * routing, auth gate, health dependencies, readiness, inngest status clarity,
 * and the security headers. Exit 1 on any failure.
 */
const base = (process.argv[2] ?? "https://idaraworks.vercel.app").replace(/\/$/, "");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  return res;
}

async function main() {
  // 1. Landing redirects unauthenticated traffic to /login.
  {
    const res = await get("/");
    const loc = res.headers.get("location") ?? "";
    record(
      "landing auth gate",
      res.status === 307 && loc.endsWith("/login"),
      `${res.status} -> ${loc}`,
    );
  }

  // 2. Login page serves, with the security headers and a correlation id.
  {
    const res = await get("/login");
    const csp = res.headers.get("content-security-policy") ?? "";
    const hsts = res.headers.get("strict-transport-security") ?? "";
    record("login page", res.status === 200, `status ${res.status}`);
    record("CSP present", csp.includes("default-src 'self'"), csp.slice(0, 60) + "…");
    record(
      "CSP pins Supabase host",
      /connect-src[^;]*https:\/\/[a-z0-9]+\.supabase\.co/.test(csp),
      (csp.match(/connect-src[^;]*/) ?? ["(none)"])[0],
    );
    record("HSTS present", hsts.includes("max-age="), hsts || "(none)");
    record(
      "nosniff present",
      res.headers.get("x-content-type-options") === "nosniff",
      res.headers.get("x-content-type-options") ?? "(none)",
    );
    record(
      "x-request-id echoed",
      Boolean(res.headers.get("x-request-id")),
      res.headers.get("x-request-id") ?? "(none)",
    );
    record(
      "x-powered-by absent",
      res.headers.get("x-powered-by") === null,
      res.headers.get("x-powered-by") ?? "absent",
    );
  }

  // 3. Protected route redirects with a next= return path.
  {
    const res = await get("/o/00000000-0000-0000-0000-000000000000");
    const loc = res.headers.get("location") ?? "";
    record(
      "protected route gate",
      res.status === 307 && loc.includes("/login?next="),
      `${res.status} -> ${loc.slice(0, 80)}`,
    );
  }

  // 4. Readiness.
  {
    const res = await get("/api/ready");
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean };
    record("readiness", res.status === 200 && body.ready === true, `status ${res.status}`);
  }

  // 5. Health: per-dependency truth.
  {
    const res = await get("/api/health");
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      commit?: string | null;
      checks?: {
        db?: { ok?: boolean };
        storage?: { ok?: boolean };
        queue?: { ok?: boolean; dead_lettered?: number };
        inngest?: { status?: string };
      };
    };
    record("health overall", res.status === 200 && body.ok === true, `status ${res.status}`);
    record("health db", body.checks?.db?.ok === true, JSON.stringify(body.checks?.db ?? {}));
    record(
      "health storage",
      body.checks?.storage?.ok === true,
      JSON.stringify(body.checks?.storage ?? {}),
    );
    record(
      "health queue",
      body.checks?.queue?.ok === true,
      JSON.stringify(body.checks?.queue ?? {}),
    );
    record(
      "health inngest explicit",
      body.checks?.inngest?.status === "configured" ||
        body.checks?.inngest?.status === "unconfigured",
      body.checks?.inngest?.status ?? "(missing)",
    );
    record(
      "queue has no dead-letters",
      (body.checks?.queue?.dead_lettered ?? 0) === 0,
      `dead_lettered=${body.checks?.queue?.dead_lettered ?? "?"}`,
    );
    const expected = process.env.EXPECTED_COMMIT;
    if (expected) {
      record(
        "deployed commit matches",
        (body.commit ?? "").startsWith(expected),
        `deployed=${body.commit ?? "(null)"} expected=${expected}`,
      );
    }
  }

  // 6. Inngest route: never an unexplained 500 — either configured (200/405
  //    introspection) or an explicit unconfigured 503.
  {
    const res = await get("/api/inngest");
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    const explicit = res.status === 503 && body.status === "inngest_unconfigured";
    const configured = res.status === 200;
    record(
      "inngest status clarity",
      explicit || configured,
      `status ${res.status} body.status=${body.status ?? "-"}`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} smoke checks passed (${base})`);
  if (failed.length) process.exit(1);
}

void main().catch((e) => {
  console.error("smoke run crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
