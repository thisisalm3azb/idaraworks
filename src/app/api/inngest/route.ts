/**
 * Inngest serve endpoint (S0 checklist §7 item 1). Signature verification is
 * enforced automatically when INNGEST_SIGNING_KEY is set (required in
 * production before pilots — owner item); without it the SDK only accepts
 * dev-mode traffic.
 */
import { serve } from "inngest/next";
import { inngest } from "@/platform/events";
import { workerFunctions } from "@/workers";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: workerFunctions,
});
