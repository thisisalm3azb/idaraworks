import { cookies } from "next/headers";
import { supabaseServer, type Ctx } from "@/platform/tenancy";
import { signRead } from "@/platform/files";
import { OrgAvatar } from "@/platform/ui";
import type { RoleArchetype } from "@/platform/registries";
import { getAppBranding } from "@/modules/branding/service";

/**
 * The reusable org-brand slot (U2) — renders the tenant's logo when
 * feat.branding_app is on AND a logo exists; otherwise the initials avatar.
 * Server component: it signs a short-TTL read as the requesting user (the same
 * authenticated signed-read path every file uses — never a public URL) and
 * NEVER throws: any failure degrades to the initials fallback. The dashboard
 * redesign consumes this component for its logo placements. Lives in the app
 * layer (BUILD_BIBLE §3.3: app imports modules only via service.ts).
 */
export async function OrgLogo({
  ctx,
  archetype,
  orgName,
}: {
  ctx: Ctx;
  archetype: RoleArchetype;
  orgName: string;
}) {
  let logoUrl: string | null = null;
  let accentColor: string | null = null;
  let display = orgName;
  try {
    const { enabled, branding } = await getAppBranding(ctx);
    if (branding.displayName) display = branding.displayName;
    if (enabled) {
      accentColor = branding.accentColor;
      if (branding.logoFileId) {
        const store = await cookies();
        const token = (await supabaseServer(store).auth.getSession()).data.session?.access_token;
        if (token) {
          logoUrl = (await signRead(ctx, archetype, token, branding.logoFileId, "thumb")).url;
        }
      }
    }
  } catch {
    logoUrl = null; // the brand slot must never break a page — fall back
  }
  return (
    <span className="flex items-center gap-2">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
        <img src={logoUrl} alt={display} className="h-8 w-8 rounded-md object-contain" />
      ) : (
        <OrgAvatar name={display} accentColor={accentColor} />
      )}
      <span className="max-w-48 truncate">{display}</span>
    </span>
  );
}
