/**
 * Load an org's resolved TermContext once per request: read the override blob
 * from app_settings (key `terminology.overrides`) and the selected template
 * (key `terminology.template`), validate defensively, and hand the resolver a
 * ready context. Reads only — the S1 config pipeline writes these.
 */
import { cache } from "react";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { Locale } from "@/platform/registries";
import { parseTerminologyOverride } from "@/platform/config/schemas/terminology";
import type { TermContext } from "./resolve";

const OVERRIDES_KEY = "terminology.overrides";
const TEMPLATE_KEY = "terminology.template";

/** Per-request memoized (React cache()): layout + page share one read. The
 * cache keys on the ctx OBJECT identity — resolveCtx is itself cache()d, so
 * every caller in a request passes the same reference. */
export const loadOrgTerminology = cache(async (ctx: Ctx, locale: Locale): Promise<TermContext> => {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select key, value from public.app_settings
      where org_id = ${ctx.orgId} and key in (${OVERRIDES_KEY}, ${TEMPLATE_KEY})
    `),
  )) as unknown as Array<{ key: string; value: unknown }>;

  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const overrides = parseTerminologyOverride(byKey.get(OVERRIDES_KEY));
  const templateRaw = byKey.get(TEMPLATE_KEY);
  const templateKey = typeof templateRaw === "string" ? templateRaw : undefined;

  return { locale, overrides, templateKey };
});
