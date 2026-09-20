/**
 * Security review 2026-09-20, pass two — laws that keep the second set of
 * closed gaps closed:
 *   • every server action under a module-gated segment names its module, so
 *     a module the organisation switched off refuses the mutation (F-21);
 *   • the authentication endpoints that talk to the provider are budgeted
 *     per client address, and a recovery link lands only on the reset
 *     screen (F-30);
 *   • no action puts a raw error message in a URL, and the public signing
 *     page renders only whitelisted codes (F-26);
 *   • every money-recording form is idempotent end to end (F-27);
 *   • exports and PDFs are bounded and budgeted; form patterns are checked
 *     before they run (F-23, F-24, F-25);
 *   • the shared rate-limit store is the deployed default and only
 *     platform-set client addresses are trusted on Vercel.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const ORG_APP = "src/app/(app)/o/[orgId]";
const read = (p: string) => readFileSync(p, "utf8");

const GATED_SEGMENTS: Record<string, string> = {
  ar: "cap.invoicing",
  invoices: "cap.invoicing",
  approvals: "cap.approvals",
  attendance: "cap.attendance",
  claims: "cap.people",
  "my-pay": "cap.people",
  leave: "cap.people",
  payroll: "cap.people",
  costing: "cap.costing",
  "customer-updates": "cap.customer_updates",
  customers: "cap.customers",
  leads: "cap.customers",
  opportunities: "cap.customers",
  sales: "cap.customers",
  documents: "cap.documents",
  expenses: "cap.expenses",
  finance: "cap.finance",
  items: "cap.items",
  "my-work": "cap.jobs",
  "material-requests": "cap.material_requests",
  "purchase-orders": "cap.purchase_orders",
  suppliers: "cap.purchase_orders",
  payments: "cap.payments",
  quotes: "cap.quoting",
  reports: "cap.daily_reports",
  studio: "cap.studio",
  revenue: "cap.revenue_studio",
};

describe("module restrictions are enforced at the action boundary (F-21)", () => {
  it("the segment layouts still gate exactly the modules the law expects", () => {
    for (const [segment, module] of Object.entries(GATED_SEGMENTS)) {
      const src = read(join(ORG_APP, segment, "layout.tsx"));
      expect(src, `${segment}/layout.tsx must gate ${module}`).toContain(`module="${module}"`);
    }
  });

  it("every action under a gated segment names its module when it resolves", () => {
    for (const [segment, module] of Object.entries(GATED_SEGMENTS)) {
      // Some gated segments (ar, costing, my-pay) are read-only and have no actions.
      const files = walk(join(ORG_APP, segment)).filter((f) =>
        /(^|[\\/])(studio-)?actions\.ts$/.test(f),
      );
      for (const f of files) {
        const calls = read(f).match(/resolveCtxForAction\([^)]*\)/g) ?? [];
        expect(calls.length, `${f} resolves through resolveCtxForAction`).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call, `${f}: ${call}`).toContain(`{ module: "${module}" }`);
        }
      }
    }
  });

  it("a disabled module is refused by the resolver, not only hidden by the layout", () => {
    const src = read("src/platform/auth/resolve.ts");
    expect(src).toContain("moduleStateOf(");
    expect(src).toContain('=== "disabled"');
    expect(src).toContain('return "module_disabled"');
  });
});

describe("authentication endpoints are budgeted (F-30)", () => {
  it("the token-hash confirm route and the code-exchange callback rate-limit per client address", () => {
    for (const f of ["src/app/auth/confirm/route.ts", "src/app/auth/callback/route.ts"]) {
      const src = read(f);
      expect(src, f).toContain('rateLimit("confirm", clientIpFromHeaders(request.headers))');
      expect(src, f).toContain("retry-after");
    }
  });

  it("the password update after recovery is budgeted per user", () => {
    const src = read("src/app/(auth)/actions.ts");
    const fn = src.slice(src.indexOf("export async function resetPasswordAction"));
    expect(fn).toContain('rateLimit("password_reset", `user:${user.id}`)');
  });

  it("a recovery link never carries its fresh session anywhere but the reset screen", () => {
    expect(read("src/platform/auth/confirm.ts")).toContain(
      'if (type === "recovery") return "/reset-password";',
    );
  });
});

describe("error text never leaks internals (F-26)", () => {
  it("no organisation action puts a raw Error message into a redirect", () => {
    const offenders = walk(ORG_APP)
      .filter((p) => /actions\.ts$/.test(p))
      .filter((f) => /err instanceof Error \? err\.message : "failed"/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the public signing page renders only whitelisted codes", () => {
    const page = read("src/app/sign/[token]/page.tsx");
    expect(page).toContain("isSignErrorCode(sp.error)");
    expect(page).not.toMatch(/\{sp\.error\}/);
    const actions = read("src/app/sign/[token]/actions.ts");
    expect(actions).not.toContain("err.message");
    expect(actions).toContain("signErrorCode(err)");
  });

  it("the public PDF diagnostic no longer echoes the renderer's message", () => {
    const src = read("src/app/d/[token]/route.ts");
    expect(src).not.toMatch(/error: "pdf_unavailable", detail:/);
    expect(src).toContain('{ error: "pdf_unavailable", printUrl: back }');
  });
});

describe("money forms are idempotent end to end (F-27)", () => {
  it("every money-recording form mints a key and its action refuses a request without one", () => {
    const forms: Array<[string, string, string]> = [
      [`${ORG_APP}/payments/new/page.tsx`, `${ORG_APP}/payments/actions.ts`, "pmt-"],
      [`${ORG_APP}/finance/banking/page.tsx`, `${ORG_APP}/finance/actions.ts`, "mt-"],
      [`${ORG_APP}/expenses/new/page.tsx`, `${ORG_APP}/expenses/actions.ts`, "exp-"],
    ];
    for (const [page, action, prefix] of forms) {
      expect(read(page), page).toContain(
        'name="idempotency_key" value={`' + prefix + "${randomUUID()}`}",
      );
      const src = read(action);
      expect(src, action).toContain('formData.get("idempotency_key")');
      expect(src, action).toContain("idempotencyKey.length < 8");
    }
  });

  it("the services replay a duplicate key instead of recording twice", () => {
    for (const [f, constraint] of [
      ["src/modules/payments/service.ts", "payment_idempotency_uq"],
      ["src/modules/finance/banking.ts", "money_transaction_idem_uq"],
      ["src/modules/expenses/service.ts", "expense_idempotency_uq"],
    ] as const) {
      expect(read(f), f).toContain(`cause.constraint_name === "${constraint}"`);
    }
  });
});

describe("expensive reads are bounded (F-23, F-24, F-25)", () => {
  it("the export route is rate-limited per member and refuses an oversized export explicitly", () => {
    const src = read("src/app/api/o/[orgId]/export/route.ts");
    expect(src).toContain('rateLimit("export", `user:${resolved.ctx.userId}`)');
    expect(src).toContain("ExportTooLargeError");
    expect(src).toContain("export const maxDuration = 60");
    expect(read("src/platform/export/service.ts")).toContain(
      "if (all.length > MAX_EXPORT_ROWS) throw new ExportTooLargeError",
    );
  });

  it("every authenticated PDF route is rate-limited per member and time-bounded", () => {
    for (const f of [
      "src/app/api/o/[orgId]/documents/[kind]/[id]/route.ts",
      "src/app/api/o/[orgId]/documents/studio/[id]/route.ts",
      "src/app/api/o/[orgId]/revenue/report/route.ts",
    ]) {
      const src = read(f);
      expect(src, f).toContain('rateLimit("pdf", `user:${resolved.ctx.userId}`)');
      expect(src, f).toContain("export const maxDuration = 60");
    }
    const pdf = read("src/platform/documents/pdf.ts");
    expect(pdf).toContain("MAX_RENDER_HTML_BYTES");
    expect(pdf).toContain("timeout: LOAD_TIMEOUT_MS");
    expect(pdf).toContain("setDefaultTimeout(PRINT_TIMEOUT_MS)");
  });

  it("public form patterns are checked before they are saved and bounded when run", () => {
    expect(read("src/modules/docstudio/types.ts")).toContain("checkPattern(p).ok");
    const forms = read("src/modules/docstudio/forms.ts");
    expect(forms).toContain("testPattern(f.pattern, v)");
    expect(forms).not.toContain("new RegExp(f.pattern)");
  });
});

describe("the staged nonce policy is observation, not enforcement (F-04)", () => {
  it("middleware mints a nonce and sends the nonce policy as report-only on request and response", () => {
    const src = read("src/middleware.ts");
    expect(src).toContain('request.headers.set("x-nonce", nonce)');
    expect(src).toContain(
      'request.headers.set("content-security-policy-report-only", cspReportOnly)',
    );
    expect(src).toContain(
      'response.headers.set("content-security-policy-report-only", cspReportOnly)',
    );
    expect(src).toContain("'strict-dynamic'");
    expect(src).toContain("report-uri /api/csp-report");
    // Never enforced from middleware: that would bypass the tested policy in next.config.
    expect(src).not.toMatch(/headers\.set\("content-security-policy",/i);
  });

  it("the enforced policy in next.config is unchanged (no nonce, 'unsafe-inline' still allowed)", () => {
    const src = read("next.config.ts");
    expect(src).toContain("script-src 'self' 'unsafe-inline'");
    expect(src).not.toContain("'nonce-");
  });

  it("the one inline script the app authors carries the nonce, and the report sink is bounded", () => {
    expect(read("src/app/_home/JsonLd.tsx")).toContain("nonce={nonce}");
    const sink = read("src/app/api/csp-report/route.ts");
    expect(sink).toContain('rateLimit("csp_report"');
    expect(sink).toContain("MAX_BODY_BYTES");
    expect(sink).not.toContain("logger.error");
  });
});

describe("privacy and commercial guards (F-28, F-22)", () => {
  it("a supplier's contact details are not copied into the append-only audit trail", () => {
    const src = read("src/modules/masters/service.ts");
    const fn = src.slice(src.indexOf('action: "supplier.update"'));
    expect(fn.slice(0, 800)).toContain('phone: "[changed]"');
    expect(fn.slice(0, 800)).toContain('email: "[changed]"');
  });

  it("the no-charge add-on path closes itself once a real payment provider is live in production", () => {
    const src = read("src/modules/subscription/service.ts");
    const fn = src.slice(src.indexOf("export async function applyGovernedAddonChange"));
    expect(fn.slice(0, 2000)).toContain("if (isProd() && getBillingProvider().enabled)");
  });
});

describe("the shared rate-limit store", () => {
  it("is the default on every deployed environment and the memory store is documented as per-process", () => {
    const src = read("src/platform/http/rateLimit.ts");
    expect(src).toContain('return isDeployed() ? "db" : "memory"');
    expect(src).toContain("app.rate_limit_hit(");
    expect(src).toContain("falling back to the per-process store");
  });

  it("on Vercel only platform-set client address headers are trusted", () => {
    expect(read("src/platform/http/clientIp.ts")).toContain(
      'if (env.VERCEL) return vercel ?? h.get("x-real-ip") ?? "unknown";',
    );
  });
});
