/**
 * Demo company importer — the visual identity, through the product's own door.
 *
 * A mark drawn from geometry alone — a rounded square in the brand colour
 * with three dunes across it (rimal: sands) — so it rasterises identically
 * anywhere without depending on a font. Uploaded once through `uploadLogo`,
 * which re-encodes the bytes through the platform image pipeline, stores the
 * variants under the organisation's own prefix, inserts the file row and
 * points `org_branding.logo_file_id` at it in one audited transaction —
 * exactly what an administrator's upload does. Idempotent: an organisation
 * that already has a logo keeps it.
 */
import sharp from "sharp";
import { uploadLogo } from "@/modules/branding/service";
import type { Sql } from "../pilot-lab/db";
import type { LabContext } from "../pilot-lab/types";

export function logoSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="0" y="0" width="512" height="512" rx="96" ry="96" fill="${color}"/>
  <path d="M40 348 C 130 300, 190 300, 250 340 S 380 392, 472 336 L 472 400 L 40 400 Z" fill="#ffffff" fill-opacity="0.92"/>
  <path d="M40 300 C 140 236, 220 236, 300 284 S 420 330, 472 272 L 472 320 C 400 350, 320 340, 250 304 C 180 268, 110 280, 40 336 Z" fill="#ffffff" fill-opacity="0.55"/>
  <path d="M40 252 C 150 172, 260 172, 340 220 S 440 262, 472 214 L 472 246 C 420 290, 350 282, 290 246 C 220 206, 130 210, 40 280 Z" fill="#ffffff" fill-opacity="0.28"/>
  <circle cx="404" cy="132" r="42" fill="#ffffff" fill-opacity="0.9"/>
</svg>`;
}

export async function logoPng(color: string): Promise<Buffer> {
  return sharp(Buffer.from(logoSvg(color)))
    .png()
    .toBuffer();
}

/** Upload the mark once; a company that already has a logo keeps it. */
export async function ensureLogo(
  sql: Sql,
  ctx: LabContext,
  log: (m: string) => void,
): Promise<void> {
  const [row] = (await sql`
    select logo_file_id::text as id from public.org_branding where org_id = ${ctx.orgId}
  `) as unknown as Array<{ id: string | null }>;
  if (row?.id) {
    log(`logo present (${row.id.slice(0, 8)}) — kept`);
    return;
  }
  const bytes = await logoPng(ctx.company.brandColor);
  const { fileId } = await uploadLogo(ctx.ctxFor("owner"), ctx.archetypeOf("owner"), {
    fileName: `${ctx.company.key}-logo.png`,
    mime: "image/png",
    bytes,
  });
  log(`logo uploaded through the branding service (${fileId.slice(0, 8)})`);
}
