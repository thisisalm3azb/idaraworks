"use client";

/**
 * H28 — the deep workspace island: the same window component in full-page
 * mode with the conversation list. Loaded only on this route.
 */
import dynamic from "next/dynamic";
import type { AgentOption, DockDict } from "./IdaraDock";
import type { Locale } from "@/platform/registries";

const IdaraWindow = dynamic(() => import("./IdaraWindow").then((m) => m.IdaraWindow), {
  ssr: false,
  loading: () => (
    <div className="h-[calc(100dvh-8rem)] rounded-xl border border-line bg-card" aria-busy="true" />
  ),
});

export function IdaraWorkspace(props: {
  orgId: string;
  userId: string;
  locale: Locale;
  dir: "ltr" | "rtl";
  dict: DockDict;
  agents: AgentOption[];
  modelAvailable: boolean;
  reason: string;
  ownerAction: string | null;
  canConfirm: boolean;
  initialConversationId: string | null;
}) {
  return (
    <IdaraWindow
      {...props}
      mode="workspace"
      pageContext={null}
      openRequest={null}
      position="bottom-end"
      onStatus={() => {}}
      onUnread={() => {}}
      onMinimise={() => {}}
      onClose={() => {}}
    />
  );
}
