/**
 * The demo showcase company — ONE fictional construction business for the live
 * website, built by the same families as the Pilot Lab under the demo brand.
 *
 * Everything below is invented. The people do not exist, the addresses and
 * bank details are fabricated, the tax registration is visibly fake, and every
 * document the company issues carries "Demo company — fictional sample data"
 * in its footer. The owner persona's login is attached at provisioning time to
 * an address the site owner controls; the other eight personas live on the
 * reserved, undeliverable `rimal-demo.invalid` domain.
 *
 * The volume profile is pitched at "a convincing mid-sized contractor with
 * about two years of history": comparable to the lab's gulfbuild, with more
 * people (payroll, attendance and leave are the screens a visitor opens
 * first), more tasks per job, both lot- and serial-tracked stock, and six
 * Management Studio plans so every view has something worth looking at.
 */
import { baseProfile, personas } from "../pilot-lab/companies";
import type { Company } from "../pilot-lab/types";

/** The demo's "today". The seeder's clock and every relative date hang off it. */
export const DEMO_AS_OF = "2026-09-18";

export const RIMAL: Company = {
  key: "rimal",
  nameEn: "Rimal Engineering & Construction",
  nameAr: "رمال للهندسة والإنشاءات",
  legalNameEn: "Rimal Engineering & Construction L.L.C. (demo — fictional)",
  country: "AE",
  currency: "AED",
  timezone: "Asia/Dubai",
  languages: ["en", "ar"],
  templateKey: "construction_v1",
  sixDayWeek: true,
  // Twenty-two months and a half of history: completed work behind, live
  // projects now, commitments ahead.
  history: { from: "2024-11-01", asOf: DEMO_AS_OF },
  brandColor: "#0f766e",
  personas: personas({
    owner: ["Faisal Al Marzouqi", "فيصل المرزوقي"],
    admin: ["Huda Salem", "هدى سالم"],
    manager: ["Tariq Mansour", "طارق منصور"],
    finance: ["Amal Khouri", "أمل خوري"],
    hr: ["Noor Abdullah", "نور عبدالله"],
    warehouse: ["Imran Siddiqui", "عمران صديقي"],
    field: ["Rashid Obaid", "راشد عبيد"],
    restricted: ["Karim Nasser", "كريم ناصر"],
    auditor: ["Dina Farah", "دينا فرح"],
  }),
  profile: {
    ...baseProfile,
    customers: 90,
    suppliers: 60,
    items: 320,
    employees: 100,
    projects: 28,
    jobs: 320,
    tasksPerJob: [3, 5],
    leads: 220,
    opportunities: 180,
    quotes: 200,
    invoices: 300,
    purchaseOrders: 260,
    stockMovementsTarget: 1500,
    journalEntries: 500,
    documents: 120,
    studioPlans: 6,
    assets: 110,
    enables: { ...baseProfile.enables, lots: true, serials: true },
  },
};
