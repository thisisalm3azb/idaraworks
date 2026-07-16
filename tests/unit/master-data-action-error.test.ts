/**
 * DEFECT-3 — the shared master-data action error helper. Pure unit coverage of
 * the classifier (each error class → a stable, safe code) and of failMasterDataAction
 * (server-side log with a correlation id + a redirect that carries the code, the
 * reference, the invalid field, and the echoed values — and never a stack/SQL/id).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const logSpy = vi.hoisted(() => ({ error: vi.fn() }));
const R = vi.hoisted(() => ({
  Sig: class RedirectSignal extends Error {
    constructor(public url: string) {
      super(url);
    }
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (u: string) => {
    throw new R.Sig(u);
  },
}));
vi.mock("@/platform/logger", async (orig) => {
  const actual = await orig<typeof import("@/platform/logger")>();
  return { ...actual, requestLogger: () => logSpy };
});

import { ZodError } from "zod";
import { ForbiddenError } from "@/platform/authz";
import { BillingReadOnlyError, CapabilityRequiredError } from "@/platform/entitlements";
import { SupplierInput, ItemInput } from "@/modules/masters/service";
import {
  classifyMasterDataError,
  failMasterDataAction,
  isMasterDataErrorCode,
  MASTER_DATA_ERROR_CODES,
} from "@/platform/http/actionError";

function zodErr(schema: { parse: (v: unknown) => unknown }, value: unknown): ZodError {
  try {
    schema.parse(value);
  } catch (e) {
    return e as ZodError;
  }
  throw new Error("expected the schema to reject");
}

describe("classifyMasterDataError", () => {
  it("maps a bad email (Zod) → invalid_email on the email field", () => {
    const err = zodErr(SupplierInput, { name: "Ok", email: "nope" });
    expect(classifyMasterDataError(err)).toEqual({ code: "invalid_email", field: "email" });
  });

  it("maps a missing name (Zod) → name_required on the name field", () => {
    const err = zodErr(SupplierInput, { name: "" });
    expect(classifyMasterDataError(err)).toEqual({ code: "name_required", field: "name" });
  });

  it("maps another invalid field (Zod) → invalid_input, surfacing the field", () => {
    const err = zodErr(ItemInput, { sku: "", name: "x", categoryKey: "cat", unit: "pcs" });
    const c = classifyMasterDataError(err);
    expect(c.code).toBe("invalid_input");
    expect(c.field).toBe("sku");
  });

  it("maps ForbiddenError → unauthorized", () => {
    expect(classifyMasterDataError(new ForbiddenError("catalog.manage")).code).toBe("unauthorized");
  });

  it("maps BillingReadOnlyError → read_only_billing", () => {
    expect(classifyMasterDataError(new BillingReadOnlyError("suspended")).code).toBe(
      "read_only_billing",
    );
  });

  it("maps CapabilityRequiredError → not_entitled", () => {
    expect(classifyMasterDataError(new CapabilityRequiredError("cap.items")).code).toBe(
      "not_entitled",
    );
  });

  it("maps a Postgres 23505 with an sku constraint → duplicate on sku", () => {
    const err = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "item_org_sku_uq",
    });
    expect(classifyMasterDataError(err)).toEqual({ code: "duplicate", field: "sku" });
  });

  it("maps a bare 23505 (no sku constraint) → duplicate without a field", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(classifyMasterDataError(err)).toEqual({ code: "duplicate", field: undefined });
  });

  it("unwraps a nested cause to find the SQLSTATE", () => {
    const err = new Error("wrapped", {
      cause: Object.assign(new Error("dup"), { code: "23505", constraint_name: "item_org_sku_uq" }),
    });
    expect(classifyMasterDataError(err).code).toBe("duplicate");
  });

  it("falls back to server_error for anything unrecognized", () => {
    expect(classifyMasterDataError(new Error("boom")).code).toBe("server_error");
    expect(classifyMasterDataError("weird").code).toBe("server_error");
  });
});

describe("isMasterDataErrorCode", () => {
  it("accepts every real code and rejects junk", () => {
    for (const c of MASTER_DATA_ERROR_CODES) expect(isMasterDataErrorCode(c)).toBe(true);
    expect(isMasterDataErrorCode("create_failed")).toBe(false);
    expect(isMasterDataErrorCode(undefined)).toBe(false);
  });
});

describe("failMasterDataAction", () => {
  const fail = (err: unknown, values: Record<string, string>) =>
    failMasterDataAction(err, {
      ctx: { orgId: "org-1", userId: "user-1", requestId: "req-abc-123" },
      base: "/o/org-1/suppliers",
      entity: "supplier",
      values,
    });

  beforeEach(() => logSpy.error.mockClear());

  it("logs server-side with the correlation id and redirects with code + ref + field + values", () => {
    const err = zodErr(SupplierInput, { name: "Ok", email: "nope" });
    let url = "";
    try {
      fail(err, { name: "Ok Co", email: "nope", phone: "" });
    } catch (e) {
      url = (e as InstanceType<typeof R.Sig>).url;
    }
    // server-side log fired with the correlation id (invisible before this fix)
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [fields, msg] = logSpy.error.mock.calls[0]!;
    expect(msg).toBe("master-data create failed");
    expect(fields.error_code).toBe("invalid_email");
    expect(fields.entity).toBe("supplier");

    const qs = new URL(url, "https://x").searchParams;
    expect(qs.get("error")).toBe("invalid_email");
    expect(qs.get("ref")).toBe("req-abc-123");
    expect(qs.get("field")).toBe("email");
    expect(qs.get("name")).toBe("Ok Co"); // non-sensitive value preserved
    // PII (email/phone) is NEVER echoed into the URL — it lands in history/logs otherwise.
    expect(qs.has("email")).toBe(false);
    expect(qs.has("phone")).toBe(false);

    // Never leaks internals or PII into the client-facing URL.
    expect(url).not.toMatch(/ZodError|stack|insert into|select |password|token/i);
    expect(url).not.toContain("nope"); // the email value is not in the URL
  });

  it("re-throws Next control-flow (redirect) errors untouched — never swallowed", () => {
    const nextRedirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/somewhere;307;",
    });
    let caught: unknown;
    try {
      fail(nextRedirect, { name: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(nextRedirect); // same object, not a RedirectSignal
    expect(logSpy.error).not.toHaveBeenCalled();
  });
});
