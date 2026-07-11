/**
 * Email seam (Phase C: invites). Resend REST when RESEND_API_KEY is set
 * (owner OA-4); otherwise a dev/CI logger sink so flows remain testable
 * without external accounts. No SDK — fetchWithPolicy per BUILD_BIBLE §8.10.
 */
import { fetchWithPolicy } from "@/platform/http/fetchWithPolicy";
import { logger } from "@/platform/logger";

export type Email = { to: string; subject: string; text: string };

export async function sendEmail(email: Email): Promise<{ delivered: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "IdaraWorks <onboarding@resend.dev>";
  if (!apiKey) {
    // Dev sink: never log message bodies at info in prod paths — this branch is
    // dev/CI only and carries the invite link, so it logs at debug.
    logger.debug({ to: email.to, subject: email.subject, text: email.text }, "email (dev sink)");
    return { delivered: false };
  }
  const res = await fetchWithPolicy(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
    },
    { timeoutMs: 10_000 },
  );
  if (!res.ok) {
    throw new Error(`email send failed: ${res.status}`);
  }
  return { delivered: true };
}
