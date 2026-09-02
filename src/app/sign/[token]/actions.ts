"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";
import { declineWithToken, resolveSignerToken, signWithToken } from "@/modules/docstudio/service";

/**
 * Public signing actions. The token is the only authority: it is resolved
 * through the SECURITY DEFINER resolver on every call, never trusted from a
 * cookie or a hidden field beyond the URL it arrived in. Rate limited per IP.
 */
async function guard(): Promise<{ ip: string | null; userAgent: string | null } | null> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const gate = await rateLimit("share", ip);
  if (!gate.allowed) return null;
  return { ip: ip || null, userAgent: h.get("user-agent") };
}

export async function signAction(token: string, lang: string, formData: FormData): Promise<void> {
  const info = await guard();
  const resolved = info ? await resolveSignerToken(token) : null;
  if (!info || !resolved) redirect(`/sign/${token}?lang=${lang}&outcome=unavailable`);
  try {
    const kind = String(formData.get("kind") ?? "typed") as "typed" | "drawn";
    const result = await signWithToken(
      resolved,
      {
        kind,
        data: String(formData.get(kind === "drawn" ? "path" : "typed") ?? ""),
        name: String(formData.get("name") ?? ""),
        title: String(formData.get("title") ?? "") || undefined,
        consent: formData.get("consent") === "on" ? true : false,
        locale: lang === "ar" ? "ar" : "en",
      },
      info,
    );
    redirect(`/sign/${token}?lang=${lang}&outcome=${result.completed ? "completed" : "signed"}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const message =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
        : err instanceof Error
          ? err.message
          : "failed";
    redirect(`/sign/${token}?lang=${lang}&error=${encodeURIComponent(message.slice(0, 160))}`);
  }
}

export async function declineAction(
  token: string,
  lang: string,
  formData: FormData,
): Promise<void> {
  const info = await guard();
  const resolved = info ? await resolveSignerToken(token) : null;
  if (!info || !resolved) redirect(`/sign/${token}?lang=${lang}&outcome=unavailable`);
  try {
    await declineWithToken(resolved, { reason: String(formData.get("reason") ?? "") }, info);
    redirect(`/sign/${token}?lang=${lang}&outcome=declined`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const message = err instanceof Error ? err.message : "failed";
    redirect(`/sign/${token}?lang=${lang}&error=${encodeURIComponent(message.slice(0, 160))}`);
  }
}
