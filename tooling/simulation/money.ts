/**
 * Money helpers for the simulation factory — reproduce the app's EXACT financial
 * math so seeded totals reconcile with what the product computes (audited from
 * src/modules/quotes/service.ts computeQuoteTotals and
 * src/modules/invoices/service.ts computeInvoiceTotals). All amounts are integer
 * minor units (bigint in the DB). Tax is EXCLUSIVE and per-line; VAT is rounded
 * per line THEN summed; totals must satisfy total = subtotal + vat.
 */

/** Minor-unit exponent by currency (KWD/BHD/OMR are 3-decimal; rest 2). */
const EXPONENT: Record<string, number> = {
  AED: 2,
  SAR: 2,
  QAR: 2,
  USD: 2,
  EUR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

export function minorExponent(currency: string): number {
  return EXPONENT[currency] ?? 2;
}

/** Convert a major-unit amount to integer minor units for a currency. */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** minorExponent(currency));
}

export type LineInput = {
  qty: number; // up to 3 decimals
  unitPriceMinor: number; // integer minor units
  vatRate: number; // percent, e.g. 5
};

export type DocTotals = {
  subtotalMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  baseTotalMinor: number;
  lines: Array<{ lineTotalMinor: number; lineVatMinor: number }>;
};

/** Per-line ex-VAT total = round(qty * unitPrice). */
export function lineTotalMinor(qty: number, unitPriceMinor: number): number {
  return Math.round(qty * unitPriceMinor);
}

/**
 * Document totals — mirrors computeQuoteTotals / computeInvoiceTotals exactly.
 * `vatApplies=false` (org not VAT-registered, or export invoice) zeroes VAT.
 */
export function computeTotals(
  lines: readonly LineInput[],
  exchangeRate = 1,
  vatApplies = true,
): DocTotals {
  const out: DocTotals["lines"] = [];
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lt = lineTotalMinor(l.qty, l.unitPriceMinor);
    const rate = vatApplies ? l.vatRate : 0;
    const lv = Math.round((lt * rate) / 100);
    out.push({ lineTotalMinor: lt, lineVatMinor: lv });
    subtotal += lt;
    vat += lv;
  }
  const total = subtotal + vat;
  return {
    subtotalMinor: subtotal,
    vatAmountMinor: vat,
    totalMinor: total,
    baseTotalMinor: Math.round(total * exchangeRate),
    lines: out,
  };
}

/** Purchase-order total: Σ round(qty*unit_cost) lines + a single header VAT. */
export function poTotals(
  lines: readonly { qty: number; unitCostMinor: number }[],
  vatMinor: number,
): { lineTotals: number[]; subtotalMinor: number; totalMinor: number } {
  const lineTotals = lines.map((l) => lineTotalMinor(l.qty, l.unitCostMinor));
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  return { lineTotals, subtotalMinor: subtotal, totalMinor: subtotal + vatMinor };
}

/** Frozen labour cost for one report line: round(normal*hourly + ot*hourly*otRate). */
export function labourCostMinor(
  normalHours: number,
  otHours: number,
  hourlyCostMinor: number,
  otRate: number,
): number {
  return Math.round(normalHours * hourlyCostMinor + otHours * hourlyCostMinor * otRate);
}
