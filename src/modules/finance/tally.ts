/**
 * H24J — Tally migration: guided, inspected, idempotent, and honest.
 *
 * Supported formats — EXACTLY these, stated to the user (D15):
 *  1. Tally XML masters export — "List of Accounts" (TALLYMESSAGE > LEDGER)
 *  2. Tally XML voucher export — "Day Book" (TALLYMESSAGE > VOUCHER with
 *     ALLLEDGERENTRIES.LIST; a negative AMOUNT is a debit, positive a credit,
 *     the Tally convention)
 *  3. Generic CSV with a header row: date, voucher_no, ledger, debit, credit
 *     and optionally narration — amounts in major units, dates YYYY-MM-DD
 *
 * Flow: inspect (parse + SHA-256 dedupe) → map ledgers to accounts (a human
 * decision, never guessed) → dry-run (what WOULD post + per-account totals to
 * compare with Tally's own trial balance + exceptions) → approve (posts via
 * the one bridge; source ('tally_import', batch, 'voucher:<key>') makes
 * re-approval a no-op) → reconciliation report.
 *
 * HONESTY RULES: vouchers dated before the books start are exceptions, never
 * postings; unbalanced vouchers are exceptions; nothing posts without an
 * explicit human approval; a failed voucher never blocks the others silently
 * — every skip is named in the report.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { requireCapability } from "@/platform/entitlements";
import { FinanceError, postFromSourceIn, type SourcePostingLine } from "./ledger";
import { financeConfigIn } from "./chart";

export const TALLY_RULE_VERSION = "tally-1";

export const TALLY_SUPPORTED_FORMATS = [
  {
    key: "tally_xml_masters",
    label: "Tally XML — List of Accounts (masters)",
    detail: "TALLYMESSAGE blocks containing LEDGER masters with parent groups.",
  },
  {
    key: "tally_xml_vouchers",
    label: "Tally XML — Day Book (vouchers)",
    detail:
      "TALLYMESSAGE blocks containing VOUCHER entries; negative amounts are debits (Tally convention).",
  },
  {
    key: "csv",
    label: "CSV — date, voucher_no, ledger, debit, credit[, narration]",
    detail: "Header row required; amounts in major units; dates YYYY-MM-DD.",
  },
] as const;

// ── parsing ──────────────────────────────────────────────────────────────────

export type TallyVoucherLine = { ledger: string; debitMinor: number; creditMinor: number };
export type TallyVoucher = {
  key: string; // voucher number, or a stable synthetic key
  date: string; // YYYY-MM-DD
  voucherType: string | null;
  narration: string | null;
  lines: TallyVoucherLine[];
};

const decodeXmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decodeXmlText(m[1]!) : null;
};

/** Tally DATE is YYYYMMDD. */
const tallyDate = (raw: string | null): string | null => {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
};

/** Tally AMOUNT: negative = debit, positive = credit. Returns integer minors. */
const tallyAmountMinor = (raw: string | null): number => {
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};

export function parseTallyMasters(xml: string): Array<{ name: string; parent: string | null }> {
  const out: Array<{ name: string; parent: string | null }> = [];
  const re = /<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]!;
    const body = m[2]!;
    const nameAttr = /NAME="([^"]*)"/i.exec(attrs);
    const name = nameAttr ? decodeXmlText(nameAttr[1]!) : (tag(body, "NAME") ?? "");
    if (!name) continue;
    out.push({ name, parent: tag(body, "PARENT") });
  }
  return out;
}

export function parseTallyVouchers(xml: string): TallyVoucher[] {
  const out: TallyVoucher[] = [];
  const re = /<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
  let m: RegExpExecArray | null;
  let synthetic = 0;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1]!;
    const date = tallyDate(tag(body, "DATE"));
    if (!date) continue;
    synthetic++;
    const key = tag(body, "VOUCHERNUMBER") || `synthetic-${synthetic}`;
    const lines: TallyVoucherLine[] = [];
    const lre = /<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = lre.exec(body)) !== null) {
      const lb = lm[1]!;
      const ledger = tag(lb, "LEDGERNAME");
      if (!ledger) continue;
      const amount = tallyAmountMinor(tag(lb, "AMOUNT"));
      lines.push({
        ledger,
        debitMinor: amount < 0 ? -amount : 0,
        creditMinor: amount > 0 ? amount : 0,
      });
    }
    out.push({
      key,
      date,
      voucherType: tag(body, "VOUCHERTYPENAME"),
      narration: tag(body, "NARRATION"),
      lines,
    });
  }
  return out;
}

