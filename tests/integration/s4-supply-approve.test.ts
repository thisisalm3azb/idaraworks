/**
 * S4 "Supply & Approve" integration (doc 11 DoD; doc 05 invariants). Real DB.
 * Proves: threshold routing (over→owner, under→manager); the SOLE-WRITER contract
 * (decide advances BOTH the approval AND the subject atomically; no decided
 * subject without a decided approval); the self-approval guard (F-4 — requester
 * can't decide own; terminal owner self-approval stamped); MR→PO auto-approve;
 * MR-less PO routes; GRN partial-receipt reconciliation + over-receipt rejection +
 * cancel-revert; reject-needs-reason; withdraw-reverts; rule-ambiguity rejection;
 * cost redaction (foreman sees no money).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { ForbiddenError } from "@/platform/authz";
import { createJobFromPreset, addCrewMember } from "@/modules/jobs/service";
import { createEmployee } from "@/modules/masters/service";
import {
  createApprovalRule,
  decideApproval,
  withdrawApproval,
  listInbox,
  getApproval,
  evaluateStuckApprovals,
  SelfApprovalError,
  ApprovalStateError,
  RuleValidationError,
} from "@/modules/approvals/service";
import { buildLpoForPo } from "@/workers/functions/lpo-pdf";
import {
  createMaterialRequest,
  submitMaterialRequest,
  convertMrToPo,
  createPurchaseOrder,
  submitPurchaseOrder,
  recordGoodsReceipt,
  cancelGoodsReceipt,
  getPurchaseOrder,
  getMaterialRequest,
  listMaterialRequests,
  SupplyStateError,
} from "@/modules/supply/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const managerUser = randomUUID();
const manager2User = randomUUID();
const procUser = randomUUID();
const foremanUser = randomUUID();
let orgId = "";
let jobId = "";
let jobOther = "";
let supplierId = "";
let itemId = "";
const THRESHOLD = 500_000; // 5000 AED

const ctxOf = (userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s4-test",
});
const ownerCtx = () => ctxOf(ownerUser, true);
const managerCtx = () => ctxOf(managerUser, false);
const procCtx = () => ctxOf(procUser, false);
const foremanCtx = () => ctxOf(foremanUser, false);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s4-${label}-${run}@example.com`}, '{"full_name":"S4 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  for (const [id, l] of [
    [ownerUser, "owner"],
    [managerUser, "mgr"],
    [manager2User, "mgr2"],
    [procUser, "proc"],
    [foremanUser, "fore"],
  ] as const) {
    await seedUser(id, l);
  }
  orgId = await createOrgForUser(ownerUser, { name: "S4 Org", country: "AE", baseCurrency: "AED" });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${manager2User}, ${orgId}, 'manager')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${procUser}, ${orgId}, 'procurement')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${foremanUser}, ${orgId}, 'foreman')`;
  const installed = await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);

  // Approval rules: MR over threshold → owner, else → manager; MR-less PO → owner.
  await createApprovalRule(ownerCtx(), "owner", {
    subjectType: "material_request",
    conditionKind: "always",
    assignedRole: "manager",
  });
  await createApprovalRule(ownerCtx(), "owner", {
    subjectType: "material_request",
    conditionKind: "amount_gte",
    amountGteMinor: THRESHOLD,
    assignedRole: "owner",
  });
  await createApprovalRule(ownerCtx(), "owner", {
    subjectType: "purchase_order",
    conditionKind: "always",
    assignedRole: "owner",
  });

  const foremanEmp = (
    await createEmployee(ownerCtx(), "owner", { name: "Foreman Emp", userId: foremanUser })
  ).id;
  supplierId = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${supplierId}, ${orgId}, 'مورد التجربة')`;
  itemId = randomUUID();
  await owner`insert into public.item (id, org_id, sku, name, category_key, unit, unit_cost_minor, active)
              values (${itemId}, ${orgId}, ${`ITM-${run}`}, 'Epoxy Resin', 'raw_material', 'L', 5000, true)`;
  jobId = (
    await createJobFromPreset(ownerCtx(), "owner", {
      presetId: installed.presetIds["13S"]!,
      name: "Assigned",
    })
  ).id;
  jobOther = (
    await createJobFromPreset(ownerCtx(), "owner", {
      presetId: installed.presetIds["13S"]!,
      name: "Other",
    })
  ).id;
  await addCrewMember(ownerCtx(), "owner", jobId, foremanEmp);
}, 240_000);

afterAll(async () => {
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of [
    "goods_receipt_line",
    "goods_receipt",
    "purchase_order_line",
    "purchase_order",
    "material_request_line",
    "material_request",
    "approval",
    "approval_rule",
    "report_labour_cost",
    "report_labour_line",
    "report_material_line",
    "report_work_line",
    "daily_report",
    "attendance",
    "issue",
    "domain_event",
    "notification",
    "notification_preference",
    "task",
    "job_crew",
    "job_stage",
    "job",
    "employee_terms",
    "employee_hr",
    "employee",
    "team",
    "item",
    "customer",
    "supplier",
    "job_preset",
    "reference_sequence",
    "org_holiday_calendar",
    "config_revision",
    "org_entitlement_override",
    "comment",
    "audit_log",
    "activity",
    "app_settings",
    "sign_in_log",
    "org_plan_state",
    "membership",
    "role_definition",
    "company",
  ]) {
    await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  }
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = any(${[ownerUser, managerUser, manager2User, procUser, foremanUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, managerUser, manager2User, procUser, foremanUser]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

async function subjectStatus(table: string, id: string): Promise<string> {
  const rows = (await owner.unsafe(`select status from public.${table} where id = $1`, [
    id,
  ])) as unknown as Array<{
    status: string;
  }>;
  return rows[0]!.status;
}
async function approvalState(subjectId: string): Promise<string | null> {
  const rows =
    (await owner`select state from public.approval where subject_id = ${subjectId} order by created_at desc limit 1`) as unknown as Array<{
      state: string;
    }>;
  return rows.length ? rows[0]!.state : null;
}

describe("threshold routing + sole-writer", () => {
  it("MR under threshold routes to manager; decide advances BOTH records", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      jobId,
      lines: [{ itemName: "Resin", qty: 2, unit: "L", estUnitCostMinor: 50_000 }], // 100k < threshold
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    const appr = await getApproval(managerCtx(), "manager", approvalId);
    expect(appr!.assignedRole).toBe("manager");
    expect(appr!.state).toBe("pending");
    // Manager (rule-scoped) sees it in the inbox with the amount (po.view holder).
    const inbox = await listInbox(managerCtx(), "manager");
    expect(inbox.some((r) => r.id === approvalId && r.amountMinor === "100000")).toBe(true);

    await decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" });
    expect(await subjectStatus("material_request", id)).toBe("approved");
    expect(await approvalState(id)).toBe("approved");
  });

  it("MR over threshold routes to owner", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "Big", qty: 1, unit: "ea", estUnitCostMinor: 800_000 }], // > threshold
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    const appr = await getApproval(ownerCtx(), "owner", approvalId);
    expect(appr!.assignedRole).toBe("owner");
    // A manager may NOT decide an owner-routed approval (rule-scope).
    await expect(
      decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    expect(await subjectStatus("material_request", id)).toBe("approved");
  });
});

describe("self-approval guard (F-4)", () => {
  it("a requester (manager) cannot decide their own; another manager can", async () => {
    const { id } = await createMaterialRequest(managerCtx(), "manager", {
      lines: [{ itemName: "x", qty: 1, unit: "ea", estUnitCostMinor: 10_000 }],
    });
    const { approvalId } = await submitMaterialRequest(managerCtx(), "manager", id);
    // assigned to manager; two managers exist so NO escalation.
    expect((await getApproval(ownerCtx(), "owner", approvalId))!.assignedRole).toBe("manager");
    await expect(
      decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" }),
    ).rejects.toBeInstanceOf(SelfApprovalError);
    await decideApproval(ctxOf(manager2User, false), "manager", {
      approvalId,
      decision: "approved",
    });
    expect(await subjectStatus("material_request", id)).toBe("approved");
  });

  it("terminal owner self-approval is permitted and stamped", async () => {
    const { id } = await createMaterialRequest(ownerCtx(), "owner", {
      lines: [{ itemName: "big", qty: 1, unit: "ea", estUnitCostMinor: 900_000 }], // → owner
    });
    const { approvalId } = await submitMaterialRequest(ownerCtx(), "owner", id);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const appr = await getApproval(ownerCtx(), "owner", approvalId);
    expect(appr!.state).toBe("approved");
    expect(appr!.selfApproved).toBe(true);
  });
});

describe("MR → PO conversion + MR-less PO", () => {
  it("converting an approved MR auto-approves its PO", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "Resin", qty: 4, unit: "L", estUnitCostMinor: 50_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    await decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" });
    const { poId, reference } = await convertMrToPo(procCtx(), "procurement", id, {
      supplierId,
      vatMinor: 0,
    });
    expect(reference).toMatch(/^PO-\d{3}$/);
    expect(await subjectStatus("material_request", id)).toBe("converted");
    expect(await subjectStatus("purchase_order", poId)).toBe("approved");
  });

  it("an MR-less PO enters the approval registry (F-3)", async () => {
    const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
      supplierId,
      lines: [{ itemName: "Direct", qty: 2, unit: "ea", unitCostMinor: 30_000 }],
    });
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    expect((await getApproval(ownerCtx(), "owner", approvalId))!.assignedRole).toBe("owner");
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    expect(await subjectStatus("purchase_order", poId)).toBe("approved");
  });
});

describe("goods receipts — partial reconciliation", () => {
  let poId = "";
  let poLineId = "";
  beforeAll(async () => {
    poId = (
      await createPurchaseOrder(procCtx(), "procurement", {
        supplierId,
        lines: [{ itemName: "Bulk", qty: 10, unit: "ea", unitCostMinor: 10_000 }],
      })
    ).id;
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const po = await getPurchaseOrder(procCtx(), "procurement", poId);
    poLineId = po!.lines[0]!.id;
  });

  it("partial then full receipt reconciles PO status; over-receipt rejected", async () => {
    await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-07-13",
      lines: [{ poLineId, receivedQty: 4 }],
    });
    expect(await subjectStatus("purchase_order", poId)).toBe("partially_received");
    // Over-receipt (4 already + 8 = 12 > 10) is rejected.
    await expect(
      recordGoodsReceipt(procCtx(), "procurement", {
        poId,
        receivedDate: "2026-07-13",
        lines: [{ poLineId, receivedQty: 8 }],
      }),
    ).rejects.toBeInstanceOf(SupplyStateError);
    const grn2 = await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-07-14",
      lines: [{ poLineId, receivedQty: 6 }],
    });
    expect(await subjectStatus("purchase_order", poId)).toBe("received");
    // Cancelling the completing GRN reverts to partially_received.
    await cancelGoodsReceipt(ownerCtx(), "owner", grn2.id);
    expect(await subjectStatus("purchase_order", poId)).toBe("partially_received");
  });
});

describe("reject / withdraw / authz / rules / redaction", () => {
  it("reject requires a reason and notifies (subject → rejected)", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "z", qty: 1, unit: "ea", estUnitCostMinor: 20_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    await expect(
      decideApproval(managerCtx(), "manager", { approvalId, decision: "rejected" }),
    ).rejects.toThrow(/reason/);
    await decideApproval(managerCtx(), "manager", {
      approvalId,
      decision: "rejected",
      note: "not needed",
    });
    expect(await subjectStatus("material_request", id)).toBe("rejected");
  });

  it("requester withdraws a pending approval; subject reverts to draft", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "w", qty: 1, unit: "ea", estUnitCostMinor: 20_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    await withdrawApproval(procCtx(), "procurement", approvalId);
    expect(await approvalState(id)).toBe("withdrawn");
    expect(await subjectStatus("material_request", id)).toBe("draft");
  });

  it("foreman cannot decide, cannot MR an unassigned job; sees no cost", async () => {
    await expect(listInbox(foremanCtx(), "foreman")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createMaterialRequest(foremanCtx(), "foreman", {
        jobId: jobOther,
        lines: [{ itemName: "x", qty: 1, unit: "ea" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Foreman MR on the assigned job, no cost entered; the read redacts totals.
    const mine = await createMaterialRequest(foremanCtx(), "foreman", {
      jobId,
      lines: [{ itemName: "resin", qty: 3, unit: "L" }],
    });
    const detail = await getMaterialRequest(foremanCtx(), "foreman", mine.id);
    expect(detail!.totalMinor).toBeNull();
    expect(detail!.lines[0]!.estUnitCostMinor).toBeNull();
    const list = await listMaterialRequests(foremanCtx(), "foreman");
    expect(list.every((r) => r.totalMinor === null)).toBe(true);
  });

  it("rejects an ambiguous rule set (two 'always' rules)", async () => {
    await expect(
      createApprovalRule(ownerCtx(), "owner", {
        subjectType: "purchase_order",
        conditionKind: "always",
        assignedRole: "admin",
      }),
    ).rejects.toBeInstanceOf(RuleValidationError);
  });

  it("only a pending approval can be decided (double-decide guarded)", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "d", qty: 1, unit: "ea", estUnitCostMinor: 20_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    await decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" });
    await expect(
      decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" }),
    ).rejects.toBeInstanceOf(ApprovalStateError);
  });
});

describe("E-03 stuck-approval evaluator + LPO PDF worker", () => {
  it("E-03 raises exception/raised(approval_stuck) for an aged pending approval", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "stuck", qty: 1, unit: "ea", estUnitCostMinor: 10_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    // Backdate it past the 8h warning threshold.
    await owner`update public.approval set created_at = now() - interval '10 hours' where id = ${approvalId}`;
    const before = (
      await owner`select count(*)::int as n from public.domain_event
        where org_id = ${orgId} and name = 'exception/raised'
          and payload->>'subjectId' = ${approvalId} and payload->>'kind' = 'approval_stuck'`
    )[0] as { n: number };
    expect(before.n).toBe(0);
    const res = await evaluateStuckApprovals(ownerCtx());
    expect(res.raised).toBeGreaterThanOrEqual(1);
    const after = (await owner`select payload->>'severity' as sev from public.domain_event
        where org_id = ${orgId} and name = 'exception/raised'
          and payload->>'subjectId' = ${approvalId} and payload->>'kind' = 'approval_stuck'`) as unknown as Array<{
      sev: string;
    }>;
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after[0]!.sev).toBe("warning");
    // Clean up so it doesn't skew the sole-writer scan (still pending).
    await decideApproval(managerCtx(), "manager", {
      approvalId,
      decision: "rejected",
      note: "cleanup",
    });
  });

  it("the LPO worker builds bilingual HTML for an approved PO", async () => {
    const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
      supplierId,
      lines: [{ itemName: "For PDF", qty: 2, unit: "L", unitCostMinor: 5000 }],
    });
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const res = await buildLpoForPo(ownerCtx(), poId);
    expect(res.outcome).toBe("built");
    if (res.outcome === "built") expect(res.htmlChars).toBeGreaterThan(200);
  });
});

describe("concurrency + config guards (review fixes)", () => {
  it("an MR cannot be submitted twice (guarded transition)", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "dup-submit", qty: 1, unit: "ea", estUnitCostMinor: 10_000 }],
    });
    await submitMaterialRequest(procCtx(), "procurement", id);
    await expect(submitMaterialRequest(procCtx(), "procurement", id)).rejects.toBeInstanceOf(
      SupplyStateError,
    );
    // Exactly ONE approval exists for this subject.
    const n = (
      await owner`select count(*)::int as n from public.approval where subject_id = ${id}`
    )[0] as { n: number };
    expect(n.n).toBe(1);
  });

  it("a GRN rejects a duplicate PO line in one batch (no over-receipt)", async () => {
    const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
      supplierId,
      lines: [{ itemName: "dupline", qty: 10, unit: "ea", unitCostMinor: 1000 }],
    });
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const po = await getPurchaseOrder(procCtx(), "procurement", poId);
    const lineId = po!.lines[0]!.id;
    await expect(
      recordGoodsReceipt(procCtx(), "procurement", {
        poId,
        receivedDate: "2026-07-13",
        lines: [
          { poLineId: lineId, receivedQty: 6 },
          { poLineId: lineId, receivedQty: 6 },
        ],
      }),
    ).rejects.toThrow(/more than once/);
  });

  it("an ambiguous rule is rolled back, not left live", async () => {
    // A second 'always' rule for purchase_order (one already seeded) must throw
    // AND not persist (validation is now inside the insert tx).
    const before = (
      await owner`select count(*)::int as n from public.approval_rule
        where org_id = ${orgId} and subject_type = 'purchase_order' and condition_kind = 'always'`
    )[0] as { n: number };
    await expect(
      createApprovalRule(ownerCtx(), "owner", {
        subjectType: "purchase_order",
        conditionKind: "always",
        assignedRole: "admin",
      }),
    ).rejects.toBeInstanceOf(RuleValidationError);
    const after = (
      await owner`select count(*)::int as n from public.approval_rule
        where org_id = ${orgId} and subject_type = 'purchase_order' and condition_kind = 'always'`
    )[0] as { n: number };
    expect(after.n).toBe(before.n); // rolled back — no new row
  });

  it("an approved MR cannot be converted twice (guarded transition)", async () => {
    const { id } = await createMaterialRequest(procCtx(), "procurement", {
      lines: [{ itemName: "dup-convert", qty: 1, unit: "ea", estUnitCostMinor: 10_000 }],
    });
    const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", id);
    await decideApproval(managerCtx(), "manager", { approvalId, decision: "approved" });
    await convertMrToPo(procCtx(), "procurement", id, { supplierId });
    await expect(
      convertMrToPo(procCtx(), "procurement", id, { supplierId }),
    ).rejects.toBeInstanceOf(SupplyStateError);
    // Exactly ONE PO from this MR.
    const n = (
      await owner`select count(*)::int as n from public.purchase_order where mr_id = ${id}`
    )[0] as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("sole-writer invariant (doc 05)", () => {
  it("no MR/PO in a decided-implying state lacks a matching decided approval", async () => {
    const orphans = await owner`
      select mr.id from public.material_request mr
      where mr.org_id = ${orgId} and mr.status in ('approved', 'rejected', 'converted')
        and not exists (
          select 1 from public.approval a
          where a.org_id = mr.org_id and a.subject_type = 'material_request'
            and a.subject_id = mr.id and a.state in ('approved', 'rejected')
        )`;
    expect(orphans.length).toBe(0);
    const poOrphans = await owner`
      select po.id from public.purchase_order po
      where po.org_id = ${orgId} and po.status in ('approved', 'sent', 'partially_received', 'received')
        and not exists (
          select 1 from public.approval a
          where a.org_id = po.org_id and a.subject_type = 'purchase_order'
            and a.subject_id = po.id and a.state = 'approved'
        )`;
    expect(poOrphans.length).toBe(0);
  });
});
