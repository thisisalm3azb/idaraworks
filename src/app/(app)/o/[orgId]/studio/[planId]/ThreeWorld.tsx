"use client";

/**
 * H25F — the 3D world: the SAME resolved plan and schedule, in space.
 *
 * Three worlds, one model:
 *   - city: every scheduled element is a block on a time × lane grid; its
 *     footprint is its calendar span, its height its working-day duration,
 *     its colour its status (critical = red); milestones are diamonds;
 *     dependency edges are lines from a predecessor's finish to a successor's
 *     start. Lanes are people (or element kinds when nobody is assigned).
 *   - tunnel: the same blocks along the time axis, looked at from today.
 *   - capacity: people × weeks; bar height = demand days, a translucent slab
 *     at capacity; over-capacity bars turn red.
 * Nothing here is decorative: every position, size and colour is a plan
 * quantity, hovering names it and clicking selects it in every other view.
 *
 * Rendering: WebGPU where the browser has it, WebGL 2 otherwise (three's
 * WebGPURenderer picks; ThreeView refuses to mount without either). This
 * module is loaded only when the 3D view opens (next/dynamic), so people who
 * never open it never download three.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { WorkspacePayload } from "./StudioWorkspace";

export type World = "city" | "tunnel" | "capacity";

const TONES: Record<string, number> = {
  planned: 0x9aa8a2,
  ready: 0x5b8def,
  active: 0x1f6f5f,
  blocked: 0xc77800,
  waiting: 0x7a4dd6,
  done: 0x4b5b55,
  dropped: 0x3a3f3d,
};
const CRITICAL = 0xb3261e;
const DAY = 1; // world units per calendar day
const LANE = 2.4;

function dayIndex(from: string, date: string): number {
  return Math.round(
    (Date.parse(date + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000,
  );
}

type Pick = { id: string; title: string; detail: string };

export default function ThreeWorld({
  payload,
  world,
  criticalIds,
  selectedId,
  onSelect,
  reducedMotion,
}: {
  payload: WorkspacePayload;
  world: World;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  reducedMotion: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Pick | null>(null);
  const [backend, setBackend] = useState<string>("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f6f5);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("role", "img");
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.maxPolarAngle = Math.PI / 2.05;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa8a2, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 60, 20);
    scene.add(sun);

    const pickables: THREE.Object3D[] = [];
    const byObject = new Map<THREE.Object3D, Pick>();
    const disposables: Array<{ dispose(): void }> = [];
    const box = new THREE.BoxGeometry(1, 1, 1);
    const diamond = new THREE.OctahedronGeometry(0.7);
    disposables.push(box, diamond);
    const materialFor = (color: number, opacity = 1) => {
      const m = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.65,
        metalness: 0.05,
        transparent: opacity < 1,
        opacity,
      });
      disposables.push(m);
      return m;
    };

    const scheduled = payload.nodes.filter((n) => payload.schedule[n.id]);
    let extentX = 10;
    let extentZ = 10;

    if (world === "city" || world === "tunnel") {
      const from = payload.projectStart ?? scheduled[0]?.startDate ?? "2026-01-01";
      const laneKeys = new Map<string, number>();
      const laneOf = (n: (typeof scheduled)[number]) => {
        const key = n.assigneeName ?? n.nodeType;
        if (!laneKeys.has(key)) laneKeys.set(key, laneKeys.size);
        return laneKeys.get(key)!;
      };
      const meshFor = new Map<string, { x: number; z: number; top: number; end: number }>();
      for (const n of scheduled) {
        const s = payload.schedule[n.id]!;
        const start = dayIndex(from, s.earlyStart);
        const span = Math.max(dayIndex(s.earlyStart, s.earlyFinish) + 1, 1);
        const lane = laneOf(n);
        const critical = criticalIds.has(n.id);
        const color = critical ? CRITICAL : (TONES[n.statusCategory] ?? TONES.planned!);
        const selected = n.id === selectedId;
        if (s.durationDays === 0) {
          const m = new THREE.Mesh(diamond, materialFor(color));
          m.position.set(start * DAY + 0.5, 1.2, lane * LANE);
          m.scale.setScalar(selected ? 1.4 : 1);
          scene.add(m);
          pickables.push(m);
          byObject.set(m, { id: n.id, title: n.title, detail: s.earlyStart });
          meshFor.set(n.id, {
            x: start * DAY + 0.5,
            z: lane * LANE,
            top: 1.2,
            end: start * DAY + 0.5,
          });
        } else {
          const h = Math.max(s.durationDays, 0.3);
          const m = new THREE.Mesh(box, materialFor(color, selected ? 1 : 0.92));
          m.scale.set(span * DAY - 0.15, h, LANE * 0.7);
          m.position.set(start * DAY + (span * DAY) / 2, h / 2, lane * LANE);
          scene.add(m);
          pickables.push(m);
          byObject.set(m, {
            id: n.id,
            title: n.title,
            detail: `${s.earlyStart} → ${s.earlyFinish} · ${s.durationDays}d · float ${s.totalFloatDays}`,
          });
          if (selected) {
            const edges = new THREE.LineSegments(
              new THREE.EdgesGeometry(box),
              new THREE.LineBasicMaterial({ color: 0x111111 }),
            );
            edges.scale.copy(m.scale);
            edges.position.copy(m.position);
            scene.add(edges);
            disposables.push(edges.geometry, edges.material as THREE.Material);
          }
          meshFor.set(n.id, {
            x: start * DAY,
            z: lane * LANE,
            top: h,
            end: start * DAY + span * DAY,
          });
        }
        extentX = Math.max(extentX, (start + span) * DAY);
        extentZ = Math.max(extentZ, lane * LANE);
      }
      // Dependency edges: predecessor finish-top → successor start-top.
      const lineMat = new THREE.LineBasicMaterial({ color: 0x5b6b66 });
      const critMat = new THREE.LineBasicMaterial({ color: CRITICAL });
      disposables.push(lineMat, critMat);
      for (const e of payload.edges) {
        if (e.edgeType !== "dependency") continue;
        const a = meshFor.get(e.sourceNodeId);
        const b = meshFor.get(e.targetNodeId);
        if (!a || !b) continue;
        const pts = [
          new THREE.Vector3(a.end, a.top + 0.05, a.z),
          new THREE.Vector3(a.end, a.top + 0.6, a.z),
          new THREE.Vector3(b.x, b.top + 0.6, b.z),
          new THREE.Vector3(b.x, b.top + 0.05, b.z),
        ];
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        disposables.push(g);
        const critical = criticalIds.has(e.sourceNodeId) && criticalIds.has(e.targetNodeId);
        scene.add(new THREE.Line(g, critical ? critMat : lineMat));
      }
      // Ground with week lines.
      const groundGeo = new THREE.PlaneGeometry(extentX + 10, extentZ + 10);
      const groundMat = new THREE.MeshStandardMaterial({ color: 0xe8ecea, roughness: 1 });
      disposables.push(groundGeo, groundMat);
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(extentX / 2, -0.01, extentZ / 2);
      scene.add(ground);
      const grid = new THREE.GridHelper(
        Math.max(extentX, extentZ) + 10,
        Math.ceil((Math.max(extentX, extentZ) + 10) / 7),
        0xc9d1cd,
        0xdfe5e2,
      );
      grid.position.set(extentX / 2, 0, extentZ / 2);
      scene.add(grid);
      disposables.push(grid.geometry, grid.material as THREE.Material);

      if (world === "city") {
        camera.position.set(
          extentX * 0.5,
          Math.max(extentX, extentZ) * 0.9 + 8,
          extentZ + Math.max(extentX, 12),
        );
        controls.target.set(extentX / 2, 0, extentZ / 2);
      } else {
        camera.position.set(-6, 5, extentZ / 2);
        camera.up.set(0, 1, 0);
        controls.target.set(extentX, 1, extentZ / 2);
      }
    } else {
      // capacity world
      const cap = payload.capacity;
      cap.people.forEach((p, row) => {
        cap.weeks.forEach((w, col) => {
          const cell = p.cells[w];
          if (!cell) return;
          const capacity = cell.capacityDays;
          const slabGeo = new THREE.BoxGeometry(1.6, 0.06, 1.6);
          disposables.push(slabGeo);
          const slab = new THREE.Mesh(slabGeo, materialFor(0x9aa8a2, 0.5));
          slab.position.set(col * 2, capacity, row * 2);
          scene.add(slab);
          if (cell.demandDays > 0) {
            const over = cell.demandDays > capacity;
            const m = new THREE.Mesh(box, materialFor(over ? CRITICAL : 0x1f6f5f, 0.95));
            m.scale.set(1.2, cell.demandDays, 1.2);
            m.position.set(col * 2, cell.demandDays / 2, row * 2);
            scene.add(m);
            pickables.push(m);
            byObject.set(m, {
              id: cell.items[0]?.nodeId ?? "",
              title: `${p.name} · ${w.slice(5)}`,
              detail: `${cell.demandDays} / ${capacity} days · ${cell.items.map((i) => i.title).join(", ")}`,
            });
          }
        });
        extentX = Math.max(extentX, cap.weeks.length * 2);
        extentZ = Math.max(extentZ, row * 2);
      });
      const grid = new THREE.GridHelper(
        Math.max(extentX, extentZ) + 6,
        Math.ceil((Math.max(extentX, extentZ) + 6) / 2),
        0xc9d1cd,
        0xdfe5e2,
      );
      grid.position.set(extentX / 2 - 1, 0, extentZ / 2);
      scene.add(grid);
      disposables.push(grid.geometry, grid.material as THREE.Material);
      camera.position.set(extentX * 0.4, Math.max(extentX, extentZ) * 0.8 + 6, extentZ + 12);
      controls.target.set(extentX / 2 - 1, 0, extentZ / 2);
    }

    // Picking.
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let last: THREE.Object3D | null = null;
    const pick = (ev: PointerEvent): Pick | null => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((ev.clientX - r.left) / r.width) * 2 - 1,
        -((ev.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      const obj = hit?.object ?? null;
      if (obj !== last) {
        last = obj;
        renderer.domElement.style.cursor = obj ? "pointer" : "";
      }
      return obj ? (byObject.get(obj) ?? null) : null;
    };
    const onMove = (ev: PointerEvent) => setHover(pick(ev));
    const onClick = (ev: PointerEvent) => {
      const p = pick(ev);
      if (p && p.id) onSelect(p.id);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);

    // Size + loop.
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    void renderer.init().then(() => {
      if (disposed) return;
      const info = renderer.backend as { isWebGPUBackend?: boolean };
      setBackend(info.isWebGPUBackend ? "WebGPU" : "WebGL 2");
      const loop = () => {
        if (disposed) return;
        controls.update();
        void renderer.render(scene, camera);
        raf = requestAnimationFrame(loop);
      };
      loop();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, [payload, world, criticalIds, selectedId, onSelect, reducedMotion]);

  return (
    <div className="relative h-full w-full" ref={hostRef} dir="ltr">
      {hover ? (
        <div className="pointer-events-none absolute start-2 top-2 rounded-md border border-line bg-card/95 px-2 py-1 text-xs shadow-sm">
          <span className="block font-medium text-ink">{hover.title}</span>
          <span className="block text-ink-muted">{hover.detail}</span>
        </div>
      ) : null}
      {backend ? (
        <span className="pointer-events-none absolute bottom-2 end-2 rounded-full bg-card/90 px-2 py-0.5 text-[10px] text-ink-muted">
          {backend}
        </span>
      ) : null}
    </div>
  );
}
