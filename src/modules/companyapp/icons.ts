/**
 * App icons derived from the company's logo (item 10, 2026-09-20).
 *
 * The icon route answers anonymous requests, so it never reads private
 * storage. Instead, the moment a logo is uploaded the 512px source is kept in
 * `org_app_icon` (size 0) and the full icon set is rendered from it; when the
 * brand colours change, the set is rendered again from that stored source.
 * The route reads one row through a DEFINER function and falls back to the
 * generated initials mark when no logo exists.
 *
 * Padding and shape: `generateIconSet` fits the logo inside the square with a
 * transparent margin for `any` icons and insets it further, over the brand
 * colour, for `maskable` icons, so launchers that crop to a circle never clip
 * it. Nothing is stretched: the fit is `contain`.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { appDb } from "@/platform/tenancy/db";
import { generateIconSet } from "@/platform/tenanthost/icon";
import { logger } from "@/platform/logger";

const MAX_ICON_BYTES = 1024 * 1024;

async function brandInputs(ctx: Ctx): Promise<{ orgName: string; brandColor: string | null }> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select coalesce(nullif(b.app_name, ''), nullif(ob.display_name, ''), o.name) as name,
             coalesce(b.brand_color, ob.accent_color) as brand_color
      from public.org o
      left join public.org_app_brand b on b.org_id = o.id
      left join public.org_branding ob on ob.org_id = o.id
      where o.id = ${ctx.orgId}
    `)) as unknown as Array<{ name: string; brand_color: string | null }>;
    return { orgName: rows[0]?.name ?? "IdaraWorks", brandColor: rows[0]?.brand_color ?? null };
  });
}

/** Store the logo source and render every icon size from it. Never throws: an icon problem must not fail a logo upload. */
export async function refreshAppIconsFromLogo(ctx: Ctx, sourcePng: Buffer): Promise<boolean> {
  try {
    if (sourcePng.length > MAX_ICON_BYTES) {
      logger.warn({ bytes: sourcePng.length }, "app icons: logo source too large to keep");
      return false;
    }
    const { orgName, brandColor } = await brandInputs(ctx);
    const { icons } = await generateIconSet({ source: sourcePng, orgName, brandColor });
    await withCtx(ctx, async (tx) => {
      await tx.execute(sql`
        insert into public.org_app_icon (org_id, size, maskable, png, bytes, updated_at)
        values (${ctx.orgId}, 0, false, ${sourcePng}, ${sourcePng.length}, now())
        on conflict (org_id, size, maskable)
        do update set png = excluded.png, bytes = excluded.bytes, updated_at = now()
      `);
      for (const icon of icons) {
        if (icon.buffer.length > MAX_ICON_BYTES) continue;
        await tx.execute(sql`
          insert into public.org_app_icon (org_id, size, maskable, png, bytes, updated_at)
          values (${ctx.orgId}, ${icon.size}, ${icon.maskable}, ${icon.buffer}, ${icon.buffer.length}, now())
          on conflict (org_id, size, maskable)
          do update set png = excluded.png, bytes = excluded.bytes, updated_at = now()
        `);
      }
    });
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "app icons: refresh failed",
    );
    return false;
  }
}

/** Re-render from the stored source (brand colour or name changed). No source → nothing to do. */
export async function refreshAppIconsFromStoredSource(ctx: Ctx): Promise<boolean> {
  const source = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select png from public.org_app_icon where org_id = ${ctx.orgId} and size = 0 and maskable = false
    `)) as unknown as Array<{ png: Buffer | Uint8Array }>;
    return rows[0]?.png ? Buffer.from(rows[0].png) : null;
  });
  if (!source) return false;
  return refreshAppIconsFromLogo(ctx, source);
}

/** Forget the derived icons when the logo is removed; the route falls back to the generated mark. */
export async function clearAppIcons(ctx: Ctx): Promise<void> {
  await withCtx(ctx, async (tx) => {
    // No DELETE grant by design: a 1-byte tombstone is overwritten by the next upload.
    await tx.execute(sql`
      update public.org_app_icon set png = '\\x00'::bytea, bytes = 1, updated_at = now()
      where org_id = ${ctx.orgId}
    `);
  });
}

/** The anonymous read used by the icon route: one PNG for one organisation and size, or null. */
export async function publicAppIcon(
  orgId: string,
  size: number,
  maskable: boolean,
): Promise<{ png: Buffer; updatedAt: string } | null> {
  const rows = (await appDb().transaction((tx) =>
    tx.execute(sql`
      select png, updated_at::text as updated_at from app.public_app_icon(${orgId}::uuid, ${size}, ${maskable})
    `),
  )) as unknown as Array<{ png: Buffer | Uint8Array; updated_at: string }>;
  const r = rows[0];
  if (!r || !r.png) return null;
  const png = Buffer.from(r.png);
  if (png.length < 8) return null; // tombstone after a logo removal
  return { png, updatedAt: r.updated_at };
}
