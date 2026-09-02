"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { DealCanvas } from "./DealCanvas";

const Canvas = dynamic(() => import("./DealCanvas").then((m) => m.DealCanvas), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] rounded-md bg-sunken motion-safe:animate-pulse" aria-hidden />
  ),
});

/** The canvas library loads only when the canvas tab is open. */
export function LazyCanvas(props: ComponentProps<typeof DealCanvas>) {
  return <Canvas {...props} />;
}
