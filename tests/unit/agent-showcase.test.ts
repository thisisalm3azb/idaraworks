/**
 * H13 — the Intelligent Clay identity and the homepage agent showcase.
 * Guarantees:
 *  - the ten agents shown are EXACTLY the canonical registry set (no invented,
 *    renamed or omitted agent; no duplicates),
 *  - the Manager Agent is the organizational center (rendered first, in the
 *    hero-material panel, with coordinating copy),
 *  - every agent carries responsibility, outcome, a representative question,
 *    and the evidence + human-approval indicators,
 *  - the "Intelligent Clay" identity and the founder phrase ("Developed by
 *    managers, for managers") are wired into the header and hero,
 *  - no roadmap-status wording, no "Powered by AI" badge, no autonomy claim,
 *    no em dash anywhere in the section,
 *  - accessibility: real buttons with aria-expanded/aria-controls, one shared
 *    detail region, 44px targets, nothing essential hover-only, static
 *    markup (reduced motion needs no special path), logical classes only,
 *  - the portrait system is INSTALLED (H13.1): every canonical agent has a
 *    real production asset in public/agents/ meeting the 4:5 / size budget
 *    contract, rendered with stable dimensions and lazy specialists; the
 *    monogram remains only as the fallback for a genuinely missing asset.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { SHOWCASE_AGENT_IDS } from "@/platform/agents/registry";
import {
  AgentShowcase,
  PORTRAIT_ASSETS,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  type AgentVM,
} from "@/app/_home/AgentShowcase";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const homeSrc = read("../../src/app/_home/HomePage.tsx");
const showcaseSrc = read("../../src/app/_home/AgentShowcase.tsx");
const portraitDoc = read("../../docs/design/AGENT_PORTRAIT_SYSTEM.md");

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

function vm(id: string, tt: (k: string) => string): AgentVM {
  return {
    id,
    name: tt(`home.agents.${id}.name`),
    role: tt(`home.agents.${id}.role`),
    outcome: tt(`home.agents.${id}.outcome`),
    question: tt(`home.agents.${id}.q`),
    monogram: "M",
    icon: "grid",
    tone: { bg: "#0B5348", ink: "#EFECE2" },
  };
}

function renderShowcase(tt: (k: string) => string) {
  return renderToStaticMarkup(
    h(AgentShowcase, {
      manager: vm("manager", tt),
      specialists: SHOWCASE_AGENT_IDS.filter((id) => id !== "manager").map((id) => vm(id, tt)),
      labels: {
        evidence: tt("home.agents.evidence"),
        approval: tt("home.agents.approval"),
        record: tt("home.agents.record"),
        ask: tt("home.agents.ask"),
      },
    }),
  );
}

const htmlEn = renderShowcase(tEn);
const htmlAr = renderShowcase(tAr);

describe("H13 — canonical agents", () => {
  it("the registry set is the ten canonical agents", () => {
    expect([...SHOWCASE_AGENT_IDS].sort()).toEqual(
      [
        "executive",
        "operations",
        "project",
        "sales_crm",
        "accounting",
        "finance",
        "people_payroll",
        "inventory_purchasing",
        "planning_analytics",
        "manager",
      ].sort(),
    );
  });

  it("every canonical agent has name, role, outcome and question in both catalogs", () => {
    for (const id of SHOWCASE_AGENT_IDS) {
      for (const part of ["name", "role", "outcome", "q"] as const) {
        const key = `home.agents.${id}.${part}`;
        expect(key in en, `en missing ${key}`).toBe(true);
        expect(key in ar, `ar missing ${key}`).toBe(true);
        expect(/[؀-ۿ]/.test(String(ar[key as keyof typeof ar])), `ar.${key} not Arabic`).toBe(true);
      }
    }
    // Exactly the ten agents, nothing invented: 10 agents x 4 parts + the 7
    // section-level keys (eyebrow/title/intro/evidence/approval/record/ask).
    expect(Object.keys(en).filter((k) => k.startsWith("home.agents.")).length).toBe(47);
  });

  it("renders all ten agents by name, exactly once each, in both locales", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      for (const id of SHOWCASE_AGENT_IDS) {
        // React escapes apostrophes in text (&#x27;) — match the markup form.
        const esc = (s: string) => s.replace(/'/g, "&#x27;");
        const name = esc(tt(`home.agents.${id}.name`));
        const count = html.split(name).length - 1;
        expect(count, `${id} name "${name}" rendered ${count}x`).toBe(1);
        expect(html).toContain(esc(tt(`home.agents.${id}.role`)));
      }
    }
  });

  it("HomePage builds the showcase from the canonical registry, not a hand list", () => {
    expect(homeSrc).toContain('SHOWCASE_AGENT_IDS.filter((id) => id !== "manager")');
    expect(homeSrc).toContain('agentVM("manager", t)');
    expect(homeSrc).toMatch(/Record<ShowcaseAgentId, \{ monogram: string; icon: IconName; bg: string \}>/);
  });
});

describe("H13 — the Manager Agent is the center", () => {
  it("renders the Manager first, in the hero-material panel, before the record rail", () => {
    const iManager = htmlEn.indexOf(tEn("home.agents.manager.name"));
    const iRecord = htmlEn.indexOf(tEn("home.agents.record"));
    expect(iManager).toBeGreaterThan(-1);
    expect(iRecord).toBeGreaterThan(iManager);
    for (const id of SHOWCASE_AGENT_IDS.filter((x) => x !== "manager")) {
      expect(htmlEn.indexOf(tEn(`home.agents.${id}.name`))).toBeGreaterThan(iRecord);
    }
  });

  it("the Manager's copy is coordination, and its full detail is always visible", () => {
    expect(tEn("home.agents.manager.role")).toMatch(/coordinat/i);
    // The manager card shows outcome + question inline (not behind a click).
    expect(htmlEn).toContain(tEn("home.agents.manager.outcome"));
    expect(htmlEn).toContain(tEn("home.agents.manager.q").replace(/'/g, "&#x27;"));
  });
});

describe("H13 — evidence, approval, and honest claims", () => {
  it("states evidence grounding and human approval on the room itself", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.agents.evidence"));
      expect(html).toContain(tt("home.agents.approval"));
      expect(html).toContain(tt("home.agents.record"));
    }
    expect(tEn("home.agents.evidence")).toMatch(/records/i);
    expect(tEn("home.agents.approval")).toMatch(/approve/i);
  });

  it("carries no empty AI badge, no autonomy claim, no roadmap label, no em dash", () => {
    const agentsEn = Object.keys(en)
      .filter((k) => k.startsWith("home.agents."))
      .map((k) => String(en[k as keyof typeof en]))
      .join("  ");
    expect(agentsEn).not.toMatch(/powered by (role[- ]aware )?AI|AI[- ]powered/i);
    expect(agentsEn).not.toMatch(/autonomous|acts? on its own|without (your |human )?approval/i);
    expect(agentsEn).not.toMatch(
      /\b(planned|coming soon|expanding|future capabilit|available now|roadmap)\b/i,
    );
    for (const k of Object.keys(en).filter((x) => x.startsWith("home.agents."))) {
      expect(String(en[k as keyof typeof en]), `en.${k}`).not.toContain("—");
      expect(String(ar[k as keyof typeof ar]), `ar.${k}`).not.toContain("—");
    }
  });

  it("invents no metric, price or customer data in the rendered room", () => {
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&#?[a-z0-9]+;/gi, " ");
      expect(text).not.toMatch(/\d/);
    }
  });
});

describe("H13 — identity in the opening viewport", () => {
  it("the header carries the Intelligent Clay lockup and the hero establishes it", () => {
    expect(homeSrc).toContain('t("home.nav.clay")');
    expect(String(en["home.nav.clay" as keyof typeof en])).toBe("Intelligent Clay");
    expect(String(en["home.hero.title" as keyof typeof en])).toBe(
      "Intelligent Clay for your business",
    );
    expect(String(en["home.hero.eyebrow" as keyof typeof en])).toBe(
      "Developed by managers, for managers",
    );
    expect(homeSrc).toContain('t("home.hero.support")');
  });

  it("the showcase is the first section after the hero", () => {
    const iHero = homeSrc.indexOf("<ProductVisual");
    const iAgents = homeSrc.indexOf('<section id="agents"');
    const iHow = homeSrc.indexOf('<section id="how"');
    expect(iHero).toBeGreaterThan(-1);
    expect(iAgents).toBeGreaterThan(iHero);
    expect(iHow).toBeGreaterThan(iAgents);
  });
});

describe("H13 — accessibility, RTL, motion", () => {
  it("specialists are real buttons with aria-expanded/aria-controls and 44px targets", () => {
    const buttons = htmlEn.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(9);
    for (const b of buttons) {
      expect(b).toContain('aria-expanded="false"');
      expect(b).toContain('aria-controls="agent-detail"');
      expect(b).toContain("min-h-11");
    }
    expect(htmlEn).toContain('id="agent-detail"');
    expect(htmlEn).toContain('role="region"');
  });

  it("name and responsibility are always-visible text, never hover-only", () => {
    // Every specialist's name AND role render in the initial static markup;
    // the detail panel adds outcome/question but nothing essential is hidden
    // behind hover (there is no hover-gated content in the source).
    expect(showcaseSrc).not.toMatch(/group-hover:|hover:opacity|hover:visible|hover:block/);
  });

  it("uses only logical direction classes and stays static", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
      expect(html).not.toMatch(/animation|animate-/);
    }
    expect(showcaseSrc).not.toMatch(/animation[:-]|animate-|@keyframes|transition-/);
  });
});

/** Minimal WebP dimension reader (VP8 / VP8L / VP8X), so the asset contract
 * is asserted against the real files with no new dependency. */
function webpDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP");
  const fourcc = buf.subarray(12, 16).toString("ascii");
  if (fourcc === "VP8X") {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
    };
  }
  if (fourcc === "VP8 ") {
    // Lossy: key-frame start code 9d 01 2a, then 14-bit width/height.
    expect(buf[23]).toBe(0x9d);
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourcc === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`unknown WebP variant ${fourcc}`);
}

describe("H13.1 — the installed portrait system", () => {
  it("every canonical agent has a manifest entry, no nulls, no duplicate paths", () => {
    expect(Object.keys(PORTRAIT_ASSETS).sort()).toEqual([...SHOWCASE_AGENT_IDS].sort());
    const paths = SHOWCASE_AGENT_IDS.map((id) => PORTRAIT_ASSETS[id]);
    for (const [i, p] of paths.entries()) {
      expect(p, `${SHOWCASE_AGENT_IDS[i]} portrait missing from manifest`).toBe(
        `/agents/${SHOWCASE_AGENT_IDS[i]}.webp`,
      );
    }
    expect(new Set(paths).size).toBe(SHOWCASE_AGENT_IDS.length);
  });

  it("every referenced production file exists, 640x800 4:5, under the 120KB budget", () => {
    for (const id of SHOWCASE_AGENT_IDS) {
      const file = fileURLToPath(new URL(`../../public/agents/${id}.webp`, import.meta.url));
      expect(existsSync(file), `public/agents/${id}.webp missing`).toBe(true);
      const buf = readFileSync(file);
      expect(buf.length, `${id}.webp exceeds 120KB`).toBeLessThan(120 * 1024);
      const { width, height } = webpDimensions(buf);
      expect({ id, width, height }).toEqual({
        id,
        width: PORTRAIT_WIDTH,
        height: PORTRAIT_HEIGHT,
      });
      expect(width / height).toBeCloseTo(4 / 5, 5);
    }
  });

  it("renders a portrait for all ten agents and no monogram fallback, both locales", () => {
    for (const html of [htmlEn, htmlAr]) {
      const imgs = html.match(/<img[^>]*>/g) ?? [];
      expect(imgs.length).toBe(10); // manager + 9 specialists in initial state
      for (const img of imgs) {
        expect(img).toMatch(/src="\/agents\/[a-z_]+\.webp"/);
        expect(img).toContain('alt=""'); // decorative: name+role are adjacent text
        expect(img).toContain(`width="${PORTRAIT_WIDTH}"`);
        expect(img).toContain(`height="${PORTRAIT_HEIGHT}"`);
      }
      // Only the always-visible Manager loads eagerly; specialists are lazy.
      expect(imgs.filter((i) => i.includes('loading="eager"')).length).toBe(1);
      expect(imgs.filter((i) => i.includes('loading="lazy"')).length).toBe(9);
      // The monogram fallback branch (its tonal gradient) must not render.
      expect(html).not.toContain("linear-gradient(170deg");
    }
  });

  it("portrait tiles keep stable dimensions and are never circular or stretched", () => {
    // The Manager shows the complete 4:5 frame; specialist tiles are fixed
    // squares with a face-biased cover crop. No rounded-full portrait exists.
    expect(showcaseSrc).toMatch(/aspect-\[4\/5\] w-28 sm:w-36/);
    expect(showcaseSrc).toMatch(/objectPosition: "50% 22%"/);
    expect(htmlEn).toContain("object-cover");
    for (const img of htmlEn.match(/<img[^>]*>/g) ?? []) {
      expect(img).not.toContain("rounded-full");
      expect(img).toContain("object-cover"); // cover, never stretch
    }
  });

  it("the portrait specification document reflects the installed state", () => {
    expect(portraitDoc).toMatch(/produced and installed/i);
    expect(portraitDoc).toMatch(/No robots/i);
    expect(portraitDoc).toMatch(/stock photography/i);
    expect(portraitDoc).toMatch(/public\/agents\/\{agentId\}\.webp/);
    expect(portraitDoc).toMatch(/PORTRAIT_ASSETS/);
    for (const id of SHOWCASE_AGENT_IDS) {
      expect(portraitDoc).toContain(`\`${id}\``);
    }
  });
});
