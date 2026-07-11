/**
 * The immutable per-request tenant context (phase2/10 #2, BUILD_BIBLE §5.1).
 * Resolved once per request from the session + membership (Phase C); NEVER from
 * client input. Every service/repository function takes it (or the TenantTx
 * produced from it) as its first argument.
 */
export type Ctx = Readonly<{
  orgId: string;
  userId: string;
  /** finance.viewCosts — drives the app.cost_priv GUC for privileged side-tables. */
  costPrivileged: boolean;
  requestId: string;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidCtxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCtxError";
  }
}

/** Defence-in-depth: a malformed ctx must never reach set_config. */
export function assertValidCtx(ctx: Ctx): void {
  if (!UUID_RE.test(ctx.orgId)) {
    throw new InvalidCtxError("ctx.orgId is not a UUID");
  }
  if (!UUID_RE.test(ctx.userId)) {
    throw new InvalidCtxError("ctx.userId is not a UUID");
  }
}
