/**
 * Security review 2026-09-20 — laws that keep the closed gaps closed.
 *
 *   • Every server action under an organisation resolves through
 *     resolveCtxForAction (org-enforced MFA fails closed); the bare
 *     resolveCtx belongs to pages and layouts, which redirect.
 *   • Every authenticated API route under /api/o refuses an aal1 session
 *     when the organisation requires MFA.
 *   • The public per-company identity endpoints are rate-limited.
 *   • A deployed environment (production or preview) never runs the fake
 *     billing provider, and the fake webhook secret has no default there.
 *   • Image decoding checks the file signature and caps input pixels.
 *   • The signup action enforces the password rule the form advertises.
 *   • Bearer-token public pages are noindex and robots-disallowed.
 *   • Nothing under the app logs through console.* (the redacting logger only).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const ORG_APP = "src/app/(app)/o/[orgId]";
const API_ORG = "src/app/api/o/[orgId]";

describe("server actions fail closed on org-enforced MFA", () => {
  it("no server-action file under an organisation resolves with the bare resolveCtx", () => {
    const offenders: string[] = [];
    for (const f of walk(ORG_APP).filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))) {
      const src = readFileSync(f, "utf8");
      if (!src.startsWith('"use server"')) continue;
      if (/\bresolveCtx\(/.test(src)) offenders.push(f);
    }
    expect(offenders, "actions must use resolveCtxForAction").toEqual([]);
  });

  it("every authenticated route under /api/o refuses an unmet MFA policy", () => {
    const offenders: string[] = [];
    for (const f of walk(API_ORG).filter((p) => p.endsWith("route.ts"))) {
      const src = readFileSync(f, "utf8");
      if (!/resolveCtx\(/.test(src)) continue; // public identity endpoints resolve nothing
      if (!/mfaSatisfied/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the public manifest and icon endpoints are rate-limited per client address", () => {
    for (const f of [`${API_ORG}/manifest/route.ts`, `${API_ORG}/icon/[spec]/route.ts`]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/rateLimit\("identity", clientIpFromHeaders\(request\.headers\)\)/);
      expect(src, f).toMatch(/status: 429/);
    }
  });
});

describe("the identity budget on the memory backend", () => {
  it("allows sixty calls per address per minute and refuses the sixty-first", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { rateLimit, RATE_RULES } = await import("@/platform/http/rateLimit");
    expect(RATE_RULES.identity).toEqual({ limit: 60, windowSeconds: 60 });
    const who = `probe-${Date.now()}`;
    let allowed = 0;
    let refusedAt = -1;
    for (let i = 1; i <= 61; i++) {
      const r = await rateLimit("identity", who);
      if (r.allowed) allowed++;
      else if (refusedAt < 0) refusedAt = i;
    }
    expect(allowed).toBe(60);
    expect(refusedAt).toBe(61);
    // A different address has its own budget.
    expect((await rateLimit("identity", who + "-other")).allowed).toBe(true);
  });
});

describe("billing provider by environment", () => {
  const original = process.env.APP_ENV;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = original;
    delete process.env.BILLING_PROVIDER;
    delete process.env.BILLING_FAKE_WEBHOOK_SECRET;
  });

  it("a preview deployment gets the disabled provider unless an operator set a fake secret", async () => {
    process.env.APP_ENV = "preview";
    delete process.env.BILLING_PROVIDER;
    delete process.env.BILLING_FAKE_WEBHOOK_SECRET;
    const mod = await import("@/platform/billing/adapter");
    expect(mod.getBillingProvider()).toBe(mod.disabledBillingProvider);
    process.env.BILLING_FAKE_WEBHOOK_SECRET = "preview-secret-set-by-an-operator";
    expect(mod.getBillingProvider()).toBe(mod.fakeBillingProvider);
  });

  it("local development still gets the fake provider", async () => {
    process.env.APP_ENV = "dev";
    const mod = await import("@/platform/billing/adapter");
    expect(mod.getBillingProvider()).toBe(mod.fakeBillingProvider);
  });

  it("when deployed without an explicit secret, the fake provider verifies nothing", async () => {
    process.env.APP_ENV = "preview";
    delete process.env.BILLING_FAKE_WEBHOOK_SECRET;
    const mod = await import("@/platform/billing/adapter");
    const signed = mod.fakeBillingProvider.signEvent({
      type: "activated",
      providerCustomerId: "cus_x",
      providerSubscriptionId: "sub_x",
      planKey: "growth",
      eventId: "evt_1",
      occurredAt: new Date().toISOString(),
    } as never);
    expect(mod.fakeBillingProvider.verifySignature(signed.body, signed.signature)).toBe(false);
  });
});

describe("image decoding", () => {
  it("rejects bytes that are not a JPEG, PNG or WebP before decoding", async () => {
    const { processImage, processLogo, UnsupportedImageError } =
      await import("@/platform/files/image");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(processImage(svg)).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(processLogo(Buffer.from("not an image at all"))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });

  it("still processes a real PNG", async () => {
    const { processImage } = await import("@/platform/files/image");
    const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: "#336699ff" },
    })
      .png()
      .toBuffer();
    const out = await processImage(png);
    expect(out.main.width).toBe(64);
    expect(out.thumb.mime).toBe("image/jpeg");
  });

  it("caps input pixels on every decode", () => {
    const src = readFileSync("src/platform/files/image.ts", "utf8");
    expect(src).toMatch(/limitInputPixels: MAX_INPUT_PIXELS/);
    expect(src.match(/sharp\(input, DECODE\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/Promise\.all\(\[\s*encode/);
  });
});

describe("other closed gaps stay closed", () => {
  it("the signup action enforces the minimum password length on the server", () => {
    const src = readFileSync("src/app/(auth)/actions.ts", "utf8");
    const signup = src.slice(
      src.indexOf("export async function signupAction"),
      src.indexOf("export async function", src.indexOf("export async function signupAction") + 10),
    );
    expect(signup).toMatch(/password\.length < PASSWORD_MIN_LENGTH/);
  });

  it("bearer-token public pages are noindex and disallowed for crawlers", () => {
    for (const f of [
      "src/app/f/[token]/page.tsx",
      "src/app/sign/[token]/page.tsx",
      "src/app/s/[token]/page.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/robots: \{ index: false, follow: false/);
    }
    const robots = readFileSync("src/app/robots.ts", "utf8");
    for (const p of ['"/d/"', '"/s/"', '"/f/"', '"/sign/"', '"/invite/"', '"/api/"'])
      expect(robots).toContain(p);
  });

  it("the invitation rate limit keys on the platform-set client address", () => {
    const src = readFileSync("src/app/(app)/o/[orgId]/settings/members/actions.ts", "utf8");
    expect(src).not.toMatch(/x-forwarded-for/);
    expect(src.match(/clientIpFromHeaders\(h\)/g)?.length ?? 0).toBe(2);
  });

  it("session cookies are Secure on every deployed origin", () => {
    const src = readFileSync("src/platform/tenancy/supabase.ts", "utf8");
    expect(src).toMatch(/secure: isDeployed\(\)/);
    expect(src.match(/cookieOptions: COOKIE_OPTIONS/g)?.length ?? 0).toBe(2);
  });

  it("nothing under the app logs through console.*", () => {
    const offenders: string[] = [];
    for (const f of walk("src/app").filter((p) => /\.tsx?$/.test(p))) {
      if (/console\.(log|error|warn|info)\(/.test(readFileSync(f, "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the cron secret comparison compares bytes", () => {
    const src = readFileSync("src/app/api/cron/idara/route.ts", "utf8");
    expect(src).toMatch(/if \(a\.length !== b\.length\) return false;/);
  });

  it("every third-party action in CI is pinned to a commit", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const uses = ci.match(/uses: [^\s]+/g) ?? [];
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
    expect(ci).toMatch(/audit-bulk\.mjs --level high --dev/);
  });
});
