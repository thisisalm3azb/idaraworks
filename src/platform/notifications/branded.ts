/**
 * Branded transactional email bodies (item 1, 2026-09-20).
 *
 * Every email the app itself sends — invitations, reminders, signature
 * requests — shares one layout: the IdaraWorks wordmark, a heading that says
 * what the message is for, one clear action, and a footer that says how long
 * the link lasts and what to do if it was not expected. The HTML is table-based
 * and inline-styled because that is what mail clients render reliably; the
 * plain-text twin carries the same facts for clients that show text only.
 *
 * Nothing here is user-supplied without escaping: company names and addresses
 * pass through `esc` before they reach the markup.
 *
 * Authentication emails (confirm signup, reset password, magic link) are sent
 * by Supabase Auth from its own templates; the matching branded templates for
 * the dashboard live in docs/EMAIL-TEMPLATES/ and the owner runbook.
 */

export type BrandedEmailInput = {
  /** Two to five words: the reason the email exists. */
  heading: string;
  /** Short paragraphs, each a plain sentence or two. */
  paragraphs: string[];
  action?: { label: string; url: string };
  /** e.g. "This link expires in 7 days." */
  expiry?: string;
  /** e.g. "If you weren't expecting this, you can ignore it." */
  footer?: string;
  /** "ltr" | "rtl" — Arabic bodies render right to left. */
  direction?: "ltr" | "rtl";
};

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BRAND = "#0f766e";
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";

export function brandedEmail(input: BrandedEmailInput): { html: string; text: string } {
  const dir = input.direction ?? "ltr";
  const align = dir === "rtl" ? "right" : "left";
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${INK};text-align:${align}">${esc(p)}</p>`,
    )
    .join("");
  const action = input.action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0"><tr><td style="border-radius:8px;background:${BRAND}">
        <a href="${esc(input.action.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(input.action.label)}</a>
      </td></tr></table>
      <p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all;text-align:${align}">${esc(input.action.url)}</p>`
    : "";
  const expiry = input.expiry
    ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${MUTED};text-align:${align}">${esc(input.expiry)}</p>`
    : "";
  const footer = input.footer
    ? `<p style="margin:0;font-size:13px;line-height:1.5;color:${MUTED};text-align:${align}">${esc(input.footer)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px">
        <tr><td style="padding:22px 28px 6px;border-bottom:1px solid ${LINE}">
          <span style="font-size:16px;font-weight:700;letter-spacing:0.02em;color:${BRAND}">IdaraWorks</span>
        </td></tr>
        <tr><td style="padding:22px 28px 8px">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${INK};text-align:${align}">${esc(input.heading)}</h1>
          ${paragraphs}
          ${action}
          ${expiry}
          ${footer}
        </td></tr>
        <tr><td style="padding:14px 28px 22px;border-top:1px solid ${LINE}">
          <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};text-align:${align}">IdaraWorks · www.idaraworks.com</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    input.heading,
    "",
    ...input.paragraphs,
    ...(input.action ? ["", `${input.action.label}: ${input.action.url}`] : []),
    ...(input.expiry ? ["", input.expiry] : []),
    ...(input.footer ? [input.footer] : []),
    "",
    "IdaraWorks · www.idaraworks.com",
  ].join("\n");

  return { html, text };
}
