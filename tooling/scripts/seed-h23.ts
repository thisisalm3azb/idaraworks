/**
 * Bleed-harness seeders for the H23 people/time/leave/payroll/claims tables.
 *
 * Split out of seed-two-orgs.ts for size; same contract — ONE seeder per
 * org-scoped table, writing via the OWNER connection so both orgs get real
 * rows. Chains build their own dependencies (an employee, a pay run) inline,
 * because each seeder must stand alone.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

/** The row most HR tables hang off. */
async function seedEmployeeRow(o: Owner, org: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.employee (id, org_id, name) values (${id}, ${org}, 'Bleed HR employee')`;
  return id;
}

async function seedLeaveTypeRow(o: Owner, org: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.leave_type (id, org_id, key, label)
          values (${id}, ${org}, ${"bl_" + randomUUID().slice(0, 8).replace(/-/g, "")},
                  '{"en":"Bleed leave","ar":"إجازة"}'::jsonb)`;
  return id;
}

/** pay_group → pay_period → pay_run, returned for the line/slip seeders. */
async function seedPayRunChain(o: Owner, org: string, u: string) {
  const group = randomUUID();
  const period = randomUUID();
  const run = randomUUID();
  await o`insert into public.pay_group (id, org_id, name_en) values (${group}, ${org}, 'Bleed group')`;
  await o`insert into public.pay_period (id, org_id, pay_group_id, period_start, period_end)
          values (${period}, ${org}, ${group}, '2031-01-01', '2031-01-31')`;
  await o`insert into public.pay_run
            (id, org_id, pay_group_id, period_id, reference, pack_version, currency, created_by)
          values (${run}, ${org}, ${group}, ${period}, ${"BLPAY-" + randomUUID().slice(0, 8)},
                  'core-unpacked', 'AED', ${u})`;
  return { group, period, run };
}

