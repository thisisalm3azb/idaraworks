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
 *  - the portrait system ships as the documented monogram identity with the
 *    asset manifest empty (the commissioned photographs are a REPORTED
 *    missing asset, never silently substituted stock/icons).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { AGENT_IDS } from "@/platform/agents/registry";
import { AgentShowcase, PORTRAIT_ASSETS, type AgentVM } from "@/app/_home/AgentShowcase";

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
      specialists: AGENT_IDS.filter((id) => id !== "manager").map((id) => vm(id, tt)),
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
    expect([...AGENT_IDS].sort()).toEqual(
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
    for (const id of AGENT_IDS) {
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
      for (const id of AGENT_IDS) {
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
    expect(homeSrc).toContain('AGENT_IDS.filter((id) => id !== "manager")');
    expect(homeSrc).toContain('agentVM("manager", t)');
    expect(homeSrc).toMatch(/Record<AgentId, \{ monogram: string; icon: IconName; bg: string \}>/);
  });
});

describe("H13 — the Manager Agent is the center", () => {
  it("renders the Manager first, in the hero-material panel, before the record rail", () => {
    const iManager = htmlEn.indexOf(tEn("home.agents.manager.name"));
    const iRecord = htmlEn.indexOf(tEn("home.agents.record"));
    expect(iManager).toBeGreaterThan(-1);
    expect(iRecord).toBeGreaterThan(iManager);
    for (const id of AGENT_IDS.filter((x) => x !== "manager")) {
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

describe("H13 — the portrait system", () => {
  it("the asset manifest covers exactly the canonical agents and is empty (reported, not substituted)", () => {
    expect(Object.keys(PORTRAIT_ASSETS).sort()).toEqual([...AGENT_IDS].sort());
    // No commissioned portrait exists yet; the designed monogram identity
    // renders instead. Producing the photographs per the spec doc and filling
    // this manifest is the REPORTED missing asset requirement.
    for (const id of AGENT_IDS) {
      expect(PORTRAIT_ASSETS[id]).toBeNull();
    }
  });

  it("the portrait specification document exists with exclusions and the swap procedure", () => {
    expect(portraitDoc).toMatch(/No robots/i);
    expect(portraitDoc).toMatch(/stock photography/i);
    expect(portraitDoc).toMatch(/public\/agents\/\{agentId\}\.webp/);
    expect(portraitDoc).toMatch(/PORTRAIT_ASSETS/);
    for (const id of AGENT_IDS) {
      expect(portraitDoc).toContain(`\`${id}\``);
    }
  });

  it("no stock photograph or generic icon substitution ships", () => {
    // The only <img> path is the commissioned-asset branch, gated on the
    // manifest; with the manifest empty no raster renders at all.
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toContain("<img");
    }
  });
});
