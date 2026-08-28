# Agent Portrait System (H13)

Status: **specified, assets not yet produced.** The homepage agent showcase
ships with the designed interim identity described in §4. This document is the
complete brief for producing the final portrait assets and the exact procedure
for swapping them in without code changes beyond one manifest.

## 1. Intent

Each of the ten canonical agents (see `src/platform/agents/registry.ts`,
`AGENT_IDS`) is presented on the homepage as a **professional specialist**, not
a chatbot. The portraits must read as a premium editorial series: one
photographer, one studio, one visit — a management team photographed together.

**Hard exclusions** (founder direction, non-negotiable):

- No robots, androids, or humanoid-machine imagery.
- No glowing brains, neural-network swirls, circuit motifs, or "AI sparkle"
  clichés.
- No generic stock photography and no recognizably stock-composited people.
- No 3D renders, illustration-style avatars, or cartoon characters.
- No neon, cyan-on-black, or purple "tech gradient" treatments.

## 2. Series art direction

- **Style:** editorial studio portraiture (think annual-report leadership
  pages done by a good magazine photographer). Quarter-turn to the camera,
  eyes to lens, composed and confident, at ease rather than stiff.
- **Framing:** chest-up, consistent head scale and eye-line across all ten so
  the grid reads as one series. Subject occupies ~60–70% of frame height.
- **Lighting:** one warm key with soft fill, gentle falloff; identical setup
  for the whole series.
- **Background:** seamless deep tonal backdrop, per-agent color from the tone
  palette in §5 (subtle vignette allowed, no props, no office scenes).
- **Wardrobe:** contemporary professional, region-appropriate; no lab coats,
  no headsets, no futuristic costume. Muted tones that sit well on the
  backdrop color.
- **Color grade:** warm, slightly desaturated; consistent across the series;
  must harmonize with the site's mineral-green and warm-earth palette.
- **Casting (whole series):** an international management team — a genuine
  mix of regions (Gulf/Arab, South Asian, East Asian, African, European,
  Latin American), genders, and ages (early 30s to late 50s). No agent's
  casting is fixed to a region; the ten together must read as balanced and
  international, and the Gulf launch market should be visibly represented.

## 3. Per-agent casting and expression brief

| Agent id | Public name | Presence and expression |
| --- | --- | --- |
| `manager` | Manager Agent | The center of the series: senior, settled authority, the person the room looks to. Direct gaze, calm near-smile. |
| `executive` | Executive Agent | Board-level composure; slightly reserved, evaluating. |
| `operations` | Operations Agent | Practical energy; sleeves-rolled-up credibility, alert and ready. |
| `project` | Project Agent | Organized optimism; the planner mid-thought, open expression. |
| `sales_crm` | Sales and CRM Agent | Warm, engaging, the easiest smile of the series. |
| `accounting` | Accounting Agent | Precise and unhurried; quiet confidence, faint smile. |
| `finance` | Finance Agent | Considered and forward-looking; thoughtful, steady gaze. |
| `people_payroll` | People and Payroll Agent | Approachable and trustworthy; the person people bring problems to. |
| `inventory_purchasing` | Inventory and Purchasing Agent | Grounded, methodical; dependable presence. |
| `planning_analytics` | Planning and Analytics Agent | Curious and sharp; the analyst who enjoys the question. |

## 4. The interim identity (what ships until assets exist)

Until final portraits are produced, `AgentShowcase.tsx` renders a **designed
monogram tile** per agent: the agent's deep tonal background from §5, the
shared material texture, a large monogram, and a small domain-icon chip. This
is a deliberate identity system in the site's own material language — it is
NOT a placeholder icon set, and nothing else may be substituted for it.

## 5. Technical asset specification

- **Location:** `public/agents/{agentId}.webp` — exact ids from `AGENT_IDS`
  (e.g. `public/agents/manager.webp`, `public/agents/sales_crm.webp`).
- **Format:** WebP, quality ~80. **Ratio 4:5 portrait, 640×800 px** master
  (the UI crops square via `object-cover` center; keep the face inside the
  central square). Target **under 120 KB** per file.
- **Tone pairing** (backdrop of each photograph, also the interim tile color;
  monogram/ink color for all tiles is `#EFECE2`):

| Agent id | Backdrop / tile tone |
| --- | --- |
| `manager` | `#0B5348` deep brand green |
| `executive` | `#2E3B36` charcoal green |
| `operations` | `#145C50` mineral green |
| `project` | `#4A5340` olive |
| `sales_crm` | `#6B4A2A` warm umber |
| `accounting` | `#37474B` slate |
| `finance` | `#27473F` pine |
| `people_payroll` | `#5A4632` walnut |
| `inventory_purchasing` | `#565C4C` sage grey |
| `planning_analytics` | `#1F4D5A` deep teal |

- **Alt text rule:** portraits are decorative identity for a named card; the
  agent's name and role are always adjacent visible text, so the image itself
  stays `aria-hidden` / empty-alt. Never encode information only in the image.

## 6. Swap procedure

1. Produce the ten files per §5 and place them in `public/agents/`.
2. In `src/app/_home/AgentShowcase.tsx`, set each entry of `PORTRAIT_ASSETS`
   from `null` to `"/agents/{agentId}.webp"`.
3. The `Portrait` component renders the photograph (cover-cropped, same
   rounded tile, same icon chip) when a path is present; the monogram remains
   the automatic fallback.
4. Re-run the homepage visual matrix (EN/AR × 1440/1024/768/375/320) before
   deploying; the series must read as one calibrated set in the grid.
