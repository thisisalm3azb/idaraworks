import type { SVGProps } from "react";

/**
 * The U5 icon set — hand-rolled 24-viewBox stroke icons rendered at 20px,
 * `currentColor` only (they inherit text colour, so contrast follows the
 * surrounding token). No dependency (NO new npm packages — U5 hard rule);
 * kept deliberately plain: 1.7px stroke, round caps, no fills.
 *
 * Icons are addressed BY NAME (`IconName`) so server components can pass a
 * serialisable string across the client boundary (SidebarNav/BottomNav are
 * client components for active-state resolution).
 */
export type IconName = keyof typeof PATHS;

// Each entry is the <path d> content(s) of one icon (24×24 grid).
const PATHS = {
  home: ["M3 10.5 12 3l9 7.5", "M5.5 9.5V21h13V9.5", "M9.5 21v-6h5v6"],
  briefcase: [
    "M4 8h16v12H4z",
    "M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8",
    "M4 13h16",
  ],
  calendar: ["M4 5.5h16V20H4z", "M4 9.5h16", "M8 3v4M16 3v4"],
  clipboard: ["M8 4.5h8V7H8z", "M8 5H6v16h12V5h-2", "M9 11h6M9 15h4"],
  alert: ["M12 4 2.5 20h19L12 4z", "M12 10v4.5", "M12 17.4v.2"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5V12l3 2"],
  inbox: ["M4 5h16v14H4z", "M4 13h4.5l1.5 2.5h4l1.5-2.5H20"],
  package: ["M12 3 4 7v10l8 4 8-4V7l-8-4z", "M4 7l8 4 8-4", "M12 11v10"],
  cart: [
    "M3 4h2.5l2 11.5h11L21 8H6.4",
    "M9.5 20.2a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z",
    "M17 20.2a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z",
  ],
  truck: [
    "M2.5 6h12v11h-12z",
    "M14.5 10H19l2.5 3.5V17h-7",
    "M7 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z",
    "M17.5 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z",
  ],
  box: ["M4 8h16v12H4z", "M4 8l2-4h12l2 4", "M10 12h4"],
  building: [
    "M4 21V5.5L12 3l8 2.5V21",
    "M4 21h16",
    "M9 9h1.5M13.5 9H15M9 13h1.5M13.5 13H15M9 17h1.5M13.5 17H15",
  ],
  banknote: [
    "M2.5 7h19v10h-19z",
    "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M5.5 10v.2M18.5 14v.2",
  ],
  fileText: ["M6 3h9l4 4v14H6z", "M14.5 3v4.5H19", "M9 12h6M9 16h6"],
  receipt: ["M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z", "M9.5 8h5M9.5 12h5"],
  wallet: [
    "M3.5 6.5h15A1.5 1.5 0 0 1 20 8v11H5a1.5 1.5 0 0 1-1.5-1.5z",
    "M3.5 6.5V6A1.5 1.5 0 0 1 5 4.5h12",
    "M15.5 12.5h.2",
  ],
  calculator: [
    "M5.5 3h13v18h-13z",
    "M8.5 6h7v3.5h-7z",
    "M9 13h.2M12 13h.2M15 13h.2M9 16.5h.2M12 16.5h.2M15 16.5h.2",
  ],
  chart: ["M4 4v16h16", "M8 15v-4M12 15V7M16 15v-6.5"],
  trendUp: ["M3.5 17 9 11.5l3.5 3.5L20.5 7", "M15.5 7h5v5"],
  users: [
    "M8.5 11a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z",
    "M2.5 20a6 6 0 0 1 12 0",
    "M15.5 4.9a3.25 3.25 0 0 1 0 5.8",
    "M17 14.5a6 6 0 0 1 4.5 5.5",
  ],
  user: ["M12 11.5A3.75 3.75 0 1 0 12 4a3.75 3.75 0 0 0 0 7.5z", "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  megaphone: [
    "M3.5 10v4l11 4V6l-11 4z",
    "M14.5 8.5a9 9 0 0 1 5 0",
    "M6.5 14.7V18a1.5 1.5 0 0 0 3 0v-2.2",
  ],
  download: ["M12 3.5v11", "M7.5 10.5 12 15l4.5-4.5", "M4.5 18.5h15"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M12 2.8 13.5 5l2.6-.6 1 2.4 2.6.9-.4 2.7 1.9 1.9-1.9 1.9.4 2.7-2.6.9-1 2.4-2.6-.6L12 21.5 10.5 19l-2.6.6-1-2.4-2.6-.9.4-2.7L2.8 12l1.9-1.9-.4-2.7 2.6-.9 1-2.4 2.6.6L12 2.8z",
  ],
  bell: [
    "M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4.5-1.7 5.9-2.5 6.7h16c-.8-.8-2.5-2.2-2.5-6.7A5.5 5.5 0 0 0 12 3.5z",
    "M9.8 18.8a2.3 2.3 0 0 0 4.4 0",
  ],
  plus: ["M12 5v14", "M5 12h14"],
  lock: ["M6 10.5h12V20H6z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3", "M12 14v2.5"],
  menu: ["M4 6.5h16", "M4 12h16", "M4 17.5h16"],
  close: ["m5.5 5.5 13 13", "m18.5 5.5-13 13"],
  chevronDown: ["m6 9.5 6 6 6-6"],
  chevronEnd: ["m9.5 6 6 6-6 6"],
  globe: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M3 12h18",
    "M12 3c-2.5 2.4-3.8 5.5-3.8 9s1.3 6.6 3.8 9c2.5-2.4 3.8-5.5 3.8-9S14.5 5.4 12 3z",
  ],
  logout: ["M14.5 8V4.5H4.5v15h10V16", "M9 12h11.5", "m17 8.5 3.5 3.5-3.5 3.5"],
  sparkle: ["M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2L12 3.5z"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
} as const;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({
  name,
  size = 20,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
