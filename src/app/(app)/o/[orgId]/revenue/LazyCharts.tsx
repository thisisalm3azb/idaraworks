"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { RevenueCharts } from "./RevenueCharts";

const Charts = dynamic(() => import("./RevenueCharts").then((m) => m.RevenueCharts), {
  ssr: false,
  loading: () => (
    <div className="h-40 rounded-md bg-sunken motion-safe:animate-pulse" aria-hidden />
  ),
});

/** Heavy visuals load after the numbers (H27: lazy-loaded, never blocking the hub). */
export function LazyCharts(props: ComponentProps<typeof RevenueCharts>) {
  return <Charts {...props} />;
}
