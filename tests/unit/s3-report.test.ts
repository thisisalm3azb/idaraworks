/**
 * S3 "Report: the heartbeat" unit coverage (doc 11 testing):
 *  - the per-archetype permission snapshot for the six S3 actions (doc 06);
 *  - the four new domain-event payloads validate;
 *  - the pure input schemas (report / issue / attendance) enforce their shape.
 * The stateful behaviour (cost freeze, idempotency, review loop, attendance
 * derivation, the cost wall) is proven against a real DB in the integration suite.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { can } from "@/platform/authz";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import {
  DAILY_REPORT_REVIEWED,
  DAILY_REPORT_RETURNED,
  ISSUE_RAISED,
  ISSUE_RESOLVED,
  validateEventPayload,
} from "@/platform/events";
import { SaveReportInput } from "@/modules/reports/service";
import { CreateIssueInput, UpdateIssueStatusInput } from "@/modules/issues/service";
import { MarkAttendanceInput } from "@/modules/attendance/service";

describe("S3 permission snapshot (doc 06 rows 45-47, 61)", () => {
  const EXPECT: Record<string, readonly string[]> = {
    "reports.review": ["owner", "admin", "manager"],
    "reports.backfill": ["owner", "admin"],
    "issues.raise": ["owner", "admin", "manager", "foreman", "procurement", "accounts"],
    "issues.resolve": ["owner", "admin", "manager"],
    "attendance.manage": ["owner", "admin", "manager"],
    "attendance.view": ["owner", "admin", "manager", "accounts", "viewer"],
  };

  for (const [action, allowed] of Object.entries(EXPECT)) {
    it(`${action} is granted to exactly ${allowed.join("/")}`, () => {
      for (const arch of MVP_GRANTABLE_ARCHETYPES) {
        expect(can(arch, action as Parameters<typeof can>[1])).toBe(allowed.includes(arch));
      }
    });
  }

  it("a foreman never gets review/backfill/resolve/attendance", () => {
    for (const a of [
      "reports.review",
      "reports.backfill",
      "issues.resolve",
      "attendance.manage",
      "attendance.view",
    ] as const) {
      expect(can("foreman", a)).toBe(false);
    }
  });
});

describe("S3 event payloads", () => {
  const base = { orgId: randomUUID(), actorUserId: randomUUID() };
  const reportRef = { reportId: randomUUID(), jobId: randomUUID(), reportDate: "2026-07-12" };

  it("daily_report/reviewed validates", () => {
    expect(validateEventPayload(DAILY_REPORT_REVIEWED, { ...base, ...reportRef })).toMatchObject(
      reportRef,
    );
  });
  it("daily_report/returned requires a reason", () => {
    expect(() => validateEventPayload(DAILY_REPORT_RETURNED, { ...base, ...reportRef })).toThrow();
    expect(
      validateEventPayload(DAILY_REPORT_RETURNED, {
        ...base,
        ...reportRef,
        reason: "fix materials",
      }),
    ).toMatchObject({ reason: "fix materials" });
  });
  it("issue/raised carries severity + blocker flag; jobId optional", () => {
    const p = { ...base, issueId: randomUUID(), severity: "high", isBlocker: true };
    expect(validateEventPayload(ISSUE_RAISED, p)).toMatchObject({ isBlocker: true });
    expect(() =>
      validateEventPayload(ISSUE_RAISED, {
        ...base,
        issueId: randomUUID(),
        severity: "nope",
        isBlocker: false,
      }),
    ).toThrow();
  });
  it("issue/resolved validates with optional jobId", () => {
    expect(validateEventPayload(ISSUE_RESOLVED, { ...base, issueId: randomUUID() })).toBeTruthy();
  });
});

describe("S3 input schemas", () => {
  it("SaveReportInput requires an idempotency key ≥ 8 chars", () => {
    const good = {
      jobId: randomUUID(),
      reportDate: "2026-07-12",
      summary: "did work",
      idempotencyKey: "abcd1234",
    };
    expect(SaveReportInput.parse(good).labourLines).toEqual([]);
    expect(() => SaveReportInput.parse({ ...good, idempotencyKey: "short" })).toThrow();
    expect(() => SaveReportInput.parse({ ...good, reportDate: "07/12/2026" })).toThrow();
  });

  it("SaveReportInput parses lines with defaults", () => {
    const parsed = SaveReportInput.parse({
      jobId: randomUUID(),
      reportDate: "2026-07-12",
      summary: "s",
      idempotencyKey: "key12345",
      labourLines: [{ employeeId: randomUUID(), normalHours: 8, otHours: 2 }],
      materialLines: [{ itemName: "resin", qty: 3, unit: "L" }],
    });
    expect(parsed.labourLines).toHaveLength(1);
    expect(parsed.materialLines[0]!.qty).toBe(3);
  });

  it("CreateIssueInput defaults severity=medium, isBlocker=false", () => {
    const p = CreateIssueInput.parse({ title: "crack" });
    expect(p.severity).toBe("medium");
    expect(p.isBlocker).toBe(false);
  });

  it("UpdateIssueStatusInput rejects an unknown status", () => {
    expect(() => UpdateIssueStatusInput.parse({ issueId: randomUUID(), status: "done" })).toThrow();
    expect(UpdateIssueStatusInput.parse({ issueId: randomUUID(), status: "resolved" }).status).toBe(
      "resolved",
    );
  });

  it("MarkAttendanceInput enforces the status enum + date shape", () => {
    const base = { employeeId: randomUUID(), attendanceDate: "2026-07-12", status: "present" };
    expect(MarkAttendanceInput.parse(base).status).toBe("present");
    expect(() => MarkAttendanceInput.parse({ ...base, status: "here" })).toThrow();
    expect(() => MarkAttendanceInput.parse({ ...base, attendanceDate: "today" })).toThrow();
  });
});
