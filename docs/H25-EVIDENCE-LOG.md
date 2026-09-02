# H25 — Evidence log (research retrieved 2026-09-02)

Primary-source research for the Management Studio architecture decisions.
Tiers: **verified-primary** (official docs/registry read directly),
**verified-secondary** (reputable technical source), **contextual**.
Nothing below the verified tiers drives an architecture decision.

## Libraries evaluated

### Node/canvas engine — @xyflow/react (React Flow)

- Latest **12.11.3** (npm, published days before retrieval). MIT licensed
  since 2019. Core listing ~15 kB (bundlephobia lists the full package
  larger; the engine tree-shakes). Maintained by the xyflow team.
  [npm](https://www.npmjs.com/package/@xyflow/react?activeTab=versions) ·
  [bundlephobia](https://bundlephobia.com/package/@xyflow/react) ·
  [xyflow open source](https://xyflow.com/open-source) — verified-primary.
- Supports controlled state (nodes/edges owned by our store), custom node
  and edge renderers, `onlyRenderVisibleElements` viewport culling,
  keyboard a11y, touch. Fits the "engine renders, WE own the model" law.

### 3D engine — three.js

- Release line **r182** current (SourceForge mirror of official releases);
  MIT. `WebGPURenderer` production-ready since r171 (Sept 2025) with
  automatic WebGL 2 fallback via async init; Safari 26 ships WebGPU, so
  coverage ≈95% WebGPU with the rest on WebGL 2 — matching the mandate's
  "WebGL broadly, WebGPU progressively".
  [three.js releases mirror](https://sourceforge.net/projects/three-js.mirror/files/r182/) ·
  [utsubo 2026 overview](https://www.utsubo.com/blog/threejs-2026-what-changed) ·
  [production guide](https://appscale.blog/en/blog/threejs-production-3d-web-2026-webgpu-realtime-standards)
  — verified-primary (version/license), verified-secondary (WebGPU state).
- Bundle: three core is heavy (~150 kB+ gz) → **dynamic import on the 3D
  route only**; users who never open 3D never download it (H25P law).

### Collaboration — Yjs vs server-authoritative + Supabase Realtime

- Yjs is the mature CRDT (npm current, MIT), but its own ecosystem states
  authorization is OUT of protocol scope and any client that can apply
  updates can spoof others — the server merge path grants full authority.
  [yjs](https://github.com/yjs/yjs) ·
  [y-durable-streams protocol notes](https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/YJS-PROTOCOL.md)
  — verified-primary.
- Supabase Realtime (already in our stack) provides **private channels
  with RLS authorization** (policies on `realtime.messages`, checked at
  subscribe via rolled-back SELECT/INSERT, cached per connection),
  broadcast and presence.
  [Realtime authorization docs](https://supabase.com/docs/guides/realtime/authorization) ·
  [launch post](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization)
  — verified-primary.
- **Decision follows the mandate's own law** ("a disconnected client must
  never be able to synchronize an edit it was not authorized to make"):
  canonical records are never client-merged. See ADR-3 in the truth map.

### Auto-layout — @dagrejs/dagre

- Directed layered layout, MIT; the DagreJs-org package is the one
  receiving updates (the legacy fork is unmaintained). elkjs is richer but
  EPL-licensed and far heavier; our canvas is manually positioned
  (auto-layout is a convenience for derived views), so dagre suffices.
  [dagre repo](https://github.com/dagrejs/dagre) ·
  [React Flow layouting overview](https://reactflow.dev/learn/layouting/layouting)
  — verified-primary.

## Methods

### Critical path method

- Forward pass (ES/EF), backward pass (LS/LF), **total float = LS − ES =
  LF − EF**, free float = min(ES of successors) − EF; critical path =
  zero-total-float chains through the dependency network, computed over
  WORKING calendars, never colored by hand.
  [PMI: CPM calculations](https://www.pmi.org/learning/library/critical-path-method-calculations-scheduling-8040) ·
  [Praxis Framework: critical path analysis](https://www.praxisframework.org/en/library/critical-path-analysis)
  — verified-primary (method definitions).
- Schedule-quality checks anchored to the **DCMA 14-point assessment**
  (DCMA-EA PAM 200.1 §4): missing logic ≤5%, hard constraints ≤5%, high
  float ≤5%, negative float = 0 — used as the basis for the Studio's
  schedule-health warnings.
  [DCMA 14-point guides](https://schedulelens.com/blog/dcma-14-point-assessment/) —
  verified-secondary (thresholds restated from the pamphlet).

### Monte Carlo schedule risk

- Only with explicit three-point estimates (triangular or PERT-Beta)
  supplied per task or defaulted transparently from duration ranges the
  USER enters; seeded deterministic RNG (stored seed), sample count and
  P50/P80/P90 intervals exposed, reruns reproducible. No historical
  fabrication: where estimate inputs are absent the simulation refuses
  with "insufficient estimates", never invents a distribution.

## Platform constraints honored

- Vercel serverless: no first-party websocket host → realtime transport is
  Supabase Realtime (already provisioned) — nothing new to operate.
- PostgREST 1,000-row cap: every unbounded Studio read pages (existing
  workflow law).
- The truthfulness law (owner blueprint): no invented numbers; empty and
  insufficient states say so.
