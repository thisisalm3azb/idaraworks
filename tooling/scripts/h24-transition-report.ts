/**
 * H24M — the READ-ONLY production transition report.
 *
 * Answers one question with evidence: what historical money activity exists in
 * production, how much of it is reconstructable into the new ledger, and what
 * the honest transition would look like — WITHOUT converting anything. Every
 * statement is a SELECT; there is no branch that writes.
 *
 * Same production guard as prod-health.ts: loads `.env.local` only, positively
 * identifies the production project, asks the server which database it reached,
 * prints no secret.
 *
 *   npx tsx tooling/scripts/h24-transition-report.ts
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

async function main(): Promise<void> {
  const guard = targetsOnlyProductionProject();
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.problems.join("; ")}`);
    process.exit(2);
  }
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [ident] = await sql`
      select current_database() as db,
             (select count(*)::int from public.org) as orgs`;
    console.log(`# H24 transition report — read-only`);
    console.log(`project: ${PRODUCTION_PROJECT_REF}, db: ${ident!.db}, orgs: ${ident!.orgs}`);

    const invoices = await sql`
      select kind, status, count(*)::int as n, coalesce(sum(total_minor), 0)::bigint as total,
             min(coalesce(issued_at::date, created_at::date))::text as earliest,
             max(coalesce(issued_at::date, created_at::date))::text as latest
      from public.invoice group by kind, status order by kind, status`;
    console.log("\n## invoices (by kind/status)");
    for (const r of invoices) {
      console.log(
        `${r.kind}/${r.status}: n=${r.n} total_minor=${r.total} range=${r.earliest}..${r.latest}`,
      );
    }
    const [invFx] = await sql`
      select count(*)::int as n from public.invoice i
      join public.org o on o.id = i.org_id
      where i.currency is distinct from o.base_currency`;
    const [invVat] = await sql`
      select count(*) filter (where vat_amount_minor > 0)::int as with_vat,
             count(*) filter (where coalesce(vat_amount_minor, 0) = 0)::int as zero_vat
      from public.invoice where status not in ('draft', 'cancelled')`;
    console.log(`foreign-currency invoices: ${invFx!.n}`);
    console.log(`issued invoices with VAT: ${invVat!.with_vat}; zero-VAT: ${invVat!.zero_vat}`);

    const payments = await sql`
      select status, count(*)::int as n, coalesce(sum(amount_minor), 0)::bigint as total,
             min(payment_date)::text as earliest, max(payment_date)::text as latest
      from public.payment group by status order by status`;
    console.log("\n## payments (by status)");
    for (const r of payments) {
      console.log(`${r.status}: n=${r.n} total_minor=${r.total} range=${r.earliest}..${r.latest}`);
    }
    const [payFx] = await sql`
      select count(*)::int as n from public.payment p
      join public.org o on o.id = p.org_id
      where p.currency is distinct from o.base_currency`;
    console.log(`foreign-currency payments: ${payFx!.n}`);

    const expenses = await sql`
      select count(*)::int as n, coalesce(sum(amount_minor), 0)::bigint as total,
             coalesce(sum(vat_amount_minor), 0)::bigint as vat,
             count(*) filter (where coalesce(vat_amount_minor, 0) = 0)::int as no_vat,
             min(expense_date)::text as earliest, max(expense_date)::text as latest
      from public.expense`;
    console.log("\n## expenses");
    const e = expenses[0]!;
    console.log(
      `n=${e.n} total_minor=${e.total} vat_minor=${e.vat} without_vat=${e.no_vat} range=${e.earliest}..${e.latest}`,
    );

    const [grn] = await sql`
      select count(*)::int as n,
             min(received_date)::text as earliest, max(received_date)::text as latest
      from public.goods_receipt where status = 'recorded'`;
    const [grnValue] = await sql`
      select coalesce(sum(grl.accepted_qty * pol.unit_cost_minor), 0)::bigint as ex_vat
      from public.goods_receipt g
      join public.goods_receipt_line grl on grl.grn_id = g.id and grl.org_id = g.org_id
      join public.purchase_order_line pol on pol.id = grl.po_line_id and pol.org_id = g.org_id
      where g.status = 'recorded'`;
    console.log("\n## goods receipts");
    console.log(
      `recorded=${grn!.n} accepted_value_ex_vat_minor=${grnValue!.ex_vat} range=${grn!.earliest}..${grn!.latest}`,
    );

    const [stock] = await sql`select count(*)::int as n from public.stock_movement`;
    const [payroll] = await sql`
      select count(*) filter (where status = 'finalized')::int as finalized,
             count(*)::int as total
      from public.pay_run`;
    console.log(`\n## other subledgers`);
    console.log(`stock_movements=${stock!.n}`);
    console.log(`pay_runs total=${payroll!.total} finalized=${payroll!.finalized}`);

    // The named exception. Read-only; never repaired, never posted.
    const po002 = await sql`
      select po.reference, o.name as org_name,
             (select coalesce(sum(l.qty), 0) from public.purchase_order_line l
              where l.po_id = po.id and l.org_id = po.org_id)::numeric as ordered,
             (select coalesce(sum(grl.accepted_qty), 0)
              from public.goods_receipt g
              join public.goods_receipt_line grl on grl.grn_id = g.id and grl.org_id = g.org_id
              where g.po_id = po.id and g.org_id = po.org_id
                and g.status = 'recorded')::numeric as received
      from public.purchase_order po
      join public.org o on o.id = po.org_id
      where po.reference = 'PO-002'`;
    console.log("\n## PO-002 (named reconciliation exception — untouched)");
    for (const r of po002) {
      console.log(`org="${r.org_name}" ordered=${r.ordered} received=${r.received}`);
    }

    // The new ledger's production state — must be EMPTY before any go-live.
    // Before migrations 0100+ are applied, the tables simply do not exist yet.
    const [ledgerExists] = await sql`
      select to_regclass('public.journal_entry') is not null as present`;
    console.log("\n## new ledger (production)");
    if (!ledgerExists!.present) {
      console.log("not installed yet (migrations 0100+ pending) — no financial history exists");
    } else {
      const finance = await sql`
        select
          (select count(*)::int from public.journal_entry) as journal_entries,
          (select count(*)::int from public.gl_account) as gl_accounts,
          (select count(*)::int from public.app_settings where key = 'config.finance') as orgs_with_books`;
      const f = finance[0]!;
      console.log(
        `journal_entries=${f.journal_entries} gl_accounts=${f.gl_accounts} orgs_with_books=${f.orgs_with_books}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
