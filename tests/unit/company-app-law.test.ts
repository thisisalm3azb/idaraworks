/**
 * H31 — the flag, the colour safety net, and the generated mark.
 *
 * Three laws that decide whether a customer's branded app is usable or
 * embarrassing, all of them pure enough to test without a database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import {
  contrastRatio,
  decideBackgroundColor,
  decideBrandColor,
  parseHex,
  readableForeground,
  AA_NORMAL,
  FALLBACK_BRAND_COLOR,
} from "@/platform/tenanthost/contrast";
import {
  generateIconSet,
  initialsFor,
  ICON_SIZES,
  MASKABLE_SAFE_FRACTION,
} from "@/platform/tenanthost/icon";
import { appIdentity, withinScope } from "@/platform/tenanthost/manifest";
import { truncateGraphemes } from "@/platform/tenanthost/text";

describe("the release flag", () => {
  const original = process.env.FEATURE_BRANDED_COMPANY_APPS;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_BRANDED_COMPANY_APPS;
    else process.env.FEATURE_BRANDED_COMPANY_APPS = original;
    vi.unstubAllEnvs();
  });

  it('only the exact string "1" enables it', () => {
    process.env.FEATURE_BRANDED_COMPANY_APPS = "1";
    expect(brandedCompanyAppsEnabled()).toBe(true);
  });

  it("every near-miss reads as off", () => {
    // A flag that accepts "true" is a flag somebody turns on by accident.
    for (const value of ["true", "TRUE", "True", "yes", "on", "1 ", " 1", "01", "", "0"]) {
      process.env.FEATURE_BRANDED_COMPANY_APPS = value;
      expect(brandedCompanyAppsEnabled(), JSON.stringify(value)).toBe(false);
    }
  });

  it("absent reads as off", () => {
    delete process.env.FEATURE_BRANDED_COMPANY_APPS;
    expect(brandedCompanyAppsEnabled()).toBe(false);
  });
});

describe("colour safety", () => {
  it("an invalid colour falls back silently — there was nothing to warn about", () => {
    const d = decideBrandColor(null);
    expect(d.value).toBe(FALLBACK_BRAND_COLOR);
    expect(d.customerColorUsed).toBe(false);
    expect(d.warningKey).toBeNull();
  });

  it("a malformed colour the customer DID supply produces a warning", () => {
    for (const bad of ["red", "#fff", "#12345g", "rgb(1,2,3)", "#1234567"]) {
      const d = decideBrandColor(bad);
      expect(d.value, bad).toBe(FALLBACK_BRAND_COLOR);
      expect(d.warningKey, bad).toBe("app.brand.color_invalid");
    }
  });

  it("a bright colour is kept with no warning, because a dark foreground reads fine on it", () => {
    // Worth pinning: pale yellow LOOKS like a problem and is not one. Against
    // near-black it is about 17:1, so warning about it would be noise.
    const d = decideBrandColor("#ffff99");
    expect(d.value).toBe("#ffff99");
    expect(d.customerColorUsed).toBe(true);
    expect(d.warningKey).toBeNull();
    expect(contrastRatio(parseHex(d.value)!, parseHex(d.foreground)!)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("a mid tone that fails BOTH foregrounds is kept, and warned about", () => {
    // The real hard case: a middling grey sits too close to white and to black
    // at once, so neither foreground reaches AA. The customer's brand is still
    // not overruled — the warning tells them, and the better of the two is used.
    const d = decideBrandColor("#787878");
    expect(d.value).toBe("#787878");
    expect(d.customerColorUsed).toBe(true);
    expect(d.warningKey).toBe("app.brand.color_low_contrast");
    expect(d.ratio).toBeLessThan(AA_NORMAL);
  });

  it("the foreground is always the better of the two options", () => {
    for (const bg of ["#000000", "#ffffff", "#1f6f5c", "#ffff99", "#7f7f7f", "#123456"]) {
      const fg = readableForeground(parseHex(bg)!);
      const other = fg.color === "#ffffff" ? "#111111" : "#ffffff";
      expect(
        contrastRatio(parseHex(bg)!, parseHex(fg.color)!),
        `${bg} chose ${fg.color}`,
      ).toBeGreaterThanOrEqual(contrastRatio(parseHex(bg)!, parseHex(other)!));
    }
  });

  it("a mid grey still gets a legible foreground even though neither is ideal", () => {
    // #777 is the classic worst case: about 4.5:1 against both. The point is
    // that we never return an unreadable pair, not that we perform a miracle.
    const fg = readableForeground(parseHex("#777777")!);
    expect(contrastRatio(parseHex("#777777")!, parseHex(fg.color)!)).toBeGreaterThan(3);
  });

  it("an invalid splash colour becomes white, which is never wrong", () => {
    expect(decideBackgroundColor("nonsense").value).toBe("#ffffff");
    expect(decideBackgroundColor(null).value).toBe("#ffffff");
  });
});

describe("the generated mark", () => {
  it("uses the company's own initials", () => {
    expect(initialsFor("Najolatech Boat Works")).toBe("NB");
    expect(initialsFor("Acme")).toBe("A");
  });

  it("ignores legal forms, so not every company is 'LL'", () => {
    expect(initialsFor("Gulf Marine LLC")).toBe("GM");
    expect(initialsFor("Falcon Ltd")).toBe("F");
  });

  it("keeps an Arabic grapheme whole", () => {
    const out = initialsFor("شما اتيلييه");
    expect(out.length).toBeGreaterThan(0);
    // Never a replacement character from cutting mid-grapheme.
    expect(out).not.toContain("�");
  });

  it("never returns empty, however strange the name", () => {
    for (const name of ["", "   ", "()", "LLC", "..."]) {
      expect(initialsFor(name).length, JSON.stringify(name)).toBeGreaterThan(0);
    }
  });

  it("provides both sizes Chromium requires for installability", () => {
    // MDN, 2026-09-04: the manifest "must contain a 192px and a 512px icon".
    expect(ICON_SIZES).toContain(192);
    expect(ICON_SIZES).toContain(512);
  });

  it("the maskable safe area matches the spec's guaranteed 80%", () => {
    expect(MASKABLE_SAFE_FRACTION).toBeCloseTo(0.8, 5);
  });

  it("an uploaded logo sits on the app background for maskable, and on nothing for any", async () => {
    // LiwaHarvest, 2026-09-20: a dark-green logo on the brand-green tile was
    // invisible. The tile behind an uploaded logo is the app background (white
    // by default); the transparent margin of the `any` icon is untouched.
    const { default: sharp } = await import("sharp");
    // Wider than tall, like most wordmarks: contain-fit leaves margins above and below.
    const source = await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 200, g: 20, b: 20, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const { icons, kind } = await generateIconSet({
      source,
      orgName: "Liwa Harvest",
      brandColor: "#1f6f5c",
      backgroundColor: null,
    });
    expect(kind).toBe("uploaded");
    const corner = async (buf: Buffer) => {
      const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2], data[3]] as [number, number, number, number];
    };
    const maskable = icons.find((i) => i.size === 192 && i.maskable)!;
    const any = icons.find((i) => i.size === 192 && !i.maskable)!;
    expect(await corner(maskable.buffer)).toEqual([255, 255, 255, 255]); // white tile, not brand green
    expect((await corner(any.buffer))[3]).toBe(0); // transparent margin
    // The logo itself is still there: a centre pixel of the maskable icon is the source colour.
    const centre = await sharp(maskable.buffer)
      .extract({ left: 96, top: 96, width: 1, height: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(centre[0]).toBeGreaterThan(150);
  });
});

describe("short names fit a home screen", () => {
  it("truncates on a grapheme boundary, never mid-character", () => {
    const long = "Najolatech Boat Works International";
    expect(truncateGraphemes(long, 12)).toBe("Najolatech B");
  });

  it("does not split an Arabic letter or an emoji", () => {
    expect(truncateGraphemes("شما اتيلييه للتصميم", 12)).not.toContain("�");
    const emoji = truncateGraphemes("👨‍👩‍👧‍👦 Family Co", 3);
    expect(emoji).not.toContain("�");
  });

  it("leaves a short name alone", () => {
    expect(truncateGraphemes("Acme", 12)).toBe("Acme");
  });
});

describe("one installed app per company", () => {
  const origin = "https://www.idaraworks.com";
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("a company's start_url is inside its own scope", () => {
    const id = appIdentity(origin, a);
    expect(withinScope(id.start_url, id.scope)).toBe(true);
  });

  it("the old trailing-slash scope did not contain the start_url (why companies shared a scope)", () => {
    const id = appIdentity(origin, a);
    expect(withinScope(id.start_url, `${id.scope}/`)).toBe(false);
  });

  it("two companies never fall inside each other's scope", () => {
    const A = appIdentity(origin, a);
    const B = appIdentity(origin, b);
    expect(A.id).not.toBe(B.id);
    expect(withinScope(B.start_url, A.scope)).toBe(false);
    expect(withinScope(A.start_url, B.scope)).toBe(false);
    expect(withinScope(`${origin}/o/${b}/settings/app`, A.scope)).toBe(false);
    expect(withinScope(`${origin}/o/${a}/settings/app`, A.scope)).toBe(true);
  });

  it("the id is the organisation alone: a new origin or name is the same app", () => {
    expect(appIdentity("https://ops.example.com", a).id).toBe(appIdentity(origin, a).id);
  });
});
