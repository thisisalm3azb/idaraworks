"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";
import { resolveFormToken, submitForm } from "@/modules/docstudio/service";

/** Public form submission: the token is the only authority; rate limited per IP. */
export async function submitFormAction(
  token: string,
  lang: string,
  formData: FormData,
): Promise<void> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const gate = await rateLimit("share", ip);
  const resolved = gate.allowed ? await resolveFormToken(token) : null;
  if (!resolved) redirect(`/f/${token}?lang=${lang}&outcome=unavailable`);
  const raw: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("__") || k.startsWith("$")) continue;
    if (typeof v === "string") raw[k] = v;
  }
  try {
    const res = await submitForm(resolved, token, raw, {
      ip: ip || null,
      userAgent: h.get("user-agent"),
      name: String(formData.get("__name") ?? "") || null,
      email: String(formData.get("__email") ?? "") || null,
    });
    if ("problems" in res) {
      const q = new URLSearchParams({
        lang,
        problems: JSON.stringify(res.problems),
        values: JSON.stringify(raw),
      });
      redirect(`/f/${token}?${q.toString()}`);
    }
    redirect(`/f/${token}?lang=${lang}&outcome=submitted`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/f/${token}?lang=${lang}&outcome=unavailable`);
  }
}
