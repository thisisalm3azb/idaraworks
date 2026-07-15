import type { IconName } from "@/platform/ui";

/**
 * Serialisable view-models the server layout hands to the client nav shells
 * (labels are resolved server-side — t() + terminology; clients only render).
 */
export type NavItemVM = {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  locked: boolean;
};

export type NavGroupVM = {
  key: string;
  label: string;
  icon: IconName;
  items: NavItemVM[];
};

export type BottomItemVM = NavItemVM & { isMore?: boolean };
