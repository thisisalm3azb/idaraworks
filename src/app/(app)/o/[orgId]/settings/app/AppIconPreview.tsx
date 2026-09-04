import { initialsFor } from "@/platform/tenanthost/icon";

/**
 * H31 — what the installed app will look like.
 *
 * A server component drawing plain divs, not an <img> of the generated PNG.
 * Two reasons: the preview updates the instant a colour changes without waiting
 * for a regenerated raster, and the settings page does not pay for a sharp
 * pipeline just to show a square.
 *
 * It shows the maskable safe area as a circle, because a launcher will crop to
 * roughly that and a customer who has never seen an adaptive icon has no way to
 * know their logo's corners may go missing.
 */
export function AppIconPreview({
  name,
  shortName,
  brandColor,
  foreground,
  background,
  dir,
}: {
  name: string;
  shortName: string;
  brandColor: string;
  foreground: string;
  background: string;
  dir: "ltr" | "rtl";
}) {
  const initials = initialsFor(name);
  return (
    <div className="flex flex-wrap items-start gap-6">
      {/* Home-screen tile */}
      <figure className="flex w-24 flex-col items-center gap-2">
        <div
          className="relative flex h-20 w-20 items-center justify-center rounded-[22%] shadow-card"
          style={{ backgroundColor: brandColor }}
          role="img"
          aria-label={name}
        >
          <span
            className="text-2xl font-semibold"
            style={{ color: foreground }}
            aria-hidden
            dir={dir}
          >
            {initials}
          </span>
          {/* The 80% circle a launcher may crop to. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 m-auto h-[80%] w-[80%] rounded-full border border-dashed border-white/40"
          />
        </div>
        <figcaption
          className="w-full truncate text-center text-xs text-ink-secondary"
          title={shortName}
          dir={dir}
        >
          {shortName}
        </figcaption>
      </figure>

      {/* Launch screen */}
      <figure className="flex flex-col items-center gap-2">
        <div
          className="flex h-40 w-24 flex-col items-center justify-center gap-2 rounded-lg border border-line"
          style={{ backgroundColor: background }}
          aria-hidden
        >
          <div
            className="flex h-12 w-12 items-center justify-center rounded-[22%]"
            style={{ backgroundColor: brandColor }}
          >
            <span className="text-sm font-semibold" style={{ color: foreground }} dir={dir}>
              {initials}
            </span>
          </div>
        </div>
        <figcaption className="text-xs text-ink-muted">
          {/* Not translated: this is a shape label, and the screenshot beside it
              carries the meaning. */}
          1×
        </figcaption>
      </figure>
    </div>
  );
}
