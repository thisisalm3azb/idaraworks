"use client";

/**
 * H25L — real-time presence on a plan, server-authoritative (ADR-3).
 *
 * One PRIVATE Supabase Realtime channel per plan (`studio:<org>:<plan>`,
 * authorised by RLS on realtime.messages, migration 0111). It carries only:
 *   - presence: who is here, which view they are on, which element they have
 *     selected (a name and an id, never business data);
 *   - a "changed" broadcast sent by whoever just committed an edit, so every
 *     other client re-resolves the living model from the server.
 * Nothing here can write a record: edits always go through server actions
 * and the permission matrix, so a disconnected client cannot sync anything
 * it was not allowed to do.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/platform/tenancy/supabase";

type RealtimeChannel = ReturnType<ReturnType<typeof supabaseBrowser>["channel"]>;

export type Peer = {
  userId: string;
  name: string;
  color: string;
  view: string;
  selectedId: string | null;
};

const COLORS = ["#1f6f5f", "#b3261e", "#7a4dd6", "#c77800", "#0b6bcb", "#a8236d", "#2f7d32"];

function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "");
}

/**
 * Subscribes for the life of the workspace. Returns the other people on the
 * plan and a `changed()` function the workspace calls after any successful
 * commit so peers refresh. Degrades silently: without Realtime (blocked
 * network, no session) the studio still works, just without peers.
 */
export function usePlanPresence(input: {
  orgId: string;
  planId: string;
  viewer: { id: string; name: string };
  view: string;
  selectedId: string | null;
}): { peers: Peer[]; changed: () => void; connected: boolean } {
  const router = useRouter();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { orgId, planId } = input;
  const viewerId = input.viewer.id;
  const viewerName = input.viewer.name;

  useEffect(() => {
    let cancelled = false;
    const supabase = supabaseBrowser();
    const topic = `studio:${orgId}:${planId}`;
    const channel = supabase.channel(topic, {
      config: { private: true, presence: { key: viewerId }, broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<Omit<Peer, "userId" | "color">>();
        const next: Peer[] = [];
        for (const [key, metas] of Object.entries(state)) {
          if (key === viewerId) continue;
          const m = metas[metas.length - 1];
          if (!m) continue;
          next.push({
            userId: key,
            name: m.name,
            color: colorFor(key),
            view: m.view,
            selectedId: m.selectedId ?? null,
          });
        }
        next.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setPeers(next);
      })
      .on("broadcast", { event: "changed" }, () => {
        // Coalesce bursts: one refresh per 400 ms at most.
        if (refreshTimer.current) return;
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          router.refresh();
        }, 400);
      });

    void (async () => {
      try {
        await supabase.realtime.setAuth();
      } catch {
        // no session token available: subscribe will be refused, which is correct
      }
      channel.subscribe((status) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") {
          setConnected(true);
          void channel.track({ name: viewerName, view: "canvas", selectedId: null });
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setConnected(false);
        }
      });
    })();

    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [orgId, planId, viewerId, viewerName, router]);

  // Presence follows the person's view and selection (cheap; presence is diffed server-side).
  const { view, selectedId } = input;
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch || !connected) return;
    void ch.track({ name: viewerName, view, selectedId });
  }, [view, selectedId, connected, viewerName]);

  const changed = useMemo(
    () => () => {
      const ch = channelRef.current;
      if (!ch || !connected) return;
      void ch.send({ type: "broadcast", event: "changed", payload: { planId } });
    },
    [connected, planId],
  );

  return { peers, changed, connected };
}

export function PresenceStrip({ peers, label }: { peers: Peer[]; label: string }) {
  if (peers.length === 0) return null;
  return (
    <div
      className="flex items-center gap-1"
      aria-label={label}
      title={peers.map((p) => p.name).join(", ")}
    >
      {peers.slice(0, 6).map((p) => (
        <span
          key={p.userId}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-card"
          style={{ backgroundColor: p.color }}
          title={`${p.name} · ${p.view}`}
        >
          {initials(p.name)}
        </span>
      ))}
      {peers.length > 6 ? (
        <span className="text-xs text-ink-muted">+{peers.length - 6}</span>
      ) : null}
    </div>
  );
}
