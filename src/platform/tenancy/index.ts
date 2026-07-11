export { appDatabaseUrl, TenancyEnvError } from "./env";
export { appDb, closeAppDb, createAppDb, type AppDb } from "./db";
export { assertValidCtx, InvalidCtxError, type Ctx } from "./ctx";
export { withCtx, withCtxOn, withUserCtx, type TenantTx } from "./withCtx";
export { supabaseBrowser, supabaseServer } from "./supabase";
// The query-builder tag is re-exported here so all SQL construction flows
// through the tenancy surface — repository/service code imports `sql` from
// @/platform/tenancy, never from drizzle-orm directly (boundary law, phase2/10 #3).
export { sql } from "drizzle-orm";
