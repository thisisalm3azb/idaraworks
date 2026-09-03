"use client";

/**
 * H28 — client-only entry for the launcher so its remembered position is read
 * synchronously from the device (no server render, no hydration mismatch).
 */
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { IdaraDock } from "./IdaraDock";

const Dock = dynamic(() => import("./IdaraDock").then((m) => m.IdaraDock), { ssr: false });

export function IdaraDockClient(props: ComponentProps<typeof IdaraDock>) {
  return <Dock {...props} />;
}
