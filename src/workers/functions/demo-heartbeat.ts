/**
 * demo.heartbeat consumer (S0 checklist §7.5) — the loop proof. An emitter
 * writes a demo/heartbeat domain_event; the relay publishes it to Inngest; this
 * consumer runs. It proves outbox → relay → Inngest → consumer end-to-end
 * without any feature dependency. Idempotent (a log; no state), org-verified via
 * defineOrgFunction.
 */
import { demoHeartbeatEvent, DemoHeartbeatData } from "@/platform/events";
import { logger } from "@/platform/logger";
import { defineOrgFunction } from "../harness";

export const demoHeartbeat = defineOrgFunction(
  { id: "demo-heartbeat", trigger: demoHeartbeatEvent, schema: DemoHeartbeatData, retries: 1 },
  ({ payload, ctx, runId }) => {
    logger.info(
      { orgId: ctx.orgId, nonce: payload.nonce, runId },
      "demo.heartbeat consumed — outbox→relay→inngest loop OK",
    );
    return Promise.resolve({ ok: true, nonce: payload.nonce });
  },
);
