/**
 * H11 — the Business OS section (the "#product" body) and the governing
 * north-star documents. Guarantees:
 *  - founder positioning ("Built by managers, for managers", "One business.
 *    One system.") renders in both locales,
 *  - every domain's NOW line is backed by shipped workspace surfaces (nav
 *    IA), while expansion lines are future-facing and cannot be confused
 *    with shipped capability (distinct keys, marker structure, legend),
 *  - the role-aware intelligence band is explicitly PLANNED, and "powered
 *    by AI" wording cannot render while AI_AGENTS_PRODUCTION_READY is false
 *    (flipping it requires a real entitlement capability key),
 *  - no internal module/entitlement/permission identifier is exposed,
 *  - the agent architecture document carries every non-negotiable law and
 *    the north star exists with the truth line,
 *  - anchors, tiers, pricing and CTA behavior remain intact.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { BusinessOS, AI_AGENTS_PRODUCTION_READY } from "@/app/_home/BusinessOS";
import { pricingTiers } from "@/app/_home/pricing";
import { buildNavGroups } from "@/platform/ui/nav/build";
import { FEATURE_KEYS } from "@/platform/entitlements/catalogue";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(BusinessOS, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(BusinessOS, { t: tAr }));
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const homeSrc = read("../../src/app/_home/HomePage.tsx");
const osSrc = read("../../src/app/_home/BusinessOS.tsx");
const northStar = read("../../docs/product/IDARAWORKS_BUSINESS_OS_NORTH_STAR.md");
const agentDoc = read("../../docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md");

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const osEn = Object.keys(en)
  .filter((k) => k.startsWith("home.os."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

const DOMAIN_KEYS = ["customers", "work", "people", "supply", "money", "planning"] as const;

/** Owner-eligible fully-entitled nav = the shipped surfaces (same as H6). */
const NAV_KEYS = new Set(
  buildNavGroups({
    orgId: "x",
    archetype: "owner",
    features: {
      "cap.attendance": true,
      "cap.material_requests": true,
      "cap.purchase_orders": true,
      "cap.quoting": true,
      "cap.invoicing": true,
      "cap.payments": true,
      "cap.expenses": true,
      "cap.costing": true,
      "cap.customer_updates": true,
      "feat.data_import": true,
    },
  }).flatMap((g) => g.items.map((i) => i.key)),
);

describe("H11 — positioning", () => {
  it("renders the founder positioning in both locales", () => {
    expect(String(en["home.os.eyebrow" as keyof typeof en])).toBe(
      "Built by managers, for managers",
    );
    expect(String(en["home.os.title" as keyof typeof en])).toBe("One business. One system.");
    expect(String(en["home.os.body" as keyof typeof en])).toMatch(
      /built to replace disconnected business software/i,
    );
    for (const k of ["eyebrow", "title", "body", "support"]) {
      expect(/[؀-ۿ]/.test(String(ar[`home.os.${k}` as keyof typeof ar])), `ar os.${k}`).toBe(true);
    }
    expect(homeSrc).toContain('t("home.os.title")');
    expect(homeSrc).toContain("<BusinessOS t={t} />");
  });

  it("keeps the #product anchor and the retired caps section gone", () => {
    expect(homeSrc).toMatch(/<section id="product" className="scroll-mt-16/);
    expect(homeSrc).not.toContain("CapabilityMap");
    expect(Object.keys(en).some((k) => k.startsWith("home.caps."))).toBe(false);
  });
});

describe("H11 — domain truth", () => {
  it("renders six domains around one record, both locales", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.os.record_title"));
      expect(html).toContain(tt("home.os.record_note"));
      expect((html.match(/<h3/g) ?? []).length).toBe(8); // record + 6 domains + agents
      for (const d of DOMAIN_KEYS) {
        expect(html).toContain(tt(`home.os.${d}.title`));
        expect(html).toContain(tt(`home.os.${d}.now`));
        expect(html).toContain(tt(`home.os.${d}.next`));
      }
      expect(html).toContain(tt("home.os.legend_now"));
      expect(html).toContain(tt("home.os.legend_next"));
    }
  });

  it("every NOW line is backed by shipped surfaces; no unshipped module reads as shipped", () => {
    // Each now-phrase decomposes to audited nav surfaces (H6 inventory).
    const BACKING: Record<(typeof DOMAIN_KEYS)[number], string[]> = {
      customers: ["customers", "quotes", "customer_updates"],
      work: ["jobs", "report_new", "reports_review", "issues", "approvals"],
      people: ["people", "attendance", "members"],
      supply: ["items", "material_requests", "purchase_orders", "suppliers"],
      money: ["invoices", "payments", "expenses", "costing", "ar"],
      planning: ["today", "exports"],
    };
    for (const [domain, keys] of Object.entries(BACKING)) {
      for (const k of keys) {
        expect(NAV_KEYS.has(k), `${domain}.now claims unshipped surface ${k}`).toBe(true);
      }
    }
    // Expansion lines only carry future modules; none may appear in a NOW line.
    const nows = DOMAIN_KEYS.map((d) => String(en[`home.os.${d}.now` as keyof typeof en])).join(
      " ",
    );
    for (const future of [
      /pipeline/i,
      /contract/i,
      /payroll/i,
      /leave/i,
      /inventory/i,
      /warehous/i,
      /asset/i,
      /general ledger/i,
      /payables/i,
      /budget/i,
      /forecast/i,
    ]) {
      expect(nows).not.toMatch(future);
    }
  });

  it("expansion wording is future-facing and structurally distinct from shipped", () => {
    expect(String(en["home.os.legend_next" as keyof typeof en])).toMatch(/expanding/i);
    // Now lines render with the check icon; next lines with the dashed open
    // marker and muted tone — asserted structurally.
    expect(osSrc).toMatch(/OpenDot/);
    expect((htmlEn.match(/border-dashed border-line-strong/g) ?? []).length).toBeGreaterThanOrEqual(
      7, // 6 domain open dots + legend marker (+ agents band border)
    );
  });
});

