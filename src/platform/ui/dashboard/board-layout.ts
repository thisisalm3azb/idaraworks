/**
 * The dashboard board's layout vocabulary: the sizes a widget can take and
 * the grid placement each one gets. Presentation only, dependency-free, so
 * the client editor and the server-side registry share one definition
 * without the client ever importing a module's service (which would drag the
 * database layer into the browser bundle).
 */
export const WIDGET_SIZES = ["s", "m", "l"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** One entry of a resolved layout, as the editor sees it. */
export type BoardEntry = { key: string; size: WidgetSize; hidden: boolean };

/** Grid placement per size: one column on a phone, up to three on a wide screen. */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  s: "md:col-span-1",
  m: "md:col-span-2 xl:col-span-2",
  l: "md:col-span-2 xl:col-span-3",
};