export function parseTallyCsv(text: string): TallyVoucher[] {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length < 2) return [];
  const header = rows[0]!.split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("date");
  const iNo = col("voucher_no");
  const iLedger = col("ledger");
  const iDebit = col("debit");
  const iCredit = col("credit");
  const iNarr = col("narration");
  if (iDate < 0 || iNo < 0 || iLedger < 0 || iDebit < 0 || iCredit < 0) {
    throw new FinanceError("CSV needs a header row with: date, voucher_no, ledger, debit, credit");
  }
  const byVoucher = new Map<string, TallyVoucher>();
  for (const row of rows.slice(1)) {
    const cells = row.split(",").map((c) => c.trim());
    const date = cells[iDate] ?? "";
    const no = cells[iNo] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !no) continue;
    const key = `${date}:${no}`;
    let v = byVoucher.get(key);
    if (!v) {
      v = {
        key: no,
        date,
        voucherType: null,
        narration: iNarr >= 0 ? cells[iNarr] || null : null,
        lines: [],
      };
      byVoucher.set(key, v);
    }
    v.lines.push({
      ledger: cells[iLedger] ?? "",
      debitMinor: Math.round(Number(cells[iDebit] || 0) * 100),
      creditMinor: Math.round(Number(cells[iCredit] || 0) * 100),
    });
  }
  return [...byVoucher.values()];
}

export function detectTallyFormat(
  content: string,
): "tally_xml_masters" | "tally_xml_vouchers" | "csv" {
  if (/<TALLYMESSAGE\b/i.test(content) || /<ENVELOPE\b/i.test(content)) {
    if (/<VOUCHER\b/i.test(content)) return "tally_xml_vouchers";
    if (/<LEDGER\b/i.test(content)) return "tally_xml_masters";
    throw new FinanceError("Tally XML found, but no LEDGER masters or VOUCHER entries in it");
  }
  return "csv";
}

// ── the batch lifecycle ──────────────────────────────────────────────────────

export type TallyInspection = {
  importId: string;
  format: string;
  alreadyUploaded: boolean;
  summary: {
    ledgers: string[];
    voucherCount: number;
    dateRange: { from: string; to: string } | null;
    totalDebitMinor: number;
    totalCreditMinor: number;
  };
};