describe("H11 — role-aware intelligence gating", () => {
  it("the agents band is explicitly planned", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.os.agents_label")); // "Planned" chip
      expect(html).toContain(tt("home.os.agents_title"));
      expect(html).toContain(tt("home.os.agents_body"));
      expect(html).toContain(tt("home.os.agents_suggest"));
      expect(html).toContain(tt("home.os.agents_approve"));
    }
    expect(String(en["home.os.agents_label" as keyof typeof en])).toBe("Planned");
    expect(String(en["home.os.agents_body" as keyof typeof en])).toMatch(/^Planned agents will/);
  });

  it("'powered by AI' wording cannot render without a real production capability", () => {
    // Today: no production AI exists (no AI SDK in src; provider seams are
    // unimplemented), so the flag must be false and the wording absent.
    if (!AI_AGENTS_PRODUCTION_READY) {
      const allPublic = Object.keys(en)
        .filter((k) => k.startsWith("home."))
        .map((k) => `${en[k as keyof typeof en]} ${ar[k as keyof typeof ar] ?? ""}`)
        .join("  ");
      expect(allPublic).not.toMatch(/powered by (role[- ]aware )?AI|AI[- ]powered|autonomous/i);
      expect(allPublic).not.toMatch(/مدعوم بالذكاء/);
    } else {
      // Flipping the flag requires the real backend capability to exist in
      // the entitlement catalogue AND an implemented agent runtime; this
      // branch fails until both are true.
      expect(FEATURE_KEYS as readonly string[]).toContain("feat.ai_agents");
      expect(agentDoc).toMatch(/implemented/i);
    }
  });
});

describe("H11 — governing documents", () => {
  it("the north star exists with purpose, lifecycle, laws and truth line", () => {
    expect(northStar).toContain("One business. One system.");
    expect(northStar).toContain("Built by managers, for managers");
    expect(northStar).toMatch(/market opportunity -> lead -> customer -> quote/);
    expect(northStar).toMatch(/Intelligent clay laws/i);
    expect(northStar).toMatch(/cupcake business/i);
    expect(northStar).toMatch(/NO production AI runs today/i);
    expect(northStar).toMatch(/Delivery sequence/i);
  });

  it("the agent architecture contains every non-negotiable safety law", () => {
    for (const law of [
      /inherit the acting user's organization and permissions/i,
      /never bypass RLS/i,
      /service-role access/i,
      /another organization's records/i,
      /redacted prices, costs, payroll/i,
      /which records support/i,
      /facts, calculations, assumptions and suggestions/i,
      /explicit human approval/i,
      /Financial posting, payroll finalization, employee termination, supplier\s+commitment, customer communication and destructive correction/i,
      /never generate or modify application code/i,
      /never generate or execute DDL/i,
      /never modify RLS, permissions or security policy/i,
      /governed schemas and validated commands/i,
      /auditable/i,
      /reversible/i,
      /Prompt injection/i,
      /silently activate modules/i,
    ]) {
      expect(agentDoc).toMatch(law);
    }
    // Approval classification + orchestrator without widened permissions.
    for (const cls of [
      /READ AND EXPLAIN/,
      /DRAFT/,
      /RECOMMEND/,
      /PREPARE REVERSIBLE CHANGE/,
      /EXECUTE AFTER APPROVAL/,
      /PROHIBITED/,
    ]) {
      expect(agentDoc).toMatch(cls);
    }
    expect(agentDoc).toMatch(/Manager Agent/);
    expect(agentDoc).toMatch(/never sums, widens or\s+escalates permissions/i);
  });
});

describe("H11 — integrity, truthfulness, scope", () => {
  it("exposes no internal module, entitlement or permission identifier", () => {
    // Catalog values and the VISIBLE text (class attributes like font-medium
    // are not public copy) must carry no internal identifier.
    const visible = htmlEn.replace(/<[^>]+>/g, " ");
    for (const blob of [osEn, visible]) {
      expect(blob).not.toMatch(/\bcap\.|\bfeat\.|\baddon\.|\blimit\.|tier_|\bRLS\b|org_id/);
      expect(blob).not.toMatch(/\b(medium|high)\b/);
    }
  });

  it("internal tier identifiers and pricing behavior remain unchanged", () => {
    expect(pricingTiers().map((x) => x.key)).toEqual(["free", "medium", "high"]);
    expect(homeSrc).toMatch(/<section id="pricing" className="scroll-mt-16/);
    expect(homeSrc).toContain("<ClosingSection");
  });

  it("makes no fake customer, compliance, security or metric claim; no em dash", () => {
    expect(osEn).not.toMatch(/trusted by|customers worldwide|certified|complian|guarantee/i);
    expect(osEn).not.toContain("—");
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.os."))) {
      expect(String(ar[k as keyof typeof ar])).not.toContain("—");
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&#?[a-z0-9]+;/gi, " ");
      expect(text).not.toMatch(/\d/);
    }
  });

  it("static markup, logical classes, mirrored arrow, no fake controls", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
      expect(html).not.toMatch(/<button|<a |<input|tabindex|role="(button|switch)"/i);
      expect(html).not.toMatch(/animation|animate-/);
    }
    expect(htmlEn).toContain("rtl:-scale-x-100");
    expect(osSrc).not.toMatch(/animation[:-]|@keyframes/);
  });
});