export const H23_SEEDERS: Record<string, Seeder> = {
  department: async (o, org) => {
    await o`insert into public.department (org_id, name_en) values (${org}, 'Bleed dept')`;
  },
  position: async (o, org) => {
    await o`insert into public.position (org_id, name_en) values (${org}, 'Bleed position')`;
  },
  work_location: async (o, org) => {
    await o`insert into public.work_location (org_id, name_en) values (${org}, 'Bleed site')`;
  },
  employee_event: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_event (org_id, employee_id, event, created_by)
            values (${org}, ${emp}, 'created', ${u})`;
  },
  employee_contract: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_contract
              (org_id, employee_id, contract_no, start_date, created_by)
            values (${org}, ${emp}, ${"BLC-" + randomUUID().slice(0, 8)}, '2031-01-01', ${u})`;
  },
  employee_compensation: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_compensation
              (org_id, employee_id, effective_date, salary_minor, hourly_cost_minor, created_by)
            values (${org}, ${emp}, '2031-01-01', 100000, 500, ${u})`;
  },
  employee_payment_instruction: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_payment_instruction (org_id, employee_id, created_by)
            values (${org}, ${emp}, ${u})`;
  },
  employee_field_def: async (o, org) => {
    await o`insert into public.employee_field_def (org_id, key, label)
            values (${org}, ${"bl_" + randomUUID().slice(0, 8).replace(/-/g, "")},
                    '{"en":"Bleed field","ar":"حقل"}'::jsonb)`;
  },
  employee_field_value: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const field = randomUUID();
    await o`insert into public.employee_field_def (id, org_id, key, label)
            values (${field}, ${org}, ${"blv_" + randomUUID().slice(0, 8).replace(/-/g, "")},
                    '{"en":"Bleed field","ar":"حقل"}'::jsonb)`;
    await o`insert into public.employee_field_value (org_id, employee_id, field_id, value, updated_by)
            values (${org}, ${emp}, ${field}, '"x"'::jsonb, ${u})`;
  },
  employee_document: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_document (org_id, employee_id, doc_type, title, created_by)
            values (${org}, ${emp}, 'other', 'Bleed document', ${u})`;
  },
  employee_document_access: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const doc = randomUUID();
    await o`insert into public.employee_document (id, org_id, employee_id, doc_type, title, created_by)
            values (${doc}, ${org}, ${emp}, 'other', 'Bleed doc for log', ${u})`;
    await o`insert into public.employee_document_access (org_id, document_id, action, user_id)
            values (${org}, ${doc}, 'view', ${u})`;
  },
  disciplinary_record: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.disciplinary_record
              (org_id, employee_id, kind, occurred_on, summary, created_by)
            values (${org}, ${emp}, 'note', '2031-01-01', 'Bleed note', ${u})`;
  },
  manager_delegation: async (o, org, u) => {
    const a = await seedEmployeeRow(o, org);
    const b = await seedEmployeeRow(o, org);
    await o`insert into public.manager_delegation
              (org_id, from_employee_id, to_employee_id, starts_on, ends_on, created_by)
            values (${org}, ${a}, ${b}, '2031-01-01', '2031-01-10', ${u})`;
  },
  job_requisition: async (o, org, u) => {
    await o`insert into public.job_requisition (org_id, reference, title, created_by)
            values (${org}, ${"BLR-" + randomUUID().slice(0, 8)}, 'Bleed requisition', ${u})`;
  },
  candidate: async (o, org, u) => {
    const req = randomUUID();
    await o`insert into public.job_requisition (id, org_id, reference, title, created_by)
            values (${req}, ${org}, ${"BLRC-" + randomUUID().slice(0, 8)}, 'Bleed req', ${u})`;
    await o`insert into public.candidate (org_id, requisition_id, name, created_by)
            values (${org}, ${req}, 'Bleed Candidate', ${u})`;
  },
  candidate_interview: async (o, org, u) => {
    const req = randomUUID();
    const cand = randomUUID();
    await o`insert into public.job_requisition (id, org_id, reference, title, created_by)
            values (${req}, ${org}, ${"BLRI-" + randomUUID().slice(0, 8)}, 'Bleed req', ${u})`;
    await o`insert into public.candidate (id, org_id, requisition_id, name, created_by)
            values (${cand}, ${org}, ${req}, 'Bleed Interviewee', ${u})`;
    await o`insert into public.candidate_interview (org_id, candidate_id, scheduled_at, created_by)
            values (${org}, ${cand}, now(), ${u})`;
  },
  candidate_offer: async (o, org, u) => {
    const req = randomUUID();
    const cand = randomUUID();
    await o`insert into public.job_requisition (id, org_id, reference, title, created_by)
            values (${req}, ${org}, ${"BLRO-" + randomUUID().slice(0, 8)}, 'Bleed req', ${u})`;
    await o`insert into public.candidate (id, org_id, requisition_id, name, created_by)
            values (${cand}, ${org}, ${req}, 'Bleed Offeree', ${u})`;
    await o`insert into public.candidate_offer (org_id, candidate_id, salary_minor, start_date, created_by)
            values (${org}, ${cand}, 100000, '2031-02-01', ${u})`;
  },
  offboarding_item: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.offboarding_item (org_id, employee_id, kind, title, created_by)
            values (${org}, ${emp}, 'other', 'Bleed handover', ${u})`;
  },
  final_settlement_input: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.final_settlement_input (org_id, employee_id, kind, label, created_by)
            values (${org}, ${emp}, 'note', 'Bleed input', ${u})`;
  },
  work_pattern: async (o, org) => {
    await o`insert into public.work_pattern (org_id, name_en) values (${org}, 'Bleed pattern')`;
  },
  shift: async (o, org) => {
    await o`insert into public.shift (org_id, name_en, starts_at, ends_at)
            values (${org}, 'Bleed shift', '08:00', '17:00')`;
  },
  schedule_assignment: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const pattern = randomUUID();
    await o`insert into public.work_pattern (id, org_id, name_en)
            values (${pattern}, ${org}, 'Bleed assigned pattern')`;
    await o`insert into public.schedule_assignment
              (org_id, employee_id, pattern_id, starts_on, created_by)
            values (${org}, ${emp}, ${pattern}, '2031-01-01', ${u})`;
  },
  attendance_event: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.attendance_event (org_id, employee_id, kind, work_date, recorded_by)
            values (${org}, ${emp}, 'in', '2031-01-05', ${u})`;
  },
  attendance_correction: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.attendance_correction
              (org_id, employee_id, attendance_date, requested_status, reason, created_by)
            values (${org}, ${emp}, '2031-01-05', 'present', 'Bleed correction', ${u})`;
  },
  overtime_request: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.overtime_request
              (org_id, employee_id, work_date, minutes, reason, created_by)
            values (${org}, ${emp}, '2031-01-05', 60, 'Bleed overtime', ${u})`;
  },
  leave_type: async (o, org) => {
    await seedLeaveTypeRow(o, org);
  },
  leave_policy: async (o, org, u) => {
    const lt = await seedLeaveTypeRow(o, org);
    await o`insert into public.leave_policy (org_id, leave_type_id, version, created_by)
            values (${org}, ${lt}, 1, ${u})`;
  },
  leave_ledger: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const lt = await seedLeaveTypeRow(o, org);
    await o`insert into public.leave_ledger (org_id, employee_id, leave_type_id, kind, days, created_by)
            values (${org}, ${emp}, ${lt}, 'opening', 10, ${u})`;
  },
  leave_request: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const lt = await seedLeaveTypeRow(o, org);
    await o`insert into public.leave_request
              (org_id, employee_id, leave_type_id, start_date, end_date, days, created_by)
            values (${org}, ${emp}, ${lt}, '2031-03-02', '2031-03-03', 2, ${u})`;
  },
  pay_group: async (o, org) => {
    await o`insert into public.pay_group (org_id, name_en) values (${org}, 'Bleed lone group')`;
  },
  pay_period: async (o, org, u) => {
    await seedPayRunChain(o, org, u); // creates group + period (+ a run, harmless)
  },
  pay_component_def: async (o, org) => {
    await o`insert into public.pay_component_def (org_id, key, label, kind)
            values (${org}, ${"bl_" + randomUUID().slice(0, 8).replace(/-/g, "")},
                    '{"en":"Bleed allowance","ar":"بدل"}'::jsonb, 'earning')`;
  },
  employee_pay_component: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const comp = randomUUID();
    await o`insert into public.pay_component_def (id, org_id, key, label, kind)
            values (${comp}, ${org}, ${"ble_" + randomUUID().slice(0, 8).replace(/-/g, "")},
                    '{"en":"Bleed comp","ar":"بدل"}'::jsonb, 'earning')`;
    await o`insert into public.employee_pay_component
              (org_id, employee_id, component_id, effective_from, amount_minor, created_by)
            values (${org}, ${emp}, ${comp}, '2031-01-01', 5000, ${u})`;
  },
  employee_loan: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.employee_loan
              (org_id, employee_id, reference, principal_minor, installment_minor, starts_on, created_by)
            values (${org}, ${emp}, ${"BLL-" + randomUUID().slice(0, 8)}, 10000, 1000, '2031-01-01', ${u})`;
  },
  loan_repayment: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const loan = randomUUID();
    await o`insert into public.employee_loan
              (id, org_id, employee_id, reference, principal_minor, installment_minor, starts_on, created_by)
            values (${loan}, ${org}, ${emp}, ${"BLLR-" + randomUUID().slice(0, 8)}, 10000, 1000,
                    '2031-01-01', ${u})`;
    await o`insert into public.loan_repayment (org_id, loan_id, amount_minor)
            values (${org}, ${loan}, 1000)`;
  },
  payroll_adjustment: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.payroll_adjustment
              (org_id, employee_id, kind, label, amount_minor, reason, created_by)
            values (${org}, ${emp}, 'earning', 'Bleed adj', 500, 'bleed fixture', ${u})`;
  },
  pay_run: async (o, org, u) => {
    await seedPayRunChain(o, org, u);
  },
  pay_run_line: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const { run } = await seedPayRunChain(o, org, u);
    await o`insert into public.pay_run_line
              (org_id, pay_run_id, employee_id, snapshot, gross_minor, net_minor)
            values (${org}, ${run}, ${emp}, '{}'::jsonb, 1000, 1000)`;
  },
  payslip: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const { run } = await seedPayRunChain(o, org, u);
    const line = randomUUID();
    await o`insert into public.pay_run_line
              (id, org_id, pay_run_id, employee_id, snapshot, gross_minor, net_minor)
            values (${line}, ${org}, ${run}, ${emp}, '{}'::jsonb, 1000, 1000)`;
    await o`insert into public.payslip
              (org_id, pay_run_id, pay_run_line_id, employee_id, slip_no, issuer_snapshot,
               snapshot, net_minor, currency, period_start, period_end, issued_by)
            values (${org}, ${run}, ${line}, ${emp}, ${"BLS-" + randomUUID().slice(0, 8)},
                    '{}'::jsonb, '{}'::jsonb, 1000, 'AED', '2031-01-01', '2031-01-31', ${u})`;
  },
  payout_batch: async (o, org, u) => {
    await o`insert into public.payout_batch (org_id, reference, amount_minor, currency, created_by)
            values (${org}, ${"BLB-" + randomUUID().slice(0, 8)}, 1000, 'AED', ${u})`;
  },
  expense_claim: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.expense_claim
              (org_id, employee_id, reference, title, currency, base_currency, created_by)
            values (${org}, ${emp}, ${"BLCL-" + randomUUID().slice(0, 8)}, 'Bleed claim',
                    'AED', 'AED', ${u})`;
  },
  expense_claim_line: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    const claim = randomUUID();
    await o`insert into public.expense_claim
              (id, org_id, employee_id, reference, title, currency, base_currency, created_by)
            values (${claim}, ${org}, ${emp}, ${"BLCC-" + randomUUID().slice(0, 8)}, 'Bleed claim',
                    'AED', 'AED', ${u})`;
    await o`insert into public.expense_claim_line
              (org_id, claim_id, expense_date, category_key, description, amount_minor)
            values (${org}, ${claim}, '2031-01-05', 'general', 'Bleed line', 900)`;
  },
  mileage_rate: async (o, org, u) => {
    await o`insert into public.mileage_rate (org_id, rate_minor_per_km, effective_from, created_by)
            values (${org}, 100, '2031-01-01', ${u})`;
  },
  cash_advance: async (o, org, u) => {
    const emp = await seedEmployeeRow(o, org);
    await o`insert into public.cash_advance
              (org_id, employee_id, reference, amount_minor, purpose, created_by)
            values (${org}, ${emp}, ${"BLA-" + randomUUID().slice(0, 8)}, 2000, 'Bleed float', ${u})`;
  },
};
