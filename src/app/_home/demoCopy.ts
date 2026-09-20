import { INDUSTRIES, STEPS, type DemoCopy, type Industry, type StepView } from "./demoRules";
import type { TryItLabels } from "./TryIt";
import type { HomeT } from "./ui";
import { SIGNUP_HREF } from "./nav";

/**
 * Resolves every sentence the interactive demo shows, on the server, from the
 * catalogue: four industry scenarios and five steps, with each step's text
 * filled from the industry's sample values. The client receives plain strings.
 */
export function buildDemoCopy(t: HomeT, job: string): DemoCopy {
  const scenarios = {} as DemoCopy["scenarios"];
  const views = {} as DemoCopy["views"];
  for (const industry of INDUSTRIES) {
    const sc = (field: string) => t(`home.demo.sc.${industry}.${field}`);
    scenarios[industry] = { item: sc("item"), qty: sc("qty") };
    const vars = {
      job,
      customer: sc("customer"),
      value: sc("value"),
      work: sc("work"),
      detail: sc("detail"),
      resource: sc("resource"),
      resource_text: sc("resource_text"),
    };
    views[industry] = STEPS.map((step): StepView => {
      const st = (field: string) => t(`home.demo.st.${step}.${field}`, vars);
      return {
        label: st("label"),
        heading: st("heading"),
        text: st("text"),
        button: st("button"),
        state: st("state"),
        reference: st("reference"),
        detailLabel: st("detail_label"),
        detailValue: st("detail_value"),
        totalLabel: st("total_label"),
        totalValue: st("total_value"),
        trace: st("trace"),
        phoneTitle: st("phone_title"),
        phoneCopy: st("phone_copy"),
      };
    });
  }
  return { scenarios, views };
}

export function buildDemoLabels(t: HomeT, ctaHref: string = SIGNUP_HREF): TryItLabels {
  const industries = {} as Record<Industry, string>;
  for (const k of INDUSTRIES) industries[k] = t(`home.strip.${k}`);
  return {
    nameLabel: t("home.demo.name_label"),
    namePlaceholder: t("home.demo.name_placeholder"),
    colourLabel: t("home.demo.colour_label"),
    colours: {
      forest: t("home.demo.colour_forest"),
      indigo: t("home.demo.colour_indigo"),
      copper: t("home.demo.colour_copper"),
      ocean: t("home.demo.colour_ocean"),
    },
    industryLabel: t("home.demo.industry_label"),
    industries,
    status: t("home.demo.status"),
    workspace: t("home.hero.workspace"),
    steps: {
      quote: t("home.demo.step_quote"),
      work: t("home.demo.step_work"),
      resources: t("home.demo.step_resources"),
      invoice: t("home.demo.step_invoice"),
      paid: t("home.demo.step_paid"),
    },
    stepAria: t("home.demo.step_aria", { n: "{n}", name: "{name}" }),
    sideEyebrow: t("home.demo.side_eyebrow"),
    sideEvent: t("home.demo.side_event"),
    sideCaption: t("home.demo.side_caption"),
    powered: t("home.hero.powered"),
    footerNote: t("home.demo.footer_note"),
    reset: t("home.demo.reset"),
    cta: t("home.demo.cta"),
    ctaNote: t("home.demo.cta_note"),
    ctaLocal: t("home.demo.cta_local"),
    ctaHref,
  };
}
