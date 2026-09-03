"use server";

/**
 * H28 — the organisation's AI settings: self-service policy, the privacy
 * register, organisation-supplied provider keys, agent availability,
 * proactive schedules and remembered knowledge. Every action resolves the
 * session and membership first and refuses while the release flag is off.
 * Secrets pass through here once, encrypted server-side, and never return.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ByokUnavailableError,
  recordPrivacyRegister,
  revokeByokKeyIn,
  revokePrivacyRegister,
  setSelfServicePolicy,
  storeByokKeyIn,
} from "@/platform/ai";
import { command } from "@/platform/audit";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import {
  forget,
  remember,
  setAgentState,
  setSchedulePref,
  upsertSchedule,
  SCHEDULE_KINDS,
} from "@/modules/idara/service";

const base = (orgId: string) => `/o/${orgId}/settings/ai`;

async function ctxOrRedirect(orgId: string) {
  if (!idaraEnabled()) redirect("/");
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

function fail(orgId: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  const code =
    err instanceof ForbiddenError
      ? "forbidden"
      : err instanceof ByokUnavailableError
        ? "byok_unavailable"
        : err instanceof z.ZodError
          ? "invalid"
          : "failed";
  redirect(`${base(orgId)}?error=${code}`);
}

const on = (fd: FormData, k: string) => fd.get(k) === "on";
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

export async function savePolicyAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    const domains = fd.getAll("restricted").map(String);
    const perUser = str(fd, "perUserDailyCredits");
    await setSelfServicePolicy(r.ctx, r.archetype, {
      aiEnabledByOrg: on(fd, "aiEnabled"),
      restrictedDomains: domains,
      perUserDailyCredits: perUser === null ? null : Number(perUser),
      softWarnPct: Number(str(fd, "softWarnPct") ?? 80),
      reason: str(fd, "reason") ?? undefined,
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=policy`);
}

export async function savePrivacyAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await recordPrivacyRegister(r.ctx, r.archetype, {
      providerKey: str(fd, "providerKey"),
      lawfulBasis: str(fd, "lawfulBasis"),
      processorAgreementRef: str(fd, "processorAgreementRef"),
      transferMechanism: str(fd, "transferMechanism"),
      retentionNote: str(fd, "retentionNote") ?? undefined,
      minimisationConfirmed: on(fd, "minimisationConfirmed"),
      ropaRef: str(fd, "ropaRef") ?? undefined,
      dpoChecked: on(fd, "dpoChecked"),
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=privacy`);
}

export async function revokePrivacyAction(orgId: string, providerKey: string): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await revokePrivacyRegister(
      r.ctx,
      r.archetype,
      z.enum(["openai", "anthropic"]).parse(providerKey),
    );
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=privacy_revoked`);
}

export async function storeByokAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    assertCan(r.archetype, "config.manage");
    const providerKey = z.enum(["openai", "anthropic"]).parse(str(fd, "providerKey"));
    const secret = str(fd, "secret");
    if (!secret) throw new z.ZodError([]);
    await command(
      r.ctx,
      {
        audit: {
          action: "idara.byok.store",
          entityType: "ai_byok_key",
          summary: `organisation key stored for ${providerKey} (last4 only recorded)`,
        },
      },
      async (tx) => storeByokKeyIn(tx, r.ctx, providerKey, secret),
    );
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=byok`);
}

export async function revokeByokAction(orgId: string, id: string): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    assertCan(r.archetype, "config.manage");
    await command(
      r.ctx,
      {
        audit: {
          action: "idara.byok.revoke",
          entityType: "ai_byok_key",
          entityId: id,
          summary: "organisation key revoked",
        },
      },
      async (tx) => {
        await revokeByokKeyIn(tx, r.ctx, z.string().uuid().parse(id));
        return null;
      },
    );
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=byok_revoked`);
}

export async function setAgentStateAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await setAgentState(r.ctx, r.archetype, {
      agentId: str(fd, "agentId"),
      enabled: on(fd, "enabled"),
      reason: str(fd, "reason") ?? undefined,
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=agent`);
}

export async function saveScheduleAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await upsertSchedule(r.ctx, r.archetype, {
      kind: z.enum(SCHEDULE_KINDS).parse(str(fd, "kind")),
      cadence: str(fd, "cadence") ?? "daily",
      hourLocal: Number(str(fd, "hourLocal") ?? 8),
      weekday: str(fd, "weekday") === null ? null : Number(str(fd, "weekday")),
      recipients: fd.getAll("recipients").map(String),
      enabled: on(fd, "enabled"),
      dedupWindowHours: Number(str(fd, "dedupWindowHours") ?? 24),
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=schedule`);
}

export async function saveSchedulePrefAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    const snooze = str(fd, "snoozeDays");
    await setSchedulePref(r.ctx, {
      scheduleId: str(fd, "scheduleId"),
      muted: on(fd, "muted"),
      snoozedUntil: snooze
        ? new Date(Date.now() + Number(snooze) * 86_400_000).toISOString()
        : null,
      frequency: str(fd, "frequency") ?? "every",
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=pref`);
}

export async function rememberAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await remember(r.ctx, r.archetype, {
      scope: str(fd, "scope") ?? "user",
      kind: str(fd, "kind") ?? "knowledge",
      key: str(fd, "key"),
      value: str(fd, "value"),
      source: "settings",
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=memory`);
}

export async function forgetAction(orgId: string, id: string): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await forget(r.ctx, r.archetype, z.string().uuid().parse(id));
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=forgotten`);
}
