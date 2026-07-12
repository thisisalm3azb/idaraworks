/**
 * Storage schema harness (Phase E): buckets exist per spec, the storage.objects
 * wall exists and is read/insert-only for authenticated, and the DB class map
 * (app.can_access_file_class) is in EXACT parity with the code matrix — every
 * archetype × class × read/write cell compared against can().
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canAccessFileClass } from "@/platform/files";
import { FILE_ACCESS_CLASSES, MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const orgId = randomUUID();
// One synthetic member per archetype (SQL-seeded; no sessions needed here).
const users = Object.fromEntries(MVP_GRANTABLE_ARCHETYPES.map((a) => [a, randomUUID()])) as Record<
  (typeof MVP_GRANTABLE_ARCHETYPES)[number],
  string
>;
const deactivated = randomUUID();

beforeAll(async () => {
  await owner`insert into public.org (id, name, country, base_currency)
    values (${orgId}, 'Storage Harness Org', 'AE', 'AED')`;
  for (const archetype of MVP_GRANTABLE_ARCHETYPES) {
    const priv = archetype === "owner" || archetype === "admin" || archetype === "accounts";
    await owner`insert into public.role_definition (org_id, key, archetype, label, cost_privileged, price_privileged)
      values (${orgId}, ${archetype}, ${archetype}, '{"en":"x"}'::jsonb, ${priv}, ${priv})`;
  }
  for (const [archetype, id] of Object.entries(users)) {
    const email = `sh-${archetype}-${id.slice(0, 8)}@test.local`;
    await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${email}, '{"full_name":"x"}'::jsonb, now(), now())`;
    await owner`insert into public.membership (user_id, org_id, role_key)
      values (${id}, ${orgId}, ${archetype})`;
  }
  // A deactivated admin: must fail every class check.
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${deactivated}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${"sh-deact-" + deactivated.slice(0, 8) + "@test.local"}, '{"full_name":"x"}'::jsonb, now(), now())`;
  await owner`insert into public.membership (user_id, org_id, role_key, deactivated_at)
    values (${deactivated}, ${orgId}, 'admin', now())`;
}, 60_000);

afterAll(async () => {
  await owner`delete from public.membership where org_id = ${orgId}`;
  await owner`delete from public.role_definition where org_id = ${orgId}`;
  await owner`delete from public.org where id = ${orgId}`;
  const ids = [...Object.values(users), deactivated];
  await owner`delete from public.user_profile where id = any(${ids}::uuid[])`;
  await owner`delete from auth.users where id = any(${ids}::uuid[])`;
  await owner.end({ timeout: 5 });
});

describe("buckets (checklist §13)", () => {
  it("tenant-media and tenant-docs exist, private, with caps and image-only mimes", async () => {
    const buckets = await owner`
      select id, public, file_size_limit, allowed_mime_types
      from storage.buckets where id in ('tenant-media', 'tenant-docs')`;
    expect(buckets.map((b) => b.id).sort()).toEqual(["tenant-docs", "tenant-media"]);
    for (const b of buckets) {
      expect(b.public, `${b.id} must be private`).toBe(false);
      expect(Number(b.file_size_limit)).toBe(
        b.id === "tenant-media" ? 15 * 1024 * 1024 : 25 * 1024 * 1024,
      );
      expect(b.allowed_mime_types).toEqual(["image/jpeg", "image/png", "image/webp"]);
    }
  });
});

describe("storage.objects wall", () => {
  it("has exactly the insert + select tenant policies for authenticated, nothing mutable", async () => {
    const policies = await owner`
      select policyname, cmd, roles from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and 'authenticated' = any(roles)`;
    const names = policies.map((p) => p.policyname).sort();
    expect(names).toContain("tenant_objects_insert");
    expect(names).toContain("tenant_objects_select");
    for (const p of policies) {
      expect(["INSERT", "SELECT"], `policy ${p.policyname} must not allow ${p.cmd}`).toContain(
        p.cmd,
      );
    }
  });
});

describe("DB class map ⇔ code mirror parity (every cell, both flag states)", () => {
  it("app.can_access_file_class agrees with canAccessFileClass across archetype × price × class × rw", async () => {
    // Sweep the price_privileged FLAG — the dimension the pre-review test could
    // not see, which hid the CM1 financial_doc read divergence. Both walls must
    // track the flag, not the archetype list.
    for (const archetype of MVP_GRANTABLE_ARCHETYPES) {
      for (const price of [true, false]) {
        await owner`update public.role_definition set price_privileged = ${price}
          where org_id = ${orgId} and key = ${archetype}`;
        for (const cls of FILE_ACCESS_CLASSES) {
          for (const write of [true, false]) {
            const expected = canAccessFileClass(archetype, price, cls, write);
            const [row] = await owner`
              select app.can_access_file_class(${orgId}, ${users[archetype]}, ${cls}, ${write}) as ok`;
            expect(
              row!.ok,
              `${archetype} price=${price} ${write ? "write" : "read"} ${cls}: DB=${row!.ok} code=${expected}`,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it("a deactivated membership fails every class check", async () => {
    for (const cls of FILE_ACCESS_CLASSES) {
      const [r] = await owner`
        select app.can_access_file_class(${orgId}, ${deactivated}, ${cls}, false) as ok`;
      expect(r!.ok).toBe(false);
    }
  });

  it("a non-member fails every class check (cross-tenant)", async () => {
    const stranger = randomUUID();
    const [r] = await owner`
      select app.can_access_file_class(${orgId}, ${stranger}, 'job_media', false) as ok`;
    expect(r!.ok).toBe(false);
  });
});
