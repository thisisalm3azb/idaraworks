/**
 * H33 Pilot Lab — checkpoints, so an interrupted run resumes where it stopped.
 *
 * Kept in two places on purpose. The database copy (`app_settings`, one key per
 * family per organisation) is the truth and survives a different machine; the
 * local mirror under `.pilot-lab/` (gitignored) is what a person reads to see
 * where a run got to without opening a database.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./db";
import { CHECKPOINT_PREFIX, SEED_VERSION } from "./marker";
import type { FamilyReport } from "./types";

export const LOCAL_DIR = ".pilot-lab";
const LOCAL_STATE = join(LOCAL_DIR, "state.json");

export type Checkpoint = { seed_version: string; done: true; at: string; report: FamilyReport };

export async function getCheckpoint(
  sql: Sql,
  orgId: string,
  family: string,
): Promise<Checkpoint | null> {
  const rows = (await sql`
    select value from public.app_settings
    where org_id = ${orgId} and key = ${CHECKPOINT_PREFIX + family}
  `) as unknown as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  const obj = typeof v === "string" ? (JSON.parse(v) as Checkpoint) : (v as Checkpoint | undefined);
  if (!obj || obj.done !== true) return null;
  // A checkpoint from another seed version is not a checkpoint for this one.
  if (obj.seed_version !== SEED_VERSION) return null;
  return obj;
}

export async function setCheckpoint(
  sql: Sql,
  orgId: string,
  family: string,
  report: FamilyReport,
  at: string,
): Promise<void> {
  const cp: Checkpoint = { seed_version: SEED_VERSION, done: true, at, report };
  await sql`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${CHECKPOINT_PREFIX + family}, ${sql.json(cp as never)})
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

/** Every checkpoint for one organisation, family → checkpoint. */
export async function listCheckpoints(
  sql: Sql,
  orgId: string,
): Promise<Record<string, Checkpoint>> {
  const rows = (await sql`
    select key, value from public.app_settings
    where org_id = ${orgId} and key like ${CHECKPOINT_PREFIX + "%"}
  `) as unknown as Array<{ key: string; value: unknown }>;
  const out: Record<string, Checkpoint> = {};
  for (const r of rows) {
    const obj =
      typeof r.value === "string" ? (JSON.parse(r.value) as Checkpoint) : (r.value as Checkpoint);
    if (obj?.done === true && obj.seed_version === SEED_VERSION)
      out[r.key.slice(CHECKPOINT_PREFIX.length)] = obj;
  }
  return out;
}
