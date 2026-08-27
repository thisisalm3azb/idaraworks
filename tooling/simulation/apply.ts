/**
 * Applies a built Plan to the database over the owner/superuser (DIRECT_URL)
 * connection. Writes are idempotent (deterministic ids + ON CONFLICT DO UPDATE)
 * and in FK-safe order, with every historical timestamp set explicitly. This
 * module is only ever called AFTER the org's demo marker has been verified
 * (run.ts) — it takes the org id + owner user id as trusted inputs.
 *
 * It never sends anything external: it writes rows directly and does not run the
 * outbox relay, invite flow, or any provider. Cost rollups are refreshed through
 * the real DEFINER function so the costing dashboards reconcile.
 */
import type postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { withCtx, sql } from "@/platform/tenancy";
import type { Plan } from "./types";
import { SimClock } from "./dates";
import { uuidv5 } from "./rng";

type Sql = ReturnType<typeof postgres>;

/** Deterministic uuid for a synthesized child row (report/MR/GRN lines). */
const lid = (name: string): string => uuidv5(name);

export type ApplyTarget = {
  orgId: string;
  ownerUserId: string;
  presetIdByCode: Record<string, string>;
};

export async function applyPlan(
  owner: Sql,
  plan: Plan,
  t: ApplyTarget,
): Promise<Record<string, number>> {
  const org = t.orgId;
  const uid = t.ownerUserId;
  const clock = new SimClock(plan.asOf);
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  await owner.begin(async (tx) => {
    // ── Masters ──────────────────────────────────────────────────────────────
    for (const c of plan.customers) {
      await tx`insert into public.customer (id, org_id, name, country, contact_name, phone, email, tax_reg_no, notes, active, created_at, updated_at)
        values (${c.id}, ${org}, ${c.name}, ${c.country}, ${c.contactName}, ${c.phone}, ${c.email}, ${c.taxRegNo}, ${c.notes}, ${c.active}, ${c.createdAt}, ${c.createdAt})
        on conflict (id) do update set name = excluded.name, contact_name = excluded.contact_name, phone = excluded.phone, notes = excluded.notes, active = excluded.active, updated_at = excluded.updated_at`;
      bump("customers");
    }
    for (const s of plan.suppliers) {
      await tx`insert into public.supplier (id, org_id, name, tax_reg_no, terms_text, phone, email, active, created_at, updated_at)
        values (${s.id}, ${org}, ${s.name}, ${s.taxRegNo}, ${s.termsText}, ${s.phone}, ${s.email}, ${s.active}, ${s.createdAt}, ${s.createdAt})
        on conflict (id) do update set name = excluded.name, terms_text = excluded.terms_text, active = excluded.active, updated_at = excluded.updated_at`;
      bump("suppliers");
    }
    for (const it of plan.items) {
      await tx`insert into public.item (id, org_id, sku, name, category_key, unit, unit_cost_minor, selling_price_minor, active, created_at, updated_at)
        values (${it.id}, ${org}, ${it.sku}, ${it.name}, ${it.categoryKey}, ${it.unit}, ${it.unitCostMinor}, ${it.sellingPriceMinor}, ${it.active}, ${it.createdAt}, ${it.createdAt})
        on conflict (id) do update set name = excluded.name, unit_cost_minor = excluded.unit_cost_minor, selling_price_minor = excluded.selling_price_minor, updated_at = excluded.updated_at`;
      bump("items");
    }
    for (const e of plan.employees) {
      await tx`insert into public.employee (id, org_id, name, phone, active, created_at, updated_at)
        values (${e.id}, ${org}, ${e.name}, ${e.phone}, ${e.active}, ${e.createdAt}, ${e.createdAt})
        on conflict (id) do update set name = excluded.name, active = excluded.active, updated_at = excluded.updated_at`;
      await tx`insert into public.employee_terms (employee_id, org_id, salary_minor, hourly_cost_minor, ot_rate)
        values (${e.id}, ${org}, ${e.salaryMinor}, ${e.hourlyCostMinor}, ${e.otRate})
        on conflict (employee_id) do update set salary_minor = excluded.salary_minor, hourly_cost_minor = excluded.hourly_cost_minor, ot_rate = excluded.ot_rate`;
      bump("employees");
    }

    // ── Jobs + stages + crew ──────────────────────────────────────────────────
    for (const j of plan.jobs) {
      const presetId = t.presetIdByCode[j.presetCode];
      if (!presetId) throw new Error(`no preset id for code ${j.presetCode} (org ${org})`);
      await tx`insert into public.job
        (id, org_id, reference, name, preset_id, customer_id, status_key, status_category,
         start_date, due_date, completed_date, selling_price_minor, payment_terms,
         billing_points, custom_values, current_stage_id, created_by, created_at, updated_at)
        values (${j.id}, ${org}, ${j.reference}, ${j.name}, ${presetId}, ${j.customerId},
                ${j.statusKey}, ${j.statusCategory}, ${j.startDate}, ${j.dueDate}, ${j.completedDate},
                ${j.sellingPriceMinor}, ${j.paymentTerms}, ${JSON.stringify(j.billingPoints)}::jsonb,
                '{}'::jsonb, null, ${uid}, ${j.createdAt}, ${j.updatedAt})
        on conflict (id) do update set status_key = excluded.status_key, status_category = excluded.status_category,
          due_date = excluded.due_date, completed_date = excluded.completed_date,
          selling_price_minor = excluded.selling_price_minor, updated_at = excluded.updated_at`;
      bump("jobs");
      for (const st of j.stages) {
        await tx`insert into public.job_stage (id, org_id, job_id, stage_key, name, weight, sort, status, started_at, completed_at)
          values (${st.id}, ${org}, ${j.id}, ${st.stageKey}, ${JSON.stringify({ en: st.en, ar: st.ar })}::jsonb, ${st.weight}, ${st.sort}, ${st.status}, ${st.startedAt}, ${st.completedAt})
          on conflict (id) do update set status = excluded.status, started_at = excluded.started_at, completed_at = excluded.completed_at`;
        bump("job_stages");
      }
      const cur = j.stages.find((st) => st.stageKey === j.currentStageKey);
      if (cur)
        await tx`update public.job set current_stage_id = ${cur.id} where id = ${j.id} and org_id = ${org}`;
      for (const eid of j.crew) {
        await tx`insert into public.job_crew (org_id, job_id, employee_id, added_by, added_at)
          values (${org}, ${j.id}, ${eid}, ${uid}, ${j.createdAt})
          on conflict (job_id, employee_id) do update set removed_at = null`;
      }
    }

    // ── Daily reports + lines + frozen labour cost + attendance ───────────────
    for (const r of plan.reports) {
      const isBackfill = clock.daysAgoOf(r.reportDate) > 14;
      await tx`insert into public.daily_report
        (id, org_id, job_id, report_date, summary, blockers, next_steps, status,
         submitted_by, submitted_at, reviewed_by, reviewed_at, idempotency_key, is_backfill, created_at, updated_at)
        values (${r.id}, ${org}, ${r.jobId}, ${r.reportDate}, ${r.summary}, ${r.blockers}, ${r.nextSteps}, ${r.status},
                ${uid}, ${r.submittedAt}, ${r.reviewedAt ? uid : null}, ${r.reviewedAt}, ${r.idempotencyKey}, ${isBackfill}, ${r.createdAt}, ${r.createdAt})
        on conflict (id) do update set status = excluded.status, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`;
      bump("reports");
      let sort = 0;
      for (const w of r.workLines) {
        await tx`insert into public.report_work_line (id, org_id, report_id, stage_key, description, progress_note, sort)
          values (${lid(`rwl:${r.id}:${sort}`)}, ${org}, ${r.id}, ${w.stageKey}, ${w.description}, ${w.progressNote}, ${sort})
          on conflict (id) do nothing`;
        sort++;
      }
      sort = 0;
      for (const m of r.materialLines) {
        await tx`insert into public.report_material_line (id, org_id, report_id, item_id, item_name, qty, unit, unit_cost_minor, cost_source, cost_only, sort)
          values (${lid(`rml:${r.id}:${sort}`)}, ${org}, ${r.id}, ${m.itemId}, ${m.itemName}, ${m.qty}, ${m.unit}, ${m.unitCostMinor}, ${m.costSource}, true, ${sort})
          on conflict (id) do nothing`;
        sort++;
      }
      sort = 0;
      for (const l of r.labourLines) {
        await tx`insert into public.report_labour_line (id, org_id, report_id, employee_id, normal_hours, ot_hours, sort)
          values (${lid(`rll:${r.id}:${sort}`)}, ${org}, ${r.id}, ${l.employeeId}, ${l.normalHours}, ${l.otHours}, ${sort})
          on conflict (id) do nothing`;
        await tx`insert into public.report_labour_cost (id, org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor, frozen_at)
          values (${lid(`rlc:${r.id}:${sort}`)}, ${org}, ${r.id}, ${l.employeeId}, ${l.hourlyCostMinor}, ${l.otRate}, ${l.labourCostMinor}, ${r.submittedAt})
          on conflict (report_id, employee_id) do update set labour_cost_minor = excluded.labour_cost_minor`;
        sort++;
      }
    }
    for (const a of plan.attendance) {
      await tx`insert into public.attendance (id, org_id, employee_id, attendance_date, status, source, marked_by, note, created_at, updated_at)
        values (${a.id}, ${org}, ${a.employeeId}, ${a.date}, ${a.status}, ${a.source}, ${a.source === "manual" ? uid : null}, ${a.note}, ${clock.tsAgo(clock.daysAgoOf(a.date), 18)}, ${clock.tsAgo(clock.daysAgoOf(a.date), 18)})
        on conflict (org_id, employee_id, attendance_date) do update set status = excluded.status, source = excluded.source`;
      bump("attendance");
    }

    // ── Issues ────────────────────────────────────────────────────────────────
    for (const i of plan.issues) {
      await tx`insert into public.issue (id, org_id, job_id, title, description, severity, is_blocker, status, raised_by, resolved_by, resolved_at, created_at, updated_at)
        values (${i.id}, ${org}, ${i.jobId}, ${i.title}, ${i.description}, ${i.severity}, ${i.isBlocker}, ${i.status}, ${uid}, ${i.resolvedAt ? uid : null}, ${i.resolvedAt}, ${i.createdAt}, ${i.createdAt})
        on conflict (id) do update set status = excluded.status, resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at`;
      bump("issues");
    }

    // ── Approvals ─────────────────────────────────────────────────────────────
    for (const ar of plan.approvalRules) {
      await tx`insert into public.approval_rule (id, org_id, subject_type, condition_kind, amount_gte_minor, urgency_in, assigned_role, auto_approve_below_minor, active)
        values (${ar.id}, ${org}, ${ar.subjectType}, ${ar.conditionKind}, ${ar.amountGteMinor}, ${ar.urgencyIn}, ${ar.assignedRole}, ${ar.autoApproveBelowMinor}, true)
        on conflict (id) do nothing`;
    }
    for (const ap of plan.approvals) {
      await tx`insert into public.approval (id, org_id, subject_type, subject_id, subject_summary, requested_by, assigned_role, state, decided_by, decided_at, decision_note, self_approved, created_at, updated_at)
        values (${ap.id}, ${org}, ${ap.subjectType}, ${ap.subjectId}, ${JSON.stringify(ap.subjectSummary)}::jsonb, ${uid}, ${ap.assignedRole}, ${ap.state}, ${ap.decidedAt ? uid : null}, ${ap.decidedAt}, ${ap.decisionNote}, ${ap.selfApproved}, ${ap.createdAt}, ${ap.createdAt})
        on conflict (id) do update set state = excluded.state, decided_by = excluded.decided_by, decided_at = excluded.decided_at, decision_note = excluded.decision_note`;
      bump("approvals");
    }

    // ── Supply: material requests → POs → goods receipts ──────────────────────
    for (const mr of plan.materialRequests) {
      await tx`insert into public.material_request (id, org_id, reference, job_id, status, urgency, required_date, total_minor, converted_po_id, created_by, created_at, updated_at)
        values (${mr.id}, ${org}, ${mr.reference}, ${mr.jobId}, ${mr.status}, ${mr.urgency}, ${mr.requiredDate}, ${mr.totalMinor}, ${mr.convertedPoId}, ${uid}, ${mr.createdAt}, ${mr.createdAt})
        on conflict (id) do update set status = excluded.status, converted_po_id = excluded.converted_po_id`;
      bump("material_requests");
      let s2 = 0;
      for (const l of mr.lines) {
        await tx`insert into public.material_request_line (id, org_id, mr_id, item_id, item_name, qty, unit, est_unit_cost_minor, sort)
          values (${lid(`mrl:${mr.id}:${s2}`)}, ${org}, ${mr.id}, ${l.itemId}, ${l.itemName}, ${l.qty}, ${l.unit}, ${l.estUnitCostMinor}, ${s2})
          on conflict (id) do nothing`;
        s2++;
      }
    }
    for (const po of plan.purchaseOrders) {
      await tx`insert into public.purchase_order (id, org_id, reference, supplier_id, job_id, mr_id, status, vat_minor, total_minor, approved_at, created_by, created_at, updated_at)
        values (${po.id}, ${org}, ${po.reference}, ${po.supplierId}, ${po.jobId}, ${po.mrId}, ${po.status}, ${po.vatMinor}, ${po.totalMinor}, ${po.approvedAt}, ${uid}, ${po.createdAt}, ${po.createdAt})
        on conflict (id) do update set status = excluded.status, total_minor = excluded.total_minor, approved_at = excluded.approved_at`;
      bump("purchase_orders");
      for (const l of po.lines) {
        await tx`insert into public.purchase_order_line (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor, line_total_minor, sort)
          values (${l.id}, ${org}, ${po.id}, ${l.itemId}, ${l.itemName}, ${l.qty}, ${l.unit}, ${l.unitCostMinor}, ${l.lineTotalMinor}, ${l.sort})
          on conflict (id) do nothing`;
      }
    }
    for (const grn of plan.goodsReceipts) {
      await tx`insert into public.goods_receipt (id, org_id, reference, po_id, job_id, status, received_date, created_by, created_at, updated_at)
        values (${grn.id}, ${org}, ${grn.reference}, ${grn.poId}, ${grn.jobId}, ${grn.status}, ${grn.receivedDate}, ${uid}, ${grn.createdAt}, ${grn.createdAt})
        on conflict (id) do update set status = excluded.status`;
      bump("goods_receipts");
      let s3 = 0;
      for (const l of grn.lines) {
        await tx`insert into public.goods_receipt_line (id, org_id, grn_id, po_line_id, ordered_qty, previously_received, received_qty, damaged_qty, rejected_qty, sort)
          values (${lid(`grl:${grn.id}:${s3}`)}, ${org}, ${grn.id}, ${l.poLineId}, ${l.orderedQty}, ${l.previouslyReceived}, ${l.receivedQty}, ${l.damagedQty}, ${l.rejectedQty}, ${s3})
          on conflict (id) do nothing`;
        s3++;
      }
    }

    // ── Expenses ──────────────────────────────────────────────────────────────
    for (const ex of plan.expenses) {
      await tx`insert into public.expense (id, org_id, reference, job_id, job_name, category_key, costing_mapping, description, expense_date, amount_minor, vat_amount_minor, total_minor, payment_status, created_by, created_at, updated_at)
        values (${ex.id}, ${org}, ${ex.reference}, ${ex.jobId}, ${ex.jobName}, ${ex.categoryKey}, ${ex.costingMapping}, ${ex.description}, ${ex.expenseDate}, ${ex.amountMinor}, ${ex.vatAmountMinor}, ${ex.totalMinor}, ${ex.paymentStatus}, ${uid}, ${ex.createdAt}, ${ex.createdAt})
        on conflict (id) do update set payment_status = excluded.payment_status`;
      bump("expenses");
    }

    // ── Quotes ────────────────────────────────────────────────────────────────
    for (const q of plan.quotes) {
      const presetId = q.presetCode ? (t.presetIdByCode[q.presetCode] ?? null) : null;
      await tx`insert into public.quote
        (id, org_id, reference, customer_id, customer_name, preset_id, status, currency, exchange_rate,
         subtotal_minor, vat_amount_minor, total_minor, base_total_minor, terms, valid_until,
         accepted_at, accepted_note, rejected_reason, converted_job_id, notes, created_by, created_at, updated_at)
        values (${q.id}, ${org}, ${q.reference}, ${q.customerId}, ${q.customerName}, ${presetId}, ${q.status}, ${q.currency}, ${q.exchangeRate},
                ${q.subtotalMinor}, ${q.vatAmountMinor}, ${q.totalMinor}, ${q.baseTotalMinor}, ${q.terms}, ${q.validUntil},
                ${q.acceptedAt}, ${q.acceptedNote}, ${q.rejectedReason}, ${q.convertedJobId}, ${q.notes}, ${uid}, ${q.createdAt}, ${q.createdAt})
        on conflict (id) do update set status = excluded.status, converted_job_id = excluded.converted_job_id, accepted_at = excluded.accepted_at`;
      bump("quotes");
      for (const l of q.lines) {
        await tx`insert into public.quote_line (id, org_id, quote_id, section_key, item_id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
          values (${l.id}, ${org}, ${q.id}, ${l.sectionKey}, ${l.itemId}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitPriceMinor}, ${l.vatRate}, ${l.lineTotalMinor}, ${l.sort})
          on conflict (id) do nothing`;
      }
    }

    // ── Invoices + credit notes ───────────────────────────────────────────────
    for (const inv of plan.invoices) {
      await tx`insert into public.invoice
        (id, org_id, reference, kind, corrects_invoice_id, customer_id, customer_name, customer_tax_reg_no,
         job_id, quote_id, status, is_export, currency, exchange_rate,
         subtotal_minor, vat_amount_minor, total_minor, base_total_minor,
         issued_at, due_date, cancelled_at, cancel_reason, notes, created_by, created_at, updated_at)
        values (${inv.id}, ${org}, ${inv.reference}, ${inv.kind}, ${inv.correctsInvoiceId}, ${inv.customerId}, ${inv.customerName}, ${inv.customerTaxRegNo},
                ${inv.jobId}, ${inv.quoteId}, ${inv.status}, ${inv.isExport}, ${inv.currency}, ${inv.exchangeRate},
                ${inv.subtotalMinor}, ${inv.vatAmountMinor}, ${inv.totalMinor}, ${inv.baseTotalMinor},
                ${inv.issuedAt}, ${inv.dueDate}, ${inv.cancelledAt}, ${inv.cancelReason}, ${inv.notes}, ${uid}, ${inv.createdAt}, ${inv.createdAt})
        on conflict (id) do update set status = excluded.status, issued_at = excluded.issued_at`;
      bump(inv.kind === "credit_note" ? "credit_notes" : "invoices");
      for (const l of inv.lines) {
        await tx`insert into public.invoice_line (id, org_id, invoice_id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
          values (${l.id}, ${org}, ${inv.id}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitPriceMinor}, ${l.vatRate}, ${l.lineTotalMinor}, ${l.sort})
          on conflict (id) do nothing`;
      }
    }

    // ── Payments + receipts ───────────────────────────────────────────────────
    for (const p of plan.payments) {
      await tx`insert into public.payment
        (id, org_id, reference, invoice_id, customer_id, customer_name, status, method, payment_date,
         amount_minor, currency, exchange_rate, base_amount_minor, idempotency_key, created_by, created_at, updated_at)
        values (${p.id}, ${org}, ${p.reference}, ${p.invoiceId}, ${p.customerId}, ${p.customerName}, ${p.status}, ${p.method}, ${p.paymentDate},
                ${p.amountMinor}, ${p.currency}, ${p.exchangeRate}, ${p.baseAmountMinor}, ${"sim:" + p.id}, ${uid}, ${p.createdAt}, ${p.createdAt})
        on conflict (id) do update set status = excluded.status`;
      bump("payments");
      await tx`insert into public.payment_receipt (id, org_id, payment_id, reference, issued_at, created_at)
        values (${p.receiptId}, ${org}, ${p.id}, ${p.receiptReference}, ${p.createdAt}, ${p.createdAt})
        on conflict (id) do nothing`;
    }

    // ── Activity feed + exceptions ────────────────────────────────────────────
    for (const a of plan.activity) {
      await tx`insert into public.activity (id, org_id, actor_user_id, entity_type, entity_id, verb, summary, created_at)
        values (${a.id}, ${org}, ${uid}, ${a.entityType}, ${a.entityId}, ${a.verb}, ${a.summary}, ${a.createdAt})
        on conflict (id) do nothing`;
      bump("activity");
    }
    for (const ex of plan.exceptions) {
      await tx`insert into public.exception (id, org_id, rule_key, severity, job_id, subject_type, subject_id, audience_roles, dedup_key, raised_at, last_evaluated_at, created_at)
        values (${ex.id}, ${org}, ${ex.ruleKey}, ${ex.severity}, ${ex.subjectId}, ${ex.subjectType}, ${ex.subjectId}, ${ex.audienceRoles}, ${ex.dedupKey}, ${ex.createdAt}, ${ex.createdAt}, ${ex.createdAt})
        on conflict (id) do nothing`;
      bump("exceptions");
    }

    // ── Reference sequences (so in-app records continue the run) ──────────────
    for (const seq of plan.sequences) {
      await tx`insert into public.reference_sequence (org_id, scope_key, next_value)
        values (${org}, ${seq.scopeKey}, ${seq.nextValue})
        on conflict (org_id, scope_key) do update set next_value = greatest(public.reference_sequence.next_value, excluded.next_value)`;
    }
  });

  // ── Cost rollups (real DEFINER; needs the app.org_id GUC → run via withCtx) ─
  const ctx: Ctx = {
    orgId: org,
    userId: uid,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "sim-apply",
  };
  const jobsForCost = plan.jobs.filter(
    (j) => j.statusCategory === "active" || j.statusCategory === "done",
  );
  for (const j of jobsForCost) {
    try {
      await withCtx(ctx, (db) =>
        db.execute(sql`select app.refresh_cost_rollup(${org}::uuid, ${j.id}::uuid, 'ex_vat')`),
      );
      bump("cost_rollups");
    } catch {
      // A job with no cost inputs yet is fine — the rollup simply stays empty.
    }
  }
  return counts;
}