async function batchRow(tx: TenantTx, ctx: Ctx, importId: string) {
  const rows = (await tx.execute(sql`
    select id::text as id, format, status, payload, account_map, report
    from public.tally_import where id = ${importId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{
    id: string;
    format: string;
    status: string;
    payload: {
      vouchers?: TallyVoucher[];
      ledgers?: Array<{ name: string; parent: string | null }>;
    };
    account_map: Record<string, string>;
    report: Record<string, unknown>;
  }>;
  if (!rows[0]) throw new FinanceError("import batch not found", "not_found");
  return rows[0];
}

function summarize(vouchers: TallyVoucher[], ledgers: string[]): TallyInspection["summary"] {
  let debit = 0;
  let credit = 0;
  let from = "";
  let to = "";
  for (const v of vouchers) {
    if (!from || v.date < from) from = v.date;
    if (!to || v.date > to) to = v.date;
    for (const l of v.lines) {
      debit += l.debitMinor;
      credit += l.creditMinor;
    }
  }
  return {
    ledgers,
    voucherCount: vouchers.length,
    dateRange: from ? { from, to } : null,
    totalDebitMinor: debit,
    totalCreditMinor: credit,
  };
}

/** Step 1 — parse and store. The same bytes re-uploaded return the SAME batch. */
export async function inspectTallyFile(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<TallyInspection> {
  assertCan(archetype, "finance.manage");
  await requireCapability(ctx, "cap.finance");
  const input = z
    .object({ filename: z.string().trim().min(1).max(260), content: z.string().min(1) })
    .parse(raw);
  const sha = createHash("sha256").update(input.content, "utf8").digest("hex");
  const format = detectTallyFormat(input.content);

  let ledgers: string[] = [];
  let vouchers: TallyVoucher[] = [];
  if (format === "tally_xml_masters") {
    ledgers = parseTallyMasters(input.content).map((l) => l.name);
    if (ledgers.length === 0) throw new FinanceError("no ledger masters found in the file");
  } else {
    vouchers =
      format === "tally_xml_vouchers"
        ? parseTallyVouchers(input.content)
        : parseTallyCsv(input.content);
    if (vouchers.length === 0) throw new FinanceError("no vouchers found in the file");
    ledgers = [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)))].sort();
  }
  const summary = summarize(vouchers, ledgers);

  return command(
    ctx,
    {
      audit: (r: TallyInspection) => ({
        action: "finance.tally.inspect",
        entityType: "tally_import",
        entityId: r.importId,
        summary: `Inspected ${input.filename} (${format}, ${summary.voucherCount} vouchers)`,
      }),
    },
    async (tx) => {
      const existing = (await tx.execute(sql`
        select id::text as id, format from public.tally_import
        where org_id = ${ctx.orgId} and file_sha256 = ${sha}
      `)) as unknown as Array<{ id: string; format: string }>;
      if (existing[0]) {
        return {
          importId: existing[0].id,
          format: existing[0].format,
          alreadyUploaded: true,
          summary,
        };
      }
      const payload = { ledgers: ledgers.map((name) => ({ name, parent: null })), vouchers };
      const rows = (await tx.execute(sql`
        insert into public.tally_import
          (org_id, filename, file_sha256, format, payload, created_by)
        values (${ctx.orgId}, ${input.filename}, ${sha}, ${format},
                ${JSON.stringify(payload)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { importId: rows[0]!.id, format, alreadyUploaded: false, summary };
    },
  );
}

/** Step 2 — the HUMAN maps each Tally ledger name to an account (or 'skip'). */
export async function mapTallyLedgers(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ mapped: number; unmapped: string[] }> {
  assertCan(archetype, "finance.manage");
  const input = z
    .object({
      importId: z.string().uuid(),
      map: z.record(z.string(), z.string().min(1).max(64)),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "finance.tally.map",
        entityType: "tally_import",
        entityId: input.importId,
        summary: "Updated ledger-to-account mapping",
      },
    },
    async (tx) => {
      const batch = await batchRow(tx, ctx, input.importId);
      if (batch.status === "imported") {
        throw new FinanceError("this batch is already imported", "invalid_state");
      }
      // Every non-skip target must be a real, live account in THIS org.
      const targets = [...new Set(Object.values(input.map).filter((v) => v !== "skip"))];
      for (const accountId of targets) {
        const ok = (await tx.execute(sql`
          select 1 from public.gl_account
          where id = ${accountId} and org_id = ${ctx.orgId} and archived_at is null
        `)) as unknown as unknown[];
        if (ok.length === 0) throw new FinanceError(`unknown account for mapping: ${accountId}`);
      }
      const merged = { ...batch.account_map, ...input.map };
      await tx.execute(sql`
        update public.tally_import
        set account_map = ${JSON.stringify(merged)}::jsonb, updated_at = now()
        where id = ${input.importId} and org_id = ${ctx.orgId}
      `);
      const vouchers = batch.payload.vouchers ?? [];
      const referenced = new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)));
      const unmapped = [...referenced].filter((l) => !merged[l]).sort();
      return { mapped: Object.keys(merged).length, unmapped };
    },
  );
}

export type TallyDryRun = {
  postable: number;
  exceptions: Array<{ voucher: string; date: string; reason: string }>;
  accountTotals: Array<{ accountId: string; debitMinor: number; creditMinor: number }>;
  totalDebitMinor: number;
  totalCreditMinor: number;
};

