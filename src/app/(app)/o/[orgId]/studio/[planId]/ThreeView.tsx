"use client";

/**
 * H25F — the 3D view shell. Decides, before loading anything heavy, whether
 * this device can render (WebGPU or WebGL 2); if not, it shows the roadmap
 * with an honest note. The world itself (three.js) is a dynamic import, so
 * people who never open this view never download it.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";
import { RoadmapView } from "./RoadmapView";
import type { World } from "./ThreeWorld";

const ThreeWorld = dynamic(() => import("./ThreeWorld"), { ssr: false, loading: () => null });

const WORLDS: World[] = ["city", "tunnel", "capacity"];

function canRender3D(): boolean {
  if (typeof window === "undefined") return false;
  if ("gpu" in navigator) return true;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export function ThreeView({
  payload,
  dict,
  criticalIds,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [world, setWorld] = useState<World>("city");
  // Capability is a client fact; resolve it after mount (null = not yet known).
  const [capable, setCapable] = useState<boolean | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setCapable(canRender3D());
      setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const hasSchedule = payload.nodes.some((n) => payload.schedule[n.id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1">
        <div
          className="flex gap-1 rounded-full border border-line bg-sunken p-0.5 text-xs"
          role="tablist"
        >
          {WORLDS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={world === w}
              onClick={() => setWorld(w)}
              className={`min-h-8 rounded-full px-3 ${
                world === w ? "bg-card font-medium text-ink shadow-sm" : "text-ink-muted"
              }`}
            >
              {dict.worlds[w]}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-ink-muted">{dict.worldHint}</span>
      </div>
      <div className="min-h-0 flex-1">
        {capable === null ? (
          <p className="p-4 text-sm text-ink-muted">{dict.worldLoading}</p>
        ) : !capable ? (
          <div className="flex h-full flex-col">
            <p className="border-b border-line bg-warning-soft px-3 py-2 text-xs text-warning">
              {dict.worldFallback}
            </p>
            <div className="min-h-0 flex-1">
              <RoadmapView
                payload={payload}
                dict={dict}
                criticalIds={criticalIds}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            </div>
          </div>
        ) : !hasSchedule && world !== "capacity" ? (
          <p className="p-4 text-sm text-ink-muted">{dict.nothingScheduled}</p>
        ) : (
          <ThreeWorld
            payload={payload}
            world={world}
            criticalIds={criticalIds}
            selectedId={selectedId}
            onSelect={onSelect}
            reducedMotion={reducedMotion}
          />
        )}
      </div>
    </div>
  );
}
