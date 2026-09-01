/**
 * H22F — the attention feed says the same things in both languages.
 *
 * The inbox renders each concern with `t("inbox.attn." + kind + ".title")`, so
 * a kind added to the module without a pair of catalogue entries renders the
 * loud ⟦key⟧ marker to a real reader. That is exactly the kind of miss that
 * survives review: the module compiles, the page compiles, the test suite is
 * green, and the only symptom is on a screen nobody opened in Arabic.
 *
 * Every ICU variable the messages ask for is also checked against what the feed
 * actually supplies, because a missing variable does not throw — it degrades to
 * the raw template, printing "{sku} is down to {available}" at somebody.
 */
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { t } from "@/platform/i18n";
import type { AttentionKind } from "@/modules/inventory/attention";

const KINDS: AttentionKind[] = [
  "stock_below_reorder",
  "batch_expiring",
  "batch_expired",
  "maintenance_due",
  "maintenance_overdue",
  "asset_warranty_ending",
];

/**
 * What the page hands every message: the row's own facts, plus the two things
 * it computes — the localized name and the formatted date. Mirrors AttentionRow.
 */
const SUPPLIED = new Set([
  "sku",
  "code",
  "available",
  "reorderPoint",
  "onHand",
  "assetNo",
  "name",
  "date",
]);

const catalogs = { en, ar } as Record<"en" | "ar", Record<string, string>>;

describe("every attention kind can be said in both languages", () => {
  it("has a title and a detail in en and ar", () => {
    for (const kind of KINDS) {
      for (const part of ["title", "detail"] as const) {
        const key = `inbox.attn.${kind}.${part}`;
        for (const locale of ["en", "ar"] as const) {
          expect(catalogs[locale][key], `${locale} is missing ${key}`).toBeTruthy();
        }
      }
    }
  });

  it("asks only for variables the feed supplies", () => {
    for (const kind of KINDS) {
      for (const part of ["title", "detail"] as const) {
        const key = `inbox.attn.${kind}.${part}`;
        for (const locale of ["en", "ar"] as const) {
          const used = [...catalogs[locale][key]!.matchAll(/\{([a-zA-Z_]+)/g)].map((m) => m[1]!);
          for (const v of used) {
            expect(
              SUPPLIED.has(v),
              `${locale}.${key} wants {${v}}, which the feed never sends`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("renders without a fallback marker or a leftover placeholder", () => {
    const vars = {
      sku: "SKU-1",
      code: "L-9",
      available: "0",
      reorderPoint: "10",
      onHand: "4",
      assetNo: "A-0001",
      name: "Compressor",
      date: "01/09/2026",
    };
    for (const kind of KINDS) {
      for (const part of ["title", "detail"] as const) {
        for (const locale of ["en", "ar"] as const) {
          const out = t(`inbox.attn.${kind}.${part}`, vars, locale);
          expect(out, `${locale} ${kind}.${part} fell back`).not.toContain("⟦");
          expect(out, `${locale} ${kind}.${part} left a placeholder`).not.toMatch(/\{[a-zA-Z_]+\}/);
        }
      }
    }
  });

  it("the two languages are genuinely different text", () => {
    /*
     * Guards the lazy fix. Copying the English value into ar.json satisfies the
     * catalog-parity test and every check above while shipping an English inbox
     * to Arabic readers, which is the failure this whole file exists to catch.
     */
    for (const kind of KINDS) {
      for (const part of ["title", "detail"] as const) {
        const key = `inbox.attn.${kind}.${part}`;
        expect(ar[key as keyof typeof ar], `${key} was never translated`).not.toBe(
          en[key as keyof typeof en],
        );
      }
    }
  });

  it("the inbox chrome is translated too", () => {
    const chrome = [
      "nav.inbox",
      "inbox.title",
      "inbox.attention",
      "inbox.attention_truncated",
      "inbox.notifications",
      "inbox.unread",
      "inbox.mark_read",
      "inbox.show_all",
      "inbox.show_unread",
      "inbox.empty_all",
      "inbox.empty_unread",
      "inbox.open_item",
      "inbox.severity_urgent",
      "inbox.severity_soon",
    ];
    for (const key of chrome) {
      expect(en[key as keyof typeof en], `en is missing ${key}`).toBeTruthy();
      expect(ar[key as keyof typeof ar], `ar is missing ${key}`).toBeTruthy();
      expect(ar[key as keyof typeof ar], `${key} was never translated`).not.toBe(
        en[key as keyof typeof en],
      );
    }
  });
});
