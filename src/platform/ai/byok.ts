/**
 * H28 — bring-your-own-key storage (ADR-54/61).
 *
 * Keys are encrypted in the application with AES-256-GCM under a server-side
 * key-encryption key (`AI_BYOK_KEK`, base64, 32 bytes). Without that
 * environment secret the feature fails closed: nothing can be saved or
 * decrypted, and the UI says exactly which owner action is missing. The
 * ciphertext columns are unreadable to app_user (column grants); only the
 * gateway reads them through `app.ai_byok_ciphertext` for the current
 * organisation. Nothing ever returns the plaintext to a browser.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";

export const BYOK_OWNER_ACTION =
  "Set AI_BYOK_KEK (a base64-encoded 32-byte key) in the server environment for this deployment. Until then organisation-supplied provider keys cannot be stored or used.";

export class ByokUnavailableError extends Error {
  readonly ownerAction = BYOK_OWNER_ACTION;
  constructor() {
    super("BYOK key encryption is not provisioned");
  }
}

function kek(): Buffer | null {
  const raw = process.env.AI_BYOK_KEK;
  if (!raw) return null;
  try {
    const b = Buffer.from(raw, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export function byokProvisioned(): boolean {
  return kek() !== null;
}

export function encryptSecret(plain: string): { ciphertext: string; iv: string; tag: string } {
  const key = kek();
  if (!key) throw new ByokUnavailableError();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(parts: { ciphertext: string; iv: string; tag: string }): string {
  const key = kek();
  if (!key) throw new ByokUnavailableError();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export type ByokRow = {
  id: string;
  providerKey: string;
  last4: string;
  createdAt: string;
  createdBy: string;
};

export async function listByokKeys(tx: TenantTx, ctx: Ctx): Promise<ByokRow[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, provider_key, last4, created_at::text as created_at, created_by::text as created_by
    from public.ai_byok_key where org_id = ${ctx.orgId} and revoked_at is null
    order by created_at desc limit 50`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    providerKey: String(r.provider_key),
    last4: String(r.last4),
    createdAt: String(r.created_at),
    createdBy: String(r.created_by),
  }));
}

/** Store a key: encrypt, keep last4 only in readable columns, revoke any earlier key for the provider. */
export async function storeByokKeyIn(
  tx: TenantTx,
  ctx: Ctx,
  providerKey: string,
  secret: string,
): Promise<{ id: string; last4: string }> {
  if (!byokProvisioned()) throw new ByokUnavailableError();
  const trimmed = secret.trim();
  if (trimmed.length < 8 || trimmed.length > 512) throw new Error("key length out of range");
  const enc = encryptSecret(trimmed);
  const last4 = trimmed.slice(-4);
  await tx.execute(sql`
    update public.ai_byok_key set revoked_at = now(), revoked_by = ${ctx.userId}
    where org_id = ${ctx.orgId} and provider_key = ${providerKey} and revoked_at is null`);
  const rows = (await tx.execute(sql`
    insert into public.ai_byok_key (org_id, provider_key, key_ciphertext, key_iv, key_tag, last4, created_by)
    values (${ctx.orgId}, ${providerKey}, ${enc.ciphertext}, ${enc.iv}, ${enc.tag}, ${last4}, ${ctx.userId})
    returning id::text as id`)) as unknown as Array<{ id: string }>;
  return { id: rows[0]!.id, last4 };
}

export async function revokeByokKeyIn(tx: TenantTx, ctx: Ctx, id: string): Promise<void> {
  await tx.execute(sql`
    update public.ai_byok_key set revoked_at = now(), revoked_by = ${ctx.userId}
    where id = ${id} and org_id = ${ctx.orgId} and revoked_at is null`);
}

/** The gateway's read: the active key for a provider, decrypted server-side, never logged. */
export async function activeByokSecretIn(
  tx: TenantTx,
  ctx: Ctx,
  providerKey: string,
): Promise<string | null> {
  const ids = (await tx.execute(sql`
    select id::text as id from public.ai_byok_key
    where org_id = ${ctx.orgId} and provider_key = ${providerKey} and revoked_at is null
    order by created_at desc limit 1`)) as unknown as Array<{ id: string }>;
  const id = ids[0]?.id;
  if (!id) return null;
  const parts = (await tx.execute(
    sql`select key_ciphertext, key_iv, key_tag from app.ai_byok_ciphertext(${id}::uuid)`,
  )) as unknown as Array<{
    key_ciphertext: string;
    key_iv: string;
    key_tag: string;
  }>;
  const p = parts[0];
  if (!p) return null;
  return decryptSecret({ ciphertext: p.key_ciphertext, iv: p.key_iv, tag: p.key_tag });
}
