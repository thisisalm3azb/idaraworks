import fs from "node:fs";

// ── invoices: post on issue and on credit-note creation ─────────────────────
let inv = fs.readFileSync("src/modules/invoices/service.ts", "utf8");
inv = inv.replace(
  'import { formatDate, formatMoney } from "@/platform/format";',
  'import { formatDate, formatMoney } from "@/platform/format";\nimport { postInvoiceIssuedIn } from "@/modules/finance/service";',
);
if (!inv.includes("postInvoiceIssuedIn")) { console.log("INV IMPORT MISS"); process.exit(1); }
inv = inv.replace(
  `      await captureIssuer(tx, ctx, invoiceId, { stampIssuedAt: true });
      return { jobId: rows[0].job_id };`,
  `      await captureIssuer(tx, ctx, invoiceId, { stampIssuedAt: true });
      // H24D: the ONE accounting event for this document (idempotent; no-op
      // until the org adopts finance; loud failure once it has — books never
      // diverge quietly).
      await postInvoiceIssuedIn(tx, ctx, invoiceId);
      return { jobId: rows[0].job_id };`,
);
inv = inv.replace(
  `      await captureIssuer(tx, ctx, rows[0]!.id, { stampIssuedAt: true });
      await reconcileInvoiceStatus(tx, ctx, correctsInvoiceId);
      return { id: rows[0]!.id, reference };`,
  `      await captureIssuer(tx, ctx, rows[0]!.id, { stampIssuedAt: true });
      // H24D: a credit note posts its mirroring entry the moment it exists.
      await postInvoiceIssuedIn(tx, ctx, rows[0]!.id);
      await reconcileInvoiceStatus(tx, ctx, correctsInvoiceId);
      return { id: rows[0]!.id, reference };`,
);
fs.writeFileSync("src/modules/invoices/service.ts", inv, "utf8");

// ── payments: post on record; reverse on void ───────────────────────────────
let pay = fs.readFileSync("src/modules/payments/service.ts", "utf8");
pay = pay.replace(
  'import { submitForApproval } from "@/modules/approvals/service";',
  'import { submitForApproval } from "@/modules/approvals/service";\nimport { postPaymentReceivedIn, reverseSourcePostingIn } from "@/modules/finance/service";',
);
pay = pay.replace(
  "        return { id, reference, receiptReference, approvalId };",
  `        // H24D: money in posts once, at record time; a later reject/void
        // reverses it explicitly.
        await postPaymentReceivedIn(tx, ctx, id);
        return { id, reference, receiptReference, approvalId };`,
);
pay = pay.replace(
  "      if (!rows[0]) throw new PaymentStateError(\"payment already voided or not found\");\n      if (rows[0].invoice_id) await reconcileInvoiceStatus(tx, ctx, rows[0].invoice_id);",
  `      if (!rows[0]) throw new PaymentStateError("payment already voided or not found");
      if (rows[0].invoice_id) await reconcileInvoiceStatus(tx, ctx, rows[0].invoice_id);
      // H24D: voiding reverses the receipt posting (if the org keeps books).
      await reverseSourcePostingIn(tx, ctx, {
        sourceType: "payment",
        sourceId: paymentId,
        eventKey: "received",
        reason: \`Payment voided: \${reason}\`,
      });`,
);
fs.writeFileSync("src/modules/payments/service.ts", pay, "utf8");

// ── expenses: post on create; reverse on void ───────────────────────────────
let exp = fs.readFileSync("src/modules/expenses/service.ts", "utf8");
exp = exp.replace(
  'import { requireCapability } from "@/platform/entitlements";',
  'import { requireCapability } from "@/platform/entitlements";\nimport { postExpenseRecordedIn, reverseSourcePostingIn } from "@/modules/finance/service";',
);
exp = exp.replace(
  "      return { id: rows[0]!.id, reference };\n    },\n  );\n}\n\nexport async function voidExpense(",
  `      // H24D: the cost posts once at record time.
      await postExpenseRecordedIn(tx, ctx, rows[0]!.id);
      return { id: rows[0]!.id, reference };
    },
  );
}

export async function voidExpense(`,
);
fs.writeFileSync("src/modules/expenses/service.ts", exp, "utf8");
console.log("seams wired:",
  inv.includes("postInvoiceIssuedIn(tx, ctx, invoiceId)"),
  pay.includes("postPaymentReceivedIn(tx, ctx, id)"),
  pay.includes("reverseSourcePostingIn"),
  exp.includes("postExpenseRecordedIn"));
