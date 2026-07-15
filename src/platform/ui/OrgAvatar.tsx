import { cn } from "@/lib/cn";

/**
 * Organization-name initials avatar (U2 branding) — the HONEST fallback for
 * every logo placement: when in-app branding is off, or no logo is uploaded,
 * the org's initials render instead. Pure/presentational; the gating decision
 * belongs to the caller (getAppBranding).
 */
export function OrgAvatar({
  name,
  accentColor,
  className,
}: {
  name: string;
  /** Validated #rrggbb from org_branding (already CHECK-constrained). */
  accentColor?: string | null;
  className?: string;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0))
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 select-none items-center justify-center",
        "rounded-md bg-brand text-xs font-bold text-ink-inverse",
        className,
      )}
      style={accentColor ? { backgroundColor: accentColor } : undefined}
    >
      {initials}
    </span>
  );
}