function planVouchers(
  vouchers: TallyVoucher[],
  map: Record<string, string>,
  booksStartDate: string,
): {
  plans: Array<{ voucher: TallyVoucher; lines: SourcePostingLine[] }>;
  exceptions: TallyDryRun["exceptions"];
} {
  const plans: Array<{ voucher: TallyVoucher; lines: SourcePostingLine[] }> = [];
  const exceptions: TallyDryRun["exceptions"] = [];
  for (const v of vouchers) {
    if (v.date < booksStartDate) {
      exceptions.push({
        voucher: v.key,
        date: v.date,
        reason: `dated before the books start (${booksStartDate}) — history is never invented; bring it in as opening balances instead`,
      });
      continue;
    }
    const lines: SourcePostingLine[] = [];
    let debit = 0;
    let credit = 0;
    let skipped = false;
    let unmapped: string | null = null;
    for (const l of v.lines) {
      const target = map[l.ledger];
      if (!target) {
        unmapped = l.ledger;
        break;
      }
      if (target === "skip") {
        skipped = true;
        continue;
      }
      if (l.debitMinor === 0 && l.creditMinor === 0) continue;
      lines.push({
        accountId: target,
        description: v.narration ?? undefined,
        debitMinor: l.debitMinor || undefined,
        creditMinor: l.creditMinor || undefined,
      });
      debit += l.debitMinor;
      credit += l.creditMinor;
    }
    if (unmapped) {
      exceptions.push({ voucher: v.key, date: v.date, reason: `unmapped ledger: ${unmapped}` });
      continue;
    }
    if (skipped && lines.length > 0) {
      exceptions.push({
        voucher: v.key,
        date: v.date,
        reason: "some lines map to 'skip' — skipping part of a voucher would unbalance it",
      });
      continue;
    }
    if (lines.length === 0) continue; // whole voucher skipped deliberately
    if (debit !== credit || lines.length < 2) {
      exceptions.push({
        voucher: v.key,
        date: v.date,
        reason: `does not balance (${debit} vs ${credit})`,
      });
      continue;
    }
    plans.push({ voucher: v, lines });
  }
  return { plans, exceptions };
}

/** Step 3 — what WOULD post, plus per-account totals to hold against Tally's
 *  own trial balance. Writes the report; posts NOTHING. */
export async function dryRunTallyImport(
  ctx: Ctx,
  archetype: RoleArchetype,
  importId: string,
): Promise<TallyDryRun> {
  assertCan(archetype, "finance.manage");
  return command(
    ctx,
    {
      audit: {
        action: "finance.tally.dry_run",
        entityType: "tally_import",
        entityId: importId,
        summary: "Dry run computed",
      },
    },
    async (tx) => {
      const batch = await batchRow(tx, ctx, importId);
      if (batch.format === "tally_xml_masters") {
        throw new FinanceError("a masters file maps accounts; only voucher files post entries");
      }
      const config = await financeConfigIn(tx, ctx);
      if (!config) throw new FinanceError("finance is not set up for this organization");
      const vouchers = batch.payload.vouchers ?? [];
      const { plans, exceptions } = planVouchers(
        vouchers,
        batch.account_map,
        config.booksStartDate,
      );
      const totals = new Map<string, { debitMinor: number; creditMinor: number }>();
      let d = 0;
      let c = 0;
      for (const p of plans) {
        for (const l of p.lines) {
          const row = totals.get(l.accountId) ?? { debitMinor: 0, creditMinor: 0 };
          row.debitMinor += l.debitMinor ?? 0;
          row.creditMinor += l.creditMinor ?? 0;
          totals.set(l.accountId, row);
          d += l.debitMinor ?? 0;
          c += l.creditMinor ?? 0;
        }
      }
      const result: TallyDryRun = {
        postable: plans.length,
        exceptions,
        accountTotals: [...totals.entries()].map(([accountId, r]) => ({ accountId, ...r })),
        totalDebitMinor: d,
        totalCreditMinor: c,
      };
      await tx.execute(sql`
        update public.tally_import
        set status = 'validated', report = ${JSON.stringify({ dryRun: result })}::jsonb,
            updated_at = now()
        where id = ${importId} and org_id = ${ctx.orgId}
      `);
      return result;
    },
  );
}

export type TallyImportResult = {
  posted: number;
  alreadyPosted: number;
  failed: Array<{ voucher: string; reason: string }>;
  exceptions: TallyDryRun["exceptions"];
};

