/**
 * withCtx — the tenancy wrapper (S0 checklist §4 step 3; doc 10 #1).
 *
 * Opens ONE transaction, sets the tenant GUCs with set_config(..., true)
 * (transaction-local: they vanish at commit/rollback, which is what makes the
 * mechanism safe under Supavisor transaction-mode pooling — the entire
 * transaction is pinned to one server connection, and nothing leaks to the
 * next borrower). All repository code runs inside fn(tx) and only ever sees
 * the transaction handle.
 */
import { sql } from "drizzle-orm";
import { appDb, type AppDb } from "./db";
import { assertValidCtx, type Ctx } from "./ctx";

type TxCallback<T> = Parameters<AppDb["transaction"]>[0] extends (tx: infer TX) => unknown
  ? (tx: TX) => Promise<T>
  : never;

/** The transaction handle repositories receive. */
export type TenantTx = Parameters<TxCallback<unknown>>[0];

export async function withCtxOn<T>(
  db: AppDb,
  ctx: Ctx,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertValidCtx(ctx);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', ${ctx.orgId}, true),
        set_config('app.user_id', ${ctx.userId}, true),
        set_config('app.cost_priv', ${ctx.costPrivileged ? "true" : "false"}, true)
    `);
    return fn(tx);
  });
}

/** The standard entry point for request code. */
export async function withCtx<T>(ctx: Ctx, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withCtxOn(appDb(), ctx, fn);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * User-only context — the ctx resolver's BOOTSTRAP read (Phase C): before an
 * active org exists, a user may read their own memberships/orgs (policies key
 * on app.current_user_id()). No org GUC is set; org-scoped rows stay invisible.
 */
export async function withUserCtx<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error("withUserCtx: userId is not a UUID");
  }
  return appDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
