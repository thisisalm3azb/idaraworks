/**
 * Demo company importer — per-family checkpoints, keyed under the demo brand.
 *
 * A checkpoint per (organisation, family) in `app_settings`, mirrored to a
 * local JSON file, exactly as the Pilot Lab does under its own prefix. A
 * family with a checkpoint at this seed version is skipped on the next run,
 * which is what makes an interrupted import resumable and a repeated one
 * idempotent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "../pilot-lab/db";
import type { Brand } from "../pilot-lab/brand";
import type { FamilyReport } from "../pilot-lab/types";
import { LOCAL_DIR } from "./brand";

export type Checkpoint = { seed_version: string; done: true; at: string; report: FamilyReport };

const LOCAL_STATE = join(LOCAL_DIR, "state.json");

export async function getCheckpoint(
  sql: Sql,
  brand: Brand,
  orgId: string,
  family: string,
): Promise<Checkpoint | null> {
  const rows = (await sql`
    select value from public.app_settings
    where org_id = ${orgId} and key = ${brand.checkpointPrefix + family}
  `) as unknown as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  const obj = typeof v === "string" ? (JSON.parse(v) as Checkpoint) : (v as Checkpoint | undefined);
  if (!obj || obj.done !== true) return null;
  if (obj.seed_version !== brand.seedVersion) return null;
  return obj;
}

export async function setCheckpoint(
  sql: Sql,
  brand: Brand,
  orgId: string,
  family: string,
  report: FamilyReport,
  at: string,
): Promise<void> {
  const cp: Checkpoint = { seed_version: brand.seedVersion, done: true, at, report };
  await sql`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${brand.checkpointPrefix + family}, ${sql.json(cp as never)})
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
  `;
  mirrorLocally(orgId, family, cp);
}

type LocalState = Record<string, Record<string, Checkpoint>>;

function readLocal(): LocalState {
  if (!existsSync(LOCAL_STATE)) return {};
  try {
    return JSON.parse(readFileSync(LOCAL_STATE, "utf8")) as LocalState;
  } catch {
    return {};
  }
}

function mirrorLocally(orgId: string, family: string, cp: Checkpoint): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const s = readLocal();
  (s[orgId] ??= {})[family] = cp;
  writeFileSync(LOCAL_STATE, JSON.stringify(s, null, 2));
}

export async function listCheckpoints(
  sql: Sql,
  brand: Brand,
  orgId: string,
): Promise<Record<string, Checkpoint>> {
  const rows = (await sql`
    select key, value from public.app_settings
    where org_id = ${orgId} and key like ${brand.checkpointPrefix + "%"}
  `) as unknown as Array<{ key: string; value: unknown }>;
  const out: Record<string, Checkpoint> = {};
  for (const r of rows) {
    const obj =
      typeof r.value === "string" ? (JSON.parse(r.value) as Checkpoint) : (r.value as Checkpoint);
    if (obj?.done === true && obj.seed_version === brand.seedVersion)
      out[r.key.slice(brand.checkpointPrefix.length)] = obj;
  }
  return out;
}
