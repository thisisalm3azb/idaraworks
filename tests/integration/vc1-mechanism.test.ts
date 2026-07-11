/**
 * VC-1 mechanism regression (S0 checklist §16 VC-1, doc 10 #1).
 * The same checks as the hosted spike, run against this environment's pooler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runVc1, type Vc1Report } from "../../tooling/vc1/run-vc1";
import { closeAppDb } from "@/platform/tenancy";

let report: Vc1Report;

beforeAll(async () => {
  report = await runVc1();
}, 120_000);

afterAll(async () => {
  await closeAppDb();
});

describe("VC-1: Supavisor transaction-pooler GUC/RLS mechanism", () => {
  const checks = [
    "1 default-deny",
    "2 ctx isolation",
    "3 pooled alternation",
    "4 concurrent interleave",
    "5 cross-org write blocked",
    "6 GUC reset",
  ];
  for (const name of checks) {
    it(name, () => {
      const result = report.results.find((r) => r.check === name);
      expect(result, `check "${name}" did not run`).toBeDefined();
      expect(result!.passed, result!.detail).toBe(true);
    });
  }
});
