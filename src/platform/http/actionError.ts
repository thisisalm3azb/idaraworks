/**
 * Master-data action error handling (DEFECT-3 fix).
 *
 * The master-data creation actions (suppliers, customers, items) used to wrap
 * their service call in `catch { redirect(?error=create_failed) }` — every error
 * class (a mistyped email, a role that lacks the capability, a suspended org, a
 * genuine server fault) collapsed into ONE opaque banner ("Something went wrong
 * — try again."), the redirect dropped the POST body so the operator's typed
 * values were erased, and nothing was logged, so the real cause was invisible.
 *
 * This helper is the single, shared error path for those actions. It:
 *   1. lets Next's control-flow signals (redirect/notFound) propagate untouched;
 *   2. CLASSIFIES the error into a small, safe, stable code (never SQL/stack/id);
 *   3. LOGS the real error server-side against the request correlation id (the
 *      platform logger already redacts phone/email keys, §8.5);
 *   4. redirects back to the form with `?error=<code>&ref=<id>&field=<name>` and
 *      the submitted values echoed, so the page shows a SPECIFIC message + a
 *      "Reference: <id>", re-fills the form, and focuses the offending field.
 *
 * The client ever sees only { code, ref, field } + its own echoed input — no
 * database detail, stack, secret, or internal id ever crosses this boundary.
 */
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requestLogger } from "@/platform/logger";
import { ForbiddenError } from "@/platform/authz";
import { BillingReadOnlyError, CapabilityRequiredError } from "@/platform/entitlements";

/** Field names whose values must NEVER be echoed into the redirect URL (PII +
 * pricing land in browser history / access logs otherwise — review finding). */
const SENSITIVE_ECHO = /email|phone|mobile|tax|price|cost|iban|account/i;

/** Stable, safe error codes the master-data forms understand (i18n: masterdata.error.<code>). */
export type MasterDataErrorCode =
  | "unauthorized"
  | "invalid_email"
  | "name_required"
  | "invalid_input"
  | "duplicate"
  | "read_only_billing"
  | "not_entitled"
  | "server_error";

/** Runtime list (page-side guard: a hand-crafted `?error=xyz` must not render a raw key marker). */
export const MASTER_DATA_ERROR_CODES = [
  "unauthorized",
  "invalid_email",
  "name_required",
  "invalid_input",
  "duplicate",
  "read_only_billing",
  "not_entitled",
  "server_error",
] as const satisfies readonly MasterDataErrorCode[];

export function isMasterDataErrorCode(v: string | undefined): v is MasterDataErrorCode {
  return v !== undefined && (MASTER_DATA_ERROR_CODES as readonly string[]).includes(v);
}

export type MasterEntity = "supplier" | "customer" | "item";

export type Classified = { code: MasterDataErrorCode; field?: string };

/** Next throws redirect()/notFound() as errors carrying a `digest`; never swallow them. */
function isNextControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: string } | null)?.digest;
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND)/.test(digest);
}

/** Walk err → err.cause looking for a Postgres SQLSTATE (postgres-js / drizzle). */
function pgError(err: unknown): { code?: string; constraint?: string } {
  let e = err as {
    code?: unknown;
    constraint_name?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  for (let depth = 0; depth < 4 && e; depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      const constraint =
        (typeof e.constraint_name === "string" && e.constraint_name) ||
        (typeof e.constraint === "string" && e.constraint) ||
        undefined;
      return { code: e.code, constraint: constraint || undefined };
    }
    e = e.cause as typeof e;
  }
  return {};
}

function classifyZod(err: ZodError): Classified {
  const issues = err.issues ?? [];
  const fieldOf = (i: (typeof issues)[number]): string | undefined =>
    typeof i.path?.[0] === "string" ? (i.path[0] as string) : undefined;

  // A bad email is the single most common operator mistake — call it out precisely.
  for (const i of issues) {
    const field = fieldOf(i);
    const format = (i as { format?: string }).format;
    const validation = (i as { validation?: string }).validation;
    if (
      field === "email" &&
      (format === "email" || validation === "email" || i.code === "invalid_format")
    ) {
      return { code: "invalid_email", field: "email" };
    }
  }
  // A missing/empty name (min(1)) — the one required text field on every form.
  for (const i of issues) {
    if (fieldOf(i) === "name" && (i.code === "too_small" || i.code === "invalid_type")) {
      return { code: "name_required", field: "name" };
    }
  }
  // Anything else invalid — surface the first offending field for focus.
  return { code: "invalid_input", field: issues[0] ? fieldOf(issues[0]) : undefined };
}

/** Map any thrown error to a safe { code, field }. Order: known classes → Zod → PG → fallback. */
export function classifyMasterDataError(err: unknown): Classified {
  if (err instanceof ForbiddenError) return { code: "unauthorized" };
  if (err instanceof BillingReadOnlyError) return { code: "read_only_billing" };
  if (err instanceof CapabilityRequiredError) return { code: "not_entitled" };
  if (err instanceof ZodError) return classifyZod(err);

  const pg = pgError(err);
  if (pg.code === "23505") {
    // Only items carry a tenant-facing unique constraint (org_id, sku); suppliers
    // and customers allow duplicate display names by design.
    const field = pg.constraint && /sku/i.test(pg.constraint) ? "sku" : undefined;
    return { code: "duplicate", field };
  }
  return { code: "server_error" };
}

/** A short, id/value-free message safe to keep in a server log line. */
function safeLogMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Zod messages can be a multi-line JSON dump; PG `.message` is constraint-name
  // only (values live in `.detail`, which we never touch). Cap length regardless.
  return msg.replace(/\s+/g, " ").slice(0, 300);
}

export type FailContext = {
  ctx: { orgId: string; userId: string; requestId: string };
  base: string;
  entity: MasterEntity;
  /** Submitted form values to echo back so the form is NOT wiped (progressive enhancement). */
  values: Record<string, string>;
};

/**
 * The shared failure path: classify + log + redirect. Returns `never` — it always
 * throws (Next's redirect signal). Call it from an action's catch and `return` it.
 */
export function failMasterDataAction(err: unknown, opts: FailContext): never {
  if (isNextControlFlowError(err)) throw err;

  const { code, field } = classifyMasterDataError(err);
  const correlationId = opts.ctx.requestId;
  const pg = pgError(err);

  requestLogger({
    requestId: correlationId,
    orgId: opts.ctx.orgId,
    userId: opts.ctx.userId,
  }).error(
    {
      entity: opts.entity,
      error_code: code,
      invalid_field: field,
      err_name: err instanceof Error ? err.name : typeof err,
      err_message: safeLogMessage(err),
      ...(pg.code ? { pg_code: pg.code } : {}),
    },
    "master-data create failed",
  );

  const qs = new URLSearchParams();
  qs.set("error", code);
  qs.set("ref", correlationId);
  if (field) qs.set("field", field);
  // Preserve typed values so the form is not wiped — but NEVER echo PII/pricing
  // into the redirect URL (review: it lands in browser history + access logs).
  // Sensitive fields are re-typed; the specific message + focused field guide the user.
  for (const [k, v] of Object.entries(opts.values)) {
    if (v && !SENSITIVE_ECHO.test(k)) qs.set(k, v.slice(0, 300));
  }
  redirect(`${opts.base}?${qs.toString()}`);
}