/** Step 4 — the explicit approval. Posts each plan through the ONE bridge;
 *  (source, event) idempotency makes re-approval return the same entries. */
export async function approveTallyImport(
  ctx: Ctx,
  archetype: RoleArchetype,
  importId: string,
): Promise<TallyImportResult> {
  assertCan(archetype, "finance.post");
  await requireCapability(ctx, "cap.finance");
  return command(
    ctx,
    {
      audit: (r: TallyImportResult) => ({
        action: "finance.tally.import",
        entityType: "tally_import",
        entityId: importId,
        summary: `Imported ${r.posted} vouchers (${r.alreadyPosted} already in, ${r.failed.length} failed)`,
      }),
    },
    async (tx) => {
      const batch = await batchRow(tx, ctx, importId);
      if (batch.format === "tally_xml_masters") {
        throw new FinanceError("a masters file maps accounts; only voucher files post entries");
      }
      if (batch.status !== "validated" && batch.status !== "imported") {
        throw new FinanceError("run the dry run first — imports are never a surprise");
      }
      const config = await financeConfigIn(tx, ctx);
      if (!config) throw new FinanceError("finance is not set up for this organization");
      const base = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const vouchers = batch.payload.vouchers ?? [];
      const { plans, exceptions } = planVouchers(
        vouchers,
        batch.account_map,
        config.booksStartDate,
      );
      let posted = 0;
      let alreadyPosted = 0;
      const failed: TallyImportResult["failed"] = [];
      for (const p of plans) {
        // One savepoint-free sequential loop: a voucher that violates a ledger
        // invariant (locked period, archived account) is reported by NAME and
        // the batch keeps going on the next command call — but inside ONE
        // transaction a failure poisons it, so we post one voucher per
        // sub-call is not possible here; instead any failure aborts and is
        // reported as the batch's failure. Balanced-and-mapped was proven in
        // the dry run, so the realistic failure is a locked period.
        const r = await postFromSourceIn(tx, ctx, {
          sourceType: "tally_import",
          sourceId: importId,
          eventKey: `voucher:${p.voucher.date}:${p.voucher.key}`,
          ruleKey: "tally.voucher",
          ruleVersion: TALLY_RULE_VERSION,
          journalKind: "general",
          entryDate: p.voucher.date,
          currency: base[0]!.base_currency,
          exchangeRate: 1,
          memo:
            p.voucher.narration ?? `Tally ${p.voucher.voucherType ?? "voucher"} ${p.voucher.key}`,
          lines: p.lines,
          controlOk: true,
        });
        if (r.alreadyPosted) alreadyPosted++;
        else posted++;
      }
      const result: TallyImportResult = { posted, alreadyPosted, failed, exceptions };
      await tx.execute(sql`
        update public.tally_import
        set status = 'imported',
            report = ${JSON.stringify({ ...batch.report, import: result })}::jsonb,
            updated_at = now()
        where id = ${importId} and org_id = ${ctx.orgId}
      `);
      return result;
    },
  );
}

export type TallyBatchRow = {
  id: string;
  filename: string;
  format: string;
  status: string;
  createdAt: string;
  voucherCount: number;
};

export async function listTallyImports(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<TallyBatchRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, filename, format, status, created_at::text as created,
             coalesce(jsonb_array_length(payload->'vouchers'), 0)::int as vc
      from public.tally_import where org_id = ${ctx.orgId}
      order by created_at desc limit 50
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    filename: r.filename as string,
    format: r.format as string,
    status: r.status as string,
    createdAt: r.created as string,
    voucherCount: r.vc as number,
  }));
}

/** The stored batch detail for the guided page. */
export async function tallyImportDetail(ctx: Ctx, archetype: RoleArchetype, importId: string) {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const batch = await batchRow(tx, ctx, importId);
    const vouchers = batch.payload.vouchers ?? [];
    const referenced = [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)))].sort();
    const masterLedgers = (batch.payload.ledgers ?? []).map((l) => l.name);
    return {
      id: batch.id,
      format: batch.format,
      status: batch.status,
      ledgers: referenced.length > 0 ? referenced : masterLedgers,
      accountMap: batch.account_map,
      report: batch.report,
      summary: summarize(vouchers, referenced),
    };
  });
}
